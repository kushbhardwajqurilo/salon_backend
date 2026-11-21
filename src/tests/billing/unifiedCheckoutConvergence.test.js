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
import { Staff } from "../../models/staff/staff.model.js";
import { StaffBranch } from "../../models/staff/staffBranch.model.js";
import { Service } from "../../models/services/service.model.js";
import { ServiceCategory } from "../../models/services/serviceCategory.model.js";
import { Customer } from "../../models/customers/customer.model.js";
import { Product } from "../../models/inventory/product.model.js";
import { StockBalance } from "../../models/inventory/stockBalance.model.js";
import { SubscriptionPlan } from "../../models/subscriptions/subscriptionPlan.model.js";
import { MembershipPlan } from "../../models/memberships/membershipPlan.model.js";
import { CustomerMembership } from "../../models/memberships/customerMembership.model.js";
import { Invoice } from "../../models/billing/invoice.model.js";
import { Payment } from "../../models/billing/payment.model.js";
import { StockMovement } from "../../models/inventory/stockMovement.model.js";
import { PayrollIncentiveAllocation } from "../../models/payroll/payrollIncentiveAllocation.model.js";
import { PayrollPayment } from "../../models/payroll/payrollPayment.model.js";
import { PayrollPeriod } from "../../models/payroll/payrollPeriod.model.js";
import { PayrollRecord } from "../../models/payroll/payrollRecord.model.js";
import { SalaryStructure } from "../../models/payroll/salaryStructure.model.js";
import { IncentiveRecoveryPayment } from "../../models/incentives/incentiveRecoveryPayment.model.js";
import {
  IncentiveLedger,
  IncentiveRecoveryObligation,
  IncentiveScheme,
  InvoiceSettlementEvent,
  SchemeAssignment,
} from "../../models/incentives/index.js";
import { settlementFulfillmentEventService } from "../../services/incentives/settlementFulfillmentEvent.service.js";
import { runInTransaction } from "../../utils/transaction.js";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";

