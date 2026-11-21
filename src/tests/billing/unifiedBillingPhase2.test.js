import { describe, expect, it, beforeAll, afterAll, jest } from "@jest/globals";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app.mjs";
import { getIsolatedTestMongoUri } from "../testSetup.js";
import { User } from "../../models/users/user.model.js";
import { Role } from "../../models/roles/role.model.js";
import { Permission } from "../../models/permissions/permission.model.js";
import { Organization } from "../../models/organizations/organization.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Customer } from "../../models/customers/customer.model.js";
import { Product } from "../../models/inventory/product.model.js";
import { StockBalance } from "../../models/inventory/stockBalance.model.js";
import { StockMovement } from "../../models/inventory/stockMovement.model.js";
import { StockReservation } from "../../models/inventory/stockReservation.model.js";
import { Appointment } from "../../models/appointments/appointment.model.js";
import { Subscription } from "../../models/subscriptions/subscription.model.js";
import { SubscriptionPlan } from "../../models/subscriptions/subscriptionPlan.model.js";
import { SubscriptionUsage } from "../../models/subscriptions/subscriptionUsage.model.js";
import { MembershipPlan } from "../../models/memberships/membershipPlan.model.js";
import { CustomerMembership } from "../../models/memberships/customerMembership.model.js";
import { Service } from "../../models/services/service.model.js";
import { ServiceCategory } from "../../models/services/serviceCategory.model.js";
import { Invoice } from "../../models/billing/invoice.model.js";
import { Payment } from "../../models/billing/payment.model.js";
import jwt from "jsonwebtoken";

