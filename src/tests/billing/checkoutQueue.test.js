import dns from "dns";
import { describe, expect, it, beforeEach, afterEach, beforeAll, afterAll, jest } from "@jest/globals";
import request from "supertest";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import app from "../../../app.mjs";
import { env } from "../../../src/config/env.js";
import { redis } from "../../../src/utils/redis.js";
import "../../database/db.js";

try {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch (_) {}

import { Organization } from "../../../src/models/organizations/organization.model.js";
import { Branch } from "../../../src/models/branches/branch.model.js";
import { Customer } from "../../../src/models/customers/customer.model.js";
import { Service } from "../../../src/models/services/service.model.js";
import { ServiceCategory } from "../../../src/models/services/serviceCategory.model.js";
import { Role } from "../../../src/models/roles/role.model.js";
import { Permission } from "../../../src/models/permissions/permission.model.js";
import { User } from "../../../src/models/users/user.model.js";
import { Staff } from "../../../src/models/staff/staff.model.js";
import { Appointment } from "../../../src/models/appointments/appointment.model.js";
import { Invoice } from "../../../src/models/billing/invoice.model.js";

jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");

describe("POS Checkout Queue Endpoint (GET /api/v1/billing/checkout-queue)", () => {
  jest.setTimeout(45000);

  let orgAId, orgBId;
  let branchA1Id, branchA2Id;
  let ownerTokenA, cashierTokenA;
  let ownerUserA, cashierUserA;
  let customerA, staffA, serviceHaircut;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    let testUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/saloon_erp_test";
    if (testUri.includes("?")) {
      const parts = testUri.split("?");
      testUri = parts[0].replace(/\/([^\/]+)$/, "/saloon_erp_billing_test") + "?" + parts[1];
    } else {
      testUri = testUri.replace(/\/([^\/]+)$/, "/saloon_erp_billing_test");
    }
    await mongoose.connect(testUri);
  });

  afterAll(async () => {
    await Invoice.deleteMany({});
    await Appointment.deleteMany({});
    await Customer.deleteMany({});
    await Staff.deleteMany({});
    await Service.deleteMany({});
    await ServiceCategory.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Permission.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    // 1. Setup Organization & Branches
    const orgA = await Organization.create({ name: "Checkout Test Salon A" });
    orgAId = orgA._id;

    const bA1 = await Branch.create({ organizationId: orgAId, name: "Branch A1", isActive: true });
    branchA1Id = bA1._id;

    const bA2 = await Branch.create({ organizationId: orgAId, name: "Branch A2", isActive: true });
    branchA2Id = bA2._id;

    const orgB = await Organization.create({ name: "Checkout Test Salon B" });
    orgBId = orgB._id;

    // 2. Roles & Permissions
    const billingViewPerm = await Permission.findOneAndUpdate(
      { name: "billing.view" },
      { name: "billing.view", module: "Billing & POS", action: "View", description: "View invoices and queue" },
      { upsert: true, new: true }
    );
    const billingCheckoutPerm = await Permission.findOneAndUpdate(
      { name: "billing.checkout" },
      { name: "billing.checkout", module: "Billing & POS", action: "Checkout", description: "Checkout queue" },
      { upsert: true, new: true }
    );

    const ownerRole = await Role.create({
      name: "owner",
      organizationId: orgAId,
      permissions: [billingViewPerm._id, billingCheckoutPerm._id],
    });

    const cashierRole = await Role.create({
      name: "cashier",
      organizationId: orgAId,
      permissions: [billingViewPerm._id],
    });

    // 3. Users & Auth Tokens
    ownerUserA = await User.create({
      name: "Owner A",
      email: `owner_${Date.now()}_${Math.random()}@test.com`,
      phone: "+919999990001",
      password: "Password@123",
      role: ownerRole._id,
      organizationId: orgAId,
      status: "active",
      hasOrgWideAccess: true,
      branchAccess: [{ branchId: branchA1Id, branchName: "Branch A1", isActive: true }],
    });
    ownerTokenA = jwt.sign({ id: ownerUserA._id, role: "owner" }, env.JWT_SECRET, { expiresIn: "1h" });

    cashierUserA = await User.create({
      name: "Cashier A",
      email: `cashier_${Date.now()}_${Math.random()}@test.com`,
      phone: "+919999990002",
      password: "Password@123",
      role: cashierRole._id,
      organizationId: orgAId,
      status: "active",
      hasOrgWideAccess: false,
      branchAccess: [{ branchId: branchA1Id, branchName: "Branch A1", isActive: true }],
    });
    cashierTokenA = jwt.sign({ id: cashierUserA._id, role: "cashier" }, env.JWT_SECRET, { expiresIn: "1h" });

    // 4. Customer & Staff
    customerA = await Customer.create({
      name: "Priya Sharma",
      phone: "+919876543210",
      organizationId: orgAId,
      homeBranchId: branchA1Id,
      status: "active",
    });

    staffA = await Staff.create({
      name: "Rahul Verma",
      phone: "+919876543299",
      email: "rahul@test.com",
      designation: "Senior Stylist",
      staffCode: `STF-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      joiningDate: new Date(),
      organizationId: orgAId,
      status: "active",
    });

    // 5. Service
    const cat = await ServiceCategory.create({ name: "Hair", organizationId: orgAId });
    serviceHaircut = await Service.create({
      name: "Haircut & Styling",
      categoryId: cat._id,
      duration: 45,
      pricing: { basePrice: 1200 },
      organizationId: orgAId,
      status: "active",
    });
  });

  afterEach(async () => {
    await Invoice.deleteMany({});
    await Appointment.deleteMany({});
    await Customer.deleteMany({});
    await Staff.deleteMany({});
    await Service.deleteMany({});
    await ServiceCategory.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});
  });

  async function createAppointment(overrides = {}) {
    const today = new Date().toISOString().split("T")[0];
    const uniqueSlot = `slot_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    return Appointment.create({
      organizationId: orgAId,
      branchId: branchA1Id,
      appointmentCode: `APT-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      customerId: customerA._id,
      staffId: staffA._id,
      slotMinutes: [uniqueSlot],
      services: [
        {
          serviceId: serviceHaircut._id,
          name: serviceHaircut.name,
          duration: 45,
          price: 1200,
          appliedSubscriptionId: null,
          isRedeemedViaSubscription: false,
        },
      ],
      startAt: new Date(),
      endAt: new Date(Date.now() + 45 * 60000),
      appointmentDate: today,
      startTime: "14:30",
      endTime: "15:15",
      totalDuration: 45,
      status: "completed",
      bookingType: "walk_in",
      pricing: {
        subtotal: 1200,
        discount: 0,
        total: 1200,
      },
      ...overrides,
    });
  }

  it("1. Completed appointment with NO invoice appears in the queue", async () => {
    const apt = await createAppointment({ status: "completed" });

    const res = await request(app)
      .get("/api/v1/billing/checkout-queue")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe("Checkout queue retrieved successfully");
    expect(res.body.data.length).toBe(1);

    const item = res.body.data[0];
    expect(item.id).toBe(apt._id.toString());
    expect(item.appointmentCode).toBe(apt.appointmentCode);
    expect(item.status).toBe("completed");
    expect(item.customer.name).toBe("Priya Sharma");
    expect(item.customer.phone).toBe("+919876543210");
    expect(item.staff.name).toBe("Rahul Verma");
    expect(item.pricing.total).toBe(1200);
    expect(item.estimatedPayable).toBe(1200);
    expect(item.services[0].name).toBe("Haircut & Styling");

    expect(res.body.meta).toEqual({
      total: 1,
      completedCount: 1,
      inProgressCount: 0,
    });
  });

  it("2. Completed appointment with active invoice (draft, finalized, or paid) does NOT appear in queue", async () => {
    const aptDraft = await createAppointment({ status: "completed" });
    const aptFinalized = await createAppointment({ status: "completed" });

    // Create draft invoice for aptDraft
    await Invoice.create({
      organizationId: orgAId,
      branchId: branchA1Id,
      invoiceNumber: `INV-${Date.now()}-1`,
      appointmentId: aptDraft._id,
      appointmentCode: aptDraft.appointmentCode,
      appointmentPricingSnapshot: aptDraft.pricing,
      customerId: customerA._id,
      customerSnapshot: { name: customerA.name, phone: customerA.phone },
      lines: [
        {
          serviceId: serviceHaircut._id,
          appointmentServiceId: aptDraft.services[0]._id,
          name: serviceHaircut.name,
          duration: 45,
          unitPrice: 1200,
          lineTotal: 1200,
          customerPayable: 1200,
        },
      ],
      subtotal: 1200,
      grossPayable: 1200,
      payableAmount: 1200,
      amountDue: 1200,
      status: "draft",
      paymentStatus: "unpaid",
      createdBy: ownerUserA._id,
    });

    // Create finalized invoice for aptFinalized
    await Invoice.create({
      organizationId: orgAId,
      branchId: branchA1Id,
      invoiceNumber: `INV-${Date.now()}-2`,
      appointmentId: aptFinalized._id,
      appointmentCode: aptFinalized.appointmentCode,
      appointmentPricingSnapshot: aptFinalized.pricing,
      customerId: customerA._id,
      customerSnapshot: { name: customerA.name, phone: customerA.phone },
      lines: [
        {
          serviceId: serviceHaircut._id,
          appointmentServiceId: aptFinalized.services[0]._id,
          name: serviceHaircut.name,
          duration: 45,
          unitPrice: 1200,
          lineTotal: 1200,
          customerPayable: 1200,
        },
      ],
      subtotal: 1200,
      grossPayable: 1200,
      payableAmount: 1200,
      amountDue: 0,
      amountPaid: 1200,
      status: "finalized",
      paymentStatus: "paid",
      createdBy: ownerUserA._id,
    });

    const res = await request(app)
      .get("/api/v1/billing/checkout-queue")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString());

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(0);
    expect(res.body.meta.total).toBe(0);
  });

  it("3. Completed appointment whose invoice was CANCELLED reappears in the queue", async () => {
    const apt = await createAppointment({ status: "completed" });

    // Create cancelled invoice
    await Invoice.create({
      organizationId: orgAId,
      branchId: branchA1Id,
      invoiceNumber: `INV-${Date.now()}-CANCELLED`,
      appointmentId: apt._id,
      appointmentCode: apt.appointmentCode,
      appointmentPricingSnapshot: apt.pricing,
      customerId: customerA._id,
      customerSnapshot: { name: customerA.name, phone: customerA.phone },
      lines: [
        {
          serviceId: serviceHaircut._id,
          appointmentServiceId: apt.services[0]._id,
          name: serviceHaircut.name,
          duration: 45,
          unitPrice: 1200,
          lineTotal: 1200,
          customerPayable: 1200,
        },
      ],
      subtotal: 1200,
      grossPayable: 1200,
      payableAmount: 1200,
      amountDue: 1200,
      status: "cancelled",
      paymentStatus: "unpaid",
      createdBy: ownerUserA._id,
    });

    const res = await request(app)
      .get("/api/v1/billing/checkout-queue")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString());

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].id).toBe(apt._id.toString());
    expect(res.body.meta.total).toBe(1);
    expect(res.body.meta.completedCount).toBe(1);
  });

  it("4. Returns accurate completedCount and inProgressCount in metadata with completed sorted first", async () => {
    // In progress appointment earlier startTime
    const aptInProgress = await createAppointment({
      status: "in_progress",
      startTime: "15:00",
      appointmentCode: "APT-IN-PROGRESS-1",
    });

    // Completed appointment
    const aptCompleted = await createAppointment({
      status: "completed",
      startTime: "14:00",
      appointmentCode: "APT-COMPLETED-1",
    });

    // Another appointment with scheduled status (should be ignored)
    await createAppointment({
      status: "scheduled",
      startTime: "16:00",
    });

    const res = await request(app)
      .get("/api/v1/billing/checkout-queue")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString());

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(2);

    // Completed must appear first due to sorting statusOrder
    expect(res.body.data[0].id).toBe(aptCompleted._id.toString());
    expect(res.body.data[0].status).toBe("completed");

    expect(res.body.data[1].id).toBe(aptInProgress._id.toString());
    expect(res.body.data[1].status).toBe("in_progress");

    expect(res.body.meta).toEqual({
      total: 2,
      completedCount: 1,
      inProgressCount: 1,
    });
  });

  it("5. Authorization: Cashier with billing.view can access checkout-queue", async () => {
    await createAppointment({ status: "completed" });

    const res = await request(app)
      .get("/api/v1/billing/checkout-queue")
      .set("Authorization", `Bearer ${cashierTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.length).toBe(1);
  });

  it("6. Multi-Tenancy: Branch isolation prevents leakage across branches/organizations", async () => {
    await createAppointment({ status: "completed", branchId: branchA1Id });

    // Requesting branch A2
    const resA2 = await request(app)
      .get("/api/v1/billing/checkout-queue")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA2Id.toString());

    expect(resA2.status).toBe(200);
    expect(resA2.body.data.length).toBe(0);
    expect(resA2.body.meta.total).toBe(0);
  });
});
