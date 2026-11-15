import { describe, expect, it, beforeAll, afterAll, beforeEach, jest } from "@jest/globals";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app.mjs";
import { Organization } from "../../../src/models/organizations/organization.model.js";
import { Branch } from "../../../src/models/branches/branch.model.js";
import { Role } from "../../../src/models/roles/role.model.js";
import { Permission } from "../../../src/models/permissions/permission.model.js";
import { User } from "../../../src/models/users/user.model.js";
import { Customer } from "../../../src/models/customers/customer.model.js";
import { Service } from "../../../src/models/services/service.model.js";
import { Invoice } from "../../../src/models/billing/invoice.model.js";
import { Coupon } from "../../../src/models/coupons/coupon.model.js";
import { CouponUsage } from "../../../src/models/coupons/couponUsage.model.js";
import { CouponCustomerUsage } from "../../../src/models/coupons/couponCustomerUsage.model.js";
import jwt from "jsonwebtoken";
import { env } from "../../../src/config/env.js";
import { redis } from "../../../src/utils/redis.js";
import { getIsolatedTestMongoUri } from "../testSetup.js";

jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");

describe("Coupons Module - Stage 2 Billing Redemption & Concurrency Tests", () => {
  jest.setTimeout(40000);

  let orgA, orgB;
  let branchA1, branchA2, branchB1;
  let ownerTokenOrgA, cashierTokenOrgA, viewOnlyTokenOrgA, ownerTokenOrgB;
  let ownerUserOrgA, cashierUserOrgA, viewOnlyUserOrgA, ownerUserOrgB;
  let customer1, customer2;
  let standardService;

  beforeAll(async () => {
    const testUri = getIsolatedTestMongoUri("coupon_test");
    await mongoose.connect(testUri);
  });

  afterAll(async () => {
    await CouponUsage.deleteMany({});
    await CouponCustomerUsage.deleteMany({});
    await Coupon.deleteMany({});
    await Invoice.deleteMany({});
    await Service.deleteMany({});
    await Customer.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Permission.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await CouponUsage.deleteMany({});
    await CouponCustomerUsage.deleteMany({});
    await Coupon.deleteMany({});
    await Invoice.deleteMany({});
    await Service.deleteMany({});
    await Customer.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Permission.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});

    // 1. Create Organizations
    orgA = await Organization.create({
      name: "Salon Org A",
      code: "ORGA",
      slug: "salon-org-a",
      email: "orga@test.com",
    });

    orgB = await Organization.create({
      name: "Salon Org B",
      code: "ORGB",
      slug: "salon-org-b",
      email: "orgb@test.com",
    });

    // 2. Create Branches
    branchA1 = await Branch.create({
      name: "Branch A1",
      organizationId: orgA._id,
      isActive: true,
    });

    branchA2 = await Branch.create({
      name: "Branch A2",
      organizationId: orgA._id,
      isActive: true,
    });

    branchB1 = await Branch.create({
      name: "Branch B1",
      organizationId: orgB._id,
      isActive: true,
    });

    // 3. Create Permissions
    const permCheckout = await Permission.create({
      name: "billing.checkout",
      module: "Billing & POS",
      action: "Checkout",
      description: "Checkout",
    });
    const permView = await Permission.create({
      name: "billing.view",
      module: "Billing & POS",
      action: "View",
      description: "View",
    });
    const permCouponApply = await Permission.create({
      name: "coupons.apply",
      module: "Coupons",
      action: "Apply",
      description: "Apply",
    });
    const permVoid = await Permission.create({
      name: "billing.void",
      module: "Billing & POS",
      action: "Void",
      description: "Void",
    });

    // 4. Create Roles
    // Owner Role has all permissions (System role has unique name across DB)
    const ownerRole = await Role.create({
      name: "owner",
      organizationId: orgA._id,
      permissions: [permCheckout._id, permView._id, permCouponApply._id, permVoid._id],
      isSystem: true,
    });

    // Cashier Role has billing.checkout AND coupons.apply
    const cashierRole = await Role.create({
      name: "cashier",
      organizationId: orgA._id,
      permissions: [permCheckout._id, permView._id, permCouponApply._id, permVoid._id],
      isSystem: false,
    });

    // View-Only Role has billing.view but lacks coupons.apply and checkout
    const viewOnlyRole = await Role.create({
      name: "reception_viewer",
      organizationId: orgA._id,
      permissions: [permView._id],
      isSystem: false,
    });

    // 5. Create Users & Tokens
    ownerUserOrgA = await User.create({
      name: "Owner A",
      email: "owner-a@test.com",
      phone: "+919876543201",
      password: "password123",
      organizationId: orgA._id,
      role: ownerRole._id,
      hasOrgWideAccess: true,
      branchAccess: [{ branchId: branchA1._id, branchName: "Branch A1", isActive: true }],
      status: "active",
    });

    cashierUserOrgA = await User.create({
      name: "Cashier A",
      email: "cashier-a@test.com",
      phone: "+919876543202",
      password: "password123",
      organizationId: orgA._id,
      role: cashierRole._id,
      hasOrgWideAccess: false,
      branchAccess: [
        { branchId: branchA1._id, branchName: "Branch A1", isActive: true },
        { branchId: branchA2._id, branchName: "Branch A2", isActive: true },
      ],
      status: "active",
    });

    viewOnlyUserOrgA = await User.create({
      name: "Viewer A",
      email: "viewer-a@test.com",
      phone: "+919876543203",
      password: "password123",
      organizationId: orgA._id,
      role: viewOnlyRole._id,
      hasOrgWideAccess: false,
      branchAccess: [{ branchId: branchA1._id, branchName: "Branch A1", isActive: true }],
      status: "active",
    });

    ownerUserOrgB = await User.create({
      name: "Owner B",
      email: "owner-b@test.com",
      phone: "+919876543204",
      password: "password123",
      organizationId: orgB._id,
      role: ownerRole._id,
      hasOrgWideAccess: true,
      branchAccess: [{ branchId: branchB1._id, branchName: "Branch B1", isActive: true }],
      status: "active",
    });

    ownerTokenOrgA = jwt.sign(
      { id: ownerUserOrgA._id, organizationId: orgA._id, role: "owner" },
      env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    cashierTokenOrgA = jwt.sign(
      { id: cashierUserOrgA._id, organizationId: orgA._id, role: "cashier" },
      env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    viewOnlyTokenOrgA = jwt.sign(
      { id: viewOnlyUserOrgA._id, organizationId: orgA._id, role: "reception_viewer" },
      env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    ownerTokenOrgB = jwt.sign(
      { id: ownerUserOrgB._id, organizationId: orgB._id, role: "owner" },
      env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    // 6. Create Customers
    customer1 = await Customer.create({
      organizationId: orgA._id,
      homeBranchId: branchA1._id,
      name: "Alice Smith",
      phone: "+919811111111",
      email: "alice@test.com",
    });

    customer2 = await Customer.create({
      organizationId: orgA._id,
      homeBranchId: branchA1._id,
      name: "Bob Jones",
      phone: "+919822222222",
      email: "bob@test.com",
    });

    // 7. Create Services
    const dummyCategoryId = new mongoose.Types.ObjectId();
    standardService = await Service.create({
      organizationId: orgA._id,
      name: "Haircut & Styling",
      categoryId: dummyCategoryId,
      pricing: {
        basePrice: 1000,
      },
      duration: 45,
      gender: "unisex",
      status: "active",
    });
  });

  // Helper to create a Draft Invoice
  async function createDraftInvoice({
    customerId = customer1._id,
    branchId = branchA1._id,
    token = cashierTokenOrgA,
    servicePrice = 1000,
    hasSubscription = false,
  } = {}) {
    const lines = [
      {
        lineType: "service",
        serviceType: "registered",
        serviceId: standardService._id,
        name: "Haircut & Styling",
        quantity: 1,
        unitPrice: servicePrice,
        lineTotal: servicePrice,
        isCoveredBySubscription: false,
        subscriptionCoveredAmount: 0,
        customerPayable: servicePrice,
        discountAmount: 0,
      },
    ];

    if (hasSubscription) {
      lines.push({
        lineType: "service",
        serviceType: "registered",
        serviceId: standardService._id,
        name: "Covered Facial",
        quantity: 1,
        unitPrice: 500,
        lineTotal: 500,
        isCoveredBySubscription: true,
        subscriptionCoveredAmount: 500,
        customerPayable: 0,
        discountAmount: 0,
      });
    }

    const subtotal = hasSubscription ? servicePrice + 500 : servicePrice;
    const eligibleUncoveredAmount = servicePrice;
    const subscriptionCoveredAmount = hasSubscription ? 500 : 0;

    const invoice = await Invoice.create({
      organizationId: orgA._id,
      branchId,
      invoiceNumber: `INV-TEST-${new mongoose.Types.ObjectId()}`,
      invoiceType: "unified",
      customerId,
      customerSnapshot: {
        name: "Test Customer",
        phone: "+919811111111",
      },
      lines,
      subtotal,
      subscriptionCoveredAmount,
      lineDiscountsTotal: 0,
      invoiceDiscountsTotal: 0,
      discountTotal: 0,
      grossPayable: subtotal,
      payableAmount: eligibleUncoveredAmount,
      amountPaid: 0,
      amountDue: eligibleUncoveredAmount,
      status: "draft",
      paymentStatus: "unpaid",
      createdBy: cashierUserOrgA._id,
    });

    return invoice;
  }

  describe("1. Coupon Application & Financial Calculation", () => {
    it("should successfully apply percentage coupon and calculate correct invoice totals", async () => {
      const coupon = await Coupon.create({
        organizationId: orgA._id,
        code: "SAVE20",
        codeUpper: "SAVE20",
        discountType: "percentage",
        discountValue: 20,
        validFrom: new Date(Date.now() - 3600000),
        validUntil: new Date(Date.now() + 3600000),
        status: "active",
        createdBy: ownerUserOrgA._id,
      });

      const invoice = await createDraftInvoice({ servicePrice: 1000 });

      const res = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/coupons`)
        .set("Authorization", `Bearer ${cashierTokenOrgA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({ code: "save20" });

      if (res.status !== 200) {
        console.log("FAIL RES STATUS:", res.status, "BODY:", JSON.stringify(res.body));
      }
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.coupon.code).toBe("SAVE20");
      expect(res.body.data.coupon.calculatedDiscountAmount).toBe(200);
      expect(res.body.data.discountTotal).toBe(200);
      expect(res.body.data.payableAmount).toBe(800);
      expect(res.body.data.amountDue).toBe(800);
    });

    it("should successfully apply fixed amount coupon and clamp if higher than eligible amount", async () => {
      const coupon = await Coupon.create({
        organizationId: orgA._id,
        code: "FLAT1500",
        codeUpper: "FLAT1500",
        discountType: "fixed",
        discountValue: 1500,
        validFrom: new Date(Date.now() - 3600000),
        validUntil: new Date(Date.now() + 3600000),
        status: "active",
        createdBy: ownerUserOrgA._id,
      });

      const invoice = await createDraftInvoice({ servicePrice: 1000 });

      const res = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/coupons`)
        .set("Authorization", `Bearer ${cashierTokenOrgA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({ code: "FLAT1500" });

      if (res.status !== 200) {
        console.log("FAIL RES STATUS:", res.status, "BODY:", JSON.stringify(res.body));
      }
      expect(res.status).toBe(200);
      expect(res.body.data.coupon.calculatedDiscountAmount).toBe(1000); // Clamped to 1000
      expect(res.body.data.payableAmount).toBe(0);
      expect(res.body.data.amountDue).toBe(0);
    });

    it("should exclude subscription-covered lines from coupon eligibility", async () => {
      const coupon = await Coupon.create({
        organizationId: orgA._id,
        code: "HALF50",
        codeUpper: "HALF50",
        discountType: "percentage",
        discountValue: 50,
        validFrom: new Date(Date.now() - 3600000),
        validUntil: new Date(Date.now() + 3600000),
        status: "active",
        createdBy: ownerUserOrgA._id,
      });

      // Invoice has ₹1,000 eligible service + ₹500 subscription-covered service (Subtotal: ₹1,500)
      const invoice = await createDraftInvoice({ servicePrice: 1000, hasSubscription: true });

      const res = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/coupons`)
        .set("Authorization", `Bearer ${cashierTokenOrgA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({ code: "HALF50" });

      if (res.status !== 200) {
        console.log("FAIL RES STATUS:", res.status, "BODY:", JSON.stringify(res.body));
      }
      expect(res.status).toBe(200);
      // 50% discount applies ONLY to ₹1,000 uncovered base = ₹500
      expect(res.body.data.coupon.calculatedDiscountAmount).toBe(500);
      expect(res.body.data.subtotal).toBe(1500);
      expect(res.body.data.subscriptionCoveredAmount).toBe(500);
      expect(res.body.data.payableAmount).toBe(500);
    });

    it("should remove applied coupon from draft invoice and restore original totals", async () => {
      const coupon = await Coupon.create({
        organizationId: orgA._id,
        code: "SAVE20",
        codeUpper: "SAVE20",
        discountType: "percentage",
        discountValue: 20,
        validFrom: new Date(Date.now() - 3600000),
        validUntil: new Date(Date.now() + 3600000),
        status: "active",
        createdBy: ownerUserOrgA._id,
      });

      const invoice = await createDraftInvoice({ servicePrice: 1000 });

      // Apply
      await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/coupons`)
        .set("Authorization", `Bearer ${cashierTokenOrgA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({ code: "SAVE20" });

      // Remove
      const delRes = await request(app)
        .delete(`/api/v1/billing/invoices/${invoice._id}/coupons`)
        .set("Authorization", `Bearer ${cashierTokenOrgA}`)
        .set("X-Branch-Id", branchA1._id.toString());

      expect(delRes.status).toBe(200);
      expect(delRes.body.data.coupon).toBeNull();
      expect(delRes.body.data.discountTotal).toBe(0);
      expect(delRes.body.data.payableAmount).toBe(1000);
    });
  });

  describe("2. Validation & Anti-Stacking Guards", () => {
    it("should reject coupon application if invoice already has a manual promotional discount", async () => {
      const coupon = await Coupon.create({
        organizationId: orgA._id,
        code: "PROMO10",
        codeUpper: "PROMO10",
        discountType: "percentage",
        discountValue: 10,
        validFrom: new Date(Date.now() - 3600000),
        validUntil: new Date(Date.now() + 3600000),
        status: "active",
        createdBy: ownerUserOrgA._id,
      });

      const invoice = await createDraftInvoice({ servicePrice: 1000 });

      // Apply manual discount first
      await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenOrgA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          discountLevel: "invoice",
          discountType: "fixed",
          enteredValue: 100,
          reason: "Cashier manual courtesy discount",
        });

      // Attempt to apply coupon -> Should fail with 400
      const res = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/coupons`)
        .set("Authorization", `Bearer ${cashierTokenOrgA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({ code: "PROMO10" });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/existing promotional or manual discounts/i);
    });

    it("should reject coupon if coupon is excluded from the invoice branch", async () => {
      const coupon = await Coupon.create({
        organizationId: orgA._id,
        code: "EXCLUDE_B2",
        codeUpper: "EXCLUDE_B2",
        discountType: "percentage",
        discountValue: 15,
        validFrom: new Date(Date.now() - 3600000),
        validUntil: new Date(Date.now() + 3600000),
        status: "active",
        excludedBranchIds: [branchA2._id],
        createdBy: ownerUserOrgA._id,
      });

      const invoice = await createDraftInvoice({ branchId: branchA2._id });

      const res = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/coupons`)
        .set("Authorization", `Bearer ${cashierTokenOrgA}`)
        .set("X-Branch-Id", branchA2._id.toString())
        .send({ code: "EXCLUDE_B2" });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not valid for redemption at this branch/i);
    });

    it("should reject coupon belonging to another organization (tenant isolation)", async () => {
      await Coupon.create({
        organizationId: orgB._id,
        code: "ORGB_ONLY",
        codeUpper: "ORGB_ONLY",
        discountType: "fixed",
        discountValue: 100,
        validFrom: new Date(Date.now() - 3600000),
        validUntil: new Date(Date.now() + 3600000),
        status: "active",
        createdBy: ownerUserOrgB._id,
      });

      const invoice = await createDraftInvoice({ branchId: branchA1._id });

      const res = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/coupons`)
        .set("Authorization", `Bearer ${cashierTokenOrgA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({ code: "ORGB_ONLY" });

      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/not found/i);
    });
  });

  describe("3. Usage Lifecycle: Finalization & Cancellation", () => {
    it("should consume usage exactly once on invoice finalization", async () => {
      const coupon = await Coupon.create({
        organizationId: orgA._id,
        code: "FINALIZE_TEST",
        codeUpper: "FINALIZE_TEST",
        discountType: "percentage",
        discountValue: 10,
        validFrom: new Date(Date.now() - 3600000),
        validUntil: new Date(Date.now() + 3600000),
        status: "active",
        totalUsageLimit: 5,
        perCustomerLimit: 2,
        createdBy: ownerUserOrgA._id,
      });

      const invoice = await createDraftInvoice({ servicePrice: 1000 });

      // Apply coupon (does not increment usage)
      await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/coupons`)
        .set("Authorization", `Bearer ${cashierTokenOrgA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({ code: "FINALIZE_TEST" });

      const couponPreFinalize = await Coupon.findById(coupon._id);
      expect(couponPreFinalize.usageCount).toBe(0);
      expect(couponPreFinalize.activeUsageCount).toBe(0);

      // Finalize invoice
      const finRes = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/finalize`)
        .set("Authorization", `Bearer ${cashierTokenOrgA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({});

      expect(finRes.status).toBe(200);

      // Verify Coupon Counters
      const couponPostFinalize = await Coupon.findById(coupon._id);
      expect(couponPostFinalize.usageCount).toBe(1);
      expect(couponPostFinalize.activeUsageCount).toBe(1);

      // Verify Customer Counter
      const custCounter = await CouponCustomerUsage.findOne({
        organizationId: orgA._id,
        couponId: coupon._id,
        customerId: customer1._id,
      });
      expect(custCounter.activeUsageCount).toBe(1);
      expect(custCounter.historicalUsageCount).toBe(1);

      // Verify CouponUsage Ledger Record
      const usageLedger = await CouponUsage.findOne({
        invoiceId: invoice._id,
      });
      expect(usageLedger).not.toBeNull();
      expect(usageLedger.status).toBe("consumed");
      expect(usageLedger.discountAmount).toBe(100);
    });

    it("should reverse active capacity on cancellation while preserving historical usageCount", async () => {
      const coupon = await Coupon.create({
        organizationId: orgA._id,
        code: "CANCEL_TEST",
        codeUpper: "CANCEL_TEST",
        discountType: "fixed",
        discountValue: 200,
        validFrom: new Date(Date.now() - 3600000),
        validUntil: new Date(Date.now() + 3600000),
        status: "active",
        totalUsageLimit: 5,
        perCustomerLimit: 1,
        createdBy: ownerUserOrgA._id,
      });

      const invoice = await createDraftInvoice({ servicePrice: 1000 });

      // Apply & Finalize
      await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/coupons`)
        .set("Authorization", `Bearer ${cashierTokenOrgA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({ code: "CANCEL_TEST" });

      await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/finalize`)
        .set("Authorization", `Bearer ${cashierTokenOrgA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({});

      // Cancel invoice
      const cancelRes = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/cancel`)
        .set("Authorization", `Bearer ${cashierTokenOrgA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({ reason: "Customer changed mind before payment" });

      expect(cancelRes.status).toBe(200);

      // Verify Coupon Counters:
      // usageCount MUST remain 1 (historical consumption preserved so Stage 1 terms remain locked)
      // activeUsageCount MUST be decremented to 0 (active capacity restored)
      const couponPostCancel = await Coupon.findById(coupon._id);
      expect(couponPostCancel.usageCount).toBe(1);
      expect(couponPostCancel.activeUsageCount).toBe(0);

      // Customer active usage counter restored to 0
      const custCounter = await CouponCustomerUsage.findOne({
        organizationId: orgA._id,
        couponId: coupon._id,
        customerId: customer1._id,
      });
      expect(custCounter.activeUsageCount).toBe(0);
      expect(custCounter.historicalUsageCount).toBe(1);

      // Ledger marked reversed
      const usageLedger = await CouponUsage.findOne({ invoiceId: invoice._id });
      expect(usageLedger.status).toBe("reversed");
      expect(usageLedger.reversalReason).toBe("Customer changed mind before payment");
    });
  });

  describe("4. Concurrency & Limit Enforcement", () => {
    it("should enforce total usage limit under simultaneous competing finalizations", async () => {
      const coupon = await Coupon.create({
        organizationId: orgA._id,
        code: "LIMIT1",
        codeUpper: "LIMIT1",
        discountType: "percentage",
        discountValue: 10,
        validFrom: new Date(Date.now() - 3600000),
        validUntil: new Date(Date.now() + 3600000),
        status: "active",
        totalUsageLimit: 1, // Exactly 1 total usage allowed
        createdBy: ownerUserOrgA._id,
      });

      const inv1 = await createDraftInvoice({ customerId: customer1._id });
      const inv2 = await createDraftInvoice({ customerId: customer2._id });

      // Apply coupon to both draft invoices
      await request(app)
        .post(`/api/v1/billing/invoices/${inv1._id}/coupons`)
        .set("Authorization", `Bearer ${cashierTokenOrgA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({ code: "LIMIT1" });

      await request(app)
        .post(`/api/v1/billing/invoices/${inv2._id}/coupons`)
        .set("Authorization", `Bearer ${cashierTokenOrgA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({ code: "LIMIT1" });

      // Fire simultaneous competing finalizations in parallel
      const [res1, res2] = await Promise.all([
        request(app)
          .post(`/api/v1/billing/invoices/${inv1._id}/finalize`)
          .set("Authorization", `Bearer ${cashierTokenOrgA}`)
          .set("X-Branch-Id", branchA1._id.toString())
          .send({}),
        request(app)
          .post(`/api/v1/billing/invoices/${inv2._id}/finalize`)
          .set("Authorization", `Bearer ${cashierTokenOrgA}`)
          .set("X-Branch-Id", branchA1._id.toString())
          .send({}),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([200, 409]);

      // Assert persisted counters in DB
      const couponInDb = await Coupon.findById(coupon._id);
      expect(couponInDb.usageCount).toBe(1);
      expect(couponInDb.activeUsageCount).toBe(1);

      // Verify exactly ONE ledger record was created across all invoices
      const ledgerCount = await CouponUsage.countDocuments({
        organizationId: orgA._id,
        couponId: coupon._id,
        status: "consumed",
      });
      expect(ledgerCount).toBe(1);

      // Verify the rejected invoice remains in draft status without partial writes
      const rejectedInvoiceId = res1.status === 409 ? inv1._id : inv2._id;
      const rejectedInvoice = await Invoice.findById(rejectedInvoiceId);
      expect(rejectedInvoice.status).toBe("draft");
      expect(rejectedInvoice.coupon.usageLedgerId).toBeNull();
    });

    it("should enforce per-customer usage limit under simultaneous competing finalizations", async () => {
      const coupon = await Coupon.create({
        organizationId: orgA._id,
        code: "PERCUST1",
        codeUpper: "PERCUST1",
        discountType: "fixed",
        discountValue: 100,
        validFrom: new Date(Date.now() - 3600000),
        validUntil: new Date(Date.now() + 3600000),
        status: "active",
        totalUsageLimit: 10,
        perCustomerLimit: 1, // Exactly 1 usage allowed for this customer
        createdBy: ownerUserOrgA._id,
      });

      // Two different draft invoices for the SAME customer
      const inv1 = await createDraftInvoice({ customerId: customer1._id });
      const inv2 = await createDraftInvoice({ customerId: customer1._id });

      await request(app)
        .post(`/api/v1/billing/invoices/${inv1._id}/coupons`)
        .set("Authorization", `Bearer ${cashierTokenOrgA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({ code: "PERCUST1" });

      await request(app)
        .post(`/api/v1/billing/invoices/${inv2._id}/coupons`)
        .set("Authorization", `Bearer ${cashierTokenOrgA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({ code: "PERCUST1" });

      // Competing first-time finalizations for the same customer
      const [res1, res2] = await Promise.all([
        request(app)
          .post(`/api/v1/billing/invoices/${inv1._id}/finalize`)
          .set("Authorization", `Bearer ${cashierTokenOrgA}`)
          .set("X-Branch-Id", branchA1._id.toString())
          .send({}),
        request(app)
          .post(`/api/v1/billing/invoices/${inv2._id}/finalize`)
          .set("Authorization", `Bearer ${cashierTokenOrgA}`)
          .set("X-Branch-Id", branchA1._id.toString())
          .send({}),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([200, 409]);

      // Exactly ONE counter document exists for this customer with activeUsageCount = 1
      const custCounter = await CouponCustomerUsage.findOne({
        organizationId: orgA._id,
        couponId: coupon._id,
        customerId: customer1._id,
      });
      expect(custCounter).not.toBeNull();
      expect(custCounter.activeUsageCount).toBe(1);
      expect(custCounter.historicalUsageCount).toBe(1);

      // Rejected invoice remains draft without ledger writes
      const rejectedInvoiceId = res1.status === 409 ? inv1._id : inv2._id;
      const rejectedInvoice = await Invoice.findById(rejectedInvoiceId);
      expect(rejectedInvoice.status).toBe("draft");
      expect(rejectedInvoice.coupon.usageLedgerId).toBeNull();
    });

    it("should reject coupon with per-customer limit when invoice lacks a customer record", async () => {
      const coupon = await Coupon.create({
        organizationId: orgA._id,
        code: "CUST_REQ",
        codeUpper: "CUST_REQ",
        discountType: "percentage",
        discountValue: 15,
        validFrom: new Date(Date.now() - 3600000),
        validUntil: new Date(Date.now() + 3600000),
        status: "active",
        perCustomerLimit: 1,
        createdBy: ownerUserOrgA._id,
      });

      // Valid customer draft invoice
      const invoice = await createDraftInvoice({ customerId: customer1._id });

      // Unset customerId directly in database to simulate legacy/corrupted walk-in invoice without customer
      await Invoice.collection.updateOne(
        { _id: invoice._id },
        { $unset: { customerId: "" } }
      );

      const applyRes = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/coupons`)
        .set("Authorization", `Bearer ${cashierTokenOrgA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({ code: "CUST_REQ" });

      expect(applyRes.status).toBe(400);
      expect(applyRes.body.message).toMatch(/customer record is required/i);
    });

    it("should atomically permit exactly one coupon when two different coupons are applied concurrently to the same draft invoice", async () => {
      // 1. Create two distinct valid active coupons with individual eligibility
      const couponA = await Coupon.create({
        organizationId: orgA._id,
        code: "COUPONA",
        codeUpper: "COUPONA",
        discountType: "percentage",
        discountValue: 20, // 20% of 1000 = 200
        validFrom: new Date(Date.now() - 3600000),
        validUntil: new Date(Date.now() + 3600000),
        status: "active",
        totalUsageLimit: 10,
        perCustomerLimit: 5,
        createdBy: ownerUserOrgA._id,
      });

      const couponB = await Coupon.create({
        organizationId: orgA._id,
        code: "COUPONB",
        codeUpper: "COUPONB",
        discountType: "fixed",
        discountValue: 150, // Fixed 150
        validFrom: new Date(Date.now() - 3600000),
        validUntil: new Date(Date.now() + 3600000),
        status: "active",
        totalUsageLimit: 10,
        perCustomerLimit: 5,
        createdBy: ownerUserOrgA._id,
      });

      // 2. Create clean draft invoice with no manual/promotional discounts
      const draftInvoice = await createDraftInvoice({
        servicePrice: 1000,
        customerId: customer1._id,
      });

      expect(draftInvoice.status).toBe("draft");
      expect(draftInvoice.coupon).toBeNull();
      expect(draftInvoice.subtotal).toBe(1000);
      expect(draftInvoice.discountTotal).toBe(0);

      // 3. Launch both requests simultaneously against the same draft invoice
      const [resA, resB] = await Promise.all([
        request(app)
          .post(`/api/v1/billing/invoices/${draftInvoice._id}/coupons`)
          .set("Authorization", `Bearer ${cashierTokenOrgA}`)
          .set("X-Branch-Id", branchA1._id.toString())
          .send({ code: "COUPONA" }),
        request(app)
          .post(`/api/v1/billing/invoices/${draftInvoice._id}/coupons`)
          .set("Authorization", `Bearer ${cashierTokenOrgA}`)
          .set("X-Branch-Id", branchA1._id.toString())
          .send({ code: "COUPONB" }),
      ]);

      const statuses = [resA.status, resB.status];
      // Assertion 1: Exactly one request succeeds with 200
      expect(statuses.filter((s) => s === 200).length).toBe(1);

      // Assertion 2: The other request is rejected with 400 or 409
      expect(statuses.filter((s) => s === 400 || s === 409).length).toBe(1);

      const winningRes = resA.status === 200 ? resA : resB;
      const losingRes = resA.status === 200 ? resB : resA;
      const winningCode = winningRes.body.data.coupon.code;
      const losingCode = winningCode === "COUPONA" ? "COUPONB" : "COUPONA";

      expect(["COUPONA", "COUPONB"]).toContain(winningCode);
      expect(losingRes.body.message).toMatch(/(already has coupon|concurrent modification|Stacking is not permitted)/i);

      // Assertion 3: Reload invoice directly from MongoDB
      const reloadedInvoice = await Invoice.findById(draftInvoice._id);

      // Assertion 4: Persisted invoice contains exactly one applied coupon
      expect(reloadedInvoice.coupon).not.toBeNull();
      expect(reloadedInvoice.coupon.couponId).toBeDefined();

      // Assertion 5: Persisted snapshot identifies winning coupon, never both
      expect(reloadedInvoice.coupon.code).toBe(winningCode);

      // Assertion 6: Discount totals reflect only the winning coupon
      if (winningCode === "COUPONA") {
        expect(reloadedInvoice.coupon.calculatedDiscountAmount).toBe(200);
        expect(reloadedInvoice.discountTotal).toBe(200);
        expect(reloadedInvoice.payableAmount).toBe(800);
        expect(reloadedInvoice.amountDue).toBe(800);
      } else {
        expect(reloadedInvoice.coupon.calculatedDiscountAmount).toBe(150);
        expect(reloadedInvoice.discountTotal).toBe(150);
        expect(reloadedInvoice.payableAmount).toBe(850);
        expect(reloadedInvoice.amountDue).toBe(850);
      }

      // Assertion 7: Losing coupon has no usage consumption
      const reloadedCouponA = await Coupon.findById(couponA._id);
      const reloadedCouponB = await Coupon.findById(couponB._id);

      // Assertion 8: Neither coupon's usageCount nor activeUsageCount changes during application alone
      expect(reloadedCouponA.usageCount).toBe(0);
      expect(reloadedCouponA.activeUsageCount).toBe(0);
      expect(reloadedCouponB.usageCount).toBe(0);
      expect(reloadedCouponB.activeUsageCount).toBe(0);

      // Assertion 9: No CouponUsage consumed ledger entry is created before finalization
      const ledgerEntries = await CouponUsage.find({ invoiceId: draftInvoice._id });
      expect(ledgerEntries.length).toBe(0);

      // Assertion 10: Invoice remains in draft status
      expect(reloadedInvoice.status).toBe("draft");

      // Assertion 11: No partial or inconsistent financial state remains after both requests finish
      expect(reloadedInvoice.subtotal).toBe(1000);
      expect(reloadedInvoice.grossPayable).toBe(1000 - reloadedInvoice.discountTotal);
      expect(reloadedInvoice.payableAmount).toBe(
        reloadedInvoice.subtotal - reloadedInvoice.discountTotal
      );
      expect(reloadedInvoice.amountDue).toBe(reloadedInvoice.payableAmount);
    });
  });

  describe("5. Permission Enforcement", () => {
    it("should require both billing.checkout AND coupons.apply to apply or remove a coupon", async () => {
      const coupon = await Coupon.create({
        organizationId: orgA._id,
        code: "AUTH_TEST",
        codeUpper: "AUTH_TEST",
        discountType: "percentage",
        discountValue: 10,
        validFrom: new Date(Date.now() - 3600000),
        validUntil: new Date(Date.now() + 3600000),
        status: "active",
        createdBy: ownerUserOrgA._id,
      });

      const invoice = await createDraftInvoice({ servicePrice: 1000 });

      // View-only user has billing.view but lacks billing.checkout & coupons.apply
      const res = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/coupons`)
        .set("Authorization", `Bearer ${viewOnlyTokenOrgA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({ code: "AUTH_TEST" });

      expect(res.status).toBe(403);
    });
  });
});

