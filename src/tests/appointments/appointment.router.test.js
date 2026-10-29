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

// Deterministic relative future date fixtures to prevent test staleness
const getFutureDateStr = (daysAhead = 30) => {
  const d = new Date(Date.now() + daysAhead * 86400000);
  return d.toISOString().split("T")[0];
};

const getFutureDayOfWeekStr = (targetDayName, weeksAhead = 4) => {
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const targetIdx = days.indexOf(targetDayName.toLowerCase());
  const now = new Date();
  const d = new Date(now.getTime() + weeksAhead * 7 * 86400000);
  const diff = (targetIdx - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + diff);
  return d.toISOString().split("T")[0];
};

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
    await Appointment.syncIndexes();
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
      "appointments.edit",
      "appointments.force_early_start",
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
          appointmentDate: getFutureDateStr(30),
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
          appointmentDate: getFutureDateStr(31),
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
          appointmentDate: getFutureDateStr(32),
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
          appointmentDate: getFutureDateStr(33),
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
          appointmentDate: getFutureDateStr(30),
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
      // Create approved leave for staffA on 2026-11-20
      await Leave.create({
        organizationId: orgId,
        branchId: branchAId,
        staffId: staffA._id,
        leaveCode: "LV-TEST-01",
        leaveType: "Casual",
        startDate: new Date(getFutureDateStr(30) + "T00:00:00.000Z"),
        endDate: new Date(getFutureDateStr(30) + "T00:00:00.000Z"),
        dates: [getFutureDateStr(30)],
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
          appointmentDate: getFutureDateStr(30),
          startTime: "10:00",
          bookingType: "advance",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("on leave");
    });

    it("supports walk-in appointment creation with scheduled status and recorded arrivedAt", async () => {
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
      expect(res.body.data.status).toBe("scheduled");
      expect(res.body.data.arrivedAt).toBeDefined();
      expect(new Date(res.body.data.arrivedAt).getTime()).not.toBeNaN();
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
          appointmentDate: getFutureDateStr(30),
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
          appointmentDate: getFutureDateStr(30),
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
          appointmentDate: getFutureDateStr(30),
          startTime: "10:00",
          bookingType: "advance",
        });

      const aptId = createRes.body.data.id;

      const res = await request(app)
        .patch(`/api/v1/appointments/${aptId}/reschedule`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          appointmentDate: getFutureDateStr(31),
          startTime: "11:00",
        });

      if (res.status !== 200) console.error("RESCHEDULE ERROR:", res.body);
      expect(res.status).toBe(200);
      expect(res.body.data.appointmentDate).toBe(getFutureDateStr(31));
      expect(res.body.data.startTime).toBe("11:00");
      expect(res.body.data.status).toBe("scheduled");
    });

    it("assign-staff assigns staff without modifying status to in_progress", async () => {
      const createRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          serviceIds: [serviceHaircut._id.toString()],
          appointmentDate: getFutureDateStr(30),
          startTime: "10:00",
          bookingType: "advance",
        });

      const aptId = createRes.body.data.id;

      const res = await request(app)
        .patch(`/api/v1/appointments/${aptId}/assign-staff`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          staffId: staffA._id.toString(),
        });

      expect(res.status).toBe(200);
      expect(res.body.data.staffId._id.toString()).toBe(staffA._id.toString());
      expect(res.body.data.status).toBe("scheduled");
    });

    it("rejects cross-branch rescheduling (Invariant 5)", async () => {
      const createRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          serviceIds: [serviceHaircut._id.toString()],
          appointmentDate: getFutureDateStr(30),
          startTime: "10:00",
          bookingType: "advance",
        });

      const aptId = createRes.body.data.id;

      const res = await request(app)
        .patch(`/api/v1/appointments/${aptId}/reschedule`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchBId.toString(), // Target branch mismatch
          appointmentDate: getFutureDateStr(31),
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
          appointmentDate: getFutureDateStr(30),
          startTime: "10:00",
          bookingType: "advance",
        });

      const aptId = createRes.body.data.id;

      // 1. scheduled -> in_progress (future appointment requires forceEarlyStart or starting within window)
      const rejectFutureStart = await request(app)
        .patch(`/api/v1/appointments/${aptId}/status`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          status: "in_progress",
        });

      expect(rejectFutureStart.status).toBe(400);
      expect(rejectFutureStart.body.message).toContain("Cannot start future appointment early");

      // Now start with forceEarlyStart: true
      const startRes = await request(app)
        .patch(`/api/v1/appointments/${aptId}/status`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          status: "in_progress",
          forceEarlyStart: true,
        });

      expect(startRes.status).toBe(200);
      expect(startRes.body.data.status).toBe("in_progress");
      expect(startRes.body.data.startedAt).toBeDefined();

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
          appointmentDate: getFutureDateStr(30),
          startTime: "10:00",
          bookingType: "advance",
        });

      const aptId = createRes.body.data.id;

      await request(app)
        .patch(`/api/v1/appointments/${aptId}/status`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchAId.toString(), status: "in_progress", forceEarlyStart: true });

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

    it("late completion preserves scheduled startAt, endAt, startTime, and endTime while recording completedAt", async () => {
      const createRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          staffId: staffA._id.toString(),
          serviceIds: [serviceHaircut._id.toString()], // 30 min duration
          appointmentDate: getFutureDateStr(30),
          startTime: "12:45",
          bookingType: "advance",
        });

      const aptId = createRes.body.data.id;
      expect(createRes.body.data.startTime).toBe("12:45");
      expect(createRes.body.data.endTime).toBe("13:15");
      const scheduledEndAt = createRes.body.data.endAt;

      // Start appointment
      await request(app)
        .patch(`/api/v1/appointments/${aptId}/status`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchAId.toString(), status: "in_progress", forceEarlyStart: true });

      // Complete appointment much later (simulated runtime completion)
      const completeRes = await request(app)
        .patch(`/api/v1/appointments/${aptId}/status`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchAId.toString(), status: "completed" });

      expect(completeRes.status).toBe(200);
      expect(completeRes.body.data.status).toBe("completed");
      expect(completeRes.body.data.startTime).toBe("12:45");
      expect(completeRes.body.data.endTime).toBe("13:15");
      expect(completeRes.body.data.endAt).toBe(scheduledEndAt);
      expect(completeRes.body.data.completedAt).toBeDefined();

      // Ensure updating services while in_progress also preserves scheduled startAt + totalDuration
      const inProgApt = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          staffId: staffA._id.toString(),
          serviceIds: [serviceHaircut._id.toString()],
          appointmentDate: getFutureDateStr(31),
          startTime: "10:00",
          bookingType: "advance",
        });
      const inProgId = inProgApt.body.data.id;
      await request(app)
        .patch(`/api/v1/appointments/${inProgId}/status`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchAId.toString(), status: "in_progress", forceEarlyStart: true });

      const updateInProgRes = await request(app)
        .put(`/api/v1/appointments/${inProgId}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          serviceIds: [serviceHaircut._id.toString(), serviceColor._id.toString()], // 30 + 60 = 90 min
        });
      expect(updateInProgRes.status).toBe(200);
      expect(updateInProgRes.body.data.startTime).toBe("10:00");
      expect(updateInProgRes.body.data.endTime).toBe("11:30");
      expect(updateInProgRes.body.data.totalDuration).toBe(90);
    });

    it("detects overdue in_progress appointment for assigned staff, requiring allowOverdueStaffOverride", async () => {
      // 1. Create Appointment 1 whose endAt is in the past, on the same appointmentDate
      const targetDateStr = getFutureDateStr(30);
      const pastStart = new Date(Date.now() - 90 * 60000);
      const pastEnd = new Date(Date.now() - 30 * 60000); // Ended 30 minutes ago
      const apt1 = await Appointment.create({
        organizationId: orgId,
        branchId: branchAId,
        customerId: customer._id,
        staffId: staffA._id,
        appointmentCode: `OVERDUE-${Date.now()}`,
        appointmentDate: targetDateStr,
        startTime: "09:00",
        endTime: "10:00",
        startAt: pastStart,
        endAt: pastEnd,
        totalDuration: 60,
        bookingType: "advance",
        status: "in_progress",
        startedAt: pastStart,
        services: [
          {
            serviceType: "registered",
            serviceId: serviceHaircut._id,
            name: "Haircut",
            duration: 60,
            price: 500,
          },
        ],
        pricing: { subtotal: 500, discount: 0, total: 500 },
        slotMinutes: [],
      });

      // 2. Create Appointment 2 scheduled for targetDateStr with staffA
      const createRes2 = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          staffId: staffA._id.toString(),
          serviceIds: [serviceHaircut._id.toString()],
          appointmentDate: targetDateStr,
          startTime: "11:00",
          bookingType: "advance",
        });

      const apt2Id = createRes2.body.data.id;

      // 3. Attempt to transition Appointment 2 to in_progress without override
      const conflictRes = await request(app)
        .patch(`/api/v1/appointments/${apt2Id}/status`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          status: "in_progress",
          forceEarlyStart: true,
        });

      expect(conflictRes.status).toBe(409);
      expect(conflictRes.body.message).toMatch(/overdue appointment/i);
      expect(conflictRes.body.errors).toMatchObject({
        conflictType: "STAFF_OVERDUE_APPOINTMENT",
        overdueAppointmentId: apt1._id.toString(),
        requiresOverride: true,
      });

      // 4. Staff member lacking appointments.reschedule cannot provide allowOverdueStaffOverride
      const staffPerms = await Permission.find({
        name: { $in: ["appointments.view", "appointments.update_status", "appointments.force_early_start"] },
      });
      const staffRole = await Role.create({
        name: `staff_no_reschedule_${Date.now()}`,
        permissions: staffPerms.map((p) => p._id),
      });
      const staffUser = await User.create({
        name: "Staff No Reschedule",
        email: `staff_no_reschedule_${Date.now()}@salon.com`,
        phone: "+919876540000",
        password: "Password@123",
        role: staffRole._id,
        organizationId: orgId,
        status: "active",
        hasOrgWideAccess: false,
        branchAccess: [{ branchId: branchAId, branchName: "Branch Downtown", isActive: true }],
      });
      const staffToken = jwt.sign({ id: staffUser._id, role: staffRole.name }, env.JWT_SECRET, { expiresIn: "1h" });

      const unauthorizedOverrideRes = await request(app)
        .patch(`/api/v1/appointments/${apt2Id}/status`)
        .set("Authorization", `Bearer ${staffToken}`)
        .send({
          branchId: branchAId.toString(),
          status: "in_progress",
          forceEarlyStart: true,
          allowOverdueStaffOverride: true,
        });
      expect(unauthorizedOverrideRes.status).toBe(403);

      // 5. Authorized manager / owner provides allowOverdueStaffOverride -> succeeds
      const authorizedOverrideRes = await request(app)
        .patch(`/api/v1/appointments/${apt2Id}/status`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          status: "in_progress",
          forceEarlyStart: true,
          allowOverdueStaffOverride: true,
        });

      // Clean up apt1 and apt2
      await Appointment.deleteMany({ _id: { $in: [apt1._id, apt2Id] } });
    });

    it("does NOT block starting today's appointment when staff has an unfinished historical in_progress appointment from a previous calendar day", async () => {
      // 1. Create historical in_progress appointment from a previous day (e.g. August 13, 2026)
      const historicalStart = new Date("2026-08-13T10:00:00.000Z");
      const historicalEnd = new Date("2026-08-13T10:42:00.000Z");
      const historicalApt = await Appointment.create({
        organizationId: orgId,
        branchId: branchAId,
        customerId: customer._id,
        staffId: staffA._id,
        appointmentCode: "APT-20260813-0004",
        appointmentDate: "2026-08-13",
        startTime: "15:30",
        endTime: "16:12",
        startAt: historicalStart,
        endAt: historicalEnd,
        totalDuration: 42,
        bookingType: "advance",
        status: "in_progress",
        startedAt: historicalStart,
        services: [
          {
            serviceType: "registered",
            serviceId: serviceHaircut._id,
            name: "Haircut",
            duration: 42,
            price: 500,
          },
        ],
        pricing: { subtotal: 500, discount: 0, total: 500 },
        slotMinutes: [],
      });

      // 2. Create today's appointment for the same staff member
      const todayDateStr = getFutureDateStr(30);
      const createResToday = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          staffId: staffA._id.toString(),
          serviceIds: [serviceHaircut._id.toString()],
          appointmentDate: todayDateStr,
          startTime: "14:00",
          bookingType: "advance",
        });

      expect(createResToday.status).toBe(201);
      const todayAptId = createResToday.body.data.id;

      // 3. Start today's appointment without allowOverdueStaffOverride -> MUST succeed (no 409)
      const startRes = await request(app)
        .patch(`/api/v1/appointments/${todayAptId}/status`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          status: "in_progress",
          forceEarlyStart: true,
        });

      expect(startRes.status).toBe(200);
      expect(startRes.body.data.status).toBe("in_progress");

      // Clean up
      await Appointment.deleteMany({ _id: { $in: [historicalApt._id, todayAptId] } });
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
        appointmentDate: getFutureDateStr(38),
        startTime: "11:00",
        bookingType: "advance",
      };

      const payload2 = {
        branchId: branchAId.toString(),
        customerId: customer._id.toString(),
        staffId: staffA._id.toString(),
        serviceIds: [serviceHaircut._id.toString()],
        appointmentDate: getFutureDateStr(38),
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
        appointmentDate: getFutureDateStr(38),
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
        appointmentDate: getFutureDateStr(39),
        startTime: "10:00",
        bookingType: "advance",
      };

      const payloadB = {
        branchId: branchAId.toString(),
        customerId: customer._id.toString(),
        staffId: null,
        serviceIds: [serviceHaircut._id.toString()],
        appointmentDate: getFutureDateStr(39),
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
        appointmentDate: getFutureDateStr(39),
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
          appointmentDate: getFutureDateStr(30),
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
          appointmentDate: getFutureDateStr(30),
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
          appointmentDate: getFutureDateStr(30),
          startTime: "10:00",
          bookingType: "advance",
        });

      const aptId = createRes.body.data.id;

      const res = await request(app)
        .post(`/api/v1/appointments/${aptId}/reminder/trigger`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/(branchId|Please select a Branch)/);
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
          appointmentDate: getFutureDateStr(30),
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
          appointmentDate: getFutureDateStr(30),
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

    it("allows sending notifications multiple times consecutively", async () => {
      await Customer.updateOne({ _id: customer._id }, { $set: { email: "alice@example.com", phone: "+919876543210" } });

      const createRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          serviceIds: [serviceHaircut._id.toString()],
          appointmentDate: getFutureDateStr(30),
          startTime: "10:00",
          bookingType: "advance",
          reminder: { enabled: true, channel: "both", offsetMinutes: 60 },
        });

      const aptId = createRes.body.data.id;

      // First dispatch
      const res1 = await request(app)
        .post(`/api/v1/appointments/${aptId}/reminder/trigger`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchAId.toString() });
      expect(res1.status).toBe(200);
      expect(res1.body.data.reminder.status).toBe("sent");

      // Second dispatch (re-trigger notification)
      const res2 = await request(app)
        .post(`/api/v1/appointments/${aptId}/reminder/trigger`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchAId.toString() });
      expect(res2.status).toBe(200);
      expect(res2.body.data.reminder.status).toBe("sent");
      expect(res2.body.data.reminder.email.status).toBe("sent");
      expect(res2.body.data.reminder.sms.status).toBe("sent");
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
          appointmentDate: getFutureDateStr(34),
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
          appointmentDate: getFutureDateStr(34),
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
          appointmentDate: getFutureDateStr(34),
          startTime: "16:00",
          bookingType: "advance",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/invalid, inactive, or belong to a different organization/i);
    });
  });

  describe("Cascading Rescheduling Engine & Service Modifications", () => {
    it("previews service modification extending in-progress appointment and detects affected subsequent bookings", async () => {
      const targetDate = getFutureDateStr(30);

      // 1. Create first appointment (10:00 - 10:45)
      const apt1Res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          staffId: staffA._id.toString(),
          services: [{ serviceId: serviceHaircut._id.toString(), customPrice: 1500 }],
          appointmentDate: targetDate,
          startTime: "10:00",
          bookingType: "advance",
        });
      expect(apt1Res.status).toBe(201);
      const apt1Id = apt1Res.body.data.id;

      // 2. Create second appointment immediately following (10:45 - 11:30)
      const apt2Res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          staffId: staffA._id.toString(),
          services: [{ serviceId: serviceHaircut._id.toString() }],
          appointmentDate: targetDate,
          startTime: "10:45",
          bookingType: "advance",
        });
      expect(apt2Res.status).toBe(201);
      const apt2Id = apt2Res.body.data.id;

      // Transition apt1 to in_progress with forceEarlyStart
      await request(app)
        .patch(`/api/v1/appointments/${apt1Id}/status`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchAId.toString(), status: "in_progress", forceEarlyStart: true });

      // 3. Preview adding serviceColor (60 mins) to apt1
      const previewRes = await request(app)
        .post(`/api/v1/appointments/${apt1Id}/services/preview`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          services: [
            { serviceId: serviceHaircut._id.toString() }, // Agreed price 1500 should be preserved
            { serviceId: serviceColor._id.toString(), customPrice: 2000 },
          ],
        });

      expect(previewRes.status).toBe(200);
      expect(previewRes.body.data.previewToken).toBeDefined();
      expect(previewRes.body.data.canCommit).toBe(true);
      expect(previewRes.body.data.initiatingAppointment.services[0].price).toBe(1500); // Preserved customPrice
      expect(previewRes.body.data.initiatingAppointment.services[1].price).toBe(2000);
      expect(previewRes.body.data.affectedAppointments.length).toBe(1);
      expect(previewRes.body.data.affectedAppointments[0].id).toBe(apt2Id);
      expect(previewRes.body.data.affectedAppointments[0].reason).toContain("Cascaded");

      const previewToken = previewRes.body.data.previewToken;

      // 4. Commit the cascade
      const commitRes = await request(app)
        .post(`/api/v1/appointments/${apt1Id}/services/commit`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          previewToken,
          services: [
            { serviceId: serviceHaircut._id.toString() },
            { serviceId: serviceColor._id.toString(), customPrice: 2000 },
          ],
        });

      if (commitRes.status !== 200) {
        console.error("COMMIT ERROR:", JSON.stringify(commitRes.body, null, 2));
      }
      expect(commitRes.status).toBe(200);
      expect(commitRes.body.message).toContain("committed successfully");

      // Verify apt2 has shifted start time
      const updatedApt2 = await Appointment.findById(apt2Id);
      expect(updatedApt2.startTime).not.toBe("10:45");
      expect(new Date(updatedApt2.startAt).getTime()).toBeGreaterThan(new Date(`${targetDate}T10:45:00`).getTime());

      // 5. Re-committing with the same preview token should fail with 409 (Stale Proposal)
      const staleCommitRes = await request(app)
        .post(`/api/v1/appointments/${apt1Id}/services/commit`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          previewToken,
          services: [
            { serviceId: serviceHaircut._id.toString() },
            { serviceId: serviceColor._id.toString() },
          ],
        });
      expect(staleCommitRes.status).toBe(409);
      expect(staleCommitRes.body.message).toContain("stale");
    });

    it("rejects forceEarlyStart if user lacks appointments.force_early_start permission", async () => {
      // Create a staff-level role with appointments.update_status only
      const staffPerms = await Permission.find({
        name: { $in: ["appointments.view", "appointments.update_status"] },
      });
      const staffRole = await Role.create({
        name: "staff_member",
        permissions: staffPerms.map((p) => p._id),
      });
      const staffUser = await User.create({
        name: "Regular Staff",
        email: `staff_${Date.now()}@salon.com`,
        phone: "+919876500000",
        password: "Password@123",
        role: staffRole._id,
        organizationId: orgId,
        status: "active",
        hasOrgWideAccess: false,
        branchAccess: [{ branchId: branchAId, branchName: "Branch Downtown", isActive: true }],
      });
      const staffToken = jwt.sign({ id: staffUser._id, role: "staff_member" }, env.JWT_SECRET, { expiresIn: "1h" });

      // Create future appointment
      const futureAptRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          staffId: staffA._id.toString(),
          services: [{ serviceId: serviceHaircut._id.toString() }],
          appointmentDate: getFutureDateStr(35),
          startTime: "14:00",
          bookingType: "advance",
        });
      expect(futureAptRes.status).toBe(201);
      const futureAptId = futureAptRes.body.data.id;

      // Staff user attempts forceEarlyStart -> should be rejected with 403 Forbidden
      const unauthorizedRes = await request(app)
        .patch(`/api/v1/appointments/${futureAptId}/status`)
        .set("Authorization", `Bearer ${staffToken}`)
        .send({ branchId: branchAId.toString(), status: "in_progress", forceEarlyStart: true });

      expect(unauthorizedRes.status).toBe(403);
      expect(unauthorizedRes.body.message).toMatch(/permission/i);

      // Owner (has appointments.force_early_start) -> succeeds
      const authorizedRes = await request(app)
        .patch(`/api/v1/appointments/${futureAptId}/status`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchAId.toString(), status: "in_progress", forceEarlyStart: true });

      expect(authorizedRes.status).toBe(200);
      expect(authorizedRes.body.data.status).toBe("in_progress");
    });

    it("detects conflict when cascading reschedule extends beyond branch closing hours", async () => {
      // Set branch operating hours: 09:00 - 12:00 on Friday
      await Branch.findByIdAndUpdate(branchAId, {
        operatingHours: {
          friday: { openTime: "09:00", closeTime: "12:00", isOpen: true },
        },
      });

      const targetDate = getFutureDayOfWeekStr("friday", 4);

      const apt1Res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          staffId: staffA._id.toString(),
          services: [{ serviceId: serviceHaircut._id.toString() }],
          appointmentDate: targetDate,
          startTime: "10:00",
          bookingType: "advance",
        });
      const apt1Id = apt1Res.body.data.id;

      // Followed by apt2: 10:45 - 11:45 (60 min)
      await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          staffId: staffA._id.toString(),
          services: [{ serviceId: serviceColor._id.toString() }],
          appointmentDate: targetDate,
          startTime: "10:45",
          bookingType: "advance",
        });

      // Put apt1 in progress
      await request(app)
        .patch(`/api/v1/appointments/${apt1Id}/status`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchAId.toString(), status: "in_progress", forceEarlyStart: true });

      // Add a 60 min service to apt1 -> apt1 will now end around 11:45
      // Shifting apt2 (60 min) will push apt2 to end at ~12:45, exceeding 12:00 closing time!
      const previewRes = await request(app)
        .post(`/api/v1/appointments/${apt1Id}/services/preview`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          services: [
            { serviceId: serviceHaircut._id.toString() },
            { serviceId: serviceColor._id.toString() },
          ],
        });

      expect(previewRes.status).toBe(200);
      expect(previewRes.body.data.canCommit).toBe(false);
      expect(previewRes.body.data.conflicts.length).toBeGreaterThanOrEqual(1);
      expect(previewRes.body.data.conflicts[0].reason).toContain("exceeds branch closing time");
    });

    it("factors branch bufferMinutes into cascading reschedule slots", async () => {
      // Configure 15 minutes turnaround buffer on Branch
      await Branch.findByIdAndUpdate(branchAId, {
        bufferMinutes: 15,
        operatingHours: null,
      });

      const targetDate = getFutureDateStr(30);

      const apt1Res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          staffId: staffA._id.toString(),
          services: [{ serviceId: serviceHaircut._id.toString() }], // 30 min + 15 min buffer = 45 min
          appointmentDate: targetDate,
          startTime: "10:00",
          bookingType: "advance",
        });
      const apt1Id = apt1Res.body.data.id;

      const apt2Res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          staffId: staffA._id.toString(),
          services: [{ serviceId: serviceHaircut._id.toString() }],
          appointmentDate: targetDate,
          startTime: "11:00",
          bookingType: "advance",
        });
      const apt2Id = apt2Res.body.data.id;

      // Start apt1
      await request(app)
        .patch(`/api/v1/appointments/${apt1Id}/status`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchAId.toString(), status: "in_progress", forceEarlyStart: true });

      // Extend apt1 with 60 min service (ends at 11:30)
      // With 15 min buffer, apt2 should be cascaded to start at 11:45
      const previewRes = await request(app)
        .post(`/api/v1/appointments/${apt1Id}/services/preview`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          services: [
            { serviceId: serviceHaircut._id.toString() },
            { serviceId: serviceColor._id.toString() },
          ],
        });

      expect(previewRes.status).toBe(200);
      expect(previewRes.body.data.canCommit).toBe(true);
      expect(previewRes.body.data.affectedAppointments[0].id).toBe(apt2Id);
      // Initiating ends at 11:30, buffer 15 min -> 11:45
      expect(previewRes.body.data.affectedAppointments[0].proposedStartTime).toBe("11:45");
    });

    it("rejects commit when modified payload does not match preview token", async () => {
      const targetDate = getFutureDateStr(30);
      const aptRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          staffId: staffA._id.toString(),
          services: [{ serviceId: serviceHaircut._id.toString() }],
          appointmentDate: targetDate,
          startTime: "10:00",
          bookingType: "advance",
        });
      const aptId = aptRes.body.data.id;

      await request(app)
        .patch(`/api/v1/appointments/${aptId}/status`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchAId.toString(), status: "in_progress", forceEarlyStart: true });

      // Preview with custom price 1000
      const previewRes = await request(app)
        .post(`/api/v1/appointments/${aptId}/services/preview`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          services: [{ serviceId: serviceHaircut._id.toString(), customPrice: 1000 }],
        });
      const previewToken = previewRes.body.data.previewToken;

      // Attempt to commit with tampered custom price 500
      const tamperedCommitRes = await request(app)
        .post(`/api/v1/appointments/${aptId}/services/commit`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          previewToken,
          services: [{ serviceId: serviceHaircut._id.toString(), customPrice: 500 }],
        });

      expect(tamperedCommitRes.status).toBe(409);
      expect(tamperedCommitRes.body.message).toContain("stale");
    });

    it("rejects commit when discount is altered after preview", async () => {
      const targetDate = getFutureDateStr(31);
      const aptRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          staffId: staffA._id.toString(),
          services: [{ serviceId: serviceHaircut._id.toString() }],
          appointmentDate: targetDate,
          startTime: "10:00",
          bookingType: "advance",
        });
      const aptId = aptRes.body.data.id;

      await request(app)
        .patch(`/api/v1/appointments/${aptId}/status`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchAId.toString(), status: "in_progress", forceEarlyStart: true });

      // Preview with discount 50
      const previewRes = await request(app)
        .post(`/api/v1/appointments/${aptId}/services/preview`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          services: [{ serviceId: serviceHaircut._id.toString() }],
          discount: 50,
        });
      const previewToken = previewRes.body.data.previewToken;

      // Commit with modified discount 100
      const commitRes = await request(app)
        .post(`/api/v1/appointments/${aptId}/services/commit`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          previewToken,
          services: [{ serviceId: serviceHaircut._id.toString() }],
          discount: 100,
        });

      expect(commitRes.status).toBe(409);
      expect(commitRes.body.message).toContain("stale");
    });

    it("detects conflict when initiating appointment itself overflows branch closing hours", async () => {
      // Branch with Sunday closing at 19:00
      const branchSunday = await Branch.create({
        organizationId: orgId,
        name: "Branch Sunday Closing",
        operatingHours: {
          sunday: { openTime: "09:00", closeTime: "19:00", isOpen: true },
        },
      });

      const targetDate = getFutureDayOfWeekStr("sunday", 4);
      const aptRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchSunday._id.toString(),
          customerId: customer._id.toString(),
          staffId: staffA._id.toString(),
          services: [{ serviceId: serviceHaircut._id.toString() }], // 30 min (18:30 - 19:00)
          appointmentDate: targetDate,
          startTime: "18:30",
          bookingType: "advance",
        });
      const aptId = aptRes.body.data.id;

      // Propose adding color (60 min) -> new end 19:30 (exceeds 19:00 close)
      const previewRes = await request(app)
        .post(`/api/v1/appointments/${aptId}/services/preview`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchSunday._id.toString(),
          services: [
            { serviceId: serviceHaircut._id.toString() },
            { serviceId: serviceColor._id.toString() },
          ],
        });

      expect(previewRes.status).toBe(200);
      expect(previewRes.body.data.canCommit).toBe(false);
      expect(previewRes.body.data.conflicts.length).toBeGreaterThan(0);
      expect(previewRes.body.data.conflicts[0].appointmentId).toBe(aptId);
      expect(previewRes.body.data.conflicts[0].reason).toContain("exceeds branch closing time of 19:00");
    });

    it("permits extension that exactly finishes at branch closing time (valid boundary case)", async () => {
      const branchBoundary = await Branch.create({
        organizationId: orgId,
        name: "Branch Boundary Close",
        operatingHours: {
          sunday: { openTime: "09:00", closeTime: "19:00", isOpen: true },
        },
      });

      const targetDate = getFutureDayOfWeekStr("sunday", 4);
      const aptRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchBoundary._id.toString(),
          customerId: customer._id.toString(),
          staffId: staffA._id.toString(),
          services: [{ serviceId: serviceHaircut._id.toString() }], // 30 min (18:00 - 18:30)
          appointmentDate: targetDate,
          startTime: "18:00",
          bookingType: "advance",
        });
      const aptId = aptRes.body.data.id;

      // Propose adding another haircut (30 min) -> finishes exactly at 19:00
      const previewRes = await request(app)
        .post(`/api/v1/appointments/${aptId}/services/preview`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchBoundary._id.toString(),
          services: [
            { serviceId: serviceHaircut._id.toString() },
            { serviceId: serviceHaircut._id.toString() },
          ],
        });

      expect(previewRes.status).toBe(200);
      expect(previewRes.body.data.canCommit).toBe(true);
      expect(previewRes.body.data.conflicts).toHaveLength(0);
      expect(previewRes.body.data.initiatingAppointment.proposedEndTime).toBe("19:00");
    });

    it("rejects commit when branch scope is tampered / mismatched", async () => {
      const targetDate = getFutureDateStr(33);
      const aptRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          staffId: staffA._id.toString(),
          services: [{ serviceId: serviceHaircut._id.toString() }],
          appointmentDate: targetDate,
          startTime: "10:00",
          bookingType: "advance",
        });
      const aptId = aptRes.body.data.id;

      await request(app)
        .patch(`/api/v1/appointments/${aptId}/status`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchAId.toString(), status: "in_progress", forceEarlyStart: true });

      const previewRes = await request(app)
        .post(`/api/v1/appointments/${aptId}/services/preview`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          services: [{ serviceId: serviceHaircut._id.toString() }],
        });
      const previewToken = previewRes.body.data.previewToken;

      // Commit with different branchId (branchBId)
      const commitRes = await request(app)
        .post(`/api/v1/appointments/${aptId}/services/commit`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchBId.toString(),
          previewToken,
          services: [{ serviceId: serviceHaircut._id.toString() }],
        });

      expect(commitRes.status).toBe(400);
      expect(commitRes.body.message).toContain("Target branchId does not match appointment branch");
    });

    it("rejects commit when initiating appointment version changes concurrently after preview", async () => {
      const targetDate = getFutureDateStr(34);
      const aptRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          staffId: staffA._id.toString(),
          services: [{ serviceId: serviceHaircut._id.toString() }],
          appointmentDate: targetDate,
          startTime: "10:00",
          bookingType: "advance",
        });
      const aptId = aptRes.body.data.id;

      await request(app)
        .patch(`/api/v1/appointments/${aptId}/status`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchAId.toString(), status: "in_progress", forceEarlyStart: true });

      const previewRes = await request(app)
        .post(`/api/v1/appointments/${aptId}/services/preview`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          services: [
            { serviceId: serviceHaircut._id.toString() },
            { serviceId: serviceColor._id.toString() },
          ],
        });
      const previewToken = previewRes.body.data.previewToken;

      // Concurrently update initiating appointment version in database
      await Appointment.findByIdAndUpdate(aptId, { $inc: { version: 1 } });

      // Commit with the original preview token
      const commitRes = await request(app)
        .post(`/api/v1/appointments/${aptId}/services/commit`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          previewToken,
          services: [
            { serviceId: serviceHaircut._id.toString() },
            { serviceId: serviceColor._id.toString() },
          ],
        });

      expect(commitRes.status).toBe(409);
      expect(commitRes.body.message).toContain("stale");
    });

    it("rejects commit when an affected appointment version changes concurrently after preview", async () => {
      const targetDate = getFutureDateStr(35);
      const apt1Res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          staffId: staffA._id.toString(),
          services: [{ serviceId: serviceHaircut._id.toString() }],
          appointmentDate: targetDate,
          startTime: "10:00",
          bookingType: "advance",
        });
      const apt1Id = apt1Res.body.data.id;

      const apt2Res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          customerId: customer._id.toString(),
          staffId: staffA._id.toString(),
          services: [{ serviceId: serviceHaircut._id.toString() }],
          appointmentDate: targetDate,
          startTime: "10:30",
          bookingType: "advance",
        });
      const apt2Id = apt2Res.body.data.id;

      await request(app)
        .patch(`/api/v1/appointments/${apt1Id}/status`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchAId.toString(), status: "in_progress", forceEarlyStart: true });

      // Preview adding color (60 min) to apt1 -> will cascade apt2
      const previewRes = await request(app)
        .post(`/api/v1/appointments/${apt1Id}/services/preview`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          services: [
            { serviceId: serviceHaircut._id.toString() },
            { serviceId: serviceColor._id.toString() },
          ],
        });
      expect(previewRes.status).toBe(200);
      expect(previewRes.body.data.affectedAppointments).toHaveLength(1);
      const previewToken = previewRes.body.data.previewToken;

      // Concurrently update affected appointment apt2 version
      await Appointment.findByIdAndUpdate(apt2Id, { $inc: { version: 1 } });

      // Commit should detect that recomputed preview token does not match previewToken (or version mismatch)
      const commitRes = await request(app)
        .post(`/api/v1/appointments/${apt1Id}/services/commit`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchAId.toString(),
          previewToken,
          services: [
            { serviceId: serviceHaircut._id.toString() },
            { serviceId: serviceColor._id.toString() },
          ],
        });

      expect(commitRes.status).toBe(409);
      expect(commitRes.body.message).toContain("stale");
    }, 60000);
  });
});


