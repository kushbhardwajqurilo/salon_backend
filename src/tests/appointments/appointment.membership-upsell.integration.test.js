import { describe, expect, it, beforeAll, afterAll, beforeEach, jest } from "@jest/globals";
import crypto from "crypto";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app.mjs";
import { Organization } from "../../models/organizations/organization.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Customer } from "../../models/customers/customer.model.js";
import { Staff } from "../../models/staff/staff.model.js";
import { StaffBranch } from "../../models/staff/staffBranch.model.js";
import { Service } from "../../models/services/service.model.js";
import { ServiceCategory } from "../../models/services/serviceCategory.model.js";
import { Role } from "../../models/roles/role.model.js";
import { Permission } from "../../models/permissions/permission.model.js";
import { User } from "../../models/users/user.model.js";
import { Appointment } from "../../models/appointments/appointment.model.js";
import { MembershipPlan } from "../../models/memberships/membershipPlan.model.js";
import { CustomerMembership } from "../../models/memberships/customerMembership.model.js";
import { Invoice } from "../../models/billing/invoice.model.js";
import { billingService } from "../../services/billing/billing.service.js";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";
import { redis } from "../../utils/redis.js";
import { getIsolatedTestMongoUri } from "../testSetup.js";

jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");

describe("Appointment ↔ Membership Mid-Appointment Upsell Flow", () => {
  jest.setTimeout(40000);

  let org;
  let branch;
  let ownerToken;
  let ownerUser;
  let customer1;
  let customer2;
  let serviceHaircut;
  let serviceColor;
  let staffMember;
  let membershipPlan;

  beforeAll(async () => {
    process.env.ALLOW_STANDALONE_TRANSACTION_FALLBACK = "true";
    const testUri = getIsolatedTestMongoUri("apt_test");
    await mongoose.connect(testUri);
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    // Clean collections
    await Promise.all([
      Organization.deleteMany({}),
      Branch.deleteMany({}),
      Customer.deleteMany({}),
      Staff.deleteMany({}),
      StaffBranch.deleteMany({}),
      Service.deleteMany({}),
      ServiceCategory.deleteMany({}),
      Role.deleteMany({}),
      Permission.deleteMany({}),
      User.deleteMany({}),
      Appointment.deleteMany({}),
      MembershipPlan.deleteMany({}),
      CustomerMembership.deleteMany({}),
      Invoice.deleteMany({}),
    ]);

    org = await Organization.create({
      name: "Salon Premium Org",
      slug: `salon-org-${Date.now()}`,
      currency: "INR",
    });

    branch = await Branch.create({
      organizationId: org._id,
      name: "Main Branch",
      code: "MB-01",
      timezone: "Asia/Kolkata",
      isActive: true,
      operatingHours: {
        monday: { isOpen: true, openTime: "09:00", closeTime: "20:00" },
        tuesday: { isOpen: true, openTime: "09:00", closeTime: "20:00" },
        wednesday: { isOpen: true, openTime: "09:00", closeTime: "20:00" },
        thursday: { isOpen: true, openTime: "09:00", closeTime: "20:00" },
        friday: { isOpen: true, openTime: "09:00", closeTime: "20:00" },
        saturday: { isOpen: true, openTime: "09:00", closeTime: "20:00" },
        sunday: { isOpen: true, openTime: "09:00", closeTime: "20:00" },
      },
    });

    // Create permissions & role
    const permNames = [
      "appointments.view",
      "appointments.create",
      "appointments.edit",
      "memberships.sell",
      "memberships.view",
      "billing.create",
      "billing.view",
    ];
    const permissions = await Promise.all(
      permNames.map((name) =>
        Permission.create({
          name,
          module: name.split(".")[0],
          action: name.split(".")[1] || "manage",
          description: name,
        })
      )
    );

    const ownerRole = await Role.create({
      name: "Owner Role",
      organizationId: org._id,
      permissions: permissions.map((p) => p._id),
      isSystem: true,
    });

    ownerUser = await User.create({
      name: "Owner User",
      email: `owner-${Date.now()}@test.com`,
      phone: "+919999999991",
      password: "password123",
      organizationId: org._id,
      role: ownerRole._id,
      hasOrgWideAccess: true,
      branchAccess: [{ branchId: branch._id, branchName: "Main Branch", isActive: true }],
    });

    ownerToken = jwt.sign(
      {
        id: ownerUser._id.toString(),
        userId: ownerUser._id.toString(),
        organizationId: org._id.toString(),
        role: "owner",
        hasOrgWideAccess: true,
      },
      env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    customer1 = await Customer.create({
      organizationId: org._id,
      homeBranchId: branch._id,
      name: "Alice Johnson",
      phone: "+919876543210",
      status: "active",
    });

    customer2 = await Customer.create({
      organizationId: org._id,
      homeBranchId: branch._id,
      name: "Bob Johnson",
      phone: "+919876543211",
      status: "active",
    });

    staffMember = await Staff.create({
      organizationId: org._id,
      name: "Senior Stylist John",
      email: "john@test.com",
      phone: "+919876543212",
      designation: "Stylist",
      staffCode: `STF-${Date.now()}`,
      joiningDate: new Date(),
      primaryBranchId: branch._id,
      status: "active",
      isActive: true,
    });

    await StaffBranch.create({
      organizationId: org._id,
      staffId: staffMember._id,
      branchId: branch._id,
      isActive: true,
    });

    const category = await ServiceCategory.create({
      organizationId: org._id,
      name: "Hair Services",
    });

    serviceHaircut = await Service.create({
      organizationId: org._id,
      categoryId: category._id,
      name: "Signature Haircut",
      duration: 30,
      pricing: { basePrice: 1000 },
      status: "active",
    });

    serviceColor = await Service.create({
      organizationId: org._id,
      categoryId: category._id,
      name: "Hair Color",
      duration: 60,
      pricing: { basePrice: 2000 },
      status: "active",
    });

    // Create a 2-member membership plan with 20% discount on services
    membershipPlan = await MembershipPlan.create({
      organizationId: org._id,
      name: "Family Gold VIP",
      code: "FGOLD",
      tier: "Gold",
      price: 5000,
      validityDuration: 12,
      validityUnit: "months",
      validityMonths: 12,
      maxBeneficiaries: 2,
      benefits: {
        serviceDiscountPercentage: 20,
        productDiscountPercentage: 10,
        eligibleServiceIds: [serviceHaircut._id, serviceColor._id],
      },
      permittedBranchIds: [branch._id],
      isActive: true,
    });
  });

  it("1. Successfully upsells membership during scheduled appointment, creating pending_payment membership and applying 20% discount to appointment services immediately", async () => {
    // Step A: Create appointment with Haircut (1000) and Hair Color (2000) = Subtotal 3000
    const startAt = new Date(Date.now() + 3600000);
    const endAt = new Date(startAt.getTime() + 90 * 60000);

    const appt = await Appointment.create({
      organizationId: org._id,
      branchId: branch._id,
      appointmentCode: "APT-TEST-001",
      customerId: customer1._id,
      staffId: staffMember._id,
      services: [
        {
          serviceType: "registered",
          serviceId: serviceHaircut._id,
          name: serviceHaircut.name,
          duration: serviceHaircut.duration,
          price: 1000,
        },
        {
          serviceType: "registered",
          serviceId: serviceColor._id,
          name: serviceColor.name,
          duration: serviceColor.duration,
          price: 2000,
        },
      ],
      startAt,
      endAt,
      appointmentDate: "2026-11-25",
      startTime: "10:00",
      endTime: "11:30",
      totalDuration: 90,
      bookingType: "advance",
      status: "scheduled",
      pricing: {
        subtotal: 3000,
        discount: 0,
        total: 3000,
      },
    });

    // Step B: Upsell Membership for customer1 (payer) and customer2 (beneficiary)
    const res = await request(app)
      .post(`/api/v1/appointments/${appt._id}/upsell-membership`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("x-branch-id", branch._id.toString())
      .send({
        planId: membershipPlan._id.toString(),
        payerCustomerId: customer1._id.toString(),
        beneficiaryCustomerIds: [customer1._id.toString(), customer2._id.toString()],
        soldByStaffId: staffMember._id.toString(),
        notes: "Family plan upsold in consultation",
        billImmediately: true,
      });

    if (res.status !== 201) console.log("RES BODY ERROR:", JSON.stringify(res.body));
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.customerMemberships).toHaveLength(2);

    // Verify memberships created in pending_payment state
    const createdMems = await CustomerMembership.find({
      organizationId: org._id,
      membershipPlanId: membershipPlan._id,
    });
    expect(createdMems).toHaveLength(2);
    expect(createdMems[0].status).toBe("pending_payment");
    expect(createdMems[1].status).toBe("pending_payment");

    // Verify unified invoice was generated
    const invoice = await Invoice.findById(res.body.data.invoice._id);
    expect(invoice).toBeTruthy();
    expect(invoice.lines[0].lineType).toBe("membership");
    expect(invoice.lines[0].lineTotal).toBe(5000);

    // Verify appointment was re-evaluated and discounted 20%:
    // Haircut: 1000 -> 200 discount (20%)
    // Color: 2000 -> 400 discount (20%)
    // Total discount: 600. New Total: 2400.
    const updatedAppt = await Appointment.findById(appt._id);
    expect(updatedAppt.services[0].appliedCustomerMembershipId).toBeTruthy();
    expect(updatedAppt.services[0].membershipDiscountPercentage).toBe(20);
    expect(updatedAppt.services[0].membershipDiscountAmount).toBe(200);

    expect(updatedAppt.services[1].appliedCustomerMembershipId).toBeTruthy();
    expect(updatedAppt.services[1].membershipDiscountPercentage).toBe(20);
    expect(updatedAppt.services[1].membershipDiscountAmount).toBe(400);

    expect(updatedAppt.pricing.subtotal).toBe(3000);
    expect(updatedAppt.pricing.discount).toBe(600);
    expect(updatedAppt.pricing.total).toBe(2400);

    // Step C: Recording payment on the membership invoice activates the memberships without duplicating
    await billingService.finalizeInvoice(invoice._id, {}, org._id, branch._id, ownerUser._id);
    await billingService.recordPayment(
      invoice._id,
      {
        method: "card",
        amount: 5000,
      },
      org._id,
      branch._id,
      ownerUser._id
    );

    const paidMems = await CustomerMembership.find({
      organizationId: org._id,
      membershipPlanId: membershipPlan._id,
    });
    expect(paidMems).toHaveLength(2);
    expect(paidMems[0].status).toBe("active");
    expect(paidMems[1].status).toBe("active");
  });

  it("2. Rejects upsell if beneficiary count exceeds plan maxBeneficiaries", async () => {
    const startAt = new Date(Date.now() + 3600000);
    const endAt = new Date(startAt.getTime() + 30 * 60000);

    const appt = await Appointment.create({
      organizationId: org._id,
      branchId: branch._id,
      appointmentCode: "APT-TEST-002",
      customerId: customer1._id,
      services: [
        {
          serviceType: "registered",
          serviceId: serviceHaircut._id,
          name: serviceHaircut.name,
          duration: 30,
          price: 1000,
        },
      ],
      startAt,
      endAt,
      appointmentDate: "2026-11-25",
      startTime: "10:00",
      endTime: "10:30",
      totalDuration: 30,
      bookingType: "advance",
      status: "scheduled",
      pricing: { subtotal: 1000, discount: 0, total: 1000 },
    });

    const customer3 = await Customer.create({
      organizationId: org._id,
      homeBranchId: branch._id,
      name: "Charlie Johnson",
      phone: "+919876543213",
      status: "active",
    });

    const res = await request(app)
      .post(`/api/v1/appointments/${appt._id}/upsell-membership`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("x-branch-id", branch._id.toString())
      .send({
        planId: membershipPlan._id.toString(),
        payerCustomerId: customer1._id.toString(),
        beneficiaryCustomerIds: [
          customer1._id.toString(),
          customer2._id.toString(),
          customer3._id.toString(), // 3 members > maxBeneficiaries of 2
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/allows at most 2 beneficiaries/i);
  });

  it("3. Service modification preview automatically applies customer's active or pending_payment membership discount to newly added eligible services", async () => {
    // Customer1 has an active membership (20% discount on Haircut and Color)
    const membershipPurchaseId = new mongoose.Types.ObjectId();
    const startDate = new Date();
    const endDate = new Date(startDate);
    endDate.setFullYear(endDate.getFullYear() + 1);

    await CustomerMembership.create({
      organizationId: org._id,
      customerId: customer1._id,
      payerCustomerId: customer1._id,
      membershipPurchaseId,
      membershipPlanId: membershipPlan._id,
      membershipCode: "MEM-TEST-ACTIVE",
      planSnapshot: {
        name: membershipPlan.name,
        tier: "Gold",
        price: 5000,
        validityMonths: 12,
        maxBeneficiaries: 2,
        benefits: {
          serviceDiscountPercentage: 20,
          eligibleServiceIds: [serviceHaircut._id, serviceColor._id],
        },
      },
      status: "active",
      startDate,
      endDate,
      permittedBranchIds: [branch._id],
    });

    const startAt = new Date(Date.now() + 7200000);
    const endAt = new Date(startAt.getTime() + 30 * 60000);

    const appt = await Appointment.create({
      organizationId: org._id,
      branchId: branch._id,
      appointmentCode: "APT-TEST-003",
      customerId: customer1._id,
      staffId: staffMember._id,
      services: [
        {
          serviceType: "registered",
          serviceId: serviceHaircut._id,
          name: serviceHaircut.name,
          duration: 30,
          price: 1000,
        },
      ],
      startAt,
      endAt,
      appointmentDate: "2026-11-25",
      startTime: "12:00",
      endTime: "12:30",
      totalDuration: 30,
      bookingType: "advance",
      status: "scheduled",
      pricing: { subtotal: 1000, discount: 0, total: 1000 },
    });

    // Preview adding serviceColor (2000)
    const res = await request(app)
      .post(`/api/v1/appointments/${appt._id}/services/preview`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("x-branch-id", branch._id.toString())
      .send({
        branchId: branch._id.toString(),
        services: [
          { serviceId: serviceHaircut._id.toString(), customPrice: 1000 },
          { serviceId: serviceColor._id.toString(), customPrice: 2000 },
        ],
      });

    if (res.status !== 200) console.log("PREVIEW ERROR:", JSON.stringify(res.body));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const proposal = res.body.data.initiatingAppointment;

    // Subtotal: 1000 + 2000 = 3000
    // Total discount: 20% on 1000 (200) + 20% on 2000 (400) = 600
    // Total payable: 2400
    expect(proposal.pricing.subtotal).toBe(3000);
    expect(proposal.pricing.discount).toBe(600);
    expect(proposal.pricing.total).toBe(2400);

    // Verify individual service lines have membership discount populated
    expect(proposal.services[0].membershipDiscountAmount).toBe(200);
    expect(proposal.services[0].membershipDiscountPercentage).toBe(20);
    expect(proposal.services[1].membershipDiscountAmount).toBe(400);
    expect(proposal.services[1].membershipDiscountPercentage).toBe(20);
  });
});
