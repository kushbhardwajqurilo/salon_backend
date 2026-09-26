import { describe, expect, it, beforeEach, afterEach, jest } from "@jest/globals";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app.mjs";
import { Organization } from "../../../src/models/organizations/organization.model.js";
import { Branch } from "../../../src/models/branches/branch.model.js";
import { Customer } from "../../../src/models/customers/customer.model.js";
import { Staff } from "../../../src/models/staff/staff.model.js";
import { Service } from "../../../src/models/services/service.model.js";
import { ServiceCategory } from "../../../src/models/services/serviceCategory.model.js";
import { Role } from "../../../src/models/roles/role.model.js";
import { Permission } from "../../../src/models/permissions/permission.model.js";
import { User } from "../../../src/models/users/user.model.js";
import { Appointment } from "../../../src/models/appointments/appointment.model.js";
import { Leave } from "../../../src/models/leaves/leave.model.js";
import jwt from "jsonwebtoken";
import { env } from "../../../src/config/env.js";
import { redis } from "../../../src/utils/redis.js";

jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");

describe("Appointment Module Comprehensive Test Suite", () => {
  jest.setTimeout(30000);
  let dbConnection;
  let orgId, branchAId, branchBId;
  let ownerToken, ownerUser;
  let customer;
  let staffA;
  let serviceHaircut, serviceColor;
  let category;

  beforeAll(async () => {
    let testUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/saloon_erp_test";
    if (testUri.includes("?")) {
      const parts = testUri.split("?");
      testUri = parts[0].replace(/\/([^\/]+)$/, "/saloon_erp_apt_test") + "?" + parts[1];
    } else {
      testUri = testUri.replace(/\/([^\/]+)$/, "/saloon_erp_apt_test");
    }
    dbConnection = await mongoose.connect(testUri);
  });

  afterAll(async () => {
    await Appointment.deleteMany({});
    await Leave.deleteMany({});
    await Service.deleteMany({});
    await ServiceCategory.deleteMany({});
    await Staff.deleteMany({});
    await Customer.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Permission.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    // 1. Create Organization & Branches
    const org = await Organization.create({ name: "Appointment Test Salon Org" });
    orgId = org._id;

    const branchA = await Branch.create({ organizationId: orgId, name: "Branch Downtown", isActive: true });
    branchAId = branchA._id;

    const branchB = await Branch.create({ organizationId: orgId, name: "Branch Uptown", isActive: true });
    branchBId = branchB._id;

    // 2. Setup Permissions & Role
    const permNames = [
      "appointments.view",
      "appointments.book",
      "appointments.create",
      "appointments.reschedule",
      "appointments.assign_staff",
      "appointments.update_status",
      "appointments.cancel",
      "appointments.delete",
      "appointments.reminders.send",
    ];

    const perms = await Promise.all(
      permNames.map((name) =>
        Permission.create({ name, module: "Appointments", action: name, description: name })
      )
    );

    const ownerRole = await Role.create({
      name: "owner",
      description: "Owner Role",
      permissions: perms.map((p) => p._id),
    });

    // 3. Setup User & Auth Token
    ownerUser = await User.create({
      name: "Salon Owner",
      email: `owner_${Date.now()}@salon.com`,
      phone: "+919999999999",
      password: "Password@123",
      role: ownerRole._id,
      organizationId: orgId,
      status: "active",
      hasOrgWideAccess: true,
      branchAccess: [
        { branchId: branchAId, branchName: "Branch Downtown", isActive: true },
        { branchId: branchBId, branchName: "Branch Uptown", isActive: true },
      ],
    });

    ownerToken = jwt.sign({ id: ownerUser._id, role: "owner" }, env.JWT_SECRET, { expiresIn: "1h" });

    // 4. Setup Customer
    customer = await Customer.create({
      name: "Alice Smith",
      phone: "+919876543210",
      organizationId: orgId,
      homeBranchId: branchAId,
      status: "active",
    });

    // 5. Setup Staff
    staffA = await Staff.create({
      name: "John Stylist",
      phone: "+919123456789",
      email: `john_${Date.now()}@salon.com`,
      organizationId: orgId,
      designation: "Senior Stylist",
      status: "active",
      staffCode: `STF-${Date.now()}`,
      joiningDate: new Date(),
    });

    // 6. Setup Category & Services (Services are Organization-Global master data)
    category = await ServiceCategory.create({
      name: "Hair Care",
      organizationId: orgId,
    });

    serviceHaircut = await Service.create({
      name: "Haircut",
      categoryId: category._id,
      duration: 30,
      pricing: { basePrice: 500 },
      status: "active",
      organizationId: orgId,
    });

    serviceColor = await Service.create({
      name: "Hair Coloring",
      categoryId: category._id,
      duration: 60,
      pricing: { basePrice: 1500 },
      status: "active",
      organizationId: orgId,
    });
  });

  afterEach(async () => {
    await Appointment.deleteMany({});
    await Leave.deleteMany({});
    await Service.deleteMany({});
    await ServiceCategory.deleteMany({});
    await Staff.deleteMany({});
    await Customer.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Permission.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});
  });

  describe("POST /api/v1/appointments - Appointment Creation & Invariants", () => {
    it("creates an advance appointment with valid payload, calculating pricing snapshot & totalDuration without tax", async () => {
      const res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          staffId: staffA._id.toString(),
          serviceIds: [serviceHaircut._id.toString(), serviceColor._id.toString()],
          appointmentDate: "2026-10-20",
          startTime: "10:00",
          bookingType: "advance",
          discount: 100,
        });

      if (res.status !== 201) console.error("CREATE ERROR:", res.body);
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.appointmentCode).toMatch(/^APT-\d{8}-\d{4}$/);
      expect(res.body.data.totalDuration).toBe(90); // 30 + 60
      expect(res.body.data.endTime).toBe("11:30");
      expect(res.body.data.status).toBe("scheduled");

      // Pricing Check: Base = 500 + 1500 = 2000. Discount = 100. Total = 1900. No tax.
      expect(res.body.data.pricing.subtotal).toBe(2000);
      expect(res.body.data.pricing.tax).toBeUndefined();
      expect(res.body.data.pricing.discount).toBe(100);
      expect(res.body.data.pricing.total).toBe(1900);
      expect(res.body.data.services[0].price).toBe(500);
      expect(res.body.data.services[0].taxRate).toBeUndefined();
      expect(res.body.data.services[0].taxAmount).toBeUndefined();
    });

    it("creates an appointment with custom service prices overriding master base prices", async () => {
      const res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          staffId: staffA._id.toString(),
          services: [
            { serviceId: serviceHaircut._id.toString(), customPrice: 400 },
            { serviceId: serviceColor._id.toString(), customPrice: 1200 },
          ],
          appointmentDate: "2026-10-21",
          startTime: "10:00",
          bookingType: "advance",
          discount: 50,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.services[0].price).toBe(400);
      expect(res.body.data.services[1].price).toBe(1200);
      expect(res.body.data.pricing.subtotal).toBe(1600);
      expect(res.body.data.pricing.discount).toBe(50);
      expect(res.body.data.pricing.total).toBe(1550);
    });

    it("creates an appointment with mixed custom price and omitted custom price defaulting to master basePrice", async () => {
      const res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          staffId: staffA._id.toString(),
          services: [
            { serviceId: serviceHaircut._id.toString(), customPrice: 350 },
            { serviceId: serviceColor._id.toString() }, // omitted -> defaults to 1500
          ],
          appointmentDate: "2026-10-22",
          startTime: "10:00",
          bookingType: "advance",
        });

      expect(res.status).toBe(201);
      expect(res.body.data.services[0].price).toBe(350);
      expect(res.body.data.services[1].price).toBe(1500);
      expect(res.body.data.pricing.subtotal).toBe(1850);
      expect(res.body.data.pricing.total).toBe(1850);
    });

    it("ensures changing Service master base price does NOT mutate existing appointment snapshots", async () => {
      const createRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          staffId: staffA._id.toString(),
          serviceIds: [serviceHaircut._id.toString()],
          appointmentDate: "2026-10-23",
          startTime: "10:00",
          bookingType: "advance",
        });

      expect(createRes.status).toBe(201);
      const aptId = createRes.body.data.id;
      expect(createRes.body.data.services[0].price).toBe(500);

      // Now change Service master base price to 800
      await Service.findByIdAndUpdate(serviceHaircut._id, { "pricing.basePrice": 800 });

      // Fetch appointment from API
      const getRes = await request(app)
        .get(`/api/v1/appointments/${aptId}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchAId.toString());

      expect(getRes.status).toBe(200);
      expect(getRes.body.data.services[0].price).toBe(500);
      expect(getRes.body.data.pricing.subtotal).toBe(500);
      expect(getRes.body.data.pricing.total).toBe(500);
    });

    it("rejects appointment creation if body.branchId is missing (Invariant 2)", async () => {
      const res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          customerId: customer._id.toString(),
          serviceIds: [serviceHaircut._id.toString()],
          appointmentDate: "2026-10-20",
          startTime: "10:00",
          bookingType: "advance",
        });

      expect(res.status).toBe(400);
    });

    it("rejects advance booking in the past", async () => {
      const res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          serviceIds: [serviceHaircut._id.toString()],
          appointmentDate: "2020-01-01",
          startTime: "10:00",
          bookingType: "advance",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("past");
    });

    it("rejects creation if assigned staff is on leave (Leave Integration)", async () => {
      // Create approved leave for staffA on 2026-10-20
      await Leave.create({
        organizationId: orgId,
        branchId: branchAId,
        staffId: staffA._id,
        leaveCode: "LV-TEST-01",
        leaveType: "Casual",
        startDate: new Date("2026-10-20T00:00:00.000Z"),
        endDate: new Date("2026-10-20T00:00:00.000Z"),
        dates: ["2026-10-20"],
        reason: "Vacation",
        status: "approved",
        submittedBy: ownerUser._id,
        submittedFor: "self",
      });

      const res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          staffId: staffA._id.toString(),
          serviceIds: [serviceHaircut._id.toString()],
          appointmentDate: "2026-10-20",
          startTime: "10:00",
          bookingType: "advance",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("on leave");
    });

    it("supports walk-in appointment creation with immediate in_progress status", async () => {
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, "0");
      const dd = String(today.getDate()).padStart(2, "0");
      const todayStr = `${yyyy}-${mm}-${dd}`;

      const res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          staffId: staffA._id.toString(),
          serviceIds: [serviceHaircut._id.toString()],
          appointmentDate: todayStr,
          startTime: "14:00",
          bookingType: "walk_in",
        });

      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe("in_progress");
    });
  });

  describe("GET /api/v1/appointments - READ Scoping", () => {
    it("allows All-Branches READ when X-Branch-Id header is omitted for org-wide access user", async () => {
      // Create appointment in Branch A
      await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          serviceIds: [serviceHaircut._id.toString()],
          appointmentDate: "2026-10-20",
          startTime: "10:00",
          bookingType: "advance",
        });

      const res = await request(app)
        .get("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    });

    it("filters appointments strictly by X-Branch-Id header when provided", async () => {
      await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          serviceIds: [serviceHaircut._id.toString()],
          appointmentDate: "2026-10-20",
          startTime: "10:00",
          bookingType: "advance",
        });

      const res = await request(app)
        .get("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchBId.toString());

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
    });

    it("filters appointments by customerName and general search matching customer name", async () => {
      // Create a second customer with a different name
      const customerBob = await Customer.create({
        name: "Bob Builder",
        phone: "+919811112222",
        organizationId: orgId,
        homeBranchId: branchAId,
        status: "active",
      });

      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, "0");
      const dd = String(today.getDate()).padStart(2, "0");
      const todayStr = `${yyyy}-${mm}-${dd}`;

      // Create appointment for Alice
      await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          serviceIds: [serviceHaircut._id.toString()],
          appointmentDate: todayStr,
          startTime: "14:00",
          bookingType: "walk_in",
        });

      // Create appointment for Bob
      await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customerBob._id.toString(),
          serviceIds: [serviceHaircut._id.toString()],
          appointmentDate: todayStr,
          startTime: "15:00",
          bookingType: "walk_in",
        });

      // Query with customerName=Alice
      const resAlice = await request(app)
        .get("/api/v1/appointments?customerName=Alice")
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(resAlice.status).toBe(200);
      expect(resAlice.body.data.length).toBeGreaterThanOrEqual(1);
      expect(resAlice.body.data.every((apt) => apt.customerId._id === customer._id.toString())).toBe(true);

      // Query with customerName=Bob
      const resBob = await request(app)
        .get("/api/v1/appointments?customerName=Bob")
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(resBob.status).toBe(200);
      expect(resBob.body.data.length).toBeGreaterThanOrEqual(1);
      expect(resBob.body.data.every((apt) => apt.customerId._id === customerBob._id.toString())).toBe(true);

      // Query with generic search=Bob
      const resSearch = await request(app)
        .get("/api/v1/appointments?search=Bob")
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(resSearch.status).toBe(200);
      expect(resSearch.body.data.length).toBeGreaterThanOrEqual(1);
      expect(resSearch.body.data.every((apt) => apt.customerId._id === customerBob._id.toString())).toBe(true);

      // Query with customerName non-existent
      const resNone = await request(app)
        .get("/api/v1/appointments?customerName=NonExistentCustomerName")
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(resNone.status).toBe(200);
      expect(resNone.body.data).toHaveLength(0);
    });
  });

  describe("PATCH /api/v1/appointments/:id/reschedule - Rescheduling & Cross-Branch Guard", () => {
    it("reschedules appointment date/time within the same branch", async () => {
      const createRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          serviceIds: [serviceHaircut._id.toString()],
          appointmentDate: "2026-10-20",
          startTime: "10:00",
          bookingType: "advance",
        });

      const aptId = createRes.body.data.id;

      const res = await request(app)
        .patch(`/api/v1/appointments/${aptId}/reschedule`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          appointmentDate: "2026-10-21",
          startTime: "11:00",
        });

      if (res.status !== 200) console.error("RESCHEDULE ERROR:", res.body);
      expect(res.status).toBe(200);
      expect(res.body.data.appointmentDate).toBe("2026-10-21");
      expect(res.body.data.startTime).toBe("11:00");
    });

    it("rejects cross-branch rescheduling (Invariant 5)", async () => {
      const createRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          serviceIds: [serviceHaircut._id.toString()],
          appointmentDate: "2026-10-20",
          startTime: "10:00",
          bookingType: "advance",
        });

      const aptId = createRes.body.data.id;

      const res = await request(app)
        .patch(`/api/v1/appointments/${aptId}/reschedule`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchBId.toString(), // Target branch mismatch
          appointmentDate: "2026-10-21",
          startTime: "11:00",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("Cross-branch");
    });
  });

  describe("PATCH /api/v1/appointments/:id/status - Status Machine & completedAt Guard", () => {
    it("progresses status from scheduled -> in_progress -> completed, populating completedAt", async () => {
      const createRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          staffId: staffA._id.toString(),
          serviceIds: [serviceHaircut._id.toString()],
          appointmentDate: "2026-10-20",
          startTime: "10:00",
          bookingType: "advance",
        });

      const aptId = createRes.body.data.id;

      // 1. scheduled -> in_progress
      const startRes = await request(app)
        .patch(`/api/v1/appointments/${aptId}/status`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          status: "in_progress",
        });

      expect(startRes.status).toBe(200);
      expect(startRes.body.data.status).toBe("in_progress");

      // 2. in_progress -> completed
      const completeRes = await request(app)
        .patch(`/api/v1/appointments/${aptId}/status`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          status: "completed",
        });

      expect(completeRes.status).toBe(200);
      expect(completeRes.body.data.status).toBe("completed");
      expect(completeRes.body.data.completedAt).not.toBeNull();
    });

    it("prevents modifying completed appointments (Terminal State Guard)", async () => {
      const createRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          staffId: staffA._id.toString(),
          serviceIds: [serviceHaircut._id.toString()],
          appointmentDate: "2026-10-20",
          startTime: "10:00",
          bookingType: "advance",
        });

      const aptId = createRes.body.data.id;

      await request(app)
        .patch(`/api/v1/appointments/${aptId}/status`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchAId.toString(), status: "in_progress" });

      await request(app)
        .patch(`/api/v1/appointments/${aptId}/status`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchAId.toString(), status: "completed" });

      // Attempt to modify completed appointment
      const res = await request(app)
        .put(`/api/v1/appointments/${aptId}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          notes: "Updating completed apt notes",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("terminal status");
    });
  });

  describe("Concurrency & Overlap Detection Strategy", () => {
    it("rejects overlapping booking for the same staff member with 409 Conflict", async () => {
      // Create first booking: 10:00 to 10:30 (30 mins)
      await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          staffId: staffA._id.toString(),
          serviceIds: [serviceHaircut._id.toString()],
          appointmentDate: "2026-10-25",
          startTime: "10:00",
          bookingType: "advance",
        });

      // Attempt overlapping booking: 10:15 to 10:45
      const res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          staffId: staffA._id.toString(),
          serviceIds: [serviceHaircut._id.toString()],
          appointmentDate: "2026-10-25",
          startTime: "10:15",
          bookingType: "advance",
        });

      expect(res.status).toBe(409);
      expect(res.body.message).toContain("overlapping appointment");
    });

    it("handles simultaneous Promise.all requests for same staff & interval: exactly 1 succeeds, 1 gets 409, 1 DB entry created", async () => {
      const payload1 = {
        branchId: branchAId.toString(),
        customerId: customer._id.toString(),
        staffId: staffA._id.toString(),
        serviceIds: [serviceHaircut._id.toString()],
        appointmentDate: "2026-09-28",
        startTime: "11:00",
        bookingType: "advance",
      };

      const payload2 = {
        branchId: branchAId.toString(),
        customerId: customer._id.toString(),
        staffId: staffA._id.toString(),
        serviceIds: [serviceHaircut._id.toString()],
        appointmentDate: "2026-09-28",
        startTime: "11:15", // Overlaps 11:00-11:30
        bookingType: "advance",
      };

      const [res1, res2] = await Promise.all([
        request(app).post("/api/v1/appointments").set("Authorization", `Bearer ${ownerToken}`).send(payload1),
        request(app).post("/api/v1/appointments").set("Authorization", `Bearer ${ownerToken}`).send(payload2),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([201, 409]);

      const aptCount = await Appointment.countDocuments({
        organizationId: orgId,
        staffId: staffA._id,
        appointmentDate: "2026-09-28",
        isDeleted: false,
      });
      expect(aptCount).toBe(1);
    });

    it("allows multiple unassigned (staffId = null) appointments to coexist at overlapping times", async () => {
      const payloadA = {
        branchId: branchAId.toString(),
        customerId: customer._id.toString(),
        staffId: null,
        serviceIds: [serviceHaircut._id.toString()],
        appointmentDate: "2026-09-29",
        startTime: "10:00",
        bookingType: "advance",
      };

      const payloadB = {
        branchId: branchAId.toString(),
        customerId: customer._id.toString(),
        staffId: null,
        serviceIds: [serviceHaircut._id.toString()],
        appointmentDate: "2026-09-29",
        startTime: "10:15",
        bookingType: "advance",
      };

      const resA = await request(app).post("/api/v1/appointments").set("Authorization", `Bearer ${ownerToken}`).send(payloadA);
      const resB = await request(app).post("/api/v1/appointments").set("Authorization", `Bearer ${ownerToken}`).send(payloadB);

      expect(resA.status).toBe(201);
      expect(resB.status).toBe(201);

      const count = await Appointment.countDocuments({
        organizationId: orgId,
        staffId: null,
        appointmentDate: "2026-09-29",
        isDeleted: false,
      });
      expect(count).toBe(2);
    });
  });

  describe("DELETE /api/v1/appointments/:id - Administrative Soft Delete", () => {
    it("soft deletes an appointment when user has appointments.delete permission", async () => {
      const createRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          serviceIds: [serviceHaircut._id.toString()],
          appointmentDate: "2026-10-20",
          startTime: "10:00",
          bookingType: "advance",
        });

      const aptId = createRes.body.data.id;

      const res = await request(app)
        .delete(`/api/v1/appointments/${aptId}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchAId.toString() });

      expect(res.status).toBe(200);

      // Verify soft deleted in DB
      const aptDb = await Appointment.findById(aptId);
      expect(aptDb.isDeleted).toBe(true);
    });
  });

  describe("POST /api/v1/appointments/:id/reminder/trigger - Manual Reminder Dispatch & Authorization", () => {
    it("dispatches manual reminder for scheduled appointment with valid branchId", async () => {
      const createRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          serviceIds: [serviceHaircut._id.toString()],
          appointmentDate: "2026-10-20",
          startTime: "10:00",
          bookingType: "advance",
          reminder: { enabled: true, channel: "sms", offsetMinutes: 60 },
        });

      const aptId = createRes.body.data.id;

      const res = await request(app)
        .post(`/api/v1/appointments/${aptId}/reminder/trigger`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchAId.toString() });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.reminder.status).toBe("sent");
    });

    it("rejects manual reminder trigger if body.branchId is missing", async () => {
      const createRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          serviceIds: [serviceHaircut._id.toString()],
          appointmentDate: "2026-10-20",
          startTime: "10:00",
          bookingType: "advance",
        });

      const aptId = createRes.body.data.id;

      const res = await request(app)
        .post(`/api/v1/appointments/${aptId}/reminder/trigger`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("branchId");
    });

    it("handles channel = both with partial_delivery status when customer email is present but phone is missing", async () => {
      // Update customer to have email but no phone
      await Customer.updateOne({ _id: customer._id }, { $set: { email: "alice@example.com", phone: null } });

      const createRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          serviceIds: [serviceHaircut._id.toString()],
          appointmentDate: "2026-10-20",
          startTime: "10:00",
          bookingType: "advance",
          reminder: { enabled: true, channel: "both", offsetMinutes: 60 },
        });

      const aptId = createRes.body.data.id;

      const res = await request(app)
        .post(`/api/v1/appointments/${aptId}/reminder/trigger`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchAId.toString() });

      expect(res.status).toBe(200);
      expect(res.body.data.reminder.status).toBe("partial_delivery");
      expect(res.body.data.reminder.email.status).toBe("sent");
      expect(res.body.data.reminder.sms.status).toBe("failed");
    });

    it("handles channel = both with sent status when both email and phone are present", async () => {
      await Customer.updateOne({ _id: customer._id }, { $set: { email: "alice@example.com", phone: "+919876543210" } });

      const createRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          serviceIds: [serviceHaircut._id.toString()],
          appointmentDate: "2026-10-20",
          startTime: "10:00",
          bookingType: "advance",
          reminder: { enabled: true, channel: "both", offsetMinutes: 60 },
        });

      const aptId = createRes.body.data.id;

      const res = await request(app)
        .post(`/api/v1/appointments/${aptId}/reminder/trigger`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchAId.toString() });

      expect(res.status).toBe(200);
      expect(res.body.data.reminder.status).toBe("sent");
      expect(res.body.data.reminder.email.status).toBe("sent");
      expect(res.body.data.reminder.sms.status).toBe("sent");
    });
  });

  describe("Organization-Global Services in Appointments", () => {
    it("allows booking the same organization-global service across multiple different branches of the same organization", async () => {
      // 1. Book Haircut in Branch A
      const resBranchA = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          services: [{ serviceId: serviceHaircut._id.toString() }],
          appointmentDate: "2026-10-22",
          startTime: "11:00",
          bookingType: "advance",
        });

      expect(resBranchA.status).toBe(201);
      expect(resBranchA.body.data.branchId).toBe(branchAId.toString());
      expect(resBranchA.body.data.services[0].serviceId).toBe(serviceHaircut._id.toString());
      expect(resBranchA.body.data.services[0].price).toBe(500);

      // 2. Book the EXACT same Haircut in Branch B with customPrice = 600
      const resBranchB = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchBId.toString(),
          customerId: customer._id.toString(),
          services: [{ serviceId: serviceHaircut._id.toString(), customPrice: 600 }],
          appointmentDate: "2026-10-22",
          startTime: "14:00",
          bookingType: "advance",
        });

      expect(resBranchB.status).toBe(201);
      expect(resBranchB.body.data.branchId).toBe(branchBId.toString());
      expect(resBranchB.body.data.services[0].serviceId).toBe(serviceHaircut._id.toString());
      expect(resBranchB.body.data.services[0].price).toBe(600);

      // Verify customer's visitedBranchIds now includes BOTH home branch (Branch A) and new visited branch (Branch B)
      const updatedCustomer = await Customer.findById(customer._id);
      const visitedStrs = updatedCustomer.visitedBranchIds.map((id) => id.toString());
      expect(visitedStrs).toContain(branchAId.toString());
      expect(visitedStrs).toContain(branchBId.toString());
    });

    it("rejects booking an appointment with a service belonging to a different organization", async () => {
      // Create another organization with its own service
      const otherOrg = await Organization.create({
        name: "Other Salon Org",
        slug: `other-org-${Date.now()}`,
        status: "active",
      });
      const otherCat = await ServiceCategory.create({
        name: "Other Care",
        organizationId: otherOrg._id,
      });
      const otherService = await Service.create({
        name: "Other Haircut",
        categoryId: otherCat._id,
        duration: 45,
        pricing: { basePrice: 800 },
        status: "active",
        organizationId: otherOrg._id,
      });

      const res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          services: [{ serviceId: otherService._id.toString() }],
          appointmentDate: "2026-10-22",
          startTime: "16:00",
          bookingType: "advance",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/invalid, inactive, or belong to a different organization/i);
    });
  });
});
