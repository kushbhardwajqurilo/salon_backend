import { describe, expect, it, beforeEach, afterEach, beforeAll, afterAll, jest } from "@jest/globals";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app.mjs";
import { Organization } from "../../models/organizations/organization.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Customer } from "../../models/customers/customer.model.js";
import { Staff } from "../../models/staff/staff.model.js";
import { Service } from "../../models/services/service.model.js";
import { ServiceCategory } from "../../models/services/serviceCategory.model.js";
import { Role } from "../../models/roles/role.model.js";
import { Permission } from "../../models/permissions/permission.model.js";
import { User } from "../../models/users/user.model.js";
import { Appointment } from "../../models/appointments/appointment.model.js";
import { Subscription } from "../../models/subscriptions/subscription.model.js";
import { Invoice } from "../../models/billing/invoice.model.js";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";
import { redis } from "../../utils/redis.js";

jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");


const getFutureDateStr = (daysAhead = 30) => {
  const d = new Date(Date.now() + daysAhead * 86400000);
  return d.toISOString().split("T")[0];
};

describe("Appointment Custom Services & Agreed Pricing Suite", () => {
  jest.setTimeout(45000);
  let dbConnection;
  let orgId, branchId;
  let ownerToken;
  let customer;
  let staff;
  let serviceHaircut, serviceColor;

  beforeAll(async () => {
    let testUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/saloon_erp_test";
    if (testUri.includes("?")) {
      const parts = testUri.split("?");
      testUri = parts[0].replace(/\/([^\/]+)$/, "/saloon_erp_custom_services_test") + "?" + parts[1];
    } else {
      testUri = testUri.replace(/\/([^\/]+)$/, "/saloon_erp_custom_services_test");
    }
    dbConnection = await mongoose.connect(testUri);
    await Appointment.syncIndexes();
  });

  afterAll(async () => {
    await Invoice.deleteMany({});
    await Appointment.deleteMany({});
    await Subscription.deleteMany({});
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
    await Invoice.deleteMany({});
    await Appointment.deleteMany({});
    await Subscription.deleteMany({});
    await Service.deleteMany({});
    await ServiceCategory.deleteMany({});
    await Staff.deleteMany({});
    await Customer.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Permission.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});

    const org = await Organization.create({
      name: "Custom Svc Test Org",
      slug: "custom-svc-test-org",
      email: "org@test.com",
    });
    orgId = org._id;

    const branch = await Branch.create({
      organizationId: orgId,
      name: "Main Branch",
      timezone: "Asia/Kolkata",
      bufferMinutes: 0,
      operatingHours: {
        monday: { isOpen: true, openTime: "08:00", closeTime: "22:00" },
        tuesday: { isOpen: true, openTime: "08:00", closeTime: "22:00" },
        wednesday: { isOpen: true, openTime: "08:00", closeTime: "22:00" },
        thursday: { isOpen: true, openTime: "08:00", closeTime: "22:00" },
        friday: { isOpen: true, openTime: "08:00", closeTime: "22:00" },
        saturday: { isOpen: true, openTime: "08:00", closeTime: "22:00" },
        sunday: { isOpen: true, openTime: "08:00", closeTime: "22:00" },
      },
      isActive: true,
    });
    branchId = branch._id;

    const category = await ServiceCategory.create({
      organizationId: orgId,
      name: "General",
      gender: "unisex",
    });

    serviceHaircut = await Service.create({
      organizationId: orgId,
      categoryId: category._id,
      name: "Regular Haircut",
      duration: 30,
      pricing: { basePrice: 500 },
      status: "active",
    });

    serviceColor = await Service.create({
      organizationId: orgId,
      categoryId: category._id,
      name: "Hair Coloring",
      duration: 45,
      pricing: { basePrice: 1500 },
      status: "active",
    });

    customer = await Customer.create({
      organizationId: orgId,
      homeBranchId: branchId,
      name: "Alice Custom",
      phone: "+919876543210",
      email: "alice@test.com",
      status: "active",
    });

    staff = await Staff.create({
      organizationId: orgId,
      branchId: branchId,
      name: "Bob Stylist",
      phone: "+919876543211",
      email: "bob@test.com",
      status: "active",
      designation: "Stylist",
      staffCode: `STF-${Date.now()}`,
      joiningDate: new Date(),
    });

    const permNames = [
      "appointments.view",
      "appointments.create",
      "appointments.update",
      "appointments.delete",
      "appointments.edit",
      "billing.view",
      "billing.checkout",
      "services.view",
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

    const user = await User.create({
      name: "Owner User",
      email: `owner_${Date.now()}@test.com`,
      phone: "+919999999999",
      password: "Password@123",
      role: ownerRole._id,
      organizationId: orgId,
      status: "active",
      hasOrgWideAccess: true,
      branchAccess: [
        { branchId, branchName: "Main Branch", isActive: true },
      ],
    });

    ownerToken = jwt.sign(
      { id: user._id.toString(), role: "owner" },
      env.JWT_SECRET || "default_jwt_secret_for_tests",
      { expiresIn: "1d" }
    );
  });

  describe("1. Appointment Creation: Registered, Custom and Mixed Lines", () => {
    it("successfully creates appointment with legacy serviceIds array", async () => {
      const res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          customerId: customer._id.toString(),
          staffId: staff._id.toString(),
          serviceIds: [serviceHaircut._id.toString()],
          appointmentDate: getFutureDateStr(30),
          startTime: "10:00",
          bookingType: "advance",
        });

      expect(res.status).toBe(201);
      expect(res.body.data.services).toHaveLength(1);
      expect(res.body.data.services[0].serviceType).toBe("registered");
      expect(res.body.data.services[0].serviceId.toString()).toBe(serviceHaircut._id.toString());
      expect(res.body.data.services[0].price).toBe(500);
      expect(res.body.data.totalDuration).toBe(30);
    });

    it("successfully creates appointment with registered service and agreed custom price", async () => {
      const res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          customerId: customer._id.toString(),
          staffId: staff._id.toString(),
          services: [
            {
              serviceType: "registered",
              serviceId: serviceHaircut._id.toString(),
              customPrice: 420,
            },
          ],
          appointmentDate: getFutureDateStr(30),
          startTime: "11:00",
          bookingType: "advance",
        });

      expect(res.status).toBe(201);
      expect(res.body.data.services[0].price).toBe(420);
      expect(res.body.data.pricing.subtotal).toBe(420);
      expect(res.body.data.pricing.total).toBe(420);
    });

    it("successfully creates custom-only appointment without catalog record", async () => {
      const res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          customerId: customer._id.toString(),
          staffId: staff._id.toString(),
          services: [
            {
              serviceType: "custom",
              name: "Special Bridal Touch-up",
              duration: 40,
              price: 1200,
            },
          ],
          appointmentDate: getFutureDateStr(30),
          startTime: "12:00",
          bookingType: "advance",
        });

      expect(res.status).toBe(201);
      expect(res.body.data.services).toHaveLength(1);
      const svc = res.body.data.services[0];
      expect(svc.serviceType).toBe("custom");
      expect(svc.serviceId).toBeNull();
      expect(svc.name).toBe("Special Bridal Touch-up");
      expect(svc.duration).toBe(40);
      expect(svc.price).toBe(1200);
      expect(res.body.data.totalDuration).toBe(40);
      expect(res.body.data.pricing.subtotal).toBe(1200);

      // Verify no catalog service was created in Service collection
      const catalogCount = await Service.countDocuments({ name: "Special Bridal Touch-up" });
      expect(catalogCount).toBe(0);
    });

    it("successfully creates mixed appointment with registered and custom services", async () => {
      const res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          customerId: customer._id.toString(),
          staffId: staff._id.toString(),
          services: [
            {
              serviceType: "registered",
              serviceId: serviceHaircut._id.toString(),
              customPrice: 450,
            },
            {
              serviceType: "custom",
              name: "Scalp Massage & Acupressure",
              duration: 20,
              price: 350,
            },
          ],
          appointmentDate: getFutureDateStr(30),
          startTime: "14:00",
          bookingType: "advance",
        });

      expect(res.status).toBe(201);
      expect(res.body.data.services).toHaveLength(2);
      expect(res.body.data.totalDuration).toBe(50); // 30 + 20
      expect(res.body.data.pricing.subtotal).toBe(800); // 450 + 350
    });

    it("rejects custom service with subscription assignment", async () => {
      const res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          customerId: customer._id.toString(),
          staffId: staff._id.toString(),
          services: [
            {
              serviceType: "custom",
              name: "Exploit Custom Hair",
              duration: 30,
              price: 500,
              appliedSubscriptionId: new mongoose.Types.ObjectId().toString(),
            },
          ],
          appointmentDate: getFutureDateStr(30),
          startTime: "15:00",
          bookingType: "advance",
        });

      expect(res.status).toBe(400);
    });

    it("rejects custom service with invalid duration or price", async () => {
      const resNegativePrice = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          customerId: customer._id.toString(),
          services: [
            {
              serviceType: "custom",
              name: "Negative Price",
              duration: 30,
              price: -50,
            },
          ],
          appointmentDate: getFutureDateStr(30),
          startTime: "15:00",
          bookingType: "advance",
        });
      expect(resNegativePrice.status).toBe(400);

      const resZeroDuration = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          customerId: customer._id.toString(),
          services: [
            {
              serviceType: "custom",
              name: "Zero Duration",
              duration: 0,
              price: 100,
            },
          ],
          appointmentDate: getFutureDateStr(30),
          startTime: "15:00",
          bookingType: "advance",
        });
      expect(resZeroDuration.status).toBe(400);

      const resEmptyName = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          customerId: customer._id.toString(),
          services: [
            {
              serviceType: "custom",
              name: "   ",
              duration: 30,
              price: 100,
            },
          ],
          appointmentDate: getFutureDateStr(30),
          startTime: "15:00",
          bookingType: "advance",
        });
      expect(resEmptyName.status).toBe(400);
    });

    it("successfully creates custom-only appointment when client sends serviceIds: []", async () => {
      const res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          customerId: customer._id.toString(),
          staffId: staff._id.toString(),
          serviceIds: [],
          services: [
            {
              serviceType: "custom",
              name: "Only Custom With Empty ServiceIds",
              duration: 25,
              price: 550,
            },
          ],
          appointmentDate: getFutureDateStr(30),
          startTime: "16:00",
          bookingType: "advance",
        });

      expect(res.status).toBe(201);
      expect(res.body.data.services).toHaveLength(1);
      expect(res.body.data.services[0].serviceType).toBe("custom");
      expect(res.body.data.services[0].serviceId).toBeNull();
      expect(res.body.data.services[0].name).toBe("Only Custom With Empty ServiceIds");
      expect(res.body.data.services[0].price).toBe(550);
      expect(res.body.data.totalDuration).toBe(25);
    });

    it("successfully creates custom-only appointment when client sends serviceIds: null", async () => {
      const res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          customerId: customer._id.toString(),
          staffId: staff._id.toString(),
          serviceIds: null,
          services: [
            {
              serviceType: "custom",
              name: "Only Custom With Null ServiceIds",
              duration: 15,
              price: 300,
            },
          ],
          appointmentDate: getFutureDateStr(30),
          startTime: "16:30",
          bookingType: "advance",
        });

      expect(res.status).toBe(201);
      expect(res.body.data.services).toHaveLength(1);
      expect(res.body.data.services[0].serviceType).toBe("custom");
      expect(res.body.data.services[0].serviceId).toBeNull();
      expect(res.body.data.services[0].price).toBe(300);
    });

    it("successfully preserves custom price 0", async () => {
      const res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          customerId: customer._id.toString(),
          staffId: staff._id.toString(),
          serviceIds: [],
          services: [
            {
              serviceType: "custom",
              name: "Complimentary Consultation",
              duration: 15,
              price: 0,
            },
          ],
          appointmentDate: getFutureDateStr(30),
          startTime: "17:00",
          bookingType: "advance",
        });

      expect(res.status).toBe(201);
      expect(res.body.data.services).toHaveLength(1);
      expect(res.body.data.services[0].price).toBe(0);
      expect(res.body.data.pricing.subtotal).toBe(0);
      expect(res.body.data.pricing.total).toBe(0);
    });

    it("rejects appointment when both services and serviceIds are empty or missing", async () => {
      const resBothEmpty = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          customerId: customer._id.toString(),
          serviceIds: [],
          services: [],
          appointmentDate: getFutureDateStr(30),
          startTime: "17:30",
          bookingType: "advance",
        });
      expect(resBothEmpty.status).toBe(400);

      const resNeither = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          customerId: customer._id.toString(),
          appointmentDate: getFutureDateStr(30),
          startTime: "17:30",
          bookingType: "advance",
        });
      expect(resNeither.status).toBe(400);
    });

    it("rejects appointment with invalid registered service IDs", async () => {
      const nonExistentId = new mongoose.Types.ObjectId().toString();
      const res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          customerId: customer._id.toString(),
          serviceIds: [nonExistentId],
          appointmentDate: getFutureDateStr(30),
          startTime: "18:00",
          bookingType: "advance",
        });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/invalid, inactive, or belong to a different organization/i);
    });
  });

  describe("2. Updating Appointments: Editing, Preserving and Removing Custom Lines", () => {
    it("preserves custom line agreed price and subdocument identity on update", async () => {
      const createRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          customerId: customer._id.toString(),
          staffId: staff._id.toString(),
          services: [
            {
              serviceType: "custom",
              name: "Initial Custom",
              duration: 25,
              price: 600,
            },
          ],
          appointmentDate: getFutureDateStr(30),
          startTime: "16:00",
          bookingType: "advance",
        });

      const aptId = createRes.body.data.id;
      const customLineId = createRes.body.data.services[0]._id;

      // Update with new custom line name but referencing line _id and omitting price
      const updateRes = await request(app)
        .put(`/api/v1/appointments/${aptId}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          services: [
            {
              _id: customLineId,
              serviceType: "custom",
              name: "Updated Custom Name",
              duration: 35,
            },
          ],
        });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.data.services[0].name).toBe("Updated Custom Name");
      expect(updateRes.body.data.services[0].duration).toBe(35);
      expect(updateRes.body.data.services[0].price).toBe(600); // Preserved!
      expect(updateRes.body.data.totalDuration).toBe(35);
      expect(updateRes.body.data.pricing.subtotal).toBe(600);
    });

    it("allows metadata-only update (e.g. notes) when services and serviceIds are omitted", async () => {
      const createRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          customerId: customer._id.toString(),
          staffId: staff._id.toString(),
          serviceIds: [serviceHaircut._id.toString()],
          appointmentDate: getFutureDateStr(30),
          startTime: "12:00",
          bookingType: "advance",
        });

      const aptId = createRes.body.data.id;

      const updateRes = await request(app)
        .put(`/api/v1/appointments/${aptId}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          notes: "Customer requested a quiet appointment",
        });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.data.notes).toBe("Customer requested a quiet appointment");
      expect(updateRes.body.data.services).toHaveLength(1);
    });

    it("rejects update when services is explicitly an empty array", async () => {
      const createRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          customerId: customer._id.toString(),
          staffId: staff._id.toString(),
          serviceIds: [serviceHaircut._id.toString()],
          appointmentDate: getFutureDateStr(30),
          startTime: "12:30",
          bookingType: "advance",
        });

      const aptId = createRes.body.data.id;

      const updateEmptyRes = await request(app)
        .put(`/api/v1/appointments/${aptId}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          services: [],
        });

      expect(updateEmptyRes.status).toBe(400);
    });

    it("rejects update when serviceIds is explicitly an empty array and services is omitted", async () => {
      const createRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          customerId: customer._id.toString(),
          staffId: staff._id.toString(),
          serviceIds: [serviceHaircut._id.toString()],
          appointmentDate: getFutureDateStr(30),
          startTime: "13:00",
          bookingType: "advance",
        });

      const aptId = createRes.body.data.id;

      const updateEmptyRes = await request(app)
        .put(`/api/v1/appointments/${aptId}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          serviceIds: [],
        });

      expect(updateEmptyRes.status).toBe(400);
    });

    it("gives precedence to services over serviceIds without merging when both are provided", async () => {
      const createRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          customerId: customer._id.toString(),
          staffId: staff._id.toString(),
          // serviceIds has serviceColor, but services has custom service
          serviceIds: [serviceColor._id.toString()],
          services: [
            {
              serviceType: "custom",
              name: "Precedence Custom Service",
              duration: 20,
              price: 300,
            },
          ],
          appointmentDate: getFutureDateStr(30),
          startTime: "13:30",
          bookingType: "advance",
        });

      expect(createRes.status).toBe(201);
      // Precedence: services was chosen, not merged with serviceIds
      expect(createRes.body.data.services).toHaveLength(1);
      expect(createRes.body.data.services[0].name).toBe("Precedence Custom Service");
      expect(createRes.body.data.totalDuration).toBe(20);
    });
  });

  describe("3. Preview and Commit Workflow with Custom Services", () => {
    it("handles preview and commit with custom service causing cascade shift", async () => {
      // 1. Create downstream booking
      const apt2Res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          customerId: customer._id.toString(),
          staffId: staff._id.toString(),
          serviceIds: [serviceHaircut._id.toString()], // 30 min
          appointmentDate: getFutureDateStr(30),
          startTime: "10:30",
          bookingType: "advance",
        });
      expect(apt2Res.status).toBe(201);
      const apt2Id = apt2Res.body.data.id;

      // 2. Create upstream booking
      const apt1Res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          customerId: customer._id.toString(),
          staffId: staff._id.toString(),
          serviceIds: [serviceHaircut._id.toString()], // 10:00 - 10:30
          appointmentDate: getFutureDateStr(30),
          startTime: "10:00",
          bookingType: "advance",
        });
      expect(apt1Res.status).toBe(201);
      const apt1Id = apt1Res.body.data.id;

      // 3. Preview adding custom service (30 min) to apt1 -> will extend apt1 to 11:00 and shift apt2 to 11:00
      const previewRes = await request(app)
        .post(`/api/v1/appointments/${apt1Id}/services/preview`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          services: [
            { serviceType: "registered", serviceId: serviceHaircut._id.toString() },
            {
              serviceType: "custom",
              name: "Special Styling",
              duration: 30,
              price: 700,
            },
          ],
        });

      expect(previewRes.status).toBe(200);
      expect(previewRes.body.data.canCommit).toBe(true);
      expect(previewRes.body.data.affectedAppointments).toHaveLength(1);
      expect(previewRes.body.data.affectedAppointments[0].id).toBe(apt2Id);
      expect(previewRes.body.data.affectedAppointments[0].proposedStartTime).toBe("11:00");
      const previewToken = previewRes.body.data.previewToken;

      // 4. Commit modification with valid token
      const commitRes = await request(app)
        .post(`/api/v1/appointments/${apt1Id}/services/commit`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          previewToken,
          services: [
            { serviceType: "registered", serviceId: serviceHaircut._id.toString() },
            {
              serviceType: "custom",
              name: "Special Styling",
              duration: 30,
              price: 700,
            },
          ],
        });

      expect(commitRes.status).toBe(200);
      expect(commitRes.body.data.initiatingAppointment.totalDuration).toBe(60);

      // Verify apt2 was shifted in DB
      const updatedApt2 = await Appointment.findById(apt2Id);
      expect(updatedApt2.startTime).toBe("11:00");
      expect(updatedApt2.endTime).toBe("11:30");
    });

    it("rejects commit when custom service price is tampered without re-preview", async () => {
      const aptRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          customerId: customer._id.toString(),
          staffId: staff._id.toString(),
          serviceIds: [serviceHaircut._id.toString()],
          appointmentDate: getFutureDateStr(30),
          startTime: "17:00",
          bookingType: "advance",
        });
      const aptId = aptRes.body.data.id;

      const previewRes = await request(app)
        .post(`/api/v1/appointments/${aptId}/services/preview`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          services: [
            {
              serviceType: "custom",
              name: "Tamper Test",
              duration: 30,
              price: 500,
            },
          ],
        });
      const previewToken = previewRes.body.data.previewToken;

      // Attempt to commit with tampered price 100 instead of 500
      const commitRes = await request(app)
        .post(`/api/v1/appointments/${aptId}/services/commit`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          previewToken,
          services: [
            {
              serviceType: "custom",
              name: "Tamper Test",
              duration: 30,
              price: 100,
            },
          ],
        });

      expect(commitRes.status).toBe(409);
      expect(commitRes.body.message).toContain("stale");
    });

    it("rejects replayed commit token (cannot commit twice with same token)", async () => {
      const futureDate = new Date(Date.now() + 5 * 86400000).toISOString().split("T")[0];
      const aptRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          customerId: customer._id.toString(),
          staffId: staff._id.toString(),
          services: [{ serviceType: "custom", name: "Replay Test Custom", duration: 30, price: 300 }],
          appointmentDate: futureDate,
          startTime: "10:00",
          bookingType: "advance",
        });

      const aptId = aptRes.body.data.id;
      const previewRes = await request(app)
        .post(`/api/v1/appointments/${aptId}/services/preview`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          services: [
            { serviceType: "custom", name: "Replay Test Custom", duration: 30, price: 300 },
            { serviceType: "custom", name: "Added Line", duration: 15, price: 150 },
          ],
        });

      const token = previewRes.body.data.previewToken;
      const commitPayload = {
        branchId: branchId.toString(),
        previewToken: token,
        services: [
          { serviceType: "custom", name: "Replay Test Custom", duration: 30, price: 300 },
          { serviceType: "custom", name: "Added Line", duration: 15, price: 150 },
        ],
      };

      // First commit succeeds
      const commit1 = await request(app)
        .post(`/api/v1/appointments/${aptId}/services/commit`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send(commitPayload);
      expect(commit1.status).toBe(200);

      // Replay of same token fails with 409
      const commit2 = await request(app)
        .post(`/api/v1/appointments/${aptId}/services/commit`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send(commitPayload);
      expect(commit2.status).toBe(409);
      expect(commit2.body.message).toContain("stale");
    });

    it("rejects tampered or forged preview token string", async () => {
      const futureDate = new Date(Date.now() + 5 * 86400000).toISOString().split("T")[0];
      const aptRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          customerId: customer._id.toString(),
          staffId: staff._id.toString(),
          services: [{ serviceType: "custom", name: "Forgery Test", duration: 30, price: 300 }],
          appointmentDate: futureDate,
          startTime: "11:00",
          bookingType: "advance",
        });

      const aptId = aptRes.body.data.id;
      const fakeToken = "a".repeat(64); // Invalid HMAC digest
      const commitRes = await request(app)
        .post(`/api/v1/appointments/${aptId}/services/commit`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          previewToken: fakeToken,
          services: [{ serviceType: "custom", name: "Forgery Test", duration: 30, price: 300 }],
        });

      expect(commitRes.status).toBe(409);
      expect(commitRes.body.message).toContain("stale");
    });

    it("handles concurrent commit requests: exactly one succeeds and concurrent attempt receives 409", async () => {
      const futureDate = new Date(Date.now() + 6 * 86400000).toISOString().split("T")[0];
      const aptRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          customerId: customer._id.toString(),
          staffId: staff._id.toString(),
          services: [{ serviceType: "custom", name: "Concurrency Custom", duration: 30, price: 300 }],
          appointmentDate: futureDate,
          startTime: "12:00",
          bookingType: "advance",
        });

      const aptId = aptRes.body.data.id;
      const previewRes = await request(app)
        .post(`/api/v1/appointments/${aptId}/services/preview`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          services: [
            { serviceType: "custom", name: "Concurrency Custom", duration: 30, price: 300 },
            { serviceType: "custom", name: "Concurrent Add", duration: 20, price: 200 },
          ],
        });

      const token = previewRes.body.data.previewToken;
      const commitPayload = {
        branchId: branchId.toString(),
        previewToken: token,
        services: [
          { serviceType: "custom", name: "Concurrency Custom", duration: 30, price: 300 },
          { serviceType: "custom", name: "Concurrent Add", duration: 20, price: 200 },
        ],
      };

      // Fire two concurrent commits simultaneously
      const [res1, res2] = await Promise.all([
        request(app).post(`/api/v1/appointments/${aptId}/services/commit`).set("Authorization", `Bearer ${ownerToken}`).send(commitPayload),
        request(app).post(`/api/v1/appointments/${aptId}/services/commit`).set("Authorization", `Bearer ${ownerToken}`).send(commitPayload),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([200, 409]);
    });
  });

  describe("4. Invoicing and Billing with Custom and Mixed Services", () => {
    it("creates invoice correctly for mixed appointment preserving custom lines and unit prices", async () => {
      const aptRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchId.toString(),
          customerId: customer._id.toString(),
          staffId: staff._id.toString(),
          services: [
            {
              serviceType: "registered",
              serviceId: serviceHaircut._id.toString(),
              customPrice: 400,
            },
            {
              serviceType: "custom",
              name: "VIP Styling Service",
              duration: 30,
              price: 900,
            },
          ],
          discount: 100,
          appointmentDate: getFutureDateStr(30),
          startTime: "18:00",
          bookingType: "advance",
        });
      const apt = aptRes.body.data;

      // Generate invoice from appointment
      const invoiceRes = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          appointmentId: apt.id,
        });

      expect(invoiceRes.status).toBe(201);
      const invoice = invoiceRes.body.data;
      expect(invoice.lines).toHaveLength(2);

      const registeredLine = invoice.lines.find((l) => l.serviceType === "registered");
      const customLine = invoice.lines.find((l) => l.serviceType === "custom");

      expect(registeredLine).toBeDefined();
      expect(registeredLine.serviceId.toString()).toBe(serviceHaircut._id.toString());
      expect(registeredLine.unitPrice).toBe(400);

      expect(customLine).toBeDefined();
      expect(customLine.serviceId).toBeNull();
      expect(customLine.name).toBe("VIP Styling Service");
      expect(customLine.unitPrice).toBe(900);

      expect(invoice.subtotal).toBe(1300); // 400 + 900
      expect(invoice.discountTotal).toBe(100);
      expect(invoice.payableAmount).toBe(1200);
    });
  });
});
