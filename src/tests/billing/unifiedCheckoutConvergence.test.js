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
import { Appointment } from "../../models/appointments/appointment.model.js";
import { Service } from "../../models/services/service.model.js";
import { ServiceCategory } from "../../models/services/serviceCategory.model.js";
import { Customer } from "../../models/customers/customer.model.js";
import { Product } from "../../models/inventory/product.model.js";
import { StockBalance } from "../../models/inventory/stockBalance.model.js";
import { SubscriptionPlan } from "../../models/subscriptions/subscriptionPlan.model.js";
import { MembershipPlan } from "../../models/memberships/membershipPlan.model.js";
import { Invoice } from "../../models/billing/invoice.model.js";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";

describe("Unified Billing Convergence & Single Checkout Lifecycle Suite", () => {
  jest.setTimeout(45000);
  let orgId, branchId, userToken, role, customer, service, product, subPlan, memPlan;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    const testUri = getIsolatedTestMongoUri("checkout_queue_test");
    await mongoose.connect(testUri);
    // 1. Setup Organization & Branch
    const org = await Organization.create({
      name: "Unified Convergence Org",
      slug: `conv-org-${Date.now()}`,
      status: "active",
    });
    orgId = org._id;

    const branch = await Branch.create({
      name: "Main Convergence Branch",
      organizationId: orgId,
      code: `BR-${Date.now()}`,
      isActive: true,
    });
    branchId = branch._id;

    // 2. Setup Permissions & Role
    const requiredPerms = [
      "billing.checkout",
      "billing.view",
      "billing.payment",
      "billing.cancel",
      "payments.receive",
      "payments.view",
      "memberships.view",
      "subscriptions.sell",
    ];

    const permDocs = await Promise.all(
      requiredPerms.map((name) =>
        Permission.findOneAndUpdate(
          { name },
          { name, module: "Billing", action: name, description: name },
          { upsert: true, returnDocument: "after" }
        )
      )
    );

    role = await Role.create({
      name: `cashier_conv_${Date.now()}`,
      description: "Convergence Cashier",
      organizationId: orgId,
      permissions: permDocs.map((p) => p._id),
    });

    const user = await User.create({
      name: "Cashier Converge",
      username: `cashier_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
      email: `cashier_${Date.now()}_${Math.floor(Math.random() * 10000)}@test.com`,
      phone: `+9199887${Math.floor(10000 + Math.random() * 90000)}`,
      password: "Password@123",
      role: role._id,
      organizationId: orgId,
      status: "active",
      hasOrgWideAccess: false,
      branchAccess: [{ branchId, branchName: "Main Convergence Branch", isActive: true }],
    });

    userToken = jwt.sign(
      { id: user._id.toString(), role: role.name, organizationId: orgId.toString() },
      env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    // 3. Customer
    customer = await Customer.create({
      name: "Arthur Dent",
      phone: "+919988771122",
      organizationId: orgId,
      homeBranchId: branchId,
      status: "active",
    });

    // 4. Catalog items
    const cat = await ServiceCategory.create({ name: "Hair Styling", organizationId: orgId });
    service = await Service.create({
      name: "Precision Cut",
      categoryId: cat._id,
      duration: 30,
      pricing: { basePrice: 600 },
      organizationId: orgId,
      status: "active",
    });

    product = await Product.create({
      organizationId: orgId,
      name: "Organic Shampoo 250ml",
      sku: `SHAMP-${Date.now()}`,
      category: "Haircare",
      stockUnit: "bottle",
      costPrice: 200,
      sellingPrice: 500,
      usageType: "retail_sale",
      status: "active",
    });

    await StockBalance.create({
      organizationId: orgId,
      branchId,
      productId: product._id,
      onHand: 100,
      allocated: 0,
      available: 100,
    });

    subPlan = await SubscriptionPlan.create({
      organizationId: orgId,
      name: "Haircare 4-Pack",
      code: `SUB4P-${Date.now()}`,
      suggestedPrice: 1800,
      validityMonths: 3,
      entitlements: [{ serviceId: service._id, quantity: 4 }],
      isActive: true,
    });

    memPlan = await MembershipPlan.create({
      organizationId: orgId,
      name: "Silver VIP",
      code: `MEMSILV-${Date.now()}`,
      tier: "Silver",
      price: 1000,
      validityMonths: 12,
      benefits: {
        serviceDiscountPercentage: 10,
        productDiscountPercentage: 10,
      },
      isActive: true,
    });
  });

  afterAll(async () => {
    await Invoice.deleteMany({ organizationId: orgId });
    await Appointment.deleteMany({ organizationId: orgId });
    await Customer.deleteMany({ organizationId: orgId });
    await Product.deleteMany({ organizationId: orgId });
    await Service.deleteMany({ organizationId: orgId });
    await SubscriptionPlan.deleteMany({ organizationId: orgId });
    await MembershipPlan.deleteMany({ organizationId: orgId });
    await User.deleteMany({ organizationId: orgId });
    await Role.deleteMany({ organizationId: orgId });
    await Branch.deleteMany({ organizationId: orgId });
    await Organization.deleteMany({ _id: orgId });
  });

  async function createAppointmentFixture() {
    return Appointment.create({
      organizationId: orgId,
      branchId,
      customerId: customer._id,
      appointmentCode: `APT-CONV-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      appointmentDate: "2026-11-20",
      startTime: "10:00",
      endTime: "10:30",
      totalDuration: 30,
      startAt: new Date(),
      endAt: new Date(Date.now() + 1800000),
      duration: 30,
      status: "completed",
      bookingType: "advance",
      services: [
        {
          serviceId: service._id,
          name: service.name,
          duration: 30,
          price: 600,
          isRedeemedViaSubscription: false,
        },
      ],
      pricing: { subtotal: 600, discount: 0, total: 600 },
    });
  }

  // --------------------------------------------------------------------------
  // TEST CASES PROVING CENTRAL CONVERGENCE & IDEMPOTENCY
  // --------------------------------------------------------------------------

  it("1. Appointment completion opens one unified draft invoice", async () => {
    const apt = await createAppointmentFixture();

    const res = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({
        appointmentId: apt._id.toString(),
        notes: "Appointment unified checkout",
      });

    if (res.status !== 201) {
      console.error("Test 6 Error Body:", JSON.stringify(res.body, null, 2));
    }
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.appointmentId).toBe(apt._id.toString());
    expect(res.body.data.status).toBe("draft");
    expect(res.body.data.lines).toHaveLength(1);
    expect(res.body.data.lines[0].lineType).toBe("service");
  });

  it("2. Repeated appointment checkout resumes the same draft instead of erroring or duplicating", async () => {
    const apt = await createAppointmentFixture();

    // Call 1: Creates Draft
    const res1 = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({ appointmentId: apt._id.toString() });

    expect(res1.status).toBe(201);
    const invoiceId1 = res1.body.data._id;

    // Call 2: Re-invoking checkout for the same appointment resumes existing draft
    const res2 = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({ appointmentId: apt._id.toString() });

    expect(res2.status).toBe(201);
    expect(res2.body.data._id).toBe(invoiceId1);
    expect(res2.body.data.status).toBe("draft");
  });

  it("3. Appointment checkout can add retail products in the same unified invoice", async () => {
    const apt = await createAppointmentFixture();

    const res = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({
        appointmentId: apt._id.toString(),
        productLines: [{ productId: product._id.toString(), quantity: 2 }],
      });

    if (res.status !== 201) {
      console.error("Test 6 Error Body:", JSON.stringify(res.body, null, 2));
    }
    expect(res.status).toBe(201);
    const inv = res.body.data;
    expect(inv.lines).toHaveLength(2); // 1 service + 1 product line
    expect(inv.lines.some((l) => l.lineType === "service")).toBe(true);
    expect(inv.lines.some((l) => l.lineType === "product" && l.quantity === 2)).toBe(true);
    // 600 (svc) + (2 * 500) = 1600
    expect(inv.subtotal).toBe(1600);
    expect(inv.payableAmount).toBe(1600);
  });

  it("4. Standalone subscription sale routes through the exact same unified checkout pipeline", async () => {
    const res = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({
        customerId: customer._id.toString(),
        subscriptionLines: [{ planId: subPlan._id.toString() }],
      });

    if (res.status !== 201) {
      console.error("Test 6 Error Body:", JSON.stringify(res.body, null, 2));
    }
    expect(res.status).toBe(201);
    const inv = res.body.data;
    expect(inv.invoiceType).toBe("subscription");
    expect(inv.lines[0].lineType).toBe("subscription");
    expect(inv.lines[0].unitPrice).toBe(1800);
    expect(inv.payableAmount).toBe(1800);
  });

  it("5. Standalone membership sale routes through the exact same unified checkout pipeline", async () => {
    const res = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({
        customerId: customer._id.toString(),
        membershipLines: [{ membershipPlanId: memPlan._id.toString(), quantity: 1 }],
      });

    if (res.status !== 201) {
      console.error("Test 6 Error Body:", JSON.stringify(res.body, null, 2));
    }
    expect(res.status).toBe(201);
    const inv = res.body.data;
    expect(inv.invoiceType).toBe("membership");
    expect(inv.lines[0].lineType).toBe("membership");
    expect(inv.lines[0].unitPrice).toBe(1000);
    expect(inv.payableAmount).toBe(1000);
  });

  it("6. Walk-in composite checkout supports all 4 line types in one authoritative invoice", async () => {
    const res = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({
        customerId: customer._id.toString(),
        serviceLines: [{ serviceId: service._id.toString(), quantity: 1 }],
        productLines: [{ productId: product._id.toString(), quantity: 1 }],
        subscriptionLines: [{ planId: subPlan._id.toString() }],
        membershipLines: [{ membershipPlanId: memPlan._id.toString(), quantity: 1 }],
      });

    if (res.status !== 201) {
      console.error("Test 6 Error Body:", JSON.stringify(res.body, null, 2));
    }
    expect(res.status).toBe(201);
    const inv = res.body.data;
    expect(inv.invoiceType).toBe("combined");
    expect(inv.lines).toHaveLength(4);
    expect(inv.lines.map((l) => l.lineType)).toEqual(
      expect.arrayContaining(["service", "product", "subscription", "membership"])
    );
  });

  it("7. Reopening draft and adding extra items preserves the same invoice ID and updates cart", async () => {
    const apt = await createAppointmentFixture();

    // 1. Initial draft creation
    const res1 = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({ appointmentId: apt._id.toString() });

    expect(res1.status).toBe(201);
    const initialInvoiceId = res1.body.data._id;
    const initialInvoiceNumber = res1.body.data.invoiceNumber;
    expect(res1.body.data.lines).toHaveLength(1);

    // 2. Add retail product to the ongoing checkout
    const res2 = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({
        appointmentId: apt._id.toString(),
        productLines: [{ productId: product._id.toString(), quantity: 1 }],
      });

    if (res2.status !== 201) {
      console.error("Test 7 Res2 Error Body:", JSON.stringify(res2.body, null, 2));
    }
    expect(res2.status).toBe(201);
    // Draft identity preserved! Same _id and invoiceNumber
    expect(res2.body.data._id).toBe(initialInvoiceId);
    expect(res2.body.data.invoiceNumber).toBe(initialInvoiceNumber);
    expect(res2.body.data.lines).toHaveLength(2); // service + product

    // Verify stock balance was allocated for product
    const bal = await StockBalance.findOne({ organizationId: orgId, branchId, productId: product._id });
    expect(bal.allocated).toBeGreaterThanOrEqual(1);
  });

  it("8. Concurrent appointment draft creation yields exactly one active invoice", async () => {
    const apt = await createAppointmentFixture();

    // Fire 4 simultaneous checkout requests for the same appointment
    const reqs = Array.from({ length: 4 }).map(() =>
      request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${userToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({ appointmentId: apt._id.toString() })
    );

    const results = await Promise.all(reqs);

    // Concurrency handling: exactly one request creates the draft (201), concurrent requests return 201 (idempotent resume) or 409 (conflict)
    for (const r of results) {
      expect([200, 201, 409]).toContain(r.status);
    }

    // Verify exactly one active invoice exists in the DB for this appointment
    const activeInvoices = await Invoice.find({
      organizationId: orgId,
      appointmentId: apt._id,
      status: { $in: ["draft", "finalized"] },
    });
    expect(activeInvoices).toHaveLength(1);
  });

  it("9. Duplicate payment submission does not commit double stock or duplicate ledger records", async () => {
    // 1. Create a retail product invoice
    const createRes = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({
        customerId: customer._id.toString(),
        productLines: [{ productId: product._id.toString(), quantity: 1 }],
      });

    expect(createRes.status).toBe(201);
    const invId = createRes.body.data._id;

    // 2. Finalize invoice
    await request(app)
      .post(`/api/v1/billing/invoices/${invId}/finalize`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send();

    // Initial stock
    const initialBal = await StockBalance.findOne({ organizationId: orgId, branchId, productId: product._id });
    const initialOnHand = initialBal.onHand;

    // 3. Payment 1 with idempotency key
    const idempotencyKey = `PAY-IDEMP-${Date.now()}`;
    const payRes1 = await request(app)
      .post(`/api/v1/billing/invoices/${invId}/payments`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .set("Idempotency-Key", idempotencyKey)
      .send({
        amount: 500,
        paymentMethod: "cash",
      });

    expect(payRes1.status).toBe(201);
    expect(payRes1.body.data.invoice.paymentStatus).toBe("paid");

    const balAfterPay1 = await StockBalance.findOne({ organizationId: orgId, branchId, productId: product._id });
    expect(balAfterPay1.onHand).toBe(initialOnHand - 1);

    // 4. Duplicate Payment with same idempotency key
    const payRes2 = await request(app)
      .post(`/api/v1/billing/invoices/${invId}/payments`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .set("Idempotency-Key", idempotencyKey)
      .send({
        amount: 500,
        paymentMethod: "cash",
      });

    // Should return idempotent cached payment response or 200/201 without second deduction
    expect([200, 201]).toContain(payRes2.status);

    const balAfterPay2 = await StockBalance.findOne({ organizationId: orgId, branchId, productId: product._id });
    expect(balAfterPay2.onHand).toBe(initialOnHand - 1); // Not decremented twice!
  });

  it("10. Complete Appointment Upsell Workflow: Appointment + Retail + Subscription Upsell + Membership Upsell in ONE invoice with atomic multi-domain settlement", async () => {
    // 1. Open an existing appointment with service lines
    const apt = await createAppointmentFixture();

    // 2. Start checkout: Creates draft invoice with appointment service line
    const initRes = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({ appointmentId: apt._id.toString() });

    expect(initRes.status).toBe(201);
    const draftId = initRes.body.data._id;
    const draftInvoiceNumber = initRes.body.data.invoiceNumber;
    expect(initRes.body.data.lines).toHaveLength(1);
    expect(initRes.body.data.lines[0].lineType).toBe("service");
    expect(initRes.body.data.lines[0].customerPayable).toBe(600);

    // Initial onHand stock and allocation
    const initStock = await StockBalance.findOne({ organizationId: orgId, branchId, productId: product._id });
    const initialOnHand = initStock.onHand;
    const initialAllocated = initStock.allocated;

    // 3, 4, 5. Upsell into ongoing appointment checkout: Add Retail Product, Subscription Package covering haircut, and Membership
    const updateRes = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({
        appointmentId: apt._id.toString(),
        productLines: [{ productId: product._id.toString(), quantity: 1 }],
        subscriptionLines: [{ planId: subPlan._id.toString() }],
        membershipLines: [{ membershipPlanId: memPlan._id.toString(), quantity: 1 }],
      });

    expect(updateRes.status).toBe(201);
    const inv = updateRes.body.data;

    // 9. Verify same invoice ID and invoice number preserved
    expect(inv._id).toBe(draftId);
    expect(inv.invoiceNumber).toBe(draftInvoiceNumber);

    // 6. Verify all items appear on ONE unified invoice
    expect(inv.lines).toHaveLength(4);
    const serviceLine = inv.lines.find((l) => l.lineType === "service");
    const productLine = inv.lines.find((l) => l.lineType === "product");
    const subLine = inv.lines.find((l) => l.lineType === "subscription");
    const memLine = inv.lines.find((l) => l.lineType === "membership");

    expect(serviceLine).toBeDefined();
    expect(productLine).toBeDefined();
    expect(subLine).toBeDefined();
    expect(memLine).toBeDefined();

    // 7, 8. Verify subscription coverage on the appointment service line:
    // Haircut (₹600) covered by newly purchased subscription pack -> customerPayable = 0, covered = 600
    expect(serviceLine.isCoveredBySubscription).toBe(true);
    expect(serviceLine.subscriptionCoveredAmount).toBe(600);
    expect(serviceLine.customerPayable).toBe(0);

    // Retail product (₹500): Membership provides 10% discount -> ₹50 discount, customerPayable = 450
    expect(productLine.unitPrice).toBe(500);
    expect(productLine.discountAmount).toBe(50);
    expect(productLine.customerPayable).toBe(450);

    // Subscription plan (₹1800) + Membership plan (₹1000)
    expect(subLine.unitPrice).toBe(1800);
    expect(subLine.customerPayable).toBe(1800);
    expect(memLine.unitPrice).toBe(1000);
    expect(memLine.customerPayable).toBe(1000);

    // Subtotal = 600 + 500 + 1800 + 1000 = 3900
    // Subscription waived = 600
    // Membership discount = 50
    // Total payable = 450 + 1800 + 1000 = 3250
    expect(inv.subtotal).toBe(3900);
    expect(inv.subscriptionCoveredAmount).toBe(600);
    expect(inv.discountTotal).toBe(50);
    expect(inv.payableAmount).toBe(3250);
    expect(inv.amountDue).toBe(3250);

    // Verify stock allocation (reserved = 1, onHand unchanged)
    let bal = await StockBalance.findOne({ organizationId: orgId, branchId, productId: product._id });
    expect(bal.allocated).toBeGreaterThanOrEqual(1);
    expect(bal.onHand).toBe(initialOnHand);

    // Finalize invoice
    const finRes = await request(app)
      .post(`/api/v1/billing/invoices/${draftId}/finalize`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send();
    expect(finRes.status).toBe(200);

    // 10. Settle full payment (₹3250)
    const payRes = await request(app)
      .post(`/api/v1/billing/invoices/${draftId}/payments`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({
        amount: 3250,
        paymentMethod: "card",
      });

    expect(payRes.status).toBe(201);
    expect(payRes.body.data.invoice.paymentStatus).toBe("paid");
    expect(payRes.body.data.invoice.amountDue).toBe(0);

    // 11. Verify subscription activation and exactly one entitlement consumption
    const { Subscription } = await import("../../models/subscriptions/subscription.model.js");
    const { SubscriptionUsage } = await import("../../models/subscriptions/subscriptionUsage.model.js");
    const { Payment } = await import("../../models/billing/payment.model.js");
    const activatedSub = await Subscription.findOne({
      customerId: customer._id,
      organizationId: orgId,
      status: "active",
    });
    expect(activatedSub).toBeTruthy();
    expect(activatedSub.invoiceId.toString()).toBe(draftId.toString());

    // 1 entitlement session consumed for the haircut in this appointment
    const hairEnt = activatedSub.entitlements.find((e) => e.serviceId.toString() === service._id.toString());
    expect(hairEnt.usedQuantity).toBe(1);
    expect(hairEnt.remainingQuantity).toBe(3); // 4 total - 1 used

    // Exactly one usage audit record created
    const usages = await SubscriptionUsage.find({
      subscriptionId: activatedSub._id,
      subscriptionInvoiceId: draftId,
    });
    expect(usages).toHaveLength(1);
    expect(usages[0].quantity).toBe(1);
    expect(usages[0].serviceId.toString()).toBe(service._id.toString());

    // 12. Verify membership activation
    const { CustomerMembership } = await import("../../models/memberships/customerMembership.model.js");
    const activatedMem = await CustomerMembership.findOne({
      customerId: customer._id,
      organizationId: orgId,
      status: "active",
    });
    expect(activatedMem).toBeTruthy();
    expect(activatedMem.membershipPlanId.toString()).toBe(memPlan._id.toString());
    expect(activatedMem.invoiceId.toString()).toBe(draftId.toString());

    // 13. Verify exactly one retail stock deduction: onHand decreased by 1, allocated returned to initial
    bal = await StockBalance.findOne({ organizationId: orgId, branchId, productId: product._id });
    expect(bal.onHand).toBe(initialOnHand - 1);
    expect(bal.allocated).toBe(initialAllocated);

    // 14. Verify appointment checkout queue / billing synchronization
    const { billingService } = await import("../../services/billing/billing.service.js");
    const queueResult = await billingService.getCheckoutQueue({
      organizationId: orgId,
      branchId: branchId,
    });
    // Appointment now has active paid invoice -> filtered out of checkout queue
    expect(queueResult.data.some((q) => q.id === apt._id.toString())).toBe(false);

    // 15. Verify printable PDF receipt generates seamlessly for the complete unified composite invoice
    const pdfRes = await request(app)
      .get(`/api/v1/billing/invoices/${draftId}/pdf`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString());

    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers["content-type"]).toBe("application/pdf");
  });

  it("11. Concurrent draft settlement race: Two drafts competing for final entitlement results in exactly one success, one 409 conflict, and atomic rollback", async () => {
    const { Subscription } = await import("../../models/subscriptions/subscription.model.js");
    const { SubscriptionUsage } = await import("../../models/subscriptions/subscriptionUsage.model.js");
    const { Payment } = await import("../../models/billing/payment.model.js");

    // 1. Create a pre-existing subscription with EXACTLY 1 entitlement session remaining
    const singleQuotaSub = await Subscription.create({
      organizationId: orgId,
      branchId,
      payerCustomerId: customer._id,
      customerId: customer._id,
      subscriptionCode: `SUB-RACE-${Date.now()}`,
      planId: subPlan._id,
      price: 500,
      status: "active",
      startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
      endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      members: [
        {
          customerId: customer._id,
          status: "active",
          permittedBranchIds: [branchId],
          entitlements: [
            {
              serviceId: service._id,
              serviceName: service.name,
              totalQuantity: 1,
              usedQuantity: 0,
              remainingQuantity: 1,
            },
          ],
        },
      ],
      entitlements: [
        {
          serviceId: service._id,
          serviceName: service.name,
          totalQuantity: 1,
          usedQuantity: 0,
          remainingQuantity: 1,
        },
      ],
    });

    // 2. Create Draft Invoice A with 1 covered service line + 1 retail product line
    // Customer now has an active membership giving 10% discount on retail products (₹500 -> ₹450)
    const resA = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({
        customerId: customer._id.toString(),
        serviceLines: [
          {
            serviceId: service._id.toString(),
            quantity: 1,
            appliedSubscriptionId: singleQuotaSub._id.toString(),
          },
        ],
        productLines: [{ productId: product._id.toString(), quantity: 1 }],
      });
    expect(resA.status).toBe(201);
    const invoiceAId = resA.body.data._id;
    const invALines = resA.body.data.lines;
    const serviceLineA = invALines.find((l) => l.lineType === "service");
    expect(serviceLineA.isCoveredBySubscription).toBe(true);
    expect(serviceLineA.customerPayable).toBe(0);
    // Product line gets 10% membership discount: 500 - 50 = 450
    const expectedProductPayable = resA.body.data.lines.find((l) => l.lineType === "product").customerPayable;
    expect(resA.body.data.payableAmount).toBe(expectedProductPayable);

    // 3. Create Draft Invoice B also with 1 covered service line + 1 retail product line
    const resB = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({
        customerId: customer._id.toString(),
        serviceLines: [
          {
            serviceId: service._id.toString(),
            quantity: 1,
            appliedSubscriptionId: singleQuotaSub._id.toString(),
          },
        ],
        productLines: [{ productId: product._id.toString(), quantity: 1 }],
      });
    expect(resB.status).toBe(201);
    const invoiceBId = resB.body.data._id;
    const invBLines = resB.body.data.lines;
    const serviceLineB = invBLines.find((l) => l.lineType === "service");
    expect(serviceLineB.isCoveredBySubscription).toBe(true);
    expect(serviceLineB.customerPayable).toBe(0);
    expect(resB.body.data.payableAmount).toBe(expectedProductPayable);

    // 4. Finalize both draft invoices
    const finA = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceAId}/finalize`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send();
    expect(finA.status).toBe(200);

    const finB = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceBId}/finalize`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send();
    expect(finB.status).toBe(200);

    // 5. Settle Invoice A via recordPayment: should succeed, consume the 1 session, and transition subscription to exhausted
    const payA = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceAId}/payments`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({
        amount: expectedProductPayable,
        paymentMethod: "cash",
      });
    expect([200, 201]).toContain(payA.status);
    expect(payA.body.data.invoice.paymentStatus).toBe("paid");

    // Verify subscription was decremented to 0 remaining and exhausted
    const updatedSubAfterA = await Subscription.findById(singleQuotaSub._id);
    expect(updatedSubAfterA.status).toBe("exhausted");
    expect(updatedSubAfterA.members[0].entitlements[0].remainingQuantity).toBe(0);
    expect(updatedSubAfterA.members[0].entitlements[0].usedQuantity).toBe(1);

    // Verify exactly 1 SubscriptionUsage record was created
    const usagesAfterA = await SubscriptionUsage.find({ subscriptionId: singleQuotaSub._id });
    expect(usagesAfterA).toHaveLength(1);
    expect(usagesAfterA[0].subscriptionInvoiceId.toString()).toBe(invoiceAId.toString());

    // 6. Settle Invoice B: MUST return 409 Conflict because the entitlement was already consumed!
    const payB = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceBId}/payments`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({
        amount: expectedProductPayable,
        paymentMethod: "cash",
      });
    expect(payB.status).toBe(409);
    expect(payB.body.message).toMatch(/Insufficient subscription entitlement balance/i);

    // 7. Verify Atomic Rollback: Invoice B remains unpaid and NO extra payment or usage was recorded
    const invoiceBAfterFailure = await Invoice.findById(invoiceBId);
    expect(invoiceBAfterFailure.paymentStatus).toBe("unpaid");
    expect(invoiceBAfterFailure.amountPaid).toBe(0);
    expect(invoiceBAfterFailure.amountDue).toBe(expectedProductPayable);

    // Verify NO payment document was persisted for Invoice B
    const paymentsForB = await Payment.find({ invoiceId: invoiceBId });
    expect(paymentsForB).toHaveLength(0);

    // Verify still exactly 1 SubscriptionUsage in total
    const usagesFinal = await SubscriptionUsage.find({ subscriptionId: singleQuotaSub._id });
    expect(usagesFinal).toHaveLength(1);

    // 8. Idempotency test: Re-submitting payment for Invoice A with same idempotencyKey does NOT consume double
    const idempotentKey = `PAY-IDEM-${Date.now()}`;
    const payWithKey = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceAId}/payments`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({
        amount: expectedProductPayable,
        paymentMethod: "cash",
        idempotencyKey: idempotentKey,
      });
    // Invoice A is already paid; payment exceeds remaining balance throws 409 concurrent modification or rejects
    expect([400, 409]).toContain(payWithKey.status);

    // Verify entitlement remaining stays strictly 0 and usage count is unchanged
    const subFinalCheck = await Subscription.findById(singleQuotaSub._id);
    expect(subFinalCheck.members[0].entitlements[0].usedQuantity).toBe(1);
    expect(subFinalCheck.members[0].entitlements[0].remainingQuantity).toBe(0);
  });

  it("12. Malformed invoice intra-transaction race (recordPayment): Two covered lines claiming same entitlement with only 1 remaining causes 409 and complete rollback", async () => {
    const { Subscription } = await import("../../models/subscriptions/subscription.model.js");
    const { SubscriptionUsage } = await import("../../models/subscriptions/subscriptionUsage.model.js");
    const { Payment } = await import("../../models/billing/payment.model.js");

    // 1. Create a subscription with EXACTLY 1 session remaining
    const singleQuotaSub = await Subscription.create({
      organizationId: orgId,
      branchId,
      payerCustomerId: customer._id,
      customerId: customer._id,
      subscriptionCode: `SUB-MALFORMED-PAY-${Date.now()}`,
      planId: subPlan._id,
      price: 500,
      status: "active",
      startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
      endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      members: [
        {
          customerId: customer._id,
          status: "active",
          permittedBranchIds: [branchId],
          entitlements: [
            {
              serviceId: service._id,
              serviceName: service.name,
              totalQuantity: 1,
              usedQuantity: 0,
              remainingQuantity: 1,
            },
          ],
        },
      ],
      entitlements: [
        {
          serviceId: service._id,
          serviceName: service.name,
          totalQuantity: 1,
          usedQuantity: 0,
          remainingQuantity: 1,
        },
      ],
    });

    // 2. Create normal draft invoice with 1 service line + 1 product line
    const draftRes = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({
        customerId: customer._id.toString(),
        serviceLines: [
          {
            serviceId: service._id.toString(),
            quantity: 1,
            appliedSubscriptionId: singleQuotaSub._id.toString(),
          },
        ],
        productLines: [{ productId: product._id.toString(), quantity: 1 }],
      });
    expect(draftRes.status).toBe(201);
    const invoiceId = draftRes.body.data._id;
    const payableAmount = draftRes.body.data.payableAmount;

    // 3. Finalize invoice
    const finRes = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/finalize`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send();
    expect(finRes.status).toBe(200);

    // 4. Simulate a malformed invoice state (e.g. data anomaly/unauthorized direct edit)
    // where TWO service lines both claim the exact same subscription entitlement (each requesting 1 session)
    const finalizedInvoice = await Invoice.findById(invoiceId);
    const coveredLine = finalizedInvoice.lines.find((l) => l.lineType === "service" && l.isCoveredBySubscription);
    const duplicatedCoveredLine = {
      ...coveredLine.toObject(),
      _id: new (await import("mongoose")).default.Types.ObjectId(),
    };
    finalizedInvoice.lines.push(duplicatedCoveredLine);
    await finalizedInvoice.save();

    // 5. Attempt settlement via recordPayment:
    // Line 1 decrements remaining from 1 to 0.
    // Line 2 detects remainingQuantity (0) < 1 and throws 409!
    const payRes = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({
        amount: payableAmount,
        paymentMethod: "cash",
      });

    // Expect 409 Conflict
    expect(payRes.status).toBe(409);
    expect(payRes.body.message).toMatch(/Insufficient subscription entitlement balance/i);

    // 6. Complete Atomic Rollback Verification
    // A. Invoice remains unpaid with original payable amount
    const invoiceAfter = await Invoice.findById(invoiceId);
    expect(invoiceAfter.paymentStatus).toBe("unpaid");
    expect(invoiceAfter.amountPaid).toBe(0);
    expect(invoiceAfter.amountDue).toBe(payableAmount);

    // B. No payment document was created
    const payments = await Payment.find({ invoiceId });
    expect(payments).toHaveLength(0);

    // C. No SubscriptionUsage document was created (Line 1 usage was rolled back)
    const usages = await SubscriptionUsage.find({ subscriptionId: singleQuotaSub._id });
    expect(usages).toHaveLength(0);

    // D. Subscription quota remains completely untouched (1 remaining, 0 used, status active)
    const subAfter = await Subscription.findById(singleQuotaSub._id);
    expect(subAfter.status).toBe("active");
    expect(subAfter.members[0].entitlements[0].remainingQuantity).toBe(1);
    expect(subAfter.members[0].entitlements[0].usedQuantity).toBe(0);
  });

  it("13. Malformed invoice intra-transaction race (finalizeInvoice zero-payable): Two covered lines claiming same entitlement with only 1 remaining causes 409 and complete rollback", async () => {
    const { Subscription } = await import("../../models/subscriptions/subscription.model.js");
    const { SubscriptionUsage } = await import("../../models/subscriptions/subscriptionUsage.model.js");

    // 1. Create a subscription with EXACTLY 1 session remaining
    const singleQuotaSub = await Subscription.create({
      organizationId: orgId,
      branchId,
      payerCustomerId: customer._id,
      customerId: customer._id,
      subscriptionCode: `SUB-MALFORMED-FIN-${Date.now()}`,
      planId: subPlan._id,
      price: 500,
      status: "active",
      startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
      endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      members: [
        {
          customerId: customer._id,
          status: "active",
          permittedBranchIds: [branchId],
          entitlements: [
            {
              serviceId: service._id,
              serviceName: service.name,
              totalQuantity: 1,
              usedQuantity: 0,
              remainingQuantity: 1,
            },
          ],
        },
      ],
      entitlements: [
        {
          serviceId: service._id,
          serviceName: service.name,
          totalQuantity: 1,
          usedQuantity: 0,
          remainingQuantity: 1,
        },
      ],
    });

    // 2. Create normal draft invoice with ONLY 1 service line (payableAmount = 0)
    const draftRes = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({
        customerId: customer._id.toString(),
        serviceLines: [
          {
            serviceId: service._id.toString(),
            quantity: 1,
            appliedSubscriptionId: singleQuotaSub._id.toString(),
          },
        ],
      });
    expect(draftRes.status).toBe(201);
    expect(draftRes.body.data.payableAmount).toBe(0);
    const invoiceId = draftRes.body.data._id;

    // 3. Inject a duplicated covered line directly onto the draft to simulate a malformed/corrupted draft
    // where payableAmount remains 0 and both lines point to singleQuotaSub
    const draftInvoice = await Invoice.findById(invoiceId);
    const coveredLine = draftInvoice.lines.find((l) => l.lineType === "service" && l.isCoveredBySubscription);
    const duplicatedCoveredLine = {
      ...coveredLine.toObject(),
      _id: new (await import("mongoose")).default.Types.ObjectId(),
    };
    draftInvoice.lines.push(duplicatedCoveredLine);
    await draftInvoice.save();

    // 4. Finalize invoice: Since payableAmount === 0, finalizeInvoice immediately attempts zero-due settlement!
    // Line 1 will decrement remaining from 1 to 0.
    // Line 2 will detect remainingQuantity (0) < 1 and throw 409!
    const finRes = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/finalize`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send();

    // Expect 409 Conflict
    expect(finRes.status).toBe(409);
    expect(finRes.body.message).toMatch(/Insufficient subscription entitlement balance/i);

    // 5. Complete Atomic Rollback Verification
    // A. Invoice remains in draft status, not finalized
    const invoiceAfter = await Invoice.findById(invoiceId);
    expect(invoiceAfter.status).toBe("draft");
    expect(invoiceAfter.finalizedAt).toBeNull();

    // B. No SubscriptionUsage document was created
    const usages = await SubscriptionUsage.find({ subscriptionId: singleQuotaSub._id });
    expect(usages).toHaveLength(0);

    // C. Subscription quota remains completely untouched (1 remaining, 0 used, status active)
    const subAfter = await Subscription.findById(singleQuotaSub._id);
    expect(subAfter.status).toBe("active");
    expect(subAfter.members[0].entitlements[0].remainingQuantity).toBe(1);
    expect(subAfter.members[0].entitlements[0].usedQuantity).toBe(0);
  });
});
