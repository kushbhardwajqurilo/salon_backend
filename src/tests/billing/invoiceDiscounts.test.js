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
} catch (_) { }

import { Organization } from "../../../src/models/organizations/organization.model.js";
import { Branch } from "../../../src/models/branches/branch.model.js";
import { Customer } from "../../../src/models/customers/customer.model.js";
import { Service } from "../../../src/models/services/service.model.js";
import { ServiceCategory } from "../../../src/models/services/serviceCategory.model.js";
import { Role } from "../../../src/models/roles/role.model.js";
import { Permission } from "../../../src/models/permissions/permission.model.js";
import { User } from "../../../src/models/users/user.model.js";
import { Appointment } from "../../../src/models/appointments/appointment.model.js";
import { Subscription } from "../../../src/models/subscriptions/subscription.model.js";
import { Invoice } from "../../../src/models/billing/invoice.model.js";
import { Payment } from "../../../src/models/billing/payment.model.js";
import { AuditLog } from "../../../src/models/audit/auditLog.model.js";
import { loyaltyService } from "../../../src/services/loyalty/loyalty.service.js";

jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");

describe("Billing Invoice Discounts Comprehensive Integration Test Suite", () => {
  jest.setTimeout(45000);

  let orgA, orgB;
  let branchA1, branchA2, branchB1;
  let ownerTokenA, cashierTokenA, unauthorizedTokenA, ownerTokenB;
  let customerA, categoryA, serviceHaircut, serviceColor, serviceShampoo;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    let testUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/saloon_erp_test";
    if (testUri.includes("?")) {
      const parts = testUri.split("?");
      testUri = parts[0].replace(/\/([^\/]+)$/, "/saloon_erp_invoice_discounts_test") + "?" + parts[1];
    } else {
      testUri = testUri.replace(/\/([^\/]+)$/, "/saloon_erp_invoice_discounts_test");
    }
    await mongoose.connect(testUri);
  });

  afterAll(async () => {
    await Invoice.deleteMany({});
    await Payment.deleteMany({});
    await Appointment.deleteMany({});
    await Subscription.deleteMany({});
    await AuditLog.deleteMany({});
    await Customer.deleteMany({});
    await Service.deleteMany({});
    await ServiceCategory.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Invoice.deleteMany({});
    await Payment.deleteMany({});
    await Appointment.deleteMany({});
    await Subscription.deleteMany({});
    await AuditLog.deleteMany({});
    await Customer.deleteMany({});
    await Service.deleteMany({});
    await ServiceCategory.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});

    orgA = await Organization.create({
      name: "Org Discounts A",
      status: "active",
      currency: "INR",
      timezone: "Asia/Kolkata",
    });

    orgB = await Organization.create({
      name: "Org Discounts B",
      status: "active",
      currency: "INR",
      timezone: "Asia/Kolkata",
    });

    branchA1 = await Branch.create({
      organizationId: orgA._id,
      name: "Branch A1",
      address: "100 MG Road, Bangalore",
      phone: "+919876543210",
      isActive: true,
      timezone: "Asia/Kolkata",
    });

    branchA2 = await Branch.create({
      organizationId: orgA._id,
      name: "Branch A2",
      address: "200 Indiranagar, Bangalore",
      phone: "+919876543211",
      isActive: true,
      timezone: "Asia/Kolkata",
    });

    branchB1 = await Branch.create({
      organizationId: orgB._id,
      name: "Branch B1",
      address: "300 Park Street, Kolkata",
      phone: "+919876543212",
      isActive: true,
      timezone: "Asia/Kolkata",
    });

    // Permissions
    const billingPerms = [
      "billing.view",
      "billing.checkout",
      "billing.void",
      "payments.view",
      "payments.receive",
      "payments.refund",
      "appointments.view",
      "appointments.create",
      "appointments.update_status",
      "subscriptions.sell",
      "subscriptions.view",
      "subscriptions.redeem",
    ];

    const permDocs = [];
    for (const pName of billingPerms) {
      let p = await Permission.findOne({ name: pName });
      if (!p) {
        p = await Permission.create({ name: pName, module: "Billing & POS", action: pName, description: pName });
      }
      permDocs.push(p);
    }

    const ownerRoleA = await Role.create({
      organizationId: orgA._id,
      name: "Owner Role A",
      slug: "owner-a",
      permissions: permDocs.map((p) => p._id),
    });

    const cashierRoleA = await Role.create({
      organizationId: orgA._id,
      name: "Cashier Role A",
      slug: "cashier-a",
      permissions: permDocs.filter((p) => ["billing.view", "billing.checkout", "payments.view", "payments.receive"].includes(p.name)).map((p) => p._id),
    });

    const viewOnlyRoleA = await Role.create({
      organizationId: orgA._id,
      name: "Viewer Role A",
      slug: "viewer-a",
      permissions: permDocs.filter((p) => ["billing.view"].includes(p.name)).map((p) => p._id),
    });

    const ownerRoleB = await Role.create({
      organizationId: orgB._id,
      name: "Owner Role B",
      slug: "owner-b",
      permissions: permDocs.map((p) => p._id),
    });

    const ownerUserA = await User.create({
      organizationId: orgA._id,
      branchIds: [branchA1._id, branchA2._id],
      role: ownerRoleA._id,
      name: "Owner User A",
      email: "owner.a@example.com",
      phone: "+919876543210",
      password: "hashed_password",
      status: "active",
      hasOrgWideAccess: true,
      branchAccess: [
        { branchId: branchA1._id, branchName: "Branch A1", isActive: true },
        { branchId: branchA2._id, branchName: "Branch A2", isActive: true },
      ],
    });

    const cashierUserA = await User.create({
      organizationId: orgA._id,
      branchIds: [branchA1._id],
      role: cashierRoleA._id,
      name: "Cashier User A",
      email: "cashier.a@example.com",
      phone: "+919876543211",
      password: "hashed_password",
      status: "active",
      hasOrgWideAccess: false,
      branchAccess: [
        { branchId: branchA1._id, branchName: "Branch A1", isActive: true },
      ],
    });

    const viewOnlyUserA = await User.create({
      organizationId: orgA._id,
      branchIds: [branchA1._id],
      role: viewOnlyRoleA._id,
      name: "Viewer User A",
      email: "viewer.a@example.com",
      phone: "+919876543212",
      password: "hashed_password",
      status: "active",
      hasOrgWideAccess: false,
      branchAccess: [
        { branchId: branchA1._id, branchName: "Branch A1", isActive: true },
      ],
    });

    const ownerUserB = await User.create({
      organizationId: orgB._id,
      branchIds: [branchB1._id],
      role: ownerRoleB._id,
      name: "Owner User B",
      email: "owner.b@example.com",
      phone: "+919876543213",
      password: "hashed_password",
      status: "active",
      hasOrgWideAccess: true,
      branchAccess: [
        { branchId: branchB1._id, branchName: "Branch B1", isActive: true },
      ],
    });

    ownerTokenA = jwt.sign(
      { id: ownerUserA._id, role: ownerRoleA._id, organizationId: orgA._id, branchIds: [branchA1._id, branchA2._id], hasOrgWideAccess: true },
      env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    cashierTokenA = jwt.sign(
      { id: cashierUserA._id, role: cashierRoleA._id, organizationId: orgA._id, branchIds: [branchA1._id], hasOrgWideAccess: false },
      env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    unauthorizedTokenA = jwt.sign(
      { id: viewOnlyUserA._id, role: viewOnlyRoleA._id, organizationId: orgA._id, branchIds: [branchA1._id], hasOrgWideAccess: false },
      env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    ownerTokenB = jwt.sign(
      { id: ownerUserB._id, role: ownerRoleB._id, organizationId: orgB._id, branchIds: [branchB1._id], hasOrgWideAccess: true },
      env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    customerA = await Customer.create({
      organizationId: orgA._id,
      homeBranchId: branchA1._id,
      name: "Customer John",
      phone: "+919111122222",
      email: "john@example.com",
      status: "active",
    });

    categoryA = await ServiceCategory.create({
      organizationId: orgA._id,
      name: "Hair & Styling",
      isActive: true,
    });

    serviceHaircut = await Service.create({
      organizationId: orgA._id,
      categoryId: categoryA._id,
      name: "Haircut",
      duration: 30,
      pricing: { basePrice: 1000 },
      isActive: true,
      status: "active",
    });

    serviceColor = await Service.create({
      organizationId: orgA._id,
      categoryId: categoryA._id,
      name: "Hair Coloring",
      duration: 60,
      pricing: { basePrice: 2000 },
      isActive: true,
      status: "active",
    });

    serviceShampoo = await Service.create({
      organizationId: orgA._id,
      categoryId: categoryA._id,
      name: "Shampoo & Blowdry",
      duration: 20,
      pricing: { basePrice: 500 },
      isActive: true,
      status: "active",
    });
  });

  async function createDraftInvoice(optionsOrLines) {
    let rawLines = optionsOrLines;
    if (optionsOrLines && optionsOrLines.lines) {
      rawLines = optionsOrLines.lines.map((l) => ({
        lineType: l.lineType || "service",
        serviceType: l.serviceType || "custom",
        appointmentServiceId: l.appointmentServiceId || new mongoose.Types.ObjectId(),
        name: l.name,
        duration: l.duration || 30,
        quantity: l.quantity || 1,
        unitPrice: l.price !== undefined ? l.price : (l.unitPrice || 0),
        lineTotal: (l.price !== undefined ? l.price : (l.unitPrice || 0)) * (l.quantity || 1),
        isCoveredBySubscription: l.isCovered !== undefined ? !!l.isCovered : !!l.isCoveredBySubscription,
        subscriptionCoveredAmount: l.subscriptionCoveredAmount || (l.isCovered ? (l.price || 0) : 0),
        discountAmount: 0,
        customerPayable: (l.price !== undefined ? l.price : (l.unitPrice || 0)) * (l.quantity || 1),
      }));
    }

    const defaultLines = rawLines || [
      {
        lineType: "service",
        serviceType: "registered",
        serviceId: serviceHaircut._id,
        appointmentServiceId: new mongoose.Types.ObjectId(),
        name: serviceHaircut.name,
        duration: serviceHaircut.duration,
        quantity: 1,
        unitPrice: 1000,
        lineTotal: 1000,
        isCoveredBySubscription: false,
        subscriptionCoveredAmount: 0,
        discountAmount: 0,
        customerPayable: 1000,
      },
      {
        lineType: "service",
        serviceType: "registered",
        serviceId: serviceColor._id,
        appointmentServiceId: new mongoose.Types.ObjectId(),
        name: serviceColor.name,
        duration: serviceColor.duration,
        quantity: 1,
        unitPrice: 2000,
        lineTotal: 2000,
        isCoveredBySubscription: false,
        subscriptionCoveredAmount: 0,
        discountAmount: 0,
        customerPayable: 2000,
      },
    ];

    const subtotal = defaultLines.reduce((acc, l) => acc + l.lineTotal, 0);

    return await Invoice.create({
      organizationId: orgA._id,
      branchId: branchA1._id,
      invoiceNumber: `INV-TEST-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      invoiceType: "appointment",
      customerId: customerA._id,
      customerSnapshot: { name: customerA.name, phone: customerA.phone },
      lines: defaultLines,
      subtotal,
      discountTotal: 0,
      lineDiscountsTotal: 0,
      invoiceDiscountsTotal: 0,
      appliedDiscounts: [],
      discountHistory: [],
      subscriptionCoveredAmount: 0,
      grossPayable: subtotal,
      payableAmount: subtotal,
      amountPaid: 0,
      amountDue: subtotal,
      status: "draft",
      paymentStatus: "unpaid",
      createdBy: new mongoose.Types.ObjectId(),
    });
  }

  describe("1. Fixed & Percentage Discounts on Service Lines", () => {
    it("applies a fixed discount to a single uncovered service line", async () => {
      const invoice = await createDraftInvoice();
      const lineId = invoice.lines[0]._id;

      const res = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "line",
          lineId,
          name: "Stylist Courtesy",
          discountType: "fixed",
          enteredValue: 200,
          reason: "First-time visitor promotion",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.invoice.lineDiscountsTotal).toBe(200);
      expect(res.body.data.invoice.invoiceDiscountsTotal).toBe(0);
      expect(res.body.data.invoice.discountTotal).toBe(200);
      expect(res.body.data.invoice.payableAmount).toBe(2800);
      expect(res.body.data.invoice.amountDue).toBe(2800);

      // Verify line snapshot
      const targetLine = res.body.data.invoice.lines.find((l) => l._id.toString() === lineId.toString());
      expect(targetLine.lineDiscountTotal).toBe(200);
      expect(targetLine.customerPayable).toBe(800);
      expect(targetLine.appliedDiscounts).toHaveLength(1);
      expect(targetLine.appliedDiscounts[0].calculatedAmount).toBe(200);
    });

    it("applies a percentage discount to a single service line", async () => {
      const invoice = await createDraftInvoice();
      const lineId = invoice.lines[1]._id; // 2000 base

      const res = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "line",
          lineId,
          name: "VIP Discount",
          discountType: "percentage",
          enteredValue: 15,
          reason: "VIP member courtesy",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.invoice.lineDiscountsTotal).toBe(300); // 15% of 2000
      expect(res.body.data.invoice.payableAmount).toBe(2700);

      const targetLine = res.body.data.invoice.lines.find((l) => l._id.toString() === lineId.toString());
      expect(targetLine.lineDiscountTotal).toBe(300);
      expect(targetLine.customerPayable).toBe(1700);
    });
  });

  describe("2. Multiple Sequential Discounts & Clamping", () => {
    it("applies multiple sequential discounts on one line (percentage then fixed)", async () => {
      const invoice = await createDraftInvoice();
      const lineId = invoice.lines[0]._id; // 1000 base

      // 1. First discount: 20% on 1000 -> 200 discount, 800 base remaining
      await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "line",
          lineId,
          name: "Promo 20%",
          discountType: "percentage",
          enteredValue: 20,
          reason: "Festival promo",
        });

      // 2. Second discount: Flat 100 on remaining 800 -> 100 discount, 700 customer payable
      const res2 = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "line",
          lineId,
          name: "Voucher",
          discountType: "fixed",
          enteredValue: 100,
          reason: "Loyalty voucher",
        });

      expect(res2.status).toBe(200);
      const targetLine = res2.body.data.invoice.lines.find((l) => l._id.toString() === lineId.toString());
      expect(targetLine.lineDiscountTotal).toBe(300); // 200 + 100
      expect(targetLine.customerPayable).toBe(700);
      expect(targetLine.appliedDiscounts).toHaveLength(2);
      expect(targetLine.appliedDiscounts[0].calculatedAmount).toBe(200);
      expect(targetLine.appliedDiscounts[1].calculatedAmount).toBe(100);
    });

    it("clamps fixed discounts that exceed the remaining eligible line base", async () => {
      const invoice = await createDraftInvoice();
      const lineId = invoice.lines[0]._id; // 1000 base

      // Apply 1200 fixed discount on a 1000 service line
      const res = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "line",
          lineId,
          name: "Big Voucher",
          discountType: "fixed",
          enteredValue: 1200,
          reason: "Compensation voucher",
        });

      expect(res.status).toBe(200);
      const targetLine = res.body.data.invoice.lines.find((l) => l._id.toString() === lineId.toString());
      expect(targetLine.lineDiscountTotal).toBe(1000); // Capped at line total
      expect(targetLine.customerPayable).toBe(0);
      expect(targetLine.appliedDiscounts[0].enteredValue).toBe(1200);
      expect(targetLine.appliedDiscounts[0].calculatedAmount).toBe(1000);
    });
  });

  describe("3. Invoice-Level Discounts & Proportional Allocation", () => {
    it("applies multiple sequential invoice-level discounts and allocates proportionally with exact rounding", async () => {
      const invoice = await createDraftInvoice(); // Line 1 = 1000, Line 2 = 2000. Total = 3000

      // Apply 10% invoice-level discount
      const res = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "invoice",
          name: "Seasonal Invoice Discount",
          discountType: "percentage",
          enteredValue: 10,
          reason: "Diwali promo",
        });

      expect(res.status).toBe(200);
      expect(res.body.data.invoice.invoiceDiscountsTotal).toBe(300); // 10% of 3000
      expect(res.body.data.invoice.payableAmount).toBe(2700);

      // Verify proportional line allocation:
      // Line 1: 1000 / 3000 * 300 = 100
      // Line 2: 2000 / 3000 * 300 = 200
      const lines = res.body.data.invoice.lines;
      expect(lines[0].allocatedInvoiceDiscount).toBe(100);
      expect(lines[0].customerPayable).toBe(900);
      expect(lines[1].allocatedInvoiceDiscount).toBe(200);
      expect(lines[1].customerPayable).toBe(1800);
    });

    it("assigns final rounding penny to the last eligible line", async () => {
      // Create 3 lines of 100 each -> Total 300
      const lines = [
        {
          lineType: "service",
          serviceType: "registered",
          serviceId: serviceShampoo._id,
          appointmentServiceId: new mongoose.Types.ObjectId(),
          name: "Service 1",
          duration: 15,
          quantity: 1,
          unitPrice: 100,
          lineTotal: 100,
          isCoveredBySubscription: false,
          subscriptionCoveredAmount: 0,
          discountAmount: 0,
          customerPayable: 100,
        },
        {
          lineType: "service",
          serviceType: "registered",
          serviceId: serviceShampoo._id,
          appointmentServiceId: new mongoose.Types.ObjectId(),
          name: "Service 2",
          duration: 15,
          quantity: 1,
          unitPrice: 100,
          lineTotal: 100,
          isCoveredBySubscription: false,
          subscriptionCoveredAmount: 0,
          discountAmount: 0,
          customerPayable: 100,
        },
        {
          lineType: "service",
          serviceType: "registered",
          serviceId: serviceShampoo._id,
          appointmentServiceId: new mongoose.Types.ObjectId(),
          name: "Service 3",
          duration: 15,
          quantity: 1,
          unitPrice: 100,
          lineTotal: 100,
          isCoveredBySubscription: false,
          subscriptionCoveredAmount: 0,
          discountAmount: 0,
          customerPayable: 100,
        },
      ];

      const invoice = await createDraftInvoice(lines);

      // Apply flat 10 discount across 3 lines of 100 each
      // 10 / 3 = 3.333...
      // Line 1: 3.33
      // Line 2: 3.33
      // Line 3: 10 - 6.66 = 3.34
      const res = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "invoice",
          discountType: "fixed",
          enteredValue: 10,
          reason: "Rounding test",
        });

      expect(res.status).toBe(200);
      const resLines = res.body.data.invoice.lines;
      expect(resLines[0].allocatedInvoiceDiscount).toBe(3.33);
      expect(resLines[1].allocatedInvoiceDiscount).toBe(3.33);
      expect(resLines[2].allocatedInvoiceDiscount).toBe(3.34);
      expect(resLines[0].customerPayable).toBe(96.67);
      expect(resLines[1].customerPayable).toBe(96.67);
      expect(resLines[2].customerPayable).toBe(96.66);

      // Sum of customerPayables + total discount must equal subtotal
      const totalPayable = resLines.reduce((acc, l) => acc + l.customerPayable, 0);
      expect(Number(totalPayable.toFixed(2))).toBe(290.00);
    });
  });

  describe("4. Subscription-Covered Lines Exclusion", () => {
    it("strictly rejects applying a discount to a subscription-covered service line", async () => {
      const lines = [
        {
          lineType: "service",
          serviceType: "registered",
          serviceId: serviceHaircut._id,
          appointmentServiceId: new mongoose.Types.ObjectId(),
          name: serviceHaircut.name,
          duration: serviceHaircut.duration,
          quantity: 1,
          unitPrice: 1000,
          lineTotal: 1000,
          isCoveredBySubscription: true,
          subscriptionCoveredAmount: 1000,
          discountAmount: 0,
          customerPayable: 0,
        },
        {
          lineType: "service",
          serviceType: "registered",
          serviceId: serviceColor._id,
          appointmentServiceId: new mongoose.Types.ObjectId(),
          name: serviceColor.name,
          duration: serviceColor.duration,
          quantity: 1,
          unitPrice: 2000,
          lineTotal: 2000,
          isCoveredBySubscription: false,
          subscriptionCoveredAmount: 0,
          discountAmount: 0,
          customerPayable: 2000,
        },
      ];

      const invoice = await createDraftInvoice(lines);
      const coveredLineId = invoice.lines[0]._id;

      const res = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "line",
          lineId: coveredLineId,
          discountType: "percentage",
          enteredValue: 10,
          reason: "Trying to discount covered service",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Subscription-covered services cannot receive discounts/i);
    });

    it("excludes subscription-covered amounts from invoice-level discount calculation", async () => {
      const lines = [
        {
          lineType: "service",
          serviceType: "registered",
          serviceId: serviceHaircut._id,
          appointmentServiceId: new mongoose.Types.ObjectId(),
          name: serviceHaircut.name,
          duration: serviceHaircut.duration,
          quantity: 1,
          unitPrice: 1000,
          lineTotal: 1000,
          isCoveredBySubscription: true,
          subscriptionCoveredAmount: 1000,
          discountAmount: 0,
          customerPayable: 0,
        },
        {
          lineType: "service",
          serviceType: "registered",
          serviceId: serviceColor._id,
          appointmentServiceId: new mongoose.Types.ObjectId(),
          name: serviceColor.name,
          duration: serviceColor.duration,
          quantity: 1,
          unitPrice: 2000,
          lineTotal: 2000,
          isCoveredBySubscription: false,
          subscriptionCoveredAmount: 0,
          discountAmount: 0,
          customerPayable: 2000,
        },
      ];

      const invoice = await createDraftInvoice(lines);

      // Subtotal = 3000, Covered = 1000, Uncovered Pool = 2000
      // 10% invoice discount should apply ONLY to uncovered 2000 -> 200 discount!
      const res = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "invoice",
          discountType: "percentage",
          enteredValue: 10,
          reason: "Uncovered promo",
        });

      expect(res.status).toBe(200);
      expect(res.body.data.invoice.subtotal).toBe(3000);
      expect(res.body.data.invoice.subscriptionCoveredAmount).toBe(1000);
      expect(res.body.data.invoice.discountTotal).toBe(200); // 10% of 2000 (NOT 10% of 3000)
      expect(res.body.data.invoice.payableAmount).toBe(1800); // 2000 - 200
      expect(res.body.data.invoice.grossPayable).toBe(2800); // 3000 - 200
    });
  });

  describe("5. Discount Modification, Removal & Append-Only History", () => {
    it("modifies an existing discount, recalculates totals, and appends history entry", async () => {
      const invoice = await createDraftInvoice();

      // 1. Apply 10% invoice discount
      const applyRes = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "invoice",
          discountType: "percentage",
          enteredValue: 10,
          reason: "Initial discount",
        });

      const discountId = applyRes.body.data.historyEntry.discountId;

      // 2. Modify to 20%
      const modifyRes = await request(app)
        .patch(`/api/v1/billing/invoices/${invoice._id}/discounts/${discountId}`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          enteredValue: 20,
          reason: "Manager approved higher rate",
        });

      expect(modifyRes.status).toBe(200);
      expect(modifyRes.body.data.invoice.discountTotal).toBe(600); // 20% of 3000
      expect(modifyRes.body.data.invoice.payableAmount).toBe(2400);

      // Verify embedded history length = 2 (applied, then modified)
      const histRes = await request(app)
        .get(`/api/v1/billing/invoices/${invoice._id}/discount-history`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString());

      expect(histRes.status).toBe(200);
      expect(histRes.body.data).toHaveLength(2);
      expect(histRes.body.data[0].action).toBe("applied");
      expect(histRes.body.data[1].action).toBe("modified");
      expect(histRes.body.data[1].reason).toBe("Manager approved higher rate");
    });

    it("removes a discount, restores original totals, and appends removal history", async () => {
      const invoice = await createDraftInvoice();

      // 1. Apply flat 500
      const applyRes = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "invoice",
          discountType: "fixed",
          enteredValue: 500,
          reason: "Customer promotion",
        });

      const discountId = applyRes.body.data.historyEntry.discountId;

      // 2. Remove discount
      const removeRes = await request(app)
        .delete(`/api/v1/billing/invoices/${invoice._id}/discounts/${discountId}`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          reason: "Customer opted for points instead",
        });

      expect(removeRes.status).toBe(200);
      expect(removeRes.body.data.invoice.discountTotal).toBe(0);
      expect(removeRes.body.data.invoice.payableAmount).toBe(3000);
      expect(removeRes.body.data.invoice.appliedDiscounts).toHaveLength(0);

      // Verify history has 2 records
      const histRes = await request(app)
        .get(`/api/v1/billing/invoices/${invoice._id}/discount-history`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString());

      expect(histRes.body.data).toHaveLength(2);
      expect(histRes.body.data[1].action).toBe("removed");
    });
  });

  describe("6. Partial Payment Protections & Boundary Reversal", () => {
    it("rejects applying a discount that would reduce payable below amount already paid", async () => {
      const invoice = await createDraftInvoice(); // Total 3000
      invoice.amountPaid = 2500;
      invoice.amountDue = 500;
      invoice.paymentStatus = "partially_paid";
      await invoice.save();

      // Attempt to apply 1000 discount (payable would become 2000 < 2500 paid)
      const res = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "invoice",
          discountType: "fixed",
          enteredValue: 1000,
          reason: "Excessive discount attempt",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/cannot be less than amount already paid/i);
    });

    it("removing a discount reopens amountDue without mutating existing payment records", async () => {
      const invoice = await createDraftInvoice();

      // Apply 1000 discount -> payable = 2000
      const applyRes = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "invoice",
          discountType: "fixed",
          enteredValue: 1000,
          reason: "Big discount",
        });

      const discountId = applyRes.body.data.historyEntry.discountId;

      // Simulate partial payment of 2000 (status becomes 'paid')
      await Invoice.updateOne(
        { _id: invoice._id },
        { $set: { amountPaid: 2000, amountDue: 0, paymentStatus: "paid" } }
      );

      // Now remove the 1000 discount -> payable becomes 3000, amountDue reopens to 1000, status becomes partially_paid
      const removeRes = await request(app)
        .delete(`/api/v1/billing/invoices/${invoice._id}/discounts/${discountId}`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          reason: "Revoking discount after review",
        });

      expect(removeRes.status).toBe(200);
      expect(removeRes.body.data.invoice.payableAmount).toBe(3000);
      expect(removeRes.body.data.invoice.amountPaid).toBe(2000);
      expect(removeRes.body.data.invoice.amountDue).toBe(1000);
      expect(removeRes.body.data.invoice.paymentStatus).toBe("partially_paid");
    });
  });

  describe("7. Legacy Scalar Invoices & Zero Double-Counting", () => {
    it("reads legacy scalar discount with stable identity without mutating database", async () => {
      const invoice = await createDraftInvoice();
      invoice.discountTotal = 400;
      invoice.payableAmount = 2600;
      invoice.amountDue = 2600;
      invoice.appliedDiscounts = [];
      invoice.discountHistory = [];
      await invoice.save();

      const histRes = await request(app)
        .get(`/api/v1/billing/invoices/${invoice._id}/discount-history`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString());

      expect(histRes.status).toBe(200);
      expect(histRes.body.data).toHaveLength(1);
      expect(histRes.body.data[0].reason).toMatch(/Legacy unitemized/i);
      expect(histRes.body.data[0].discountId.toString()).toBe(invoice._id.toString()); // Stable identity derived from invoice ID

      // Verify invoice in DB was NOT mutated merely by reading
      const dbCheck = await Invoice.findById(invoice._id);
      expect(dbCheck.appliedDiscounts).toHaveLength(0);
      expect(dbCheck.discountHistory).toHaveLength(0);
    });

    it("materializes legacy discount on first mutation and prevents double counting", async () => {
      const invoice = await createDraftInvoice();
      invoice.discountTotal = 400;
      invoice.payableAmount = 2600;
      invoice.amountDue = 2600;
      invoice.appliedDiscounts = [];
      invoice.discountHistory = [];
      await invoice.save();

      // Apply a new line discount of 100 on Line 1
      const res = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "line",
          lineId: invoice.lines[0]._id,
          discountType: "fixed",
          enteredValue: 100,
          reason: "Additional line discount",
        });

      expect(res.status).toBe(200);
      // Total discount should be Legacy 400 + Line 100 = 500 (NOT double counted)
      expect(res.body.data.invoice.discountTotal).toBe(500);
      expect(res.body.data.invoice.lineDiscountsTotal).toBe(100);
      expect(res.body.data.invoice.invoiceDiscountsTotal).toBe(400);
      expect(res.body.data.invoice.payableAmount).toBe(2500);

      // Verify legacy discount is now materialized in appliedDiscounts with isLegacy: true
      const dbCheck = await Invoice.findById(invoice._id);
      expect(dbCheck.appliedDiscounts).toHaveLength(1);
      expect(dbCheck.appliedDiscounts[0].isLegacy).toBe(true);
    });
  });

  describe("8. Concurrency & Authorization Guards", () => {
    it("rejects discount mutation on finalized invoice", async () => {
      const invoice = await createDraftInvoice();
      invoice.status = "finalized";
      await invoice.save();

      const res = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "invoice",
          discountType: "fixed",
          enteredValue: 100,
          reason: "Post-finalized attempt",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Only draft invoices may be discounted/i);
    });

    it("rejects unauthorized user without billing.checkout permission", async () => {
      const invoice = await createDraftInvoice();

      const res = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${unauthorizedTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "invoice",
          discountType: "fixed",
          enteredValue: 100,
          reason: "Unauthorized attempt",
        });

      expect(res.status).toBe(403);
    });

    it("rejects mutation with X-Branch-Id: all", async () => {
      const invoice = await createDraftInvoice();

      const res = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("X-Branch-Id", "all")
        .send({
          branchId: "all",
          discountLevel: "invoice",
          discountType: "fixed",
          enteredValue: 100,
          reason: "All branch attempt",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Please select a Branch/i);
    });

    it("rejects cross-organization discount mutation", async () => {
      const invoice = await createDraftInvoice();

      const res = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${ownerTokenB}`)
        .set("X-Branch-Id", branchB1._id.toString())
        .send({
          branchId: branchB1._id,
          discountLevel: "invoice",
          discountType: "fixed",
          enteredValue: 100,
          reason: "Cross org attempt",
        });

      expect(res.status).toBe(404);
    });
  });

  describe("9. Multiple Selected Lines Discounts", () => {
    it("applies a percentage discount independently across multiple selected lines", async () => {
      // Service 1: 600, Service 2: 1500 -> 10% discount -> S1: 60, S2: 150, Total: 210
      const invoice = await createDraftInvoice({
        lines: [
          { name: "Service A", price: 600, duration: 30 },
          { name: "Service B", price: 1500, duration: 60 },
          { name: "Service C", price: 400, duration: 20 },
        ],
      });

      const lineAId = invoice.lines[0]._id.toString();
      const lineBId = invoice.lines[1]._id.toString();

      const res = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "selected_lines",
          lineIds: [lineAId, lineBId],
          name: "10% Multi-Line Promo",
          discountType: "percentage",
          enteredValue: 10,
          reason: "Selected bundle discount",
        });

      expect(res.status).toBe(200);
      const inv = res.body.data.invoice;
      expect(inv.subtotal).toBe(2500);
      expect(inv.lineDiscountsTotal).toBe(210); // 60 + 150
      expect(inv.discountTotal).toBe(210);
      expect(inv.payableAmount).toBe(2290);
      expect(inv.lines[0].lineDiscountTotal).toBe(60);
      expect(inv.lines[0].customerPayable).toBe(540);
      expect(inv.lines[1].lineDiscountTotal).toBe(150);
      expect(inv.lines[1].customerPayable).toBe(1350);
      expect(inv.lines[2].lineDiscountTotal).toBe(0);
      expect(inv.lines[2].customerPayable).toBe(400);

      // Verify single history record
      expect(res.body.data.historyEntry.discountLevel).toBe("selected_lines");
      expect(res.body.data.historyEntry.calculatedAmount).toBe(210);
      expect(res.body.data.historyEntry.allocations).toHaveLength(2);
      expect(res.body.data.historyEntry.allocations[0].allocatedAmount).toBe(60);
      expect(res.body.data.historyEntry.allocations[1].allocatedAmount).toBe(150);
    });

    it("applies a fixed discount proportionally allocated across multiple selected lines with exact rounding", async () => {
      // Service A: 600, Service B: 1500 -> Total eligible base: 2100. Total fixed discount: 210 -> S1: 60, S2: 150
      const invoice = await createDraftInvoice({
        lines: [
          { name: "Service A", price: 600, duration: 30 },
          { name: "Service B", price: 1500, duration: 60 },
        ],
      });

      const lineAId = invoice.lines[0]._id.toString();
      const lineBId = invoice.lines[1]._id.toString();

      const res = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "selected_lines",
          lineIds: [lineAId, lineBId],
          discountType: "fixed",
          enteredValue: 210,
          reason: "Fixed combo discount",
        });

      expect(res.status).toBe(200);
      const inv = res.body.data.invoice;
      expect(inv.lineDiscountsTotal).toBe(210);
      expect(inv.lines[0].lineDiscountTotal).toBe(60);
      expect(inv.lines[1].lineDiscountTotal).toBe(150);
      expect(inv.payableAmount).toBe(1890);
    });

    it("assigns final rounding penny remainder to the last eligible line in selected_lines fixed discount", async () => {
      // 3 services of 100 each = 300 base. Apply 100 fixed discount.
      // 100/300 * 100 = 33.33 each.
      // Line 1: 33.33 (rem: 66.67), Line 2: 33.33 (rem: 33.34), Line 3: 33.34. Total = 100.00
      const invoice = await createDraftInvoice({
        lines: [
          { name: "S1", price: 100, duration: 15 },
          { name: "S2", price: 100, duration: 15 },
          { name: "S3", price: 100, duration: 15 },
        ],
      });

      const lineIds = invoice.lines.map((l) => l._id.toString());

      const res = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "selected_lines",
          lineIds,
          discountType: "fixed",
          enteredValue: 100,
          reason: "Rounding test",
        });

      expect(res.status).toBe(200);
      const inv = res.body.data.invoice;
      expect(inv.lineDiscountsTotal).toBe(100);
      expect(inv.lines[0].lineDiscountTotal).toBe(33.33);
      expect(inv.lines[1].lineDiscountTotal).toBe(33.33);
      expect(inv.lines[2].lineDiscountTotal).toBe(33.34);
    });

    it("rejects applying selected_lines discount if any selected line is covered by subscription", async () => {
      const invoice = await createDraftInvoice({
        lines: [
          { name: "Covered Haircut", price: 500, isCovered: true },
          { name: "Paid Coloring", price: 1500, isCovered: false },
        ],
      });

      const coveredId = invoice.lines[0]._id.toString();
      const paidId = invoice.lines[1]._id.toString();

      const res = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "selected_lines",
          lineIds: [coveredId, paidId],
          discountType: "percentage",
          enteredValue: 10,
          reason: "Try discount on covered line",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/covered by subscription and cannot receive discounts/i);
    });

    it("rejects duplicate, missing or invalid lineIds", async () => {
      const invoice = await createDraftInvoice({
        lines: [
          { name: "Service A", price: 500 },
          { name: "Service B", price: 1000 },
        ],
      });

      const lineAId = invoice.lines[0]._id.toString();

      // Duplicate lineIds
      const dupRes = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "selected_lines",
          lineIds: [lineAId, lineAId],
          discountType: "percentage",
          enteredValue: 10,
          reason: "Duplicate line test",
        });

      expect(dupRes.status).toBe(400);
      expect(dupRes.body.message).toMatch(/Duplicate line IDs/i);

      // Non-existent lineId
      const fakeId = new mongoose.Types.ObjectId().toString();
      const notFoundRes = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "selected_lines",
          lineIds: [lineAId, fakeId],
          discountType: "percentage",
          enteredValue: 10,
          reason: "Missing line test",
        });

      expect(notFoundRes.status).toBe(404);
      expect(notFoundRes.body.message).toMatch(/not found on this invoice/i);
    });

    it("rejects fixed discount exceeding the available eligible balance across selected lines", async () => {
      const invoice = await createDraftInvoice({
        lines: [
          { name: "Service A", price: 300 },
          { name: "Service B", price: 400 },
        ],
      });

      const lineAId = invoice.lines[0]._id.toString();
      const lineBId = invoice.lines[1]._id.toString();

      const res = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "selected_lines",
          lineIds: [lineAId, lineBId],
          discountType: "fixed",
          enteredValue: 750, // Base is 700
          reason: "Excessive discount",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/exceeds the total remaining eligible amount/i);
    });

    it("modifies a multi-line discount and recalculates allocations proportionally", async () => {
      // 1. Create invoice with 600 and 1500 (total: 2100)
      const invoice = await createDraftInvoice({
        lines: [
          { name: "Service A", price: 600 },
          { name: "Service B", price: 1500 },
        ],
      });

      const lineAId = invoice.lines[0]._id.toString();
      const lineBId = invoice.lines[1]._id.toString();

      // 2. Apply initial 210 fixed discount (60 on A, 150 on B)
      const applyRes = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "selected_lines",
          lineIds: [lineAId, lineBId],
          discountType: "fixed",
          enteredValue: 210,
          reason: "Initial combo discount",
        });

      const discountId = applyRes.body.data.historyEntry.discountId;

      // 3. Modify discount to 420 fixed (120 on A, 300 on B)
      const modifyRes = await request(app)
        .patch(`/api/v1/billing/invoices/${invoice._id}/discounts/${discountId}`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          enteredValue: 420,
          reason: "Doubled discount",
        });

      expect(modifyRes.status).toBe(200);
      const inv = modifyRes.body.data.invoice;
      expect(inv.lineDiscountsTotal).toBe(420);
      expect(inv.lines[0].lineDiscountTotal).toBe(120);
      expect(inv.lines[1].lineDiscountTotal).toBe(300);
      expect(inv.payableAmount).toBe(1680);

      // Verify history entry shows modified with all allocations
      const historyEntry = modifyRes.body.data.historyEntry;
      expect(historyEntry.action).toBe("modified");
      expect(historyEntry.calculatedAmount).toBe(420);
      expect(historyEntry.allocations).toHaveLength(2);
      expect(historyEntry.allocations[0].allocatedAmount).toBe(120);
      expect(historyEntry.allocations[1].allocatedAmount).toBe(300);
    });

    it("removes a multi-line discount, reversing all allocations across selected lines", async () => {
      const invoice = await createDraftInvoice({
        lines: [
          { name: "Service A", price: 600 },
          { name: "Service B", price: 1500 },
        ],
      });

      const lineAId = invoice.lines[0]._id.toString();
      const lineBId = invoice.lines[1]._id.toString();

      // Apply 10% multi-line
      const applyRes = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "selected_lines",
          lineIds: [lineAId, lineBId],
          discountType: "percentage",
          enteredValue: 10,
          reason: "Initial multi-line",
        });

      const discountId = applyRes.body.data.historyEntry.discountId;

      // Remove multi-line discount
      const removeRes = await request(app)
        .delete(`/api/v1/billing/invoices/${invoice._id}/discounts/${discountId}`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          reason: "Customer changed mind",
        });

      expect(removeRes.status).toBe(200);
      const inv = removeRes.body.data.invoice;
      expect(inv.lineDiscountsTotal).toBe(0);
      expect(inv.discountTotal).toBe(0);
      expect(inv.payableAmount).toBe(2100);
      expect(inv.lines[0].lineDiscountTotal).toBe(0);
      expect(inv.lines[1].lineDiscountTotal).toBe(0);

      const historyEntry = removeRes.body.data.historyEntry;
      expect(historyEntry.action).toBe("removed");
      expect(historyEntry.allocations).toHaveLength(2);
    });

    it("allows multiple sequential discounts (selected-lines then invoice-level)", async () => {
      // S1: 1000, S2: 1000. Total = 2000.
      // 1. Selected lines (S1 & S2) gets 10% -> S1: 100, S2: 100. Remaining pool: 1800.
      // 2. Invoice-level gets 10% -> 10% of 1800 = 180. (allocated 90 to S1, 90 to S2).
      // Total discount: 200 + 180 = 380. Payable: 1620.
      const invoice = await createDraftInvoice({
        lines: [
          { name: "S1", price: 1000 },
          { name: "S2", price: 1000 },
        ],
      });

      const line1Id = invoice.lines[0]._id.toString();
      const line2Id = invoice.lines[1]._id.toString();

      // Step 1: Selected lines discount
      await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "selected_lines",
          lineIds: [line1Id, line2Id],
          discountType: "percentage",
          enteredValue: 10,
          reason: "Step 1 selected",
        });

      // Step 2: Invoice level discount
      const invRes = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "invoice",
          discountType: "percentage",
          enteredValue: 10,
          reason: "Step 2 invoice",
        });

      expect(invRes.status).toBe(200);
      const inv = invRes.body.data.invoice;
      expect(inv.lineDiscountsTotal).toBe(200);
      expect(inv.invoiceDiscountsTotal).toBe(180);
      expect(inv.discountTotal).toBe(380);
      expect(inv.payableAmount).toBe(1620);
    });

    it("applies an invoice-level discount when lineId is explicitly null", async () => {
      const invoice = await createDraftInvoice();

      const res = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "invoice",
          lineId: null,
          lineIds: null,
          name: "Global 10%",
          discountType: "percentage",
          enteredValue: 10,
          reason: "Frontend sent lineId null for invoice discount",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.invoice.invoiceDiscountsTotal).toBe(300); // Subtotal is 3000 -> 10% = 300
      expect(res.body.data.invoice.appliedDiscounts).toHaveLength(1);
      expect(res.body.data.invoice.appliedDiscounts[0].discountLevel).toBe("invoice");
      expect(res.body.data.historyEntry.discountLevel).toBe("invoice");
      expect(res.body.data.historyEntry.lineId).toBeNull();
    });

    it("applies an invoice-level discount when lineId and lineIds are omitted", async () => {
      const invoice = await createDraftInvoice();

      const res = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "invoice",
          name: "Global Fixed 200",
          discountType: "fixed",
          enteredValue: 200,
          reason: "Invoice discount with omitted lineId",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.invoice.invoiceDiscountsTotal).toBe(200);
      expect(res.body.data.invoice.discountTotal).toBe(200);
    });

    it("rejects line-level discount when lineId is null or omitted", async () => {
      const invoice = await createDraftInvoice();

      // Test with lineId: null
      const resNull = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "line",
          lineId: null,
          discountType: "fixed",
          enteredValue: 100,
          reason: "Invalid null lineId",
        });

      expect(resNull.status).toBe(400);

      // Test with lineId omitted
      const resOmitted = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "line",
          discountType: "fixed",
          enteredValue: 100,
          reason: "Invalid omitted lineId",
        });

      expect(resOmitted.status).toBe(400);
    });

    it("rejects selected_lines discount when lineIds is null, empty or omitted", async () => {
      const invoice = await createDraftInvoice();

      // Test with lineIds: null
      const resNull = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "selected_lines",
          lineIds: null,
          discountType: "fixed",
          enteredValue: 100,
          reason: "Invalid null lineIds",
        });

      expect(resNull.status).toBe(400);

      // Test with lineIds: []
      const resEmpty = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/discounts`)
        .set("Authorization", `Bearer ${cashierTokenA}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id,
          discountLevel: "selected_lines",
          lineIds: [],
          discountType: "fixed",
          enteredValue: 100,
          reason: "Invalid empty lineIds",
        });

      expect(resEmpty.status).toBe(400);
    });
  });
});