describe("Phase 2: Unified Billing Engine & Same-Appointment Upsell Suite", () => {
  jest.setTimeout(45000);
  let orgId, branchId, foreignOrgId, foreignBranchId, userId, token;
  let customerId, facialService, massageService, retailProduct, subPlan, membershipPlan;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    const testUri = getIsolatedTestMongoUri("checkout_queue_test");
    await mongoose.connect(testUri);

    await MembershipPlan.syncIndexes();
    await CustomerMembership.syncIndexes();
    await Invoice.syncIndexes();

    // 1. Setup Organization & Branch
    const org = await Organization.create({
      name: "Unified Checkout Test Org",
      ownerEmail: "owner.unified@test.com",
    });
    orgId = org._id;

    const foreignOrg = await Organization.create({
      name: "Foreign Checkout Org",
      ownerEmail: "owner.foreign@test.com",
    });
    foreignOrgId = foreignOrg._id;

    const branch = await Branch.create({
      name: "Downtown Flagship",
      organizationId: orgId,
      address: "100 MG Road",
    });
    branchId = branch._id;

    const foreignBranch = await Branch.create({
      name: "Foreign Branch",
      organizationId: foreignOrgId,
      address: "Foreign Road",
    });
    foreignBranchId = foreignBranch._id;

    // 2. Setup Permissions & User
    const rawPerms = [
      "billing.checkout",
      "billing.view",
      "billing.void",
      "payments.receive",
      "inventory.view",
      "memberships.view",
      "memberships.sell",
    ];

    const permDocs = await Promise.all(
      rawPerms.map((name) =>
        Permission.findOneAndUpdate(
          { name },
          { name, module: "Billing & POS", action: name, description: name },
          { upsert: true, new: true }
        )
      )
    );

    const cashierRole = await Role.create({
      organizationId: orgId,
      name: `cashier_unified_${Date.now()}_${Math.random()}`,
      permissions: permDocs.map((p) => p._id),
    });

    const user = await User.create({
      organizationId: orgId,
      name: "Cashier Bob",
      email: "cashier.bob@test.com",
      phone: "+919876543299",
      password: "Password123!",
      role: cashierRole._id,
      roleId: cashierRole._id,
      branchAccess: [{ branchId, branchName: "Downtown Flagship", isActive: true }],
      hasOrgWideAccess: false,
      status: "active",
    });
    userId = user._id;

    token = jwt.sign(
      {
        id: user._id.toString(),
        userId: user._id.toString(),
        organizationId: org._id.toString(),
        role: "cashier",
        roleId: cashierRole._id.toString(),
        hasOrgWideAccess: true,
      },
      process.env.JWT_SECRET || "default_jwt_secret_for_tests",
      { expiresIn: "1h" }
    );

    // 3. Customer
    const customer = await Customer.create({
      organizationId: orgId,
      homeBranchId: branchId,
      name: "Diana Prince",
      phone: "+919999988888",
      email: "diana@themyscira.com",
    });
    customerId = customer._id;

    // 4. Services
    const category = await ServiceCategory.create({
      organizationId: orgId,
      name: "Spa & Wellness",
    });

    facialService = await Service.create({
      organizationId: orgId,
      categoryId: category._id,
      name: "Hydra Facial",
      pricing: { basePrice: 1000 },
      duration: 45,
      isActive: true,
    });

    massageService = await Service.create({
      organizationId: orgId,
      categoryId: category._id,
      name: "Aromatherapy Massage",
      pricing: { basePrice: 2000 },
      duration: 60,
      isActive: true,
    });

    // 5. Retail Product with Stock Balance
    retailProduct = await Product.create({
      organizationId: orgId,
      name: "Gold Argan Serum",
      sku: "ARGAN-001",
      category: "Haircare",
      stockUnit: "bottle",
      costPrice: 400,
      sellingPrice: 1200,
      usageType: "both",
      status: "active",
    });

    await StockBalance.create({
      organizationId: orgId,
      branchId,
      productId: retailProduct._id,
      onHand: 10,
      onHandRetail: 10,
      allocated: 0,
      allocatedRetail: 0,
      lastMovementAt: new Date(),
    });

    // 6. Subscription Plan (5x Hydra Facial package for ₹4,500)
    subPlan = await SubscriptionPlan.create({
      organizationId: orgId,
      name: "Hydra Facial 5-Session Pack",
      code: "HYDRA5",
      suggestedPrice: 4500,
      validityMonths: 6,
      entitlements: [
        {
          serviceId: facialService._id,
          quantity: 5,
        },
      ],
      permittedBranchIds: [branchId],
      isActive: true,
    });

    // 7. Membership Plan (Gold Membership: 15% off services, 10% off products for ₹2,999)
    membershipPlan = await MembershipPlan.create({
      organizationId: orgId,
      name: "VIP Gold Membership",
      code: "VIPGOLD",
      tier: "Gold",
      price: 2999,
      validityMonths: 12,
      benefits: {
        serviceDiscountPercentage: 15,
        productDiscountPercentage: 10,
        complimentaryPerks: ["Welcome Drink"],
      },
      permittedBranchIds: [branchId],
      isActive: true,
    });
  });

  afterAll(async () => {
    await Invoice.deleteMany({ organizationId: { $in: [orgId, foreignOrgId] } });
    await Payment.deleteMany({ organizationId: { $in: [orgId, foreignOrgId] } });
    await Appointment.deleteMany({ organizationId: { $in: [orgId, foreignOrgId] } });
    await Subscription.deleteMany({ organizationId: { $in: [orgId, foreignOrgId] } });
    await SubscriptionPlan.deleteMany({ organizationId: { $in: [orgId, foreignOrgId] } });
    await SubscriptionUsage.deleteMany({ organizationId: { $in: [orgId, foreignOrgId] } });
    await MembershipPlan.deleteMany({ organizationId: { $in: [orgId, foreignOrgId] } });
    await CustomerMembership.deleteMany({ organizationId: { $in: [orgId, foreignOrgId] } });
    await Product.deleteMany({ organizationId: { $in: [orgId, foreignOrgId] } });
    await StockBalance.deleteMany({ organizationId: { $in: [orgId, foreignOrgId] } });
    await StockMovement.deleteMany({ organizationId: { $in: [orgId, foreignOrgId] } });
    await StockReservation.deleteMany({ organizationId: { $in: [orgId, foreignOrgId] } });
    await Customer.deleteMany({ organizationId: { $in: [orgId, foreignOrgId] } });
    await Service.deleteMany({ organizationId: { $in: [orgId, foreignOrgId] } });
    await ServiceCategory.deleteMany({ organizationId: { $in: [orgId, foreignOrgId] } });
    await Branch.deleteMany({ organizationId: { $in: [orgId, foreignOrgId] } });
    await User.deleteMany({ organizationId: { $in: [orgId, foreignOrgId] } });
    await Role.deleteMany({ organizationId: { $in: [orgId, foreignOrgId] } });
    await Organization.deleteMany({ _id: { $in: [orgId, foreignOrgId] } });
  });

  describe("1. 4-in-1 Unified Invoice Creation & Authoritative Price Resolution", () => {
    it("creates a unified invoice with services, products, subscription plan, and membership plan", async () => {
      const res = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          branchId: branchId.toString(),
          customerId: customerId.toString(),
          serviceLines: [{ serviceId: massageService._id.toString(), quantity: 1, unitPrice: 1 }], // Attempted price tampering to 1
          productLines: [{ productId: retailProduct._id.toString(), quantity: 1, unitPrice: 50 }], // Attempted price tampering to 50
          subscriptionLines: [{ planId: subPlan._id.toString(), price: 100 }], // Attempted price tampering to 100
          membershipLines: [{ membershipPlanId: membershipPlan._id.toString(), quantity: 1, unitPrice: 200 }], // Attempted price tampering to 200
          notes: "Full 4-in-1 bundle checkout",
        });

      if (res.status !== 201) {
        console.error("4-in-1 Creation Failed:", res.body);
      }
      expect(res.status).toBe(201);
      const invoice = res.body.data;
      expect(invoice.lines).toHaveLength(4);

      // Verify authoritative pricing strictly overwritten server-side:
      const sLine = invoice.lines.find((l) => l.lineType === "service");
      const pLine = invoice.lines.find((l) => l.lineType === "product");
      const subLine = invoice.lines.find((l) => l.lineType === "subscription");
      const memLine = invoice.lines.find((l) => l.lineType === "membership");

      expect(sLine.unitPrice).toBe(2000); // Massage price ₹2,000, not ₹1
      expect(pLine.unitPrice).toBe(1200); // Serum price ₹1,200, not ₹50
      expect(subLine.unitPrice).toBe(4500); // Sub plan price ₹4,500, not ₹100
      expect(memLine.unitPrice).toBe(2999); // Mem plan price ₹2,999, not ₹200

      // Pre-evaluated in-cart membership discount (15% on service = 300, 10% on product = 120)
      expect(sLine.isDiscountedByMembership).toBe(true);
      expect(sLine.membershipDiscountAmount).toBe(300);
      expect(pLine.isDiscountedByMembership).toBe(true);
      expect(pLine.membershipDiscountAmount).toBe(120);

      // Total subtotal: 2000 + 1200 + 4500 + 2999 = 10699
      expect(invoice.subtotal).toBe(10699);
      // Total discount: 300 + 120 = 420
      expect(invoice.discountTotal).toBe(420);
      // Customer payable: 10699 - 420 = 10279
      expect(invoice.payableAmount).toBe(10279);

      // Verify stock reservation was established for the retail product
      const balance = await StockBalance.findOne({ branchId, productId: retailProduct._id });
      expect(balance.onHand).toBe(10);
      expect(balance.allocated).toBe(1); // Reserved during draft
    });

    it("rejects invoice containing inactive or foreign organization plans", async () => {
      // Inactive membership plan
      const inactivePlan = await MembershipPlan.create({
        organizationId: orgId,
        name: "Inactive Plan",
        price: 500,
        validityMonths: 1,
        isActive: false,
      });

      const res = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          branchId: branchId.toString(),
          customerId: customerId.toString(),
          membershipLines: [{ membershipPlanId: inactivePlan._id.toString() }],
        });

      expect(res.status).toBe(404);
    });
  });

  describe("2. Same-Appointment Subscription Upsell & Entitlement Waiver", () => {
    let appointment;
    let appointmentInvoiceId;

    beforeAll(async () => {
      const now = new Date();
      const end = new Date(now.getTime() + 45 * 60 * 1000);
      // Create an ongoing appointment for Diana Prince with Hydra Facial (₹1,000)
      appointment = await Appointment.create({
        organizationId: orgId,
        branchId,
        customerId,
        staffId: new mongoose.Types.ObjectId(),
        appointmentCode: `APT-UP-${Date.now().toString().slice(-4)}`,
        bookingType: "walk_in",
        status: "completed",
        startAt: now,
        endAt: end,
        appointmentDate: now.toISOString().slice(0, 10),
        startTime: "10:00",
        endTime: "10:45",
        totalDuration: 45,
        services: [
          {
            serviceType: "registered",
            serviceId: facialService._id,
            name: "Hydra Facial",
            price: 1000,
            duration: 45,
          },
        ],
        pricing: {
          subtotal: 1000,
          discount: 0,
          total: 1000,
        },
      });
    });

    it("creates an appointment invoice with a subscription upsell, waiving the service charge", async () => {
      const res = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          branchId: branchId.toString(),
          appointmentId: appointment._id.toString(),
          subscriptionLines: [{ planId: subPlan._id.toString() }], // Upselling 5-session pack
          notes: "Upsold 5-session pack during treatment",
        });

      if (res.status !== 201) {
        console.error("4-in-1 Creation Failed:", res.body);
      }
      expect(res.status).toBe(201);
      const invoice = res.body.data;
      appointmentInvoiceId = invoice._id;

      // Lines must contain:
      // 1. Service: Hydra Facial (₹1000), but isCoveredBySubscription = true, subscriptionCoveredAmount = 1000, customerPayable = 0
      // 2. Subscription Plan: Hydra Facial 5-Session Pack (₹4500), customerPayable = 4500
      expect(invoice.lines).toHaveLength(2);

      const facialLine = invoice.lines.find((l) => l.lineType === "service");
      const packageLine = invoice.lines.find((l) => l.lineType === "subscription");

      expect(facialLine.unitPrice).toBe(1000);
      expect(facialLine.isCoveredBySubscription).toBe(true);
      expect(facialLine.subscriptionCoveredAmount).toBe(1000);
      expect(facialLine.customerPayable).toBe(0);

      expect(packageLine.unitPrice).toBe(4500);
      expect(packageLine.customerPayable).toBe(4500);

      // Financial breakdown:
      // Subtotal = 1000 (facial) + 4500 (pack) = 5500
      // Subscription coverage = 1000
      // Net customer payable = 4500 (Customer pays ONLY for the package, NOT the facial twice!)
      expect(invoice.subtotal).toBe(5500);
      expect(invoice.subscriptionCoveredAmount).toBe(1000);
      expect(invoice.payableAmount).toBe(4500);
      expect(invoice.status).toBe("draft");

      // Verify subscription is NOT yet created/activated in draft mode
      const activeSubs = await Subscription.find({ customerId, status: "active" });
      expect(activeSubs).toHaveLength(0);
    });

    it("finalizes and pays invoice: activates package and consumes exactly 1 session (4 remain)", async () => {
      // 1. Finalize invoice
      const finalRes = await request(app)
        .post(`/api/v1/billing/invoices/${appointmentInvoiceId}/finalize`)
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .send({});

      expect(finalRes.status).toBe(200);

      // 2. Pay invoice (₹4,500)
      const payRes = await request(app)
        .post(`/api/v1/billing/invoices/${appointmentInvoiceId}/payments`)
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          amount: 4500,
          paymentMethod: "card",
          referenceNote: "Settled upsell package",
          idempotencyKey: `pay_upsell_${appointmentInvoiceId}`,
        });

      expect([200, 201]).toContain(payRes.status);
      const paidInvoice = payRes.body.data.invoice;
      expect(paidInvoice.paymentStatus).toBe("paid");

      // 3. Verify Subscription was instantiated and activated
      const newlyActivatedSub = await Subscription.findOne({
        customerId,
        planId: subPlan._id,
        status: "active",
      });

      expect(newlyActivatedSub).toBeDefined();
      expect(newlyActivatedSub.subscriptionCode).toMatch(/^SUB-/);

      // 4. Verify Entitlements: Total = 5, Used = 1, Remaining = 4
      const facialEntitlement = newlyActivatedSub.entitlements.find(
        (e) => e.serviceId.toString() === facialService._id.toString()
      );
      expect(facialEntitlement).toBeDefined();
      expect(facialEntitlement.totalQuantity).toBe(5);
      expect(facialEntitlement.usedQuantity).toBe(1);
      expect(facialEntitlement.remainingQuantity).toBe(4);

      // 5. Verify immutable SubscriptionUsage audit record was written
      const usageDoc = await SubscriptionUsage.findOne({
        subscriptionId: newlyActivatedSub._id,
        appointmentId: appointment._id,
      });
      expect(usageDoc).toBeDefined();
      expect(usageDoc.quantity).toBe(1);
      expect(usageDoc.serviceName).toBe("Hydra Facial");
    });
  });

  describe("3. Same-Appointment Membership Upsell & Atomic Activation", () => {
    let memAppointment;
    let memInvoiceId;

    beforeAll(async () => {
      const now = new Date();
      const end = new Date(now.getTime() + 60 * 60 * 1000);
      memAppointment = await Appointment.create({
        organizationId: orgId,
        branchId,
        customerId,
        staffId: new mongoose.Types.ObjectId(),
        appointmentCode: `APT-MEM-${Date.now().toString().slice(-4)}`,
        bookingType: "walk_in",
        status: "completed",
        startAt: now,
        endAt: end,
        appointmentDate: now.toISOString().slice(0, 10),
        startTime: "11:00",
        endTime: "12:00",
        totalDuration: 60,
        services: [
          {
            serviceType: "registered",
            serviceId: massageService._id,
            name: "Aromatherapy Massage",
            price: 2000,
            duration: 60,
          },
        ],
        pricing: {
          subtotal: 2000,
          discount: 0,
          total: 2000,
        },
      });
    });

    it("creates appointment invoice with membership upsell, applying 15% tier discount preview", async () => {
      const res = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          branchId: branchId.toString(),
          appointmentId: memAppointment._id.toString(),
          membershipLines: [{ membershipPlanId: membershipPlan._id.toString() }],
          notes: "Upsold VIP Gold membership",
        });

      if (res.status !== 201) {
        console.error("4-in-1 Creation Failed:", res.body);
      }
      expect(res.status).toBe(201);
      const invoice = res.body.data;
      memInvoiceId = invoice._id;

      // Lines:
      // 1. Membership Plan: ₹2999
      // 2. Aromatherapy Massage: ₹2000 - 15% (₹300) = ₹1700
      expect(invoice.lines).toHaveLength(2);

      const massageLine = invoice.lines.find((l) => l.lineType === "service");
      expect(massageLine.isDiscountedByMembership).toBe(true);
      expect(massageLine.membershipDiscountAmount).toBe(300);
      expect(massageLine.customerPayable).toBe(1700);

      // Payable: 2999 + 1700 = 4699
      expect(invoice.payableAmount).toBe(4699);

      // Verify CustomerMembership is NOT yet activated before payment
      const activeMems = await CustomerMembership.find({ customerId, status: "active" });
      expect(activeMems).toHaveLength(0);
    });

    it("finalizes and pays invoice: activates membership and stamps tier snapshot", async () => {
      // Finalize
      await request(app)
        .post(`/api/v1/billing/invoices/${memInvoiceId}/finalize`)
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .send({});

      // Pay
      const payRes = await request(app)
        .post(`/api/v1/billing/invoices/${memInvoiceId}/payments`)
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          amount: 4699,
          paymentMethod: "upi",
          referenceNote: "Paid Gold Membership + Discounted Service",
        });

      expect([200, 201]).toContain(payRes.status);

      // Verify CustomerMembership was activated
      const activatedMem = await CustomerMembership.findOne({
        customerId,
        membershipPlanId: membershipPlan._id,
        status: "active",
      });

      expect(activatedMem).toBeDefined();
      expect(activatedMem.membershipCode).toMatch(/^MEM-/);
      expect(activatedMem.planSnapshot.tier).toBe("Gold");
      expect(activatedMem.planSnapshot.benefits.serviceDiscountPercentage).toBe(15);
    });
  });
});
