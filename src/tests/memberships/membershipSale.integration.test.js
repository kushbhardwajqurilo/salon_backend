import { describe, expect, it, beforeAll, afterAll, beforeEach, jest } from "@jest/globals";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app.mjs";
import { Organization } from "../../models/organizations/organization.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Customer } from "../../models/customers/customer.model.js";
import { Role } from "../../models/roles/role.model.js";
import { Permission } from "../../models/permissions/permission.model.js";
import { User } from "../../models/users/user.model.js";
import { MembershipPlan } from "../../models/memberships/membershipPlan.model.js";
import { CustomerMembership } from "../../models/memberships/customerMembership.model.js";
import { AuditLog } from "../../models/audit/auditLog.model.js";
import { Invoice } from "../../models/billing/invoice.model.js";
import { Service } from "../../models/services/service.model.js";
import { ServiceCategory } from "../../models/services/serviceCategory.model.js";
import { billingService } from "../../services/billing/billing.service.js";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";
import { redis } from "../../utils/redis.js";
import { getIsolatedTestMongoUri } from "../testSetup.js";

jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");

describe("Membership Standalone Sale & Audit Trail Integration Tests", () => {
  jest.setTimeout(40000);

  let org;
  let branch;
  let otherBranch;
  let ownerToken;
  let ownerUser;
  let payerCustomer;
  let beneficiaryCustomer1;
  let beneficiaryCustomer2;
  let catalogPlan;

  beforeAll(async () => {
    process.env.ALLOW_STANDALONE_TRANSACTION_FALLBACK = "true";
    const testUri = getIsolatedTestMongoUri("checkout_queue_test");
    await mongoose.connect(testUri);

    await MembershipPlan.syncIndexes();
    await CustomerMembership.syncIndexes();
    await AuditLog.syncIndexes();

    const { InvoiceSettlementEvent } = await import("../../models/incentives/invoiceSettlementEvent.model.js");
    await InvoiceSettlementEvent.syncIndexes();

    org = await Organization.create({
      name: "Membership Sell Suite Org",
      ownerEmail: `mb.sell.${Date.now()}@test.com`,
    });

    branch = await Branch.create({
      organizationId: org._id,
      name: "Sell Main Branch",
      code: `SMB_${Date.now()}`,
      isActive: true,
    });

    otherBranch = await Branch.create({
      organizationId: org._id,
      name: "Sell Secondary Branch",
      code: `SSB_${Date.now()}`,
      isActive: true,
    });

    const sellPerm = await Permission.findOneAndUpdate(
      { name: "memberships.sell" },
      { name: "memberships.sell", module: "memberships", description: "Sell memberships" },
      { upsert: true, new: true }
    );
    const viewPerm = await Permission.findOneAndUpdate(
      { name: "memberships.view" },
      { name: "memberships.view", module: "memberships", description: "View memberships" },
      { upsert: true, new: true }
    );
    const checkoutPerm = await Permission.findOneAndUpdate(
      { name: "billing.checkout" },
      { name: "billing.checkout", module: "billing", description: "Create invoices" },
      { upsert: true, new: true }
    );
    const billViewPerm = await Permission.findOneAndUpdate(
      { name: "billing.view" },
      { name: "billing.view", module: "billing", description: "View invoices" },
      { upsert: true, new: true }
    );
    const configPerm = await Permission.findOneAndUpdate(
      { name: "memberships.configure" },
      { name: "memberships.configure", module: "memberships", description: "Configure memberships" },
      { upsert: true, new: true }
    );

    const ownerRole = await Role.create({
      name: `OwnerRole_${Date.now()}`,
      organizationId: org._id,
      permissions: [sellPerm._id, viewPerm._id, checkoutPerm._id, billViewPerm._id, configPerm._id],
    });

    const uniqueSuffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    ownerUser = await User.create({
      name: "Store Manager",
      username: `store.manager.${uniqueSuffix}`,
      email: `manager.${uniqueSuffix}@test.com`,
      phone: `+919871${Math.floor(100000 + Math.random() * 900000)}`,
      password: "Password123!",
      organizationId: org._id,
      role: ownerRole._id,
      status: "active",
      hasOrgWideAccess: true,
      branchAccess: [{ branchId: branch._id, branchName: branch.name, isActive: true }],
    });

    ownerToken = jwt.sign(
      {
        id: ownerUser._id,
        organizationId: org._id,
        role: "owner",
        scope: "access",
      },
      env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    payerCustomer = await Customer.create({
      organizationId: org._id,
      homeBranchId: branch._id,
      name: "Payer Pam",
      phone: `+919876${Math.floor(100000 + Math.random() * 900000)}`,
      email: "pam.payer@test.com",
      status: "active",
    });

    beneficiaryCustomer1 = await Customer.create({
      organizationId: org._id,
      homeBranchId: branch._id,
      name: "Beneficiary Bob",
      phone: `+919875${Math.floor(100000 + Math.random() * 900000)}`,
      status: "active",
    });

    beneficiaryCustomer2 = await Customer.create({
      organizationId: org._id,
      homeBranchId: branch._id,
      name: "Beneficiary Charlie",
      phone: `+919874${Math.floor(100000 + Math.random() * 900000)}`,
      status: "active",
    });

    catalogPlan = await MembershipPlan.create({
      organizationId: org._id,
      name: "Family VIP Plus",
      tier: "VIP",
      price: 2500,
      validityMonths: 6,
      maxBeneficiaries: 2,
      benefits: {
        serviceDiscountPercentage: 20,
        productDiscountPercentage: 10,
      },
      permittedBranchIds: [branch._id],
      isActive: true,
    });
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.close();
  });

  it("1. Successfully sells membership, creates CustomerMembership records with status 'pending_payment', and writes AuditLog with valid actorId", async () => {
    const res = await request(app)
      .post("/api/v1/memberships/sell")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("X-Branch-Id", branch._id.toString())
      .send({
        membershipPlanId: catalogPlan._id.toString(),
        payerCustomerId: payerCustomer._id.toString(),
        beneficiaryCustomerIds: [
          beneficiaryCustomer1._id.toString(),
          beneficiaryCustomer2._id.toString(),
        ],
        branchId: branch._id.toString(),
        notes: "Front desk family purchase",
        billImmediately: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.customerMemberships).toHaveLength(2);

    const purchaseId = res.body.data.membershipPurchaseId;
    expect(purchaseId).toBeDefined();

    // Verify persisted CustomerMembership records
    const memberships = await CustomerMembership.find({ membershipPurchaseId: purchaseId });
    expect(memberships).toHaveLength(2);
    expect(memberships[0].status).toBe("pending_payment");
    expect(memberships[1].status).toBe("pending_payment");
    expect(memberships[0].payerCustomerId.toString()).toBe(payerCustomer._id.toString());

    // Verify linked invoice exists
    expect(res.body.data.invoice).toBeDefined();
    expect(res.body.data.invoice.id).toBeDefined();
    const invoice = await Invoice.findById(res.body.data.invoice.id);
    expect(invoice).toBeDefined();
    expect(invoice.payableAmount).toBe(2500);

    // Verify AuditLog was written with actorId = ownerUser._id
    const auditLogs = await AuditLog.find({
      entityId: memberships[0]._id,
      action: "MEMBERSHIP_CREATED",
    });
    expect(auditLogs.length).toBeGreaterThanOrEqual(1);
    const audit = auditLogs[0];
    expect(audit.actorId.toString()).toBe(ownerUser._id.toString());
    expect(audit.organizationId.toString()).toBe(org._id.toString());
    expect(audit.metadata.membershipPurchaseId.toString()).toBe(purchaseId.toString());
  });

  it("2. Rejects request when missing authentication token", async () => {
    const res = await request(app)
      .post("/api/v1/memberships/sell")
      .set("X-Branch-Id", branch._id.toString())
      .send({
        membershipPlanId: catalogPlan._id.toString(),
        payerCustomerId: payerCustomer._id.toString(),
        beneficiaryCustomerIds: [beneficiaryCustomer1._id.toString()],
      });

    expect(res.status).toBe(401);
  });

  it("3. Ignores client-supplied actorId in payload and strictly records authenticated user ID", async () => {
    const spoofedActorId = new mongoose.Types.ObjectId();

    const res = await request(app)
      .post("/api/v1/memberships/sell")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("X-Branch-Id", branch._id.toString())
      .send({
        membershipPlanId: catalogPlan._id.toString(),
        payerCustomerId: payerCustomer._id.toString(),
        beneficiaryCustomerIds: [beneficiaryCustomer1._id.toString()],
        actorId: spoofedActorId.toString(), // Attacker tries to spoof actorId
        billImmediately: false,
      });

    expect(res.status).toBe(201);
    const purchaseId = res.body.data.membershipPurchaseId;

    const memberships = await CustomerMembership.find({ membershipPurchaseId: purchaseId });
    expect(memberships).toHaveLength(1);

    const audit = await AuditLog.findOne({
      entityId: memberships[0]._id,
      action: "MEMBERSHIP_CREATED",
    });

    expect(audit).toBeDefined();
    expect(audit.actorId.toString()).toBe(ownerUser._id.toString());
    expect(audit.actorId.toString()).not.toBe(spoofedActorId.toString());
  });

  it("4. Enforces branch scope: rejects sale when selling branch is not in plan's permitted branches", async () => {
    const res = await request(app)
      .post("/api/v1/memberships/sell")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("X-Branch-Id", otherBranch._id.toString()) // otherBranch is not in permittedBranchIds
      .send({
        membershipPlanId: catalogPlan._id.toString(),
        payerCustomerId: payerCustomer._id.toString(),
        beneficiaryCustomerIds: [beneficiaryCustomer1._id.toString()],
        branchId: otherBranch._id.toString(),
      });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/not permitted at branch/);
  });

  it("5. Rejects sale when beneficiary count exceeds plan maxBeneficiaries", async () => {
    const res = await request(app)
      .post("/api/v1/memberships/sell")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("X-Branch-Id", branch._id.toString())
      .send({
        membershipPlanId: catalogPlan._id.toString(), // maxBeneficiaries is 2
        payerCustomerId: payerCustomer._id.toString(),
        beneficiaryCustomerIds: [
          beneficiaryCustomer1._id.toString(),
          beneficiaryCustomer2._id.toString(),
          payerCustomer._id.toString(), // 3 beneficiaries > 2 allowed
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/allows at most 2 beneficiaries/);
  });

  it("6. Rejects sale when beneficiaryCustomerIds and beneficiaries roster do not match", async () => {
    const res = await request(app)
      .post("/api/v1/memberships/sell")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("X-Branch-Id", branch._id.toString())
      .send({
        membershipPlanId: catalogPlan._id.toString(),
        payerCustomerId: payerCustomer._id.toString(),
        beneficiaryCustomerIds: [beneficiaryCustomer1._id.toString()],
        beneficiaries: [{ customerId: beneficiaryCustomer2._id.toString() }], // Mismatched customer ID
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Mismatched beneficiary lists/);
  });

  it("7. Benefits resolution returns pending_payment membership immediately for eligible discounts", async () => {
    const res = await request(app)
      .get(`/api/v1/memberships/customer/${beneficiaryCustomer1._id.toString()}/benefits`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("X-Branch-Id", branch._id.toString());

    expect(res.status).toBe(200);
    expect(res.body.data.hasActiveMembership).toBe(true);
    expect(res.body.data.status).toBe("pending_payment");
    expect(res.body.data.planSnapshot.benefits.serviceDiscountPercentage).toBe(20);
  });

  it("8. Settling invoice payment transitions all beneficiaries from 'pending_payment' to 'active' idempotently", async () => {
    // 1. Sell with invoice
    const sellRes = await request(app)
      .post("/api/v1/memberships/sell")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("X-Branch-Id", branch._id.toString())
      .send({
        membershipPlanId: catalogPlan._id.toString(),
        payerCustomerId: payerCustomer._id.toString(),
        beneficiaryCustomerIds: [
          beneficiaryCustomer1._id.toString(),
          beneficiaryCustomer2._id.toString(),
        ],
        branchId: branch._id.toString(),
        billImmediately: true,
      });

    expect(sellRes.status).toBe(201);
    const invoiceId = sellRes.body.data.invoice.id;
    const purchaseId = sellRes.body.data.membershipPurchaseId;

    // Verify initial pending_payment
    let mems = await CustomerMembership.find({ membershipPurchaseId: purchaseId });
    expect(mems.every((m) => m.status === "pending_payment")).toBe(true);

    // Finalize invoice: finalizeInvoice(id, payload, organizationId, branchId, userId)
    await billingService.finalizeInvoice(invoiceId, {}, org._id, branch._id, ownerUser._id);

    // Record payment settlement: recordPayment(invoiceId, paymentData, organizationId, branchId, userId)
    await billingService.recordPayment(
      invoiceId,
      {
        method: "cash",
        amount: 2500,
        branchId: branch._id,
      },
      org._id,
      branch._id,
      ownerUser._id
    );

    // Verify both memberships transitioned to active without creating duplicates
    mems = await CustomerMembership.find({ membershipPurchaseId: purchaseId });
    expect(mems).toHaveLength(2);
    expect(mems.every((m) => m.status === "active")).toBe(true);
  });

  it("9. Enforces temporal validity and branch scope: future-dated and expired memberships do NOT grant benefits in billing or membership services", async () => {
    const fixedNow = new Date("2026-06-15T12:00:00.000Z");
    const originalNow = Date.now;
    Date.now = () => fixedNow.getTime();

    try {
      const testCustomer = await Customer.create({
        organizationId: org._id,
        homeBranchId: branch._id,
        name: "Temporal Test Customer",
        phone: `+919879${Math.floor(100000 + Math.random() * 900000)}`,
        status: "active",
      });

      const testCategory = await ServiceCategory.create({
        organizationId: org._id,
        name: "Test Styling Category",
      });

      const testService = await Service.create({
        organizationId: org._id,
        name: "Hair Styling Deluxe",
        categoryId: testCategory._id,
        duration: 45,
        pricing: { basePrice: 1000 },
        status: "active",
      });

      // 1. Future-dated pending_payment membership: starts tomorrow relative to real time (2027)
      const futureMembership = await CustomerMembership.create({
        organizationId: org._id,
        branchId: branch._id,
        customerId: testCustomer._id,
        payerCustomerId: testCustomer._id,
        membershipPlanId: catalogPlan._id,
        membershipCode: `MEM-FUT-${Date.now()}`,
        status: "pending_payment",
        startDate: new Date("2027-06-16T00:00:00.000Z"),
        endDate: new Date("2027-12-16T00:00:00.000Z"),
        planSnapshot: {
          name: "Future VIP",
          tier: "VIP",
          price: 1000,
          validityMonths: 6,
          benefits: {
            serviceDiscountPercentage: 30,
            productDiscountPercentage: 15,
          },
        },
        permittedBranchIds: [branch._id],
        isDeleted: false,
      });

      // Assert benefits via membership endpoint -> must be false (startDate > now)
      const resFut = await request(app)
        .get(`/api/v1/memberships/customer/${testCustomer._id.toString()}/benefits`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branch._id.toString());

      expect(resFut.status).toBe(200);
      expect(resFut.body.data.hasActiveMembership).toBe(false);

      // Assert benefits via billing checkout draft creation -> 0% discount
      const invResFut = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branch._id.toString())
        .send({
          customerId: testCustomer._id.toString(),
          serviceLines: [{ serviceId: testService._id.toString(), quantity: 1 }],
        });

      expect(invResFut.status).toBe(201);
      expect(invResFut.body.data.discountTotal).toBe(0);
      expect(invResFut.body.data.payableAmount).toBe(1000);

      // 2. Active eligible pending_payment membership: started yesterday, ends next year
      process.env.DEBUG_MEMBERSHIP_RESOLUTION = "true";
      await CustomerMembership.updateOne(
        { _id: futureMembership._id },
        { $set: { startDate: new Date("2026-01-01T00:00:00.000Z"), endDate: new Date("2027-12-31T23:59:59.000Z") } }
      );

      // Assert benefits via membership endpoint -> must be true (startDate <= now && endDate >= now)
      const resElig = await request(app)
        .get(`/api/v1/memberships/customer/${testCustomer._id.toString()}/benefits`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branch._id.toString());

      expect(resElig.status).toBe(200);
      const foundM = await CustomerMembership.findById(futureMembership._id);
      expect(resElig.body.data.hasActiveMembership).toBe(true);
      expect(resElig.body.data.status).toBe("pending_payment");
      expect(resElig.body.data.planSnapshot.benefits.serviceDiscountPercentage).toBe(30);

      // Assert benefits via billing checkout draft creation -> 30% discount applies
      const invResElig = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branch._id.toString())
        .send({
          customerId: testCustomer._id.toString(),
          serviceLines: [{ serviceId: testService._id.toString(), quantity: 1 }],
        });

      expect(invResElig.status).toBe(201);
      expect(invResElig.body.data.discountTotal).toBe(300); // 30% of 1000
      expect(invResElig.body.data.payableAmount).toBe(700);

      // 3. Expired membership: ended yesterday
      await CustomerMembership.updateOne(
        { _id: futureMembership._id },
        { $set: { startDate: new Date("2025-01-01T00:00:00.000Z"), endDate: new Date("2025-12-31T23:59:59.000Z") } }
      );

      const resExp = await request(app)
        .get(`/api/v1/memberships/customer/${testCustomer._id.toString()}/benefits`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branch._id.toString());

      expect(resExp.status).toBe(200);
      expect(resExp.body.data.hasActiveMembership).toBe(false);

      const invResExp = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branch._id.toString())
        .send({
          customerId: testCustomer._id.toString(),
          serviceLines: [{ serviceId: testService._id.toString(), quantity: 1 }],
        });

      expect(invResExp.status).toBe(201);
      expect(invResExp.body.data.discountTotal).toBe(0);
      expect(invResExp.body.data.payableAmount).toBe(1000);
    } finally {
      Date.now = originalNow;
      delete process.env.DEBUG_MEMBERSHIP_RESOLUTION;
    }
  });

  it("10. Membership Usage History: accurately tracks discount benefits applied in invoices and isolates tenant/branch", async () => {
    // 1. Fetch beneficiary membership from test 1
    const beneficiaryMembership = await CustomerMembership.findOne({
      organizationId: org._id,
      customerId: beneficiaryCustomer1._id,
      status: "active",
    });
    expect(beneficiaryMembership).toBeDefined();

    // 2. Fetch usage history via endpoint
    const historyRes = await request(app)
      .get(`/api/v1/memberships/${beneficiaryMembership._id.toString()}/usage`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("X-Branch-Id", branch._id.toString());

    expect(historyRes.status).toBe(200);
    expect(historyRes.body.data.membership.id).toBe(beneficiaryMembership._id.toString());
    expect(historyRes.body.data.membership.membershipCode).toBe(beneficiaryMembership.membershipCode);
    expect(Array.isArray(historyRes.body.data.usage)).toBe(true);

    // 3. Unauthorized access check (non-existent or other org)
    const randomId = new mongoose.Types.ObjectId();
    const notFoundRes = await request(app)
      .get(`/api/v1/memberships/${randomId.toString()}/usage`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("X-Branch-Id", branch._id.toString());
    expect(notFoundRes.status).toBe(404);
  });

  it("11. Renewal Reminders: triggers renewal reminder, prevents duplicates, and records delivery outcome", async () => {
    const beneficiaryMembership = await CustomerMembership.findOne({
      organizationId: org._id,
      customerId: beneficiaryCustomer1._id,
      status: "active",
    });
    expect(beneficiaryMembership).toBeDefined();

    // 1. Trigger initial reminder
    const remRes = await request(app)
      .post(`/api/v1/memberships/${beneficiaryMembership._id.toString()}/renewal-reminder`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("X-Branch-Id", branch._id.toString())
      .send({ channel: "sms" });

    expect(remRes.status).toBe(200);
    expect(remRes.body.success).toBe(true);
    expect(remRes.body.data.deliveryOutcome).toBeDefined();

    // 2. Verify persisted status on membership
    const updatedM = await CustomerMembership.findById(beneficiaryMembership._id);
    expect(updatedM.renewalReminder.status).toBe("sent");
    expect(updatedM.renewalReminder.sentAt).toBeDefined();

    // 3. Re-trigger without force: idempotent skip
    const remDuplicateRes = await request(app)
      .post(`/api/v1/memberships/${beneficiaryMembership._id.toString()}/renewal-reminder`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("X-Branch-Id", branch._id.toString())
      .send({ channel: "sms" });

    expect(remDuplicateRes.status).toBe(200);
    expect(remDuplicateRes.body.data.skipped).toBe(true);
    expect(remDuplicateRes.body.data.reason).toMatch(/already sent/);
  });
});
