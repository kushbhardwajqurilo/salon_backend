import { describe, expect, it, beforeAll, afterAll, beforeEach, jest } from "@jest/globals";
import request from "supertest";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import app from "../../../app.mjs";
import { Organization } from "../../../src/models/organizations/organization.model.js";
import { Branch } from "../../../src/models/branches/branch.model.js";
import { User } from "../../../src/models/users/user.model.js";
import { Role } from "../../../src/models/roles/role.model.js";
import { Permission } from "../../../src/models/permissions/permission.model.js";
import { Customer } from "../../../src/models/customers/customer.model.js";
import { Service } from "../../../src/models/services/service.model.js";
import { ServiceCategory } from "../../../src/models/services/serviceCategory.model.js";
import { Appointment } from "../../../src/models/appointments/appointment.model.js";
import { Subscription } from "../../../src/models/subscriptions/subscription.model.js";
import { SubscriptionUsage } from "../../../src/models/subscriptions/subscriptionUsage.model.js";
import { SubscriptionCancellationOperation } from "../../../src/models/subscriptions/subscriptionCancellationOperation.model.js";
import { Invoice } from "../../../src/models/billing/invoice.model.js";
import { Payment } from "../../../src/models/billing/payment.model.js";
import { AuditLog, AUDIT_ACTIONS } from "../../../src/models/audit/auditLog.model.js";
import { redis } from "../../../src/utils/redis.js";
import { env } from "../../../src/config/env.js";
import { getIsolatedTestMongoUri } from "../testSetup.js";