describe("Unified Billing Convergence & Single Checkout Lifecycle Suite", () => {
  jest.setTimeout(45000);
  let orgId, branchId, userToken, cashierUserId, role, customer, staff, service, product, subPlan, memPlan;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    const testUri = getIsolatedTestMongoUri("checkout_queue_test");
    await mongoose.connect(testUri);
    await Promise.all([
      InvoiceSettlementEvent.init(),
      IncentiveLedger.init(),
      PayrollIncentiveAllocation.init(),
      PayrollPayment.init(),
      IncentiveRecoveryPayment.init(),
    ]);
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
      "payments.refund",
      "memberships.view",
      "subscriptions.sell",
      "appointments.update_status",
      "payroll.calculate",
      "payroll.approve",
      "payroll.disburse",
      "payroll.reverse",
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
    cashierUserId = user._id;

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

    staff = await Staff.create({
      name: "Assigned Appointment Stylist",
      phone: `+919${Math.floor(100000000 + Math.random() * 900000000)}`,
      email: `stylist_${Date.now()}@test.com`,
      designation: "Stylist",
      joiningDate: new Date(),
      organizationId: orgId,
      status: "active",
      staffCode: `STF-${Date.now()}`,
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

  beforeEach(async () => {
    // Reset any state leaked from previous tests:
    // 1. Delete customer memberships so customer doesn't have an unexpected active membership
    await CustomerMembership.deleteMany({ organizationId: orgId });
    // 2. Reset product stock balance so available onHand and allocated are clean
    await StockBalance.updateOne(
      { organizationId: orgId, branchId, productId: product._id },
      { $set: { onHand: 100, allocated: 0, available: 100 } }
    );
  });

  afterAll(async () => {
    await PayrollPayment.deleteMany({ organizationId: orgId });
    await IncentiveRecoveryPayment.deleteMany({ organizationId: orgId });
    await PayrollIncentiveAllocation.deleteMany({ organizationId: orgId });
    await PayrollRecord.deleteMany({ organizationId: orgId });
    await PayrollPeriod.deleteMany({ organizationId: orgId });
    await SalaryStructure.deleteMany({ organizationId: orgId });
    await IncentiveLedger.deleteMany({ organizationId: orgId });
    await IncentiveRecoveryObligation.deleteMany({ organizationId: orgId });
    await InvoiceSettlementEvent.deleteMany({ organizationId: orgId });
    await SchemeAssignment.deleteMany({ organizationId: orgId });
    await IncentiveScheme.deleteMany({ organizationId: orgId });
    await Invoice.deleteMany({ organizationId: orgId });
    await Payment.deleteMany({ organizationId: orgId });
    await StockMovement.deleteMany({ organizationId: orgId });
    await Appointment.deleteMany({ organizationId: orgId });
    await Customer.deleteMany({ organizationId: orgId });
    await Product.deleteMany({ organizationId: orgId });
    await Service.deleteMany({ organizationId: orgId });
    await SubscriptionPlan.deleteMany({ organizationId: orgId });
    await MembershipPlan.deleteMany({ organizationId: orgId });
    await CustomerMembership.deleteMany({ organizationId: orgId });
    await StaffBranch.deleteMany({ organizationId: orgId });
    await Staff.deleteMany({ organizationId: orgId });
    await User.deleteMany({ organizationId: orgId });
    await Role.deleteMany({ organizationId: orgId });
    await Branch.deleteMany({ organizationId: orgId });
    await Organization.deleteMany({ _id: orgId });
    await mongoose.connection.close();
  });

  async function createAppointmentFixture(status = "completed", staffId = staff._id) {
    return Appointment.create({
      organizationId: orgId,
      branchId,
      customerId: customer._id,
      staffId,
      appointmentCode: `APT-CONV-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      appointmentDate: "2026-11-20",
      startTime: "10:00",
      endTime: "10:30",
      totalDuration: 30,
      startAt: new Date(),
      endAt: new Date(Date.now() + 1800000),
      duration: 30,
      status,
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

  async function createCommissionStaff(codePrefix) {
    const unique = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const commissionStaff = await Staff.create({
      name: `${codePrefix} Incentive Staff`,
      email: `${codePrefix.toLowerCase()}-${unique}@test.com`,
      phone: `+919${Math.floor(100000000 + Math.random() * 900000000)}`,
      designation: "Stylist",
      joiningDate: new Date("2026-01-01T00:00:00.000Z"),
      organizationId: orgId,
      status: "active",
      staffCode: `${codePrefix}-${unique}`,
    });
    await StaffBranch.create({
      staffId: commissionStaff._id,
      branchId,
      organizationId: orgId,
      isPrimary: true,
      isActive: true,
    });
    return commissionStaff;
  }

  async function getCurrentPayrollPeriod() {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const monthYear = `${year}-${String(month).padStart(2, "0")}`;
    const existingPeriod = await PayrollPeriod.findOne({
      organizationId: orgId,
      monthYear,
      isDeleted: false,
    });
    if (existingPeriod) return existingPeriod;

    return PayrollPeriod.create({
      organizationId: orgId,
      year,
      month,
      monthYear,
      startDate: new Date(Date.UTC(year, month - 1, 1)),
      endDate: new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)),
      totalDays: new Date(Date.UTC(year, month, 0)).getUTCDate(),
      status: "open",
    });
  }

  async function settleCommissionInPayroll({ commissionStaff, accrual, idempotencyKey }) {
    const period = await getCurrentPayrollPeriod();
    await SalaryStructure.create({
      organizationId: orgId,
      staffId: commissionStaff._id,
      payType: "fixed_monthly",
      baseSalary: 30000,
      effectiveFrom: period.startDate,
    });

    const calculation = await request(app)
      .post("/api/v1/payroll/calculate")
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({
        payrollPeriodId: period._id.toString(),
        staffIds: [commissionStaff._id.toString()],
      });
    expect(calculation.status).toBe(200);
    const record = calculation.body.data.find(
      (item) => item.staffId === commissionStaff._id.toString(),
    );
    expect(record).toBeDefined();
    expect(record.incentiveLedgerEntryIds).toContain(accrual._id.toString());

    const approval = await request(app)
      .post(`/api/v1/payroll/records/${record._id}/approve`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({});
    expect(approval.status).toBe(200);
    const allocation = await PayrollIncentiveAllocation.findOne({
      organizationId: orgId,
      incentiveLedgerId: accrual._id,
    });
    expect(allocation).toMatchObject({
      sourceType: accrual.sourceType,
      payableAmountInPaise: accrual.amountInPaise,
      status: "approved",
    });
    expect(allocation.staffId.toString()).toBe(commissionStaff._id.toString());
    expect(allocation.sourceBranchId.toString()).toBe(branchId.toString());
    expect(allocation.payrollPeriodId.toString()).toBe(period._id.toString());

    const paymentAttempt = await request(app)
      .post(`/api/v1/payroll/records/${record._id}/pay`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({
        paymentMethod: "bank_transfer",
        paymentReference: `MANUAL-${idempotencyKey}`,
        amountInPaise: Math.round(record.calculations.netPayable * 100),
        paymentDate: period.endDate.toISOString(),
        idempotencyKey,
      });
    expect(paymentAttempt.status).toBe(201);
    expect(paymentAttempt.body.data.record.status).toBe("approved");

    const confirmation = await request(app)
      .post(`/api/v1/payroll/records/${record._id}/payments/${paymentAttempt.body.data.payment._id}/confirm`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({ confirmActualPayment: true });
    expect(confirmation.status).toBe(200);
    expect(confirmation.body.data.record.status).toBe("paid");
    expect((await PayrollIncentiveAllocation.findById(allocation._id)).status).toBe("paid");
    return { record, allocation };
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
    expect(res.body.data.lines[0].staffId).toBe(staff._id.toString());
  });

  it("accrues commission when an already-settled appointment is completed through the appointment API", async () => {
    const serviceStaff = await createCommissionStaff("SERVICE");
    const appointment = await createAppointmentFixture("completed", serviceStaff._id);
    const scheme = await IncentiveScheme.create({
      organizationId: orgId,
      name: "Billing integration commission",
      code: `BILLING-COMMISSION-${Date.now()}`,
      schemeType: "COMMISSION",
      calculationBasis: "SERVICE_NET_REVENUE",
      rules: {
        tiers: [{ minPaise: 0, maxPaise: null, percentage: 10, fixedPaise: 0 }],
      },
      status: "active",
    });
    await SchemeAssignment.create({
      organizationId: orgId,
      schemeId: scheme._id,
      scopeType: "STAFF",
      scopeId: serviceStaff._id,
      startDate: new Date("2026-01-01T00:00:00.000Z"),
      endDate: null,
      status: "active",
    });

    const checkout = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({ appointmentId: appointment._id.toString() });
    expect(checkout.status).toBe(201);
    const invoiceId = checkout.body.data._id;
    const invoiceLineId = checkout.body.data.lines[0]._id;

    await Appointment.updateOne(
      { _id: appointment._id, organizationId: orgId },
      { $set: { status: "in_progress" }, $unset: { completedAt: 1 } },
    );

    const finalized = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/finalize`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send();
    expect(finalized.status).toBe(200);

    const payment = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .set("Idempotency-Key", `SERVICE-PAY-${invoiceId}`)
      .send({ amount: 600, paymentMethod: "cash" });
    expect(payment.status).toBe(201);
    const paymentRetry = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .set("Idempotency-Key", `SERVICE-PAY-${invoiceId}`)
      .send({ amount: 600, paymentMethod: "cash" });
    expect(paymentRetry.status).toBe(200);
    expect(paymentRetry.body.data.isIdempotentReplay).toBe(true);

    expect(await IncentiveLedger.findOne({ invoiceId, entryType: "ACCRUAL" })).toBeNull();

    const completion = await request(app)
      .patch(`/api/v1/appointments/${appointment._id}/status`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({ branchId: branchId.toString(), status: "completed" });
    expect(completion.status).toBe(200);
    expect(completion.body.data.status).toBe("completed");

    const settlementEvent = await InvoiceSettlementEvent.findOne({ invoiceId });
    const ledgerEntry = await IncentiveLedger.findOne({ invoiceId, entryType: "ACCRUAL" });
    expect(settlementEvent.lineItems[0].staffAttributions[0].staffId.toString()).toBe(
      serviceStaff._id.toString()
    );
    expect(ledgerEntry).not.toBeNull();
    expect(ledgerEntry.sourceType).toBe("service_commission");
    expect(ledgerEntry.organizationId.toString()).toBe(orgId.toString());
    expect(ledgerEntry.branchId.toString()).toBe(branchId.toString());
    expect(ledgerEntry.lineItemId.toString()).toBe(invoiceLineId);
    expect(ledgerEntry.staffId.toString()).toBe(serviceStaff._id.toString());
    expect(ledgerEntry.staffId.toString()).not.toBe(cashierUserId.toString());
    expect(ledgerEntry.amountInPaise).toBe(6000);
    expect(ledgerEntry.sourceRevenueInPaise).toBe(60000);
    expect(ledgerEntry.fulfillmentConfirmedBy.toString()).toBe(
      jwt.decode(userToken).id
    );

    const replayedEntries = await runInTransaction(async (session) => {
      const completedAppointment = await Appointment.findById(appointment._id).session(session);
      const paidInvoice = await Invoice.findById(invoiceId).session(session);
      return settlementFulfillmentEventService.handlePhysicalFulfillmentCompleted({
        appointment: completedAppointment,
        invoice: paidInvoice,
        session,
        userId: cashierUserId,
      });
    });
    expect(replayedEntries).toHaveLength(1);
    expect(await IncentiveLedger.countDocuments({
      organizationId: orgId,
      invoiceId,
      entryType: "ACCRUAL",
      sourceType: "service_commission",
    })).toBe(1);
    await settleCommissionInPayroll({
      commissionStaff: serviceStaff,
      accrual: ledgerEntry,
      idempotencyKey: `service-payroll-${ledgerEntry._id}`,
    });
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
    const subscriptionSeller = await createCommissionStaff("SUBSCRIPTION");
    const scheme = await IncentiveScheme.create({
      organizationId: orgId,
      name: "Subscription Sale Commission",
      code: `SUB_SALE_${Date.now()}`,
      schemeType: "COMMISSION",
      calculationBasis: "SUBSCRIPTION_NET_REVENUE",
      rules: {
        tiers: [{ minPaise: 0, maxPaise: null, percentage: 10, fixedPaise: 0 }],
      },
      status: "active",
    });
    await SchemeAssignment.create({
      organizationId: orgId,
      schemeId: scheme._id,
      scopeType: "STAFF",
      scopeId: subscriptionSeller._id,
      startDate: new Date("2026-01-01T00:00:00.000Z"),
      status: "active",
    });

    const res = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({
        customerId: customer._id.toString(),
        subscriptionLines: [{
          planId: subPlan._id.toString(),
          soldByStaffId: subscriptionSeller._id.toString(),
        }],
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

    const finalizeResponse = await request(app)
      .post(`/api/v1/billing/invoices/${inv._id}/finalize`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({});
    expect(finalizeResponse.status).toBe(200);
    const partialPayment = await request(app)
      .post(`/api/v1/billing/invoices/${inv._id}/payments`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .set("Idempotency-Key", `SUB-PARTIAL-${inv._id}`)
      .send({ amount: 800, paymentMethod: "cash" });
    expect(partialPayment.status).toBe(201);
    expect(await IncentiveLedger.countDocuments({
      organizationId: orgId,
      invoiceId: inv._id,
      entryType: "ACCRUAL",
      sourceType: "subscription_sale_commission",
    })).toBe(0);

    const finalPaymentKey = `SUB-FINAL-${inv._id}`;
    const payment = await request(app)
      .post(`/api/v1/billing/invoices/${inv._id}/payments`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .set("Idempotency-Key", finalPaymentKey)
      .send({ amount: 1000, paymentMethod: "cash" });
    expect(payment.status).toBe(201);
    const paymentRetry = await request(app)
      .post(`/api/v1/billing/invoices/${inv._id}/payments`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .set("Idempotency-Key", finalPaymentKey)
      .send({ amount: 1000, paymentMethod: "cash" });
    expect(paymentRetry.status).toBe(200);
    expect(paymentRetry.body.data.isIdempotentReplay).toBe(true);

    const settlement = await InvoiceSettlementEvent.findOne({
      organizationId: orgId,
      invoiceId: inv._id,
      eventType: "SETTLED",
    });
    expect(settlement.lineItems[0].sourceAttribution.soldBy.staffId.toString()).toBe(
      subscriptionSeller._id.toString(),
    );
    const accrual = await IncentiveLedger.findOne({
      organizationId: orgId,
      invoiceId: inv._id,
      entryType: "ACCRUAL",
      sourceType: "subscription_sale_commission",
    });
    expect(accrual.staffId.toString()).toBe(subscriptionSeller._id.toString());
    const subscriptionSalePayment = await Payment.findOne({
      organizationId: orgId,
      invoiceId: inv._id,
      type: "payment",
    });
    expect(subscriptionSalePayment.recordedBy.toString()).toBe(cashierUserId.toString());
    expect(accrual.staffId.toString()).not.toBe(subscriptionSalePayment.recordedBy.toString());
    expect(accrual.branchId.toString()).toBe(branchId.toString());
    expect(accrual.sourceRevenueInPaise).toBe(180000);
    expect(accrual.amountInPaise).toBe(18000);
    expect(await IncentiveLedger.countDocuments({
      organizationId: orgId,
      invoiceId: inv._id,
      entryType: "ACCRUAL",
      sourceType: "subscription_sale_commission",
    })).toBe(1);
    await settleCommissionInPayroll({
      commissionStaff: subscriptionSeller,
      accrual,
      idempotencyKey: `subscription-payroll-${accrual._id}`,
    });
    await mongoose.model("Subscription").deleteMany({
      organizationId: orgId,
      invoiceId: inv._id,
    });
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

  it("accrues membership-sale commission to the selected seller after the unified checkout is paid", async () => {
    await StaffBranch.create({
      staffId: staff._id,
      branchId,
      organizationId: orgId,
      isPrimary: true,
      isActive: true,
    });
    const scheme = await IncentiveScheme.create({
      organizationId: orgId,
      name: "Membership Sale Commission",
      code: `MEM_SALE_${Date.now()}`,
      schemeType: "COMMISSION",
      calculationBasis: "MEMBERSHIP_NET_REVENUE",
      rules: {
        tiers: [{ minPaise: 0, maxPaise: null, percentage: 10, fixedPaise: 0 }],
      },
      status: "active",
    });
    const membershipSaleAssignment = await SchemeAssignment.create({
      organizationId: orgId,
      schemeId: scheme._id,
      scopeType: "STAFF",
      scopeId: staff._id,
      startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
      status: "active",
    });

    const invoiceResponse = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({
        customerId: customer._id.toString(),
        membershipLines: [{
          membershipPlanId: memPlan._id.toString(),
          quantity: 1,
          soldByStaffId: staff._id.toString(),
        }],
      });

    expect(invoiceResponse.status).toBe(201);
    const invoice = invoiceResponse.body.data;
    const membershipLine = invoice.lines[0];
    expect(membershipLine.attribution.soldBy.staffId).toBe(staff._id.toString());

    const finalizeResponse = await request(app)
      .post(`/api/v1/billing/invoices/${invoice._id}/finalize`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({});
    expect(finalizeResponse.status).toBe(200);

    const paymentResponse = await request(app)
      .post(`/api/v1/billing/invoices/${invoice._id}/payments`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .set("idempotency-key", `MEMBERSHIP-COMMISSION-${invoice._id}`)
      .send({ amount: 1000, paymentMethod: "card" });
    expect(paymentResponse.status).toBe(201);

    const settlement = await InvoiceSettlementEvent.findOne({
      invoiceId: invoice._id,
      eventType: "SETTLED",
    });
    expect(settlement.lineItems[0].sourceAttribution.soldBy.staffId.toString()).toBe(
      staff._id.toString(),
    );
    const accruals = await IncentiveLedger.find({
      invoiceId: invoice._id,
      entryType: "ACCRUAL",
    });
    expect(accruals).toHaveLength(1);
    expect(accruals[0].sourceType).toBe("membership_sale_commission");
    expect(accruals[0].staffId.toString()).toBe(staff._id.toString());
    expect(accruals[0].sourceRevenueInPaise).toBe(100000);
    expect(accruals[0].amountInPaise).toBe(10000);
    await SchemeAssignment.deleteOne({ _id: membershipSaleAssignment._id });
    await IncentiveScheme.deleteOne({ _id: scheme._id });
    await CustomerMembership.deleteMany({ organizationId: orgId });
    await StaffBranch.deleteMany({ organizationId: orgId, staffId: staff._id });
  });

  it("records an unused membership refund once and claws back its seller commission", async () => {
    const membershipSeller = await createCommissionStaff("MEMBERSHIP");
    const scheme = await IncentiveScheme.create({
      organizationId: orgId,
      name: "Membership Refund Commission",
      code: `MEM_REFUND_${Date.now()}`,
      schemeType: "COMMISSION",
      calculationBasis: "MEMBERSHIP_NET_REVENUE",
      rules: {
        tiers: [{ minPaise: 0, maxPaise: null, percentage: 10, fixedPaise: 0 }],
      },
      status: "active",
    });
    const membershipRefundAssignment = await SchemeAssignment.create({
      organizationId: orgId,
      schemeId: scheme._id,
      scopeType: "STAFF",
      scopeId: membershipSeller._id,
      startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
      status: "active",
    });

    const invoiceResponse = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({
        customerId: customer._id.toString(),
        membershipLines: [{
          membershipPlanId: memPlan._id.toString(),
          quantity: 1,
          soldByStaffId: membershipSeller._id.toString(),
        }],
      });
    expect(invoiceResponse.status).toBe(201);
    const invoiceId = invoiceResponse.body.data._id;
    const lineId = invoiceResponse.body.data.lines[0]._id;

    const finalizeResponse = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/finalize`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({});
    expect(finalizeResponse.status).toBe(200);
    const paymentResponse = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .set("idempotency-key", `MEMBERSHIP-REFUND-SETTLE-${invoiceId}`)
      .send({ amount: 1000, paymentMethod: "card" });
    expect(paymentResponse.status).toBe(201);

    const paidInvoice = await Invoice.findById(invoiceId);
    const membership = await CustomerMembership.findById(
      paidInvoice.lines[0].customerMembershipId,
    );
    expect(paidInvoice.lines[0].attribution.soldBy.staffId.toString()).toBe(
      membershipSeller._id.toString(),
    );
    expect(membershipSeller._id.toString()).not.toBe(cashierUserId.toString());
    const accrualsBeforeRefund = await IncentiveLedger.find({
      organizationId: orgId,
      invoiceId,
      entryType: "ACCRUAL",
    });
    expect(accrualsBeforeRefund).toHaveLength(1);
    expect(accrualsBeforeRefund[0].staffId.toString()).toBe(membershipSeller._id.toString());
    const { allocation } = await settleCommissionInPayroll({
      commissionStaff: membershipSeller,
      accrual: accrualsBeforeRefund[0],
      idempotencyKey: `membership-payroll-${invoiceId}`,
    });

    const refundPath = `/api/v1/billing/invoices/${invoiceId}/membership-refunds`;
    const idempotencyKey = `MEMBERSHIP-REFUND-${invoiceId}`;
    const refundResponse = await request(app)
      .post(refundPath)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .set("Idempotency-Key", idempotencyKey)
      .send({
        lineId: lineId.toString(),
        refundPaymentMethod: "card",
        reason: "Customer cancellation before membership benefits were used",
      });
    expect(refundResponse.status).toBe(200);
    expect(refundResponse.body.data.manualRefundRecord).toBe(true);

    const replayResponse = await request(app)
      .post(refundPath)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .set("Idempotency-Key", idempotencyKey)
      .send({
        lineId: lineId.toString(),
        refundPaymentMethod: "card",
        reason: "Customer cancellation before membership benefits were used",
      });
    expect(replayResponse.status).toBe(200);
    expect(replayResponse.body.data.idempotentReplay).toBe(true);
    const conflictingReplayResponse = await request(app)
      .post(refundPath)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .set("Idempotency-Key", idempotencyKey)
      .send({
        lineId: lineId.toString(),
        refundPaymentMethod: "cash",
        reason: "Changed refund details",
      });
    expect(conflictingReplayResponse.status).toBe(409);

    const cancelledMembership = await CustomerMembership.findById(membership._id);
    const refundedInvoice = await Invoice.findById(invoiceId);
    expect(refundedInvoice.lines[0].returnedQuantity).toBe(1);
    expect(cancelledMembership.status).toBe("cancelled");
    expect(cancelledMembership.cancellationReason).toBe(
      "Customer cancellation before membership benefits were used",
    );
    const refundPayments = await Payment.find({
      organizationId: orgId,
      invoiceId,
      type: "refund",
      idempotencyKey: `MEMBERSHIP_REFUND:${invoiceId}:${idempotencyKey}`,
    });
    expect(refundPayments).toHaveLength(1);
    expect(refundPayments[0].amount).toBe(-1000);
    expect(refundPayments[0].recordedBy.toString()).toBe(cashierUserId.toString());
    expect(refundPayments[0].isManualRefundRecord).toBe(true);
    const refundEvents = await InvoiceSettlementEvent.find({
      organizationId: orgId,
      invoiceId,
      eventType: "RETURN_PROCESSED",
      customerMembershipId: membership._id,
    });
    expect(refundEvents).toHaveLength(1);
    const clawbacks = await IncentiveLedger.find({
      organizationId: orgId,
      invoiceId,
      entryType: "CLAWBACK",
    });
    expect(clawbacks).toHaveLength(1);
    expect(clawbacks[0].sourceType).toBe("membership_sale_commission");
    expect(clawbacks[0].staffId.toString()).toBe(membershipSeller._id.toString());
    expect(clawbacks[0].amountInPaise).toBe(accrualsBeforeRefund[0].amountInPaise);
    const recoveryObligation = await IncentiveRecoveryObligation.findOne({
      organizationId: orgId,
      clawbackLedgerId: clawbacks[0]._id,
    });
    expect(recoveryObligation.status).toBe("pending");
    expect(recoveryObligation.totalRecoveredInPaise).toBe(0);
    expect(await IncentiveLedger.countDocuments({
      organizationId: orgId,
      invoiceId,
      entryType: "CLAWBACK",
      sourceType: "subscription_sale_commission",
    })).toBe(0);

    const recoveryBasePath = `/api/v1/incentives/recovery-obligations/${recoveryObligation._id}/payments`;
    const partialRecoveryPayload = {
      amountInPaise: 4000,
      paymentMethod: "cash",
      paymentReference: `MEMBERSHIP-RECOVERY-PARTIAL-${invoiceId}`,
      paymentDate: new Date().toISOString(),
      reason: "Partial manual recovery",
      idempotencyKey: `membership-recovery-partial-${invoiceId}`,
    };
    const partialRecoveryAttempt = await request(app)
      .post(recoveryBasePath)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send(partialRecoveryPayload);
    expect(partialRecoveryAttempt.status).toBe(201);
    expect(partialRecoveryAttempt.body.data.obligation.totalRecoveredInPaise).toBe(0);
    expect(partialRecoveryAttempt.body.data.obligation.totalReservedInPaise).toBe(4000);
    const recordedPartialRecovery = await IncentiveRecoveryPayment.findById(
      partialRecoveryAttempt.body.data.payment._id,
    );
    expect(recordedPartialRecovery).toMatchObject({
      amountInPaise: 4000,
      paymentMethod: "cash",
      paymentReference: partialRecoveryPayload.paymentReference,
      reason: partialRecoveryPayload.reason,
      status: "recorded",
    });
    expect(recordedPartialRecovery.recordedBy.toString()).toBe(cashierUserId.toString());
    expect(recordedPartialRecovery.history[0]).toMatchObject({
      action: "recorded",
      reason: partialRecoveryPayload.reason,
    });
    expect(recordedPartialRecovery.history[0].actorId.toString()).toBe(
      cashierUserId.toString(),
    );
    const duplicateRecoveryAttempt = await request(app)
      .post(recoveryBasePath)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send(partialRecoveryPayload);
    expect(duplicateRecoveryAttempt.status).toBe(200);
    expect(duplicateRecoveryAttempt.body.data.isIdempotentReplay).toBe(true);

    const partialRecoveryId = partialRecoveryAttempt.body.data.payment._id;
    const partialConfirmationPath =
      `${recoveryBasePath}/${partialRecoveryId}/confirm`;
    const partialRecoveryConfirmation = await request(app)
      .post(partialConfirmationPath)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({ confirmActualPayment: true });
    expect(partialRecoveryConfirmation.status).toBe(200);
    expect(partialRecoveryConfirmation.body.data.obligation.totalRecoveredInPaise).toBe(4000);
    const confirmedPartialRecovery = await IncentiveRecoveryPayment.findById(partialRecoveryId);
    expect(confirmedPartialRecovery.confirmedBy.toString()).toBe(cashierUserId.toString());
    expect(confirmedPartialRecovery.confirmedAt).toBeInstanceOf(Date);
    expect(confirmedPartialRecovery.history.at(-1)).toMatchObject({
      action: "confirmed",
      reason: partialRecoveryPayload.reason,
    });
    expect(confirmedPartialRecovery.history.at(-1).actorId.toString()).toBe(
      cashierUserId.toString(),
    );
    const duplicatePartialConfirmation = await request(app)
      .post(partialConfirmationPath)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({ confirmActualPayment: true });
    expect(duplicatePartialConfirmation.status).toBe(200);
    expect(duplicatePartialConfirmation.body.data.isIdempotentReplay).toBe(true);

    const recoveryReversal = await request(app)
      .post(`${recoveryBasePath}/${partialRecoveryId}/reverse`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({
        confirmActualReversal: true,
        reversalReason: "The partial recovery was returned",
      });
    expect(recoveryReversal.status).toBe(200);
    expect(recoveryReversal.body.data.obligation.totalRecoveredInPaise).toBe(0);
    expect((await PayrollIncentiveAllocation.findById(allocation._id)).recoveredInPaise).toBe(0);
    const reversedPartialRecovery = await IncentiveRecoveryPayment.findById(partialRecoveryId);
    expect(reversedPartialRecovery.reversedBy.toString()).toBe(cashierUserId.toString());
    expect(reversedPartialRecovery.reversedAt).toBeInstanceOf(Date);
    expect(reversedPartialRecovery.reversalReason).toBe("The partial recovery was returned");
    expect(reversedPartialRecovery.history.at(-1)).toMatchObject({
      action: "reversed",
      reason: "The partial recovery was returned",
    });

    const fullRecoveryAttempt = await request(app)
      .post(recoveryBasePath)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({
        ...partialRecoveryPayload,
        amountInPaise: 10000,
        paymentReference: `MEMBERSHIP-RECOVERY-FULL-${invoiceId}`,
        idempotencyKey: `membership-recovery-full-${invoiceId}`,
      });
    expect(fullRecoveryAttempt.status).toBe(201);
    expect(fullRecoveryAttempt.body.data.obligation.totalRecoveredInPaise).toBe(0);
    const fullRecoveryConfirmation = await request(app)
      .post(`${recoveryBasePath}/${fullRecoveryAttempt.body.data.payment._id}/confirm`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({ confirmActualPayment: true });
    expect(fullRecoveryConfirmation.status).toBe(200);
    expect(fullRecoveryConfirmation.body.data.obligation.status).toBe("recovered");
    expect(fullRecoveryConfirmation.body.data.obligation.totalRecoveredInPaise).toBe(10000);
    expect((await PayrollIncentiveAllocation.findById(allocation._id)).recoveredInPaise).toBe(10000);
    const confirmedFullRecovery = await IncentiveRecoveryPayment.findById(
      fullRecoveryAttempt.body.data.payment._id,
    );
    expect(confirmedFullRecovery.confirmedBy.toString()).toBe(cashierUserId.toString());
    expect(confirmedFullRecovery.confirmedAt).toBeInstanceOf(Date);

    const reservedInvoiceResponse = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({
        customerId: customer._id.toString(),
        membershipLines: [{ membershipPlanId: memPlan._id.toString(), quantity: 1 }],
        serviceLines: [{ serviceId: service._id.toString(), quantity: 1 }],
      });
    expect(reservedInvoiceResponse.status).toBe(201);
    const reservedInvoice = reservedInvoiceResponse.body.data;
    expect(reservedInvoice.lines[1].membershipBenefitSourceLineId).toBe(
      reservedInvoice.lines[0]._id,
    );
    const reservedFinalize = await request(app)
      .post(`/api/v1/billing/invoices/${reservedInvoice._id}/finalize`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({});
    expect(reservedFinalize.status).toBe(200);
    const reservedPayment = await request(app)
      .post(`/api/v1/billing/invoices/${reservedInvoice._id}/payments`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .set("idempotency-key", `MEMBERSHIP-RESERVED-SETTLE-${reservedInvoice._id}`)
      .send({ amount: reservedInvoice.payableAmount, paymentMethod: "cash" });
    expect(reservedPayment.status).toBe(201);
    const paidReservedInvoice = await Invoice.findById(reservedInvoice._id);
    const reservedMembership = await CustomerMembership.findById(
      paidReservedInvoice.lines[0].customerMembershipId,
    );
    expect(
      paidReservedInvoice.lines[1].appliedCustomerMembershipId.toString(),
    ).toBe(reservedMembership._id.toString());
    expect(paidReservedInvoice.lines[1].membershipBenefitSourceLineId).toBeNull();
    const usedRefundResponse = await request(app)
      .post(`/api/v1/billing/invoices/${reservedInvoice._id}/membership-refunds`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .set("Idempotency-Key", `MEMBERSHIP-USED-${reservedInvoice._id}`)
      .send({
        lineId: reservedInvoice.lines[0]._id,
        refundPaymentMethod: "cash",
        reason: "Attempted refund after a benefit reservation",
      });
    expect(usedRefundResponse.status).toBe(409);
    expect(await Payment.countDocuments({
      organizationId: orgId,
      invoiceId: reservedInvoice._id,
      type: "refund",
    })).toBe(0);
    await SchemeAssignment.deleteOne({ _id: membershipRefundAssignment._id });
    await IncentiveScheme.deleteOne({ _id: scheme._id });
    await CustomerMembership.deleteMany({ organizationId: orgId });
    await StaffBranch.deleteMany({ organizationId: orgId, staffId: membershipSeller._id });
  });

  it("accrues retail commission to the seller and reverses it once for an idempotent refund", async () => {
    const retailSeller = await createCommissionStaff("RETAIL");
    const scheme = await IncentiveScheme.create({
      organizationId: orgId,
      name: "Retail Sale Commission",
      code: `RETAIL_${Date.now()}`,
      schemeType: "COMMISSION",
      calculationBasis: "PRODUCT_NET_REVENUE",
      rules: {
        tiers: [{ minPaise: 0, maxPaise: null, percentage: 10, fixedPaise: 0 }],
      },
      status: "active",
    });
    await SchemeAssignment.create({
      organizationId: orgId,
      schemeId: scheme._id,
      scopeType: "STAFF",
      scopeId: retailSeller._id,
      startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
      status: "active",
    });

    const invoiceResponse = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({
        customerId: customer._id.toString(),
        discount: 50,
        productLines: [{
          productId: product._id.toString(),
          quantity: 1,
          soldByStaffId: retailSeller._id.toString(),
        }],
      });
    expect(invoiceResponse.status).toBe(201);
    const invoice = invoiceResponse.body.data;
    const productLine = invoice.lines[0];
    expect(productLine.attribution.soldBy.staffId).toBe(retailSeller._id.toString());
    expect(productLine.customerPayable).toBe(450);

    const finalizeResponse = await request(app)
      .post(`/api/v1/billing/invoices/${invoice._id}/finalize`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({});
    expect(finalizeResponse.status).toBe(200);

    const partialPaymentResponse = await request(app)
      .post(`/api/v1/billing/invoices/${invoice._id}/payments`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .set("Idempotency-Key", `RETAIL-PAY-PARTIAL-${invoice._id}`)
      .send({ amount: 100, paymentMethod: "card" });
    expect(partialPaymentResponse.status).toBe(201);
    expect(await IncentiveLedger.countDocuments({
      invoiceId: invoice._id,
      sourceType: "retail_sale_commission",
      entryType: "ACCRUAL",
    })).toBe(0);

    const finalPaymentKey = `RETAIL-PAY-FINAL-${invoice._id}`;
    const paymentResponse = await request(app)
      .post(`/api/v1/billing/invoices/${invoice._id}/payments`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .set("Idempotency-Key", finalPaymentKey)
      .send({ amount: 350, paymentMethod: "card" });
    expect(paymentResponse.status).toBe(201);

    const accrual = await IncentiveLedger.findOne({
      invoiceId: invoice._id,
      entryType: "ACCRUAL",
      sourceType: "retail_sale_commission",
    });
    expect(accrual).toBeTruthy();
    expect(accrual.staffId.toString()).toBe(retailSeller._id.toString());
    expect(accrual.organizationId.toString()).toBe(orgId.toString());
    expect(accrual.branchId.toString()).toBe(branchId.toString());
    expect(accrual.sourceRevenueInPaise).toBe(45000);
    expect(accrual.amountInPaise).toBe(4500);
    await settleCommissionInPayroll({
      commissionStaff: retailSeller,
      accrual,
      idempotencyKey: `retail-payroll-${accrual._id}`,
    });
    const originalPayment = await Payment.findOne({
      invoiceId: invoice._id,
      type: "payment",
    });
    expect(originalPayment.recordedBy.toString()).toBe(cashierUserId.toString());
    expect(originalPayment.recordedBy.toString()).not.toBe(retailSeller._id.toString());
    const paymentRetry = await request(app)
      .post(`/api/v1/billing/invoices/${invoice._id}/payments`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .set("Idempotency-Key", finalPaymentKey)
      .send({ amount: 350, paymentMethod: "card" });
    expect(paymentRetry.status).toBe(200);
    expect(paymentRetry.body.data.isIdempotentReplay).toBe(true);

    const returnPayload = {
      items: [{
        lineId: productLine._id,
        quantity: 1,
        condition: "unopened",
        acceptPhysicalRestock: true,
        restockReason: "Unopened customer return",
      }],
      refundPaymentMethod: "card",
      reason: "Customer returned unopened product",
    };
    const returnKey = `RETAIL-RETURN-${invoice._id}`;
    const firstReturn = await request(app)
      .post(`/api/v1/billing/invoices/${invoice._id}/returns`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .set("Idempotency-Key", returnKey)
      .send(returnPayload);
    expect(firstReturn.status).toBe(200);
    expect(firstReturn.body.data.totalRefundAmount).toBe(450);

    const replayReturn = await request(app)
      .post(`/api/v1/billing/invoices/${invoice._id}/returns`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .set("Idempotency-Key", returnKey)
      .send(returnPayload);
    expect(replayReturn.status).toBe(200);
    expect(replayReturn.body.data.isIdempotentReplay).toBe(true);
    const conflictingReturn = await request(app)
      .post(`/api/v1/billing/invoices/${invoice._id}/returns`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .set("Idempotency-Key", returnKey)
      .send({ ...returnPayload, reason: "Changed reason under same key" });
    expect(conflictingReturn.status).toBe(409);

    expect(await Payment.countDocuments({
      invoiceId: invoice._id,
      type: "refund",
    })).toBe(1);
    expect(await InvoiceSettlementEvent.countDocuments({
      invoiceId: invoice._id,
      eventType: "RETURN_PROCESSED",
    })).toBe(1);
    const returnEvent = await InvoiceSettlementEvent.findOne({
      invoiceId: invoice._id,
      eventType: "RETURN_PROCESSED",
    });
    expect(returnEvent.reason).toBe(returnPayload.reason);
    expect(returnEvent.recordedBy.toString()).toBe(cashierUserId.toString());
    expect(returnEvent.returnItems).toHaveLength(1);
    expect(returnEvent.returnItems[0].lineItemId.toString()).toBe(productLine._id.toString());
    expect(returnEvent.returnItems[0].productId.toString()).toBe(product._id.toString());
    expect(returnEvent.returnItems[0]).toMatchObject({
      quantity: 1,
      condition: "unopened",
      physicalRestockAccepted: true,
      refundDueInPaise: 45000,
      refundAmountInPaise: 45000,
    });
    expect(await StockMovement.countDocuments({
      "reference.entityId": invoice._id,
      movementType: "adjustment",
    })).toBe(1);
    const clawbacks = await IncentiveLedger.find({
      invoiceId: invoice._id,
      entryType: "CLAWBACK",
      reversesLedgerId: accrual._id,
    });
    expect(clawbacks).toHaveLength(1);
    expect(clawbacks[0].amountInPaise).toBe(4500);
    expect(clawbacks[0].refundAmountInPaise).toBe(45000);
    expect(await IncentiveRecoveryObligation.countDocuments({
      clawbackLedgerId: clawbacks[0]._id,
      status: "pending",
    })).toBe(1);
    await StaffBranch.deleteMany({ organizationId: orgId, staffId: retailSeller._id });
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

  it("14. Subscription payment idempotency: duplicate submission, single quota decrement, ledger deduplication, and payload mismatch rejection", async () => {
    const { Subscription } = await import("../../models/subscriptions/subscription.model.js");
    const { SubscriptionUsage } = await import("../../models/subscriptions/subscriptionUsage.model.js");
    const { Payment } = await import("../../models/billing/payment.model.js");

    // 1. Create a subscription with 5 sessions
    const sub = await Subscription.create({
      organizationId: orgId,
      branchId,
      payerCustomerId: customer._id,
      customerId: customer._id,
      subscriptionCode: `SUB-IDEMP-${Date.now()}`,
      planId: subPlan._id,
      price: 1500,
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
              totalQuantity: 5,
              usedQuantity: 0,
              remainingQuantity: 5,
            },
          ],
        },
      ],
      entitlements: [
        {
          serviceId: service._id,
          serviceName: service.name,
          totalQuantity: 5,
          usedQuantity: 0,
          remainingQuantity: 5,
        },
      ],
    });

    // 2. Create invoice with 1 covered service line (0 customer payable) + 1 retail product line (500 payable)
    const invRes = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send({
        customerId: customer._id.toString(),
        serviceLines: [
          {
            serviceId: service._id.toString(),
            quantity: 1,
            appliedSubscriptionId: sub._id.toString(),
          },
        ],
        productLines: [{ productId: product._id.toString(), quantity: 1 }],
      });
    expect(invRes.status).toBe(201);
    const invoiceId = invRes.body.data._id;
    const payableAmount = invRes.body.data.payableAmount; // 500 (haircut covered 100% by sub)

    // Finalize invoice
    await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/finalize`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .send();

    const paymentIdempotencyKey = `IDEMP-SUB-PAY-${Date.now()}`;

    // 3. First payment submission with idempotency key
    const payRes1 = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .set("Idempotency-Key", paymentIdempotencyKey)
      .send({
        amount: payableAmount,
        paymentMethod: "card",
      });

    expect(payRes1.status).toBe(201);
    expect(payRes1.body.data.invoice.paymentStatus).toBe("paid");
    expect(payRes1.body.data.invoice.amountPaid).toBe(payableAmount);
    expect(payRes1.body.data.invoice.amountDue).toBe(0);

    // Assert exactly 1 Payment document
    const paymentsFirst = await Payment.find({ invoiceId });
    expect(paymentsFirst).toHaveLength(1);

    // Assert exactly 1 SubscriptionUsage document
    const usagesFirst = await SubscriptionUsage.find({ subscriptionId: sub._id });
    expect(usagesFirst).toHaveLength(1);
    expect(usagesFirst[0].quantity).toBe(1);

    // Assert remaining quota decreased exactly once (5 -> 4)
    const subFirst = await Subscription.findById(sub._id);
    expect(subFirst.members[0].entitlements[0].usedQuantity).toBe(1);
    expect(subFirst.members[0].entitlements[0].remainingQuantity).toBe(4);

    // 4. Duplicate submission with EXACT SAME idempotency key and payload
    const payRes2 = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .set("Idempotency-Key", paymentIdempotencyKey)
      .send({
        amount: payableAmount,
        paymentMethod: "card",
      });

    expect([200, 201]).toContain(payRes2.status);
    expect(payRes2.body.data.isIdempotentReplay).toBe(true);

    // Assert still exactly 1 Payment document
    const paymentsSecond = await Payment.find({ invoiceId });
    expect(paymentsSecond).toHaveLength(1);

    // Assert still exactly 1 SubscriptionUsage document
    const usagesSecond = await SubscriptionUsage.find({ subscriptionId: sub._id });
    expect(usagesSecond).toHaveLength(1);

    // Assert remaining quota remains unchanged (still 4, not decremented twice)
    const subSecond = await Subscription.findById(sub._id);
    expect(subSecond.members[0].entitlements[0].usedQuantity).toBe(1);
    expect(subSecond.members[0].entitlements[0].remainingQuantity).toBe(4);

    // Assert invoice paid/due amounts are NOT double-counted
    const invoiceSecond = await Invoice.findById(invoiceId);
    expect(invoiceSecond.amountPaid).toBe(payableAmount);
    expect(invoiceSecond.amountDue).toBe(0);
    expect(invoiceSecond.paymentStatus).toBe("paid");

    // 5. Reuse same idempotency key with differing payload -> must reject with 409 Conflict without mutations
    const payResConflict = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${userToken}`)
      .set("X-Branch-Id", branchId.toString())
      .set("Idempotency-Key", paymentIdempotencyKey)
      .send({
        amount: payableAmount,
        paymentMethod: "cash", // Differing method from original "card"
      });

    expect(payResConflict.status).toBe(409);
    expect(payResConflict.body.message).toMatch(/Idempotency key reuse with differing payment parameters/i);

    // Assert no additional payment or usage created after rejection
    const paymentsAfterConflict = await Payment.find({ invoiceId });
    expect(paymentsAfterConflict).toHaveLength(1);
    const usagesAfterConflict = await SubscriptionUsage.find({ subscriptionId: sub._id });
    expect(usagesAfterConflict).toHaveLength(1);
    const subAfterConflict = await Subscription.findById(sub._id);
    expect(subAfterConflict.members[0].entitlements[0].remainingQuantity).toBe(4);
  });
});