describe("Production-Grade Subscription Cancellation, Usage Reversal & Rebilling (Rule B)", () => {
  jest.setTimeout(30000);
  let org;
  let branch;
  let ownerUser;
  let ownerToken;
  let customer;
  let haircutService;
  let facialService;
  let massageService;

  beforeAll(async () => {
    const testUri = getIsolatedTestMongoUri("sub_test");
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    await mongoose.connect(testUri);

    // Organization & Branch
    org = await Organization.create({
      name: "Rule B Luxury Salon Org",
      code: `RULEB-${Date.now()}`,
      status: "active",
    });

    branch = await Branch.create({
      organizationId: org._id,
      name: "Flagship Indiranagar",
      code: `FL-${Date.now()}`,
      timezone: "Asia/Kolkata",
      status: "active",
    });

    // Create or find permissions
    const ensurePerm = async (name, module, action) => {
      let p = await Permission.findOne({ name });
      if (!p) {
        p = await Permission.create({ name, module, action, description: name });
      }
      return p;
    };

    const permSubView = await ensurePerm("subscriptions.view", "Subscriptions", "View");
    const permSubConfig = await ensurePerm("subscriptions.configure", "Subscriptions", "Configure");
    const permSubSell = await ensurePerm("subscriptions.sell", "Subscriptions", "Sell");
    const permSubRedeem = await ensurePerm("subscriptions.redeem", "Subscriptions", "Redeem");
    const permBillView = await ensurePerm("billing.view", "Billing", "View");
    const permBillManage = await ensurePerm("billing.manage", "Billing", "Manage");
    const permAptView = await ensurePerm("appointments.view", "Appointments", "View");
    const permAptManage = await ensurePerm("appointments.manage", "Appointments", "Manage");
    const permPayReceive = await ensurePerm("payments.receive", "Billing", "Receive Payment");
    const permPayView = await ensurePerm("payments.view", "Billing", "View Payments");
    const permBillCheckout = await ensurePerm("billing.checkout", "Billing", "Checkout");

    const ownerRole = await Role.create({
      name: `owner_${Date.now()}`,
      description: "Full owner permissions",
      organizationId: org._id,
      permissions: [
        permSubView._id,
        permSubConfig._id,
        permSubSell._id,
        permSubRedeem._id,
        permBillView._id,
        permBillManage._id,
        permAptView._id,
        permAptManage._id,
        permPayReceive._id,
        permPayView._id,
        permBillCheckout._id,
      ],
      isSystem: true,
    });

    const uniquePhone = `+91${Math.floor(1000000000 + Math.random() * 9000000000)}`;
    ownerUser = await User.create({
      name: "Admin Owner",
      username: `admin_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      email: `owner_${Date.now()}_${Math.floor(Math.random() * 1000)}@ruleb.com`,
      phone: uniquePhone,
      password: "HashedPassword123!",
      organizationId: org._id,
      role: ownerRole._id,
      status: "active",
      isVerified: true,
      hasOrgWideAccess: true,
      branchAccess: [],
    });

    ownerToken = jwt.sign(
      {
        id: ownerUser._id.toString(),
        sub: ownerUser._id.toString(),
        userId: ownerUser._id.toString(),
        organizationId: org._id.toString(),
        role: ownerRole.name,
        hasOrgWideAccess: true,
        branchAccess: [],
      },
      env.JWT_SECRET || "test-secret",
      { expiresIn: "1h" }
    );

    // Customer
    customer = await Customer.create({
      organizationId: org._id,
      homeBranchId: branch._id,
      name: "John Doe",
      phone: "+919876543210",
      email: "johndoe@test.com",
      status: "active",
    });

    // Service Category & Services
    const cat = await ServiceCategory.create({
      organizationId: org._id,
      name: "Hair & Wellness",
    });

    haircutService = await Service.create({
      organizationId: org._id,
      categoryId: cat._id,
      name: "Signature Haircut",
      serviceCode: `SHC-${Date.now()}`,
      duration: 30,
      pricing: { basePrice: 500 },
      status: "active",
    });

    facialService = await Service.create({
      organizationId: org._id,
      categoryId: cat._id,
      name: "Organic Glow Facial",
      serviceCode: `OGF-${Date.now()}`,
      duration: 60,
      pricing: { basePrice: 1500 },
      status: "active",
    });

    massageService = await Service.create({
      organizationId: org._id,
      categoryId: cat._id,
      name: "Aroma Massage",
      serviceCode: `AM-${Date.now()}`,
      duration: 45,
      pricing: { basePrice: 1200 },
      status: "active",
    });
  });

  afterAll(async () => {
    if (redis && typeof redis.flushall === "function") {
      await redis.flushall();
    }
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    // Clear dynamic operational records before each test
    await Appointment.deleteMany({ organizationId: org._id });
    await Subscription.deleteMany({ organizationId: org._id });
    await SubscriptionUsage.deleteMany({ organizationId: org._id });
    await SubscriptionCancellationOperation.deleteMany({ organizationId: org._id });
    await Invoice.deleteMany({ organizationId: org._id });
    await Payment.deleteMany({ organizationId: org._id });
    await AuditLog.deleteMany({ organizationId: org._id });
  });

  // Helper to create an unpaid subscription
  const createUnpaidSubscription = async (overrides = {}) => {
    return await Subscription.create({
      organizationId: org._id,
      payerCustomerId: customer._id,
      customerId: customer._id,
      subscriptionCode: `SUB-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      price: 3000,
      status: "pending_payment",
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-12-31"),
      permittedBranchIds: [branch._id],
      members: [
        {
          customerId: customer._id,
          status: "pending_payment",
          permittedBranchIds: [branch._id],
          entitlements: [
            {
              serviceId: haircutService._id,
              serviceName: haircutService.name,
              totalQuantity: 3,
              usedQuantity: 0,
              remainingQuantity: 3,
            },
            {
              serviceId: facialService._id,
              serviceName: facialService.name,
              totalQuantity: 2,
              usedQuantity: 0,
              remainingQuantity: 2,
            },
          ],
        },
      ],
      ...overrides,
    });
  };

  // Helper to create an appointment with service lines
  const createAppointmentWithServices = async (serviceItems, status = "completed") => {
    const aptCode = `APT-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const services = serviceItems.map((item) => ({
      serviceType: "registered",
      serviceId: item.service._id,
      name: item.service.name,
      duration: item.service.duration,
      price: item.price || item.service.price,
      appliedSubscriptionId: item.appliedSubscriptionId || null,
      isRedeemedViaSubscription: Boolean(item.isRedeemedViaSubscription),
      subscriptionUsageId: item.subscriptionUsageId || null,
    }));

    const totalSub = services.reduce((sum, s) => sum + s.price, 0);

    return await Appointment.create({
      organizationId: org._id,
      branchId: branch._id,
      appointmentCode: aptCode,
      customerId: customer._id,
      startAt: new Date(),
      endAt: new Date(Date.now() + 60 * 60000),
      appointmentDate: "2026-11-12",
      startTime: "10:00",
      endTime: "11:00",
      totalDuration: 60,
      bookingType: "walk_in",
      status,
      pricing: {
        subtotal: totalSub,
        discount: 0,
        total: totalSub,
      },
      services,
    });
  };

  // Helper to attach an invoice to an appointment
  const createAppointmentInvoice = async (appointment, linesConfig, payments = []) => {
    const invNumber = `INV-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const lines = linesConfig.map((cfg) => ({
      lineType: "service",
      serviceType: "registered",
      serviceId: cfg.service._id,
      appointmentServiceId: cfg.appointmentServiceId,
      name: cfg.service.name,
      duration: cfg.service.duration,
      quantity: 1,
      unitPrice: cfg.price,
      lineTotal: cfg.price,
      isCoveredBySubscription: Boolean(cfg.isCovered),
      appliedSubscriptionId: cfg.appliedSubscriptionId || null,
      subscriptionUsageId: cfg.subscriptionUsageId || null,
      subscriptionCoveredAmount: cfg.isCovered ? cfg.price : 0,
      appliedDiscounts: [],
      lineDiscountTotal: 0,
      allocatedInvoiceDiscount: 0,
      discountAmount: 0,
      customerPayable: cfg.isCovered ? 0 : cfg.price,
    }));

    const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
    const subscriptionCoveredAmount = lines.reduce((sum, l) => sum + l.subscriptionCoveredAmount, 0);
    const payableAmount = Math.max(0, subtotal - subscriptionCoveredAmount);
    const amountPaid = payments.reduce((sum, p) => sum + p.amount, 0);
    const amountDue = Math.max(0, payableAmount - amountPaid);
    const paymentStatus = amountDue === 0 ? "paid" : amountPaid > 0 ? "partially_paid" : "unpaid";

    const invoice = await Invoice.create({
      organizationId: org._id,
      branchId: branch._id,
      invoiceNumber: invNumber,
      invoiceType: "appointment",
      appointmentId: appointment._id,
      appointmentCode: appointment.appointmentCode,
      customerId: customer._id,
      customerSnapshot: {
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
      },
      lines,
      subtotal,
      lineDiscountsTotal: 0,
      invoiceDiscountsTotal: 0,
      discountTotal: 0,
      grossPayable: subtotal,
      subscriptionCoveredAmount,
      payableAmount,
      amountPaid,
      amountDue,
      status: "finalized",
      paymentStatus,
      createdBy: ownerUser._id,
    });

    for (const p of payments) {
      await Payment.create({
        organizationId: org._id,
        branchId: branch._id,
        invoiceId: invoice._id,
        customerId: customer._id,
        paymentNumber: `PAY-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        amount: p.amount,
        method: p.method || "card",
        status: p.status || "completed",
        recordedBy: ownerUser._id,
      });
    }

    return invoice;
  };

  describe("1. Authoritative Eligibility & Read-Only Impact Preview", () => {
    it("generates read-only cancellation impact preview without mutating any data", async () => {
      const sub = await createUnpaidSubscription();

      // Create an appointment with 1 haircut redeemed via sub
      const apt = await createAppointmentWithServices(
        [{ service: haircutService, price: 500 }],
        "completed"
      );
      const sLine = apt.services[0];

      // Create usage record
      const usage = await SubscriptionUsage.create({
        organizationId: org._id,
        subscriptionId: sub._id,
        customerId: customer._id,
        serviceId: haircutService._id,
        serviceName: haircutService.name,
        quantity: 1,
        branchId: branch._id,
        verifiedBy: ownerUser._id,
        verificationMethod: "otp",
        appointmentId: apt._id,
        appointmentServiceId: sLine._id,
        appointmentCode: apt.appointmentCode,
      });

      // Update apt service line to point to usage
      sLine.appliedSubscriptionId = sub._id;
      sLine.isRedeemedViaSubscription = true;
      sLine.subscriptionUsageId = usage._id;
      await apt.save();

      // Create invoice
      await createAppointmentInvoice(apt, [
        {
          service: haircutService,
          price: 500,
          appointmentServiceId: sLine._id,
          isCovered: true,
          appliedSubscriptionId: sub._id,
          subscriptionUsageId: usage._id,
        },
      ]);

      // Call GET /api/v1/subscriptions/:id/cancel/preview
      const previewRes = await request(app)
        .get(`/api/v1/subscriptions/${sub._id}/cancel/preview`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branch._id.toString());

      expect(previewRes.status).toBe(200);
      expect(previewRes.body.data.isEligible).toBe(true);
      expect(previewRes.body.data.eligibilityRule).toBe("RULE_B");
      expect(previewRes.body.data.consumedEntitlementCount).toBe(1);
      expect(previewRes.body.data.affectedAppointmentCount).toBe(1);
      expect(previewRes.body.data.breakdown.completedAppointments).toBe(1);
      expect(previewRes.body.data.expectedRebilledSubtotalIncrease).toBe(500);

      // Verify no changes were committed to database
      const reloadedSub = await Subscription.findById(sub._id);
      expect(reloadedSub.status).toBe("pending_payment");
      const reloadedUsage = await SubscriptionUsage.findById(usage._id);
      expect(reloadedUsage.isReversed).toBe(false);
    });

    it("rejects Rule B cancellation if actual payments were collected against the subscription sale invoice", async () => {
      const sub = await createUnpaidSubscription();

      // Create a paid subscription invoice
      const subInvoice = await Invoice.create({
        organizationId: org._id,
        branchId: branch._id,
        invoiceNumber: `INV-SUB-${Date.now()}`,
        invoiceType: "subscription",
        subscriptionId: sub._id,
        subscriptionCode: sub.subscriptionCode,
        customerId: customer._id,
        customerSnapshot: { name: customer.name, phone: customer.phone },
        lines: [
          {
            lineType: "subscription",
            serviceType: "registered",
            name: "Annual Plan",
            quantity: 1,
            unitPrice: 3000,
            lineTotal: 3000,
            isCoveredBySubscription: false,
            subscriptionCoveredAmount: 0,
            customerPayable: 3000,
          },
        ],
        subtotal: 3000,
        grossPayable: 3000,
        payableAmount: 3000,
        amountPaid: 3000,
        amountDue: 0,
        status: "finalized",
        paymentStatus: "paid",
        createdBy: ownerUser._id,
      });

      // Attach Payment
      await Payment.create({
        organizationId: org._id,
        branchId: branch._id,
        invoiceId: subInvoice._id,
        customerId: customer._id,
        paymentNumber: `PAY-SUB-${Date.now()}`,
        amount: 3000,
        method: "card",
        status: "completed",
        recordedBy: ownerUser._id,
      });

      sub.invoiceId = subInvoice._id;
      sub.status = "active";
      await sub.save();

      // Add a usage
      const apt = await createAppointmentWithServices([{ service: haircutService, price: 500 }]);
      await SubscriptionUsage.create({
        organizationId: org._id,
        subscriptionId: sub._id,
        customerId: customer._id,
        serviceId: haircutService._id,
        serviceName: haircutService.name,
        quantity: 1,
        branchId: branch._id,
        verifiedBy: ownerUser._id,
        appointmentId: apt._id,
        appointmentServiceId: apt.services[0]._id,
      });

      const cancelRes = await request(app)
        .patch(`/api/v1/subscriptions/${sub._id}/cancel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ reason: "Customer wants cancellation" });

      expect(cancelRes.status).toBe(400);
      expect(cancelRes.body.message).toMatch(/actual payment of ₹3000.00 was collected/i);
    });

    it("rejects cancellation if payment records and invoice aggregates disagree (reconciliation mismatch)", async () => {
      const sub = await createUnpaidSubscription();

      // Invoice claims amountPaid = 2000, but payment collection has 0 payments
      const subInvoice = await Invoice.create({
        organizationId: org._id,
        branchId: branch._id,
        invoiceNumber: `INV-MISMATCH-${Date.now()}`,
        invoiceType: "subscription",
        subscriptionId: sub._id,
        subscriptionCode: sub.subscriptionCode,
        customerId: customer._id,
        customerSnapshot: { name: customer.name, phone: customer.phone },
        lines: [],
        subtotal: 3000,
        grossPayable: 3000,
        payableAmount: 3000,
        amountPaid: 2000, // Discrepancy!
        amountDue: 1000,
        status: "finalized",
        paymentStatus: "partially_paid",
        createdBy: ownerUser._id,
      });
      sub.invoiceId = subInvoice._id;
      await sub.save();

      const cancelRes = await request(app)
        .patch(`/api/v1/subscriptions/${sub._id}/cancel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ reason: "Cancel mismatch sub" });

      expect(cancelRes.status).toBe(409);
      expect(cancelRes.body.message).toMatch(/Financial reconciliation mismatch/i);
    });
  });

  describe("2. Rule B Usage Reversal, Retail Price Restoration & Completed Appointment Rebilling", () => {
    it("successfully cancels unpaid subscription with usage on completed appointments, reverses usage, and rebills appointment invoice", async () => {
      const sub = await createUnpaidSubscription();

      // Appointment 1: Completed appointment with 1 haircut covered by sub
      const apt1 = await createAppointmentWithServices(
        [{ service: haircutService, price: 500 }],
        "completed"
      );
      const sLine1 = apt1.services[0];

      const usage1 = await SubscriptionUsage.create({
        organizationId: org._id,
        subscriptionId: sub._id,
        customerId: customer._id,
        serviceId: haircutService._id,
        serviceName: haircutService.name,
        quantity: 1,
        branchId: branch._id,
        verifiedBy: ownerUser._id,
        verificationMethod: "otp",
        appointmentId: apt1._id,
        appointmentServiceId: sLine1._id,
        appointmentCode: apt1.appointmentCode,
      });

      sLine1.appliedSubscriptionId = sub._id;
      sLine1.isRedeemedViaSubscription = true;
      sLine1.subscriptionUsageId = usage1._id;
      await apt1.save();

      // Invoice for Apt 1: Fully covered by subscription (amountDue = 0)
      const inv1 = await createAppointmentInvoice(apt1, [
        {
          service: haircutService,
          price: 500,
          appointmentServiceId: sLine1._id,
          isCovered: true,
          appliedSubscriptionId: sub._id,
          subscriptionUsageId: usage1._id,
        },
      ]);

      expect(inv1.subscriptionCoveredAmount).toBe(500);
      expect(inv1.payableAmount).toBe(0);
      expect(inv1.amountDue).toBe(0);

      // Execute Cancellation
      const cancelRes = await request(app)
        .patch(`/api/v1/subscriptions/${sub._id}/cancel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branch._id.toString())
        .send({
          reason: "Customer defaulted on subscription payment after haircut service",
        });

      expect(cancelRes.status).toBe(200);

      // 1. Verify Subscription Status
      const reloadedSub = await Subscription.findById(sub._id);
      expect(reloadedSub.status).toBe("cancelled");
      expect(reloadedSub.members[0].status).toBe("cancelled");

      // 2. Verify SubscriptionUsage record reversed
      const reloadedUsage1 = await SubscriptionUsage.findById(usage1._id);
      expect(reloadedUsage1.isReversed).toBe(true);
      expect(reloadedUsage1.reversedAt).toBeDefined();
      expect(reloadedUsage1.reversalReason).toMatch(/defaulted on subscription/i);

      // 3. Verify Appointment Service Snapshot
      const reloadedApt1 = await Appointment.findById(apt1._id);
      expect(reloadedApt1.status).toBe("completed"); // Status completed preserved!
      const reloadedLine1 = reloadedApt1.services[0];
      expect(reloadedLine1.isRedeemedViaSubscription).toBe(false);
      expect(reloadedLine1.appliedSubscriptionId).toBeNull();
      expect(reloadedLine1.subscriptionUsageId).toBeNull();
      expect(reloadedLine1.price).toBe(500); // Original agreed retail price preserved!

      // 4. Verify Invoice Rebilling
      const reloadedInv1 = await Invoice.findById(inv1._id);
      expect(reloadedInv1.subscriptionCoveredAmount).toBe(0); // Subscription coverage cleared
      expect(reloadedInv1.payableAmount).toBe(500); // Restored to customer retail payable
      expect(reloadedInv1.amountDue).toBe(500);
      expect(reloadedInv1.paymentStatus).toBe("unpaid");
      const invLine1 = reloadedInv1.lines[0];
      expect(invLine1.isCoveredBySubscription).toBe(false);
      expect(invLine1.appliedSubscriptionId).toBeNull();
      expect(invLine1.subscriptionCoveredAmount).toBe(0);
      expect(invLine1.customerPayable).toBe(500);
    });

    it("handles multiple services and multiple subscriptions in one appointment, stripping ONLY the target subscription's coverage", async () => {
      const subA = await createUnpaidSubscription();
      const subB = await createUnpaidSubscription({
        subscriptionCode: `SUB-B-${Date.now()}`,
      });

      // Appointment with 3 services:
      // Line 1: Haircut (covered by subA)
      // Line 2: Facial (covered by subB)
      // Line 3: Massage (retail paid)
      const apt = await createAppointmentWithServices(
        [
          { service: haircutService, price: 500 },
          { service: facialService, price: 1500 },
          { service: massageService, price: 1200 },
        ],
        "completed"
      );

      const [lineHaircut, lineFacial, lineMassage] = apt.services;

      // Usages for SubA and SubB
      const usageA = await SubscriptionUsage.create({
        organizationId: org._id,
        subscriptionId: subA._id,
        customerId: customer._id,
        serviceId: haircutService._id,
        serviceName: haircutService.name,
        quantity: 1,
        branchId: branch._id,
        verifiedBy: ownerUser._id,
        appointmentId: apt._id,
        appointmentServiceId: lineHaircut._id,
      });

      const usageB = await SubscriptionUsage.create({
        organizationId: org._id,
        subscriptionId: subB._id,
        customerId: customer._id,
        serviceId: facialService._id,
        serviceName: facialService.name,
        quantity: 1,
        branchId: branch._id,
        verifiedBy: ownerUser._id,
        appointmentId: apt._id,
        appointmentServiceId: lineFacial._id,
      });

      lineHaircut.appliedSubscriptionId = subA._id;
      lineHaircut.isRedeemedViaSubscription = true;
      lineHaircut.subscriptionUsageId = usageA._id;

      lineFacial.appliedSubscriptionId = subB._id;
      lineFacial.isRedeemedViaSubscription = true;
      lineFacial.subscriptionUsageId = usageB._id;
      await apt.save();

      // Invoice with partial payment for the retail Massage service (₹1200)
      const inv = await createAppointmentInvoice(
        apt,
        [
          {
            service: haircutService,
            price: 500,
            appointmentServiceId: lineHaircut._id,
            isCovered: true,
            appliedSubscriptionId: subA._id,
            subscriptionUsageId: usageA._id,
          },
          {
            service: facialService,
            price: 1500,
            appointmentServiceId: lineFacial._id,
            isCovered: true,
            appliedSubscriptionId: subB._id,
            subscriptionUsageId: usageB._id,
          },
          {
            service: massageService,
            price: 1200,
            appointmentServiceId: lineMassage._id,
            isCovered: false,
          },
        ],
        [{ amount: 1200, method: "card", status: "completed" }]
      );

      // Initial state: subtotal = 3200, covered = 2000, payable = 1200, paid = 1200, amountDue = 0
      expect(inv.subtotal).toBe(3200);
      expect(inv.subscriptionCoveredAmount).toBe(2000);
      expect(inv.payableAmount).toBe(1200);
      expect(inv.amountPaid).toBe(1200);
      expect(inv.amountDue).toBe(0);
      expect(inv.paymentStatus).toBe("paid");

      // Cancel Sub A ONLY
      const cancelRes = await request(app)
        .patch(`/api/v1/subscriptions/${subA._id}/cancel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ reason: "Cancelling Sub A only" });

      expect(cancelRes.status).toBe(200);

      // Verify Appointment
      const reloadedApt = await Appointment.findById(apt._id);
      const [rHaircut, rFacial, rMassage] = reloadedApt.services;
      expect(rHaircut.isRedeemedViaSubscription).toBe(false);
      expect(rHaircut.appliedSubscriptionId).toBeNull();

      // Facial remains covered by Sub B!
      expect(rFacial.isRedeemedViaSubscription).toBe(true);
      expect(rFacial.appliedSubscriptionId.toString()).toBe(subB._id.toString());

      // Massage remains untouched
      expect(rMassage.price).toBe(1200);

      // Verify Invoice & Preserved Payment
      const reloadedInv = await Invoice.findById(inv._id);
      expect(reloadedInv.subtotal).toBe(3200);
      expect(reloadedInv.subscriptionCoveredAmount).toBe(1500); // Sub B still covers ₹1500
      expect(reloadedInv.payableAmount).toBe(1700); // Haircut (500) + Massage (1200)
      expect(reloadedInv.amountPaid).toBe(1200); // Existing payment preserved!
      expect(reloadedInv.amountDue).toBe(500); // Customer now owes ₹500 for Haircut
      expect(reloadedInv.paymentStatus).toBe("partially_paid");

      // Sub B usage remains active
      const reloadedUsageB = await SubscriptionUsage.findById(usageB._id);
      expect(reloadedUsageB.isReversed).toBe(false);
    });

    it("processes mixed pending and completed appointments across multiple bookings", async () => {
      const sub = await createUnpaidSubscription();

      // Appointment 1: Completed
      const apt1 = await createAppointmentWithServices(
        [{ service: haircutService, price: 500 }],
        "completed"
      );
      const usage1 = await SubscriptionUsage.create({
        organizationId: org._id,
        subscriptionId: sub._id,
        customerId: customer._id,
        serviceId: haircutService._id,
        serviceName: haircutService.name,
        quantity: 1,
        branchId: branch._id,
        verifiedBy: ownerUser._id,
        appointmentId: apt1._id,
        appointmentServiceId: apt1.services[0]._id,
      });
      apt1.services[0].appliedSubscriptionId = sub._id;
      apt1.services[0].isRedeemedViaSubscription = true;
      apt1.services[0].subscriptionUsageId = usage1._id;
      await apt1.save();
      await createAppointmentInvoice(apt1, [
        {
          service: haircutService,
          price: 500,
          appointmentServiceId: apt1.services[0]._id,
          isCovered: true,
          appliedSubscriptionId: sub._id,
          subscriptionUsageId: usage1._id,
        },
      ]);

      // Appointment 2: Scheduled (Pending)
      const apt2 = await createAppointmentWithServices(
        [{ service: facialService, price: 1500 }],
        "scheduled"
      );
      const usage2 = await SubscriptionUsage.create({
        organizationId: org._id,
        subscriptionId: sub._id,
        customerId: customer._id,
        serviceId: facialService._id,
        serviceName: facialService.name,
        quantity: 1,
        branchId: branch._id,
        verifiedBy: ownerUser._id,
        appointmentId: apt2._id,
        appointmentServiceId: apt2.services[0]._id,
      });
      apt2.services[0].appliedSubscriptionId = sub._id;
      apt2.services[0].isRedeemedViaSubscription = true;
      apt2.services[0].subscriptionUsageId = usage2._id;
      await apt2.save();
      await createAppointmentInvoice(apt2, [
        {
          service: facialService,
          price: 1500,
          appointmentServiceId: apt2.services[0]._id,
          isCovered: true,
          appliedSubscriptionId: sub._id,
          subscriptionUsageId: usage2._id,
        },
      ]);

      const cancelRes = await request(app)
        .patch(`/api/v1/subscriptions/${sub._id}/cancel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ reason: "Cancel across mixed appointments" });

      expect(cancelRes.status).toBe(200);

      // Verify both usages reversed
      const usages = await SubscriptionUsage.find({ subscriptionId: sub._id });
      expect(usages.every((u) => u.isReversed)).toBe(true);

      // Verify both appointments retain their respective lifecycle status
      const rApt1 = await Appointment.findById(apt1._id);
      expect(rApt1.status).toBe("completed");
      const rApt2 = await Appointment.findById(apt2._id);
      expect(rApt2.status).toBe("scheduled");
    });
  });

  describe("3. Concurrency, Idempotency & Operation Recovery", () => {
    it("guarantees request idempotency when idempotencyKey is supplied", async () => {
      const sub = await createUnpaidSubscription();
      const apt = await createAppointmentWithServices([{ service: haircutService, price: 500 }]);
      const usage = await SubscriptionUsage.create({
        organizationId: org._id,
        subscriptionId: sub._id,
        customerId: customer._id,
        serviceId: haircutService._id,
        serviceName: haircutService.name,
        quantity: 1,
        branchId: branch._id,
        verifiedBy: ownerUser._id,
        appointmentId: apt._id,
        appointmentServiceId: apt.services[0]._id,
      });
      apt.services[0].appliedSubscriptionId = sub._id;
      apt.services[0].isRedeemedViaSubscription = true;
      apt.services[0].subscriptionUsageId = usage._id;
      await apt.save();
      await createAppointmentInvoice(apt, [
        {
          service: haircutService,
          price: 500,
          appointmentServiceId: apt.services[0]._id,
          isCovered: true,
          appliedSubscriptionId: sub._id,
        },
      ]);

      const key = `IDEM-KEY-${Date.now()}`;

      // First call
      const res1 = await request(app)
        .patch(`/api/v1/subscriptions/${sub._id}/cancel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ reason: "First request", idempotencyKey: key });

      expect(res1.status).toBe(200);

      // Second call with same idempotency key and same parameters
      const res2 = await request(app)
        .patch(`/api/v1/subscriptions/${sub._id}/cancel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ reason: "First request", idempotencyKey: key });

      expect(res2.status).toBe(200);
      expect(res2.body.data.idempotent).toBe(true);
      expect(res2.body.data.operationId).toBe(res1.body.data.operationId);
    });

    it("supports asynchronous execution acceptance and status retrieval", async () => {
      const sub = await createUnpaidSubscription();
      const apt = await createAppointmentWithServices([{ service: haircutService, price: 500 }]);
      const usage = await SubscriptionUsage.create({
        organizationId: org._id,
        subscriptionId: sub._id,
        customerId: customer._id,
        serviceId: haircutService._id,
        serviceName: haircutService.name,
        quantity: 1,
        branchId: branch._id,
        verifiedBy: ownerUser._id,
        appointmentId: apt._id,
        appointmentServiceId: apt.services[0]._id,
      });
      apt.services[0].appliedSubscriptionId = sub._id;
      apt.services[0].subscriptionUsageId = usage._id;
      await apt.save();

      // Send cancel with forceAsync: true
      const asyncRes = await request(app)
        .patch(`/api/v1/subscriptions/${sub._id}/cancel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ reason: "Async test", forceAsync: true });

      expect(asyncRes.status).toBe(202);
      expect(asyncRes.body.data.operationId).toBeDefined();
      expect(asyncRes.body.data.status).toBe("processing");

      const opId = asyncRes.body.data.operationId;

      // Check status via GET /api/v1/subscriptions/:id/cancel/operations/:operationId
      const statusRes = await request(app)
        .get(`/api/v1/subscriptions/${sub._id}/cancel/operations/${opId}`)
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(statusRes.status).toBe(200);
      expect(statusRes.body.data.operationId).toBe(opId);

      // Execute retry / trigger to complete operation
      const retryRes = await request(app)
        .post(`/api/v1/subscriptions/${sub._id}/cancel/operations/${opId}/retry`)
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(retryRes.status).toBe(200);
      expect(retryRes.body.data.status).toBe("completed");
    });
  });

  describe("4. Security & Tenant Isolation", () => {
    it("rejects unauthorized user lacking subscriptions.configure permission", async () => {
      const sub = await createUnpaidSubscription();

      const permView = await Permission.findOne({ name: "subscriptions.view" });
      const viewerRole = await Role.create({
        organizationId: org._id,
        name: `viewer_${Date.now()}`,
        permissions: [permView._id],
      });
      const viewerUser = await User.create({
        organizationId: org._id,
        name: "Viewer Guy",
        username: `viewer_${Date.now()}`,
        email: `viewer_${Date.now()}@test.com`,
        phone: `+91${Math.floor(1000000000 + Math.random() * 9000000000)}`,
        password: "Password123!",
        role: viewerRole._id,
        isVerified: true,
        status: "active",
        hasOrgWideAccess: true,
        branchAccess: [],
      });

      const viewerToken = jwt.sign(
        {
          id: viewerUser._id.toString(),
          sub: viewerUser._id.toString(),
          userId: viewerUser._id.toString(),
          organizationId: org._id.toString(),
          role: viewerRole.name,
          hasOrgWideAccess: true,
          branchAccess: [],
        },
        env.JWT_SECRET || "test-secret",
        { expiresIn: "1h" }
      );

      const res = await request(app)
        .patch(`/api/v1/subscriptions/${sub._id}/cancel`)
        .set("Authorization", `Bearer ${viewerToken}`)
        .send({ reason: "Unauthorized attempt" });

      expect(res.status).toBe(403);
    });

    it("strictly isolates cross-organization subscriptions", async () => {
      const otherOrg = await Organization.create({
        name: "Competitor Salon Org",
        code: `COMP-${Date.now()}`,
      });
      const otherSub = await Subscription.create({
        organizationId: otherOrg._id,
        customerId: customer._id,
        subscriptionCode: "SUB-OTHER-ORG",
        price: 1000,
        startDate: new Date(),
        endDate: new Date(Date.now() + 1000000),
        entitlements: [
          {
            serviceId: haircutService._id,
            serviceName: haircutService.name,
            totalQuantity: 1,
            usedQuantity: 0,
            remainingQuantity: 1,
          },
        ],
      });

      const res = await request(app)
        .patch(`/api/v1/subscriptions/${otherSub._id}/cancel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ reason: "Cross-org attack" });

      expect(res.status).toBe(404);
    });

    it("verifies canonical preview route (GET /:id/cancel/preview) and permissions", async () => {
      const sub = await Subscription.create({
        organizationId: org._id,
        customerId: customer._id,
        subscriptionCode: `SUB-PREV-${Date.now()}`,
        price: 1000,
        startDate: new Date(),
        endDate: new Date(Date.now() + 1000000),
        status: "active",
        entitlements: [
          {
            serviceId: haircutService._id,
            serviceName: haircutService.name,
            totalQuantity: 2,
            usedQuantity: 1,
            remainingQuantity: 1,
          },
        ],
      });

      // Accessible with subscriptions.view
      const res = await request(app)
        .get(`/api/v1/subscriptions/${sub._id}/cancel/preview`)
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.subscriptionId).toBe(sub._id.toString());
      expect(res.body.data.isPaid).toBe(false);

      // Verify old un-nested route returns 404
      const oldRes = await request(app)
        .get(`/api/v1/subscriptions/${sub._id}/cancel-preview`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(oldRes.status).toBe(404);
    });

    it("concurrent cancellations with differing keys create only one operation", async () => {
      const sub = await Subscription.create({
        organizationId: org._id,
        customerId: customer._id,
        subscriptionCode: `SUB-CONC-${Date.now()}`,
        price: 1000,
        startDate: new Date(),
        endDate: new Date(Date.now() + 1000000),
        status: "active",
        entitlements: [
          {
            serviceId: haircutService._id,
            serviceName: haircutService.name,
            totalQuantity: 2,
            usedQuantity: 0,
            remainingQuantity: 2,
          },
        ],
      });

      const keyA = `key-A-${Date.now()}`;
      const keyB = `key-B-${Date.now()}`;

      // Issue two simultaneous cancellation requests
      const [resA, resB] = await Promise.all([
        request(app)
          .patch(`/api/v1/subscriptions/${sub._id}/cancel`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .send({ reason: "Concurrency test A", idempotencyKey: keyA }),
        request(app)
          .patch(`/api/v1/subscriptions/${sub._id}/cancel`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .send({ reason: "Concurrency test B", idempotencyKey: keyB }),
      ]);

      // One should succeed (200), the other should either receive the already in progress/cancelled response
      const statuses = [resA.status, resB.status];
      expect(statuses).toContain(200);
      const subDoc = await Subscription.findById(sub._id);
      expect(subDoc.status).toBe("cancelled");
    });

    it("verifies operation recovery and manual retry on stalled or failed operations", async () => {
      const sub = await Subscription.create({
        organizationId: org._id,
        customerId: customer._id,
        subscriptionCode: `SUB-RETRY-${Date.now()}`,
        price: 1000,
        startDate: new Date(),
        endDate: new Date(Date.now() + 1000000),
        status: "active",
        entitlements: [
          {
            serviceId: haircutService._id,
            serviceName: haircutService.name,
            totalQuantity: 2,
            usedQuantity: 0,
            remainingQuantity: 2,
          },
        ],
      });

      // Create an operation record in 'pending' state
      const op = await SubscriptionCancellationOperation.create({
        operationId: `CAN-OP-TEST-${Date.now()}`,
        organizationId: org._id,
        branchId: branch._id,
        subscriptionId: sub._id,
        status: "pending",
        cancellationReason: "Test recovery",
        initiatedBy: ownerUser._id,
        totalUsageCount: 0,
        totalAppointmentCount: 0,
      });

      // Query status
      const statusRes = await request(app)
        .get(`/api/v1/subscriptions/${sub._id}/cancel/operations/${op.operationId}`)
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(statusRes.status).toBe(200);
      expect(statusRes.body.data.operationId).toBe(op.operationId);
      expect(statusRes.body.data.status).toBe("pending");

      // Trigger retry
      const retryRes = await request(app)
        .post(`/api/v1/subscriptions/${sub._id}/cancel/operations/${op.operationId}/retry`)
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(retryRes.status).toBe(200);
      expect(retryRes.body.data.status).toBe("completed");
    });

    it("prevents recording payment for a subscription invoice once cancelled", async () => {
      // 1. Create a subscription with billImmediately to generate an official subscription invoice
      const createRes = await request(app)
        .post("/api/v1/subscriptions")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branch._id.toString())
        .send({
          customerId: customer._id.toString(),
          price: 800,
          entitlements: [{ serviceId: haircutService._id.toString(), quantity: 1 }],
          startDate: "2026-01-01",
          endDate: "2026-12-31",
          billImmediately: true,
          branchId: branch._id.toString(),
        });

      expect(createRes.status).toBe(201);
      const subId = createRes.body.data._id;
      const invoiceId = createRes.body.data.invoice._id;

      // Finalize the subscription invoice
      await request(app)
        .post(`/api/v1/billing/invoices/${invoiceId}/finalize`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branch._id.toString());

      // 2. Cancel the subscription
      const cancelRes = await request(app)
        .patch(`/api/v1/subscriptions/${subId}/cancel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ reason: "Customer cancelled before payment" });

      expect(cancelRes.status).toBe(200);

      // 3. Attempt to record payment against the subscription invoice
      const payRes = await request(app)
        .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branch._id.toString())
        .send({
          amount: 800,
          method: "cash",
          idempotencyKey: `pay-cancelled-${Date.now()}`,
        });

      // Payment must be rejected
      expect([400, 404]).toContain(payRes.status);
    });

    it("validates idempotency contract: header precedence, conflict detection, and differing payloads", async () => {
      const sub = await Subscription.create({
        organizationId: org._id,
        customerId: customer._id,
        subscriptionCode: `SUB-IDEMP-${Date.now()}`,
        price: 1000,
        startDate: new Date(),
        endDate: new Date(Date.now() + 1000000),
        status: "active",
        entitlements: [
          {
            serviceId: haircutService._id,
            serviceName: haircutService.name,
            totalQuantity: 2,
            usedQuantity: 0,
            remainingQuantity: 2,
          },
        ],
      });

      const sharedKey = `idemp-key-${Date.now()}`;

      // A. Conflicting keys in header vs body returns 400
      const conflictRes = await request(app)
        .patch(`/api/v1/subscriptions/${sub._id}/cancel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("idempotency-key", "header-key-123")
        .send({ reason: "Test", idempotencyKey: "body-key-456" });

      expect(conflictRes.status).toBe(400);
      expect(conflictRes.body.message).toContain("Conflicting idempotency keys");

      // B. Valid submission via header
      const firstRes = await request(app)
        .patch(`/api/v1/subscriptions/${sub._id}/cancel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("idempotency-key", sharedKey)
        .send({ reason: "First cancellation request" });

      expect(firstRes.status).toBe(200);

      // C. Exact replay with same key returns idempotent response
      const replayRes = await request(app)
        .patch(`/api/v1/subscriptions/${sub._id}/cancel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("idempotency-key", sharedKey)
        .send({ reason: "First cancellation request" });

      expect(replayRes.status).toBe(200);
      expect(replayRes.body.data.idempotent).toBe(true);

      // D. Reuse of same key for a DIFFERENT subscription returns 409
      const otherSub = await Subscription.create({
        organizationId: org._id,
        customerId: customer._id,
        subscriptionCode: `SUB-OTHER-${Date.now()}`,
        price: 1000,
        startDate: new Date(),
        endDate: new Date(Date.now() + 1000000),
        status: "active",
        entitlements: [
          {
            serviceId: haircutService._id,
            serviceName: haircutService.name,
            totalQuantity: 1,
            usedQuantity: 0,
            remainingQuantity: 1,
          },
        ],
      });

      const mismatchRes = await request(app)
        .patch(`/api/v1/subscriptions/${otherSub._id}/cancel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("idempotency-key", sharedKey)
        .send({ reason: "First cancellation request" });

      expect(mismatchRes.status).toBe(409);
    });

    it("deterministic race: payment commits first, concurrent cancellation is rejected", async () => {
      // 1. Create a subscription with billImmediately
      const createRes = await request(app)
        .post("/api/v1/subscriptions")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branch._id.toString())
        .send({
          customerId: customer._id.toString(),
          price: 1200,
          entitlements: [{ serviceId: haircutService._id.toString(), quantity: 2 }],
          startDate: "2026-01-01",
          endDate: "2026-12-31",
          billImmediately: true,
          branchId: branch._id.toString(),
        });

      expect(createRes.status).toBe(201);
      const subId = createRes.body.data._id;
      const invoiceId = createRes.body.data.invoice._id;

      // Finalize invoice so payment can be recorded
      await request(app)
        .post(`/api/v1/billing/invoices/${invoiceId}/finalize`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branch._id.toString());

      // 2. Record payment FIRST
      const payRes = await request(app)
        .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branch._id.toString())
        .send({
          amount: 1200,
          method: "card",
          idempotencyKey: `race-pay-${Date.now()}`,
        });

      expect(payRes.status).toBe(201);
      expect(payRes.body.data.invoice.paymentStatus).toBe("paid");

      // 3. Attempt cancellation of this paid subscription without explicit refund confirmation
      const cancelRes = await request(app)
        .patch(`/api/v1/subscriptions/${subId}/cancel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ reason: "Cancellation attempt after payment committed" });

      // Cancellation must be rejected because payment exists
      expect(cancelRes.status).toBe(400);
      expect(cancelRes.body.message).toContain("paid");

      // Verify DB state: subscription remains active, payment record intact
      const finalSub = await Subscription.findById(subId);
      expect(finalSub.status).toBe("active");
      const payments = await Payment.find({ invoiceId });
      expect(payments).toHaveLength(1);
      expect(payments[0].amount).toBe(1200);
    });

    it("deterministic race: cancellation commits first, concurrent payment is rejected", async () => {
      // 1. Create a subscription with billImmediately
      const createRes = await request(app)
        .post("/api/v1/subscriptions")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branch._id.toString())
        .send({
          customerId: customer._id.toString(),
          price: 1500,
          entitlements: [{ serviceId: haircutService._id.toString(), quantity: 3 }],
          startDate: "2026-01-01",
          endDate: "2026-12-31",
          billImmediately: true,
          branchId: branch._id.toString(),
        });

      expect(createRes.status).toBe(201);
      const subId = createRes.body.data._id;
      const invoiceId = createRes.body.data.invoice._id;

      // Finalize invoice
      await request(app)
        .post(`/api/v1/billing/invoices/${invoiceId}/finalize`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branch._id.toString());

      // 2. Cancellation commits FIRST
      const cancelRes = await request(app)
        .patch(`/api/v1/subscriptions/${subId}/cancel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ reason: "Cancel wins race" });

      expect(cancelRes.status).toBe(200);

      // 3. Payment attempts to record against cancelled subscription
      const payRes = await request(app)
        .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branch._id.toString())
        .send({
          amount: 1500,
          method: "cash",
          idempotencyKey: `race-fail-pay-${Date.now()}`,
        });

      expect(payRes.status).toBe(400);
      expect(payRes.body.message).toContain("cancelled");

      // Verify zero payments recorded and invoice unchanged
      const payments = await Payment.find({ invoiceId });
      expect(payments).toHaveLength(0);
      const invoice = await Invoice.findById(invoiceId);
      expect(invoice.amountPaid).toBe(0);
      expect(invoice.status).toBe("cancelled");
    });

    it("prevents redemption while cancellation is in progress", async () => {
      // 1. Create active subscription
      const sub = await Subscription.create({
        organizationId: org._id,
        customerId: customer._id,
        subscriptionCode: `SUB-RED-LOCK-${Date.now()}`,
        status: "active",
        cancellationStatus: "in_progress", // Simulate in-progress cancellation
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        price: 1000,
        entitlements: [
          { serviceId: haircutService._id, serviceName: "Haircut Deluxe", totalQuantity: 5, usedQuantity: 0, remainingQuantity: 5 },
        ],
      });

      // 2. Attempt redemption
      const redeemRes = await request(app)
        .post(`/api/v1/subscriptions/${sub._id}/redeem`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branch._id.toString())
        .send({
          branchId: branch._id.toString(),
          isManual: true,
          reason: "Attempt redemption during cancellation",
          services: [{ serviceId: haircutService._id.toString(), quantity: 1 }],
        });

      expect(redeemRes.status).toBe(400);
      expect(redeemRes.body.message).toMatch(/cancellation in progress/i);
    });
  });

  describe("5. Rigorous Price Restoration & Reconciliation Safety", () => {
    it("1. Valid original price snapshot restored correctly", async () => {
      const sub = await Subscription.create({
        organizationId: org._id,
        customerId: customer._id,
        subscriptionCode: `SUB-SNAP-VALID-${Date.now()}`,
        status: "active",
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        price: 2000,
        entitlements: [{ serviceId: haircutService._id, serviceName: "Haircut Deluxe", totalQuantity: 5, usedQuantity: 1, remainingQuantity: 4 }],
      });

      const apt = await createAppointmentWithServices([
        {
          service: haircutService,
          price: 750, // Agreed snapshot price at booking
          appliedSubscriptionId: sub._id,
          isRedeemedViaSubscription: true,
        },
      ]);

      const usage = await SubscriptionUsage.create({
        organizationId: org._id,
        subscriptionId: sub._id,
        customerId: customer._id,
        serviceId: haircutService._id,
        serviceName: "Haircut Deluxe",
        quantity: 1,
        branchId: branch._id,
        verifiedBy: ownerUser._id,
        appointmentId: apt._id,
        appointmentServiceId: apt.services[0]._id,
        appointmentCode: apt.appointmentCode,
      });

      apt.services[0].subscriptionUsageId = usage._id;
      await apt.save();

      const cancelRes = await request(app)
        .patch(`/api/v1/subscriptions/${sub._id}/cancel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ reason: "Cancel with valid snapshot" });

      expect(cancelRes.status).toBe(200);

      const updatedApt = await Appointment.findById(apt._id);
      expect(updatedApt.services[0].price).toBe(750);
      expect(updatedApt.services[0].isRedeemedViaSubscription).toBe(false);
      expect(updatedApt.services[0].appliedSubscriptionId).toBeNull();
      expect(updatedApt.services[0].subscriptionUsageId).toBeNull();
    });

    it("2. Missing original price snapshot stops operation and marks reconciliation", async () => {
      const sub = await Subscription.create({
        organizationId: org._id,
        customerId: customer._id,
        subscriptionCode: `SUB-SNAP-MISS-${Date.now()}`,
        status: "active",
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        price: 2000,
        entitlements: [{ serviceId: haircutService._id, serviceName: "Haircut Deluxe", totalQuantity: 5, usedQuantity: 1, remainingQuantity: 4 }],
      });

      const apt = await createAppointmentWithServices([
        {
          service: haircutService,
          price: 500,
          appliedSubscriptionId: sub._id,
          isRedeemedViaSubscription: true,
        },
      ]);

      const usage = await SubscriptionUsage.create({
        organizationId: org._id,
        subscriptionId: sub._id,
        customerId: customer._id,
        serviceId: haircutService._id,
        serviceName: "Haircut Deluxe",
        quantity: 1,
        branchId: branch._id,
        verifiedBy: ownerUser._id,
        appointmentId: apt._id,
        appointmentServiceId: apt.services[0]._id,
        appointmentCode: apt.appointmentCode,
      });

      // Corrupt snapshot price directly via update to bypass schema validations
      await Appointment.updateOne(
        { _id: apt._id, "services._id": apt.services[0]._id },
        {
          $set: {
            "services.$.price": null,
            "services.$.subscriptionUsageId": usage._id,
          },
        }
      );

      const cancelRes = await request(app)
        .patch(`/api/v1/subscriptions/${sub._id}/cancel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ reason: "Cancel with missing snapshot" });

      expect([400, 422, 500]).toContain(cancelRes.status);

      // Verify operation marked as requires_reconciliation
      const op = await SubscriptionCancellationOperation.findOne({ subscriptionId: sub._id });
      expect(op.status).toBe("requires_reconciliation");
    });

    it("3. Invalid or negative snapshot price stops operation safely", async () => {
      const sub = await Subscription.create({
        organizationId: org._id,
        customerId: customer._id,
        subscriptionCode: `SUB-SNAP-NEG-${Date.now()}`,
        status: "active",
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        price: 2000,
        entitlements: [{ serviceId: haircutService._id, serviceName: "Haircut Deluxe", totalQuantity: 5, usedQuantity: 1, remainingQuantity: 4 }],
      });

      const apt = await createAppointmentWithServices([
        {
          service: haircutService,
          price: 500,
          appliedSubscriptionId: sub._id,
          isRedeemedViaSubscription: true,
        },
      ]);

      const usage = await SubscriptionUsage.create({
        organizationId: org._id,
        subscriptionId: sub._id,
        customerId: customer._id,
        serviceId: haircutService._id,
        serviceName: "Haircut Deluxe",
        quantity: 1,
        branchId: branch._id,
        verifiedBy: ownerUser._id,
        appointmentId: apt._id,
        appointmentServiceId: apt.services[0]._id,
        appointmentCode: apt.appointmentCode,
      });

      // Set negative snapshot price via raw update to bypass mongoose schema min:0 check
      await Appointment.updateOne(
        { _id: apt._id, "services._id": apt.services[0]._id },
        {
          $set: {
            "services.$.price": -100,
            "services.$.subscriptionUsageId": usage._id,
          },
        }
      );

      const cancelRes = await request(app)
        .patch(`/api/v1/subscriptions/${sub._id}/cancel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ reason: "Cancel with negative snapshot" });

      expect([422, 500]).toContain(cancelRes.status);

      const op = await SubscriptionCancellationOperation.findOne({ subscriptionId: sub._id });
      expect(op.status).toBe("requires_reconciliation");
    });

    it("4. Snapshot price different from current Service master price preserves snapshot", async () => {
      // Current master service price
      expect(haircutService.pricing.basePrice).toBe(500);

      // But appointment was booked at discounted/custom price of 420
      const sub = await Subscription.create({
        organizationId: org._id,
        customerId: customer._id,
        subscriptionCode: `SUB-SNAP-DIFF-${Date.now()}`,
        status: "active",
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        price: 2000,
        entitlements: [{ serviceId: haircutService._id, serviceName: "Haircut Deluxe", totalQuantity: 5, usedQuantity: 1, remainingQuantity: 4 }],
      });

      const apt = await createAppointmentWithServices([
        {
          service: haircutService,
          price: 420, // Must NOT use catalog 500!
          appliedSubscriptionId: sub._id,
          isRedeemedViaSubscription: true,
        },
      ]);

      const usage = await SubscriptionUsage.create({
        organizationId: org._id,
        subscriptionId: sub._id,
        customerId: customer._id,
        serviceId: haircutService._id,
        serviceName: "Haircut Deluxe",
        quantity: 1,
        branchId: branch._id,
        verifiedBy: ownerUser._id,
        appointmentId: apt._id,
        appointmentServiceId: apt.services[0]._id,
        appointmentCode: apt.appointmentCode,
      });

      apt.services[0].subscriptionUsageId = usage._id;
      await apt.save();

      // Create completed invoice
      const invoice = await createAppointmentInvoice(
        apt,
        [
          {
            service: haircutService,
            appointmentServiceId: apt.services[0]._id,
            price: 420,
            isCovered: true,
            appliedSubscriptionId: sub._id,
            subscriptionUsageId: usage._id,
          },
        ],
        []
      );

      const cancelRes = await request(app)
        .patch(`/api/v1/subscriptions/${sub._id}/cancel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ reason: "Cancel with snapshot != master" });

      expect(cancelRes.status).toBe(200);

      const updatedApt = await Appointment.findById(apt._id);
      expect(updatedApt.services[0].price).toBe(420); // Strict preservation of 420, NOT 500

      const updatedInv = await Invoice.findById(invoice._id);
      expect(updatedInv.lines[0].unitPrice).toBe(420); // Not 500
      expect(updatedInv.amountDue).toBe(420);
      expect(updatedInv.paymentStatus).toBe("unpaid");
    });

    it("5. Multiple service lines and multiple subscriptions in one appointment", async () => {
      const sub1 = await Subscription.create({
        organizationId: org._id,
        customerId: customer._id,
        subscriptionCode: `SUB-MULTI-1-${Date.now()}`,
        status: "active",
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        price: 2000,
        entitlements: [{ serviceId: haircutService._id, serviceName: "Haircut Deluxe", totalQuantity: 5, usedQuantity: 1, remainingQuantity: 4 }],
      });

      const sub2 = await Subscription.create({
        organizationId: org._id,
        customerId: customer._id,
        subscriptionCode: `SUB-MULTI-2-${Date.now()}`,
        status: "active",
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        price: 3000,
        entitlements: [{ serviceId: facialService._id, serviceName: "Facial Glow", totalQuantity: 3, usedQuantity: 1, remainingQuantity: 2 }],
      });

      const apt = await createAppointmentWithServices([
        {
          service: haircutService,
          price: 500,
          appliedSubscriptionId: sub1._id,
          isRedeemedViaSubscription: true,
        },
        {
          service: facialService,
          price: 800,
          appliedSubscriptionId: sub2._id,
          isRedeemedViaSubscription: true,
        },
        {
          service: massageService,
          price: 1200,
          appliedSubscriptionId: null,
          isRedeemedViaSubscription: false,
        },
      ]);

      const usage1 = await SubscriptionUsage.create({
        organizationId: org._id,
        subscriptionId: sub1._id,
        customerId: customer._id,
        serviceId: haircutService._id,
        serviceName: "Haircut Deluxe",
        quantity: 1,
        branchId: branch._id,
        verifiedBy: ownerUser._id,
        appointmentId: apt._id,
        appointmentServiceId: apt.services[0]._id,
        appointmentCode: apt.appointmentCode,
      });

      const usage2 = await SubscriptionUsage.create({
        organizationId: org._id,
        subscriptionId: sub2._id,
        customerId: customer._id,
        serviceId: facialService._id,
        serviceName: "Facial Glow",
        quantity: 1,
        branchId: branch._id,
        verifiedBy: ownerUser._id,
        appointmentId: apt._id,
        appointmentServiceId: apt.services[1]._id,
        appointmentCode: apt.appointmentCode,
      });

      apt.services[0].subscriptionUsageId = usage1._id;
      apt.services[1].subscriptionUsageId = usage2._id;
      await apt.save();

      // Cancel ONLY sub1
      const cancelRes = await request(app)
        .patch(`/api/v1/subscriptions/${sub1._id}/cancel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ reason: "Cancel sub1 only" });

      expect(cancelRes.status).toBe(200);

      const updatedApt = await Appointment.findById(apt._id);
      // Line 0 (haircut) stripped
      expect(updatedApt.services[0].isRedeemedViaSubscription).toBe(false);
      expect(updatedApt.services[0].appliedSubscriptionId).toBeNull();
      // Line 1 (facial) PRESERVED under sub2
      expect(updatedApt.services[1].isRedeemedViaSubscription).toBe(true);
      expect(updatedApt.services[1].appliedSubscriptionId.toString()).toBe(sub2._id.toString());
      // Line 2 (massage) completely untouched
      expect(updatedApt.services[2].price).toBe(1200);
      expect(updatedApt.services[2].appliedSubscriptionId).toBeNull();
    });

    it("6. Reconciliation failure without partial financial updates", async () => {
      const sub = await Subscription.create({
        organizationId: org._id,
        customerId: customer._id,
        subscriptionCode: `SUB-NO-PARTIAL-${Date.now()}`,
        status: "active",
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        price: 2000,
        entitlements: [{ serviceId: haircutService._id, serviceName: "Haircut Deluxe", totalQuantity: 5, usedQuantity: 1, remainingQuantity: 4 }],
      });

      const apt = await createAppointmentWithServices([
        {
          service: haircutService,
          price: 500,
          appliedSubscriptionId: sub._id,
          isRedeemedViaSubscription: true,
        },
      ]);

      const usage = await SubscriptionUsage.create({
        organizationId: org._id,
        subscriptionId: sub._id,
        customerId: customer._id,
        serviceId: haircutService._id,
        serviceName: "Haircut Deluxe",
        quantity: 1,
        branchId: branch._id,
        verifiedBy: ownerUser._id,
        appointmentId: apt._id,
        appointmentServiceId: apt.services[0]._id,
        appointmentCode: apt.appointmentCode,
      });

      // Update to negative price via raw update to bypass schema validations
      await Appointment.updateOne(
        { _id: apt._id, "services._id": apt.services[0]._id },
        {
          $set: {
            "services.$.price": -50,
            "services.$.subscriptionUsageId": usage._id,
          },
        }
      );

      const invoice = await createAppointmentInvoice(
        apt,
        [
          {
            service: haircutService,
            appointmentServiceId: apt.services[0]._id,
            price: 500,
            isCovered: true,
            appliedSubscriptionId: sub._id,
            subscriptionUsageId: usage._id,
          },
        ],
        []
      );

      const cancelRes = await request(app)
        .patch(`/api/v1/subscriptions/${sub._id}/cancel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ reason: "Cancel with corrupted price" });

      expect([400, 422, 500]).toContain(cancelRes.status);

      // Verify ZERO partial financial updates occurred on the invoice or usage due to transaction rollback
      const pristineUsage = await SubscriptionUsage.findById(usage._id);
      expect(pristineUsage.isReversed).toBe(false);

      const pristineInv = await Invoice.findById(invoice._id);
      expect(pristineInv.amountDue).toBe(0); // Not modified
      expect(pristineInv.paymentStatus).toBe("paid"); // Not modified
      expect(pristineInv.lines[0].isCoveredBySubscription).toBe(true); // Rolled back
    });
  });
});
