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
import { Service } from "../../models/services/service.model.js";
import { ServiceCategory } from "../../models/services/serviceCategory.model.js";
import { inventoryService } from "../../services/inventory/inventory.service.js";
import { Invoice } from "../../models/billing/invoice.model.js";
import { Payment } from "../../models/billing/payment.model.js";
import jwt from "jsonwebtoken";

describe("Retail POS & Unified Invoice Checkout Integration Test Suite", () => {
  jest.setTimeout(45000);
  let orgId, branchId, branch2Id, userId, token;
  let customerId, retailProduct, salonOnlyProduct;
  let paidInvoiceId, productLineId;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    const testUri = getIsolatedTestMongoUri("checkout_queue_test");
    await mongoose.connect(testUri);

    // 1. Create Organization & Branches
    const org = await Organization.create({
      name: "POS Test Salon Org",
      ownerEmail: "pos_owner@test.com",
    });
    orgId = org._id;

    const branch = await Branch.create({
      name: "Indiranagar Branch",
      organizationId: orgId,
      address: "100ft Road",
    });
    branchId = branch._id;

    const branch2 = await Branch.create({
      name: "Koramangala Branch",
      organizationId: orgId,
      address: "80ft Road",
    });
    branch2Id = branch2._id;

    // 2. Role with full billing & inventory permissions
    const rawPerms = [
      "billing.view",
      "billing.checkout",
      "billing.void",
      "payments.view",
      "payments.receive",
      "payments.refund",
      "inventory.view",
      "inventory.manage",
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

    const role = await Role.create({
      name: `POS Manager Role ${Date.now()}`,
      organizationId: orgId,
      permissions: permDocs.map((p) => p._id),
    });

    const uniqueSuffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const user = await User.create({
      name: "POS Cashier",
      username: `cashier_${uniqueSuffix}`,
      email: `cashier_${uniqueSuffix}@test.com`,
      phone: `+9198765${uniqueSuffix.slice(-5)}`,
      password: "Password@123",
      organizationId: orgId,
      branchIds: [branchId],
      role: role._id,
      branchAccess: [{ branchId, branchName: "Indiranagar Branch", isActive: true }],
      hasOrgWideAccess: true,
      status: "active",
    });
    userId = user._id;

    token = jwt.sign(
      {
        id: userId.toString(),
        organizationId: orgId.toString(),
        role: "manager",
        roleId: role._id.toString(),
        hasOrgWideAccess: true,
      },
      process.env.JWT_SECRET || "default_jwt_secret_for_tests",
      { expiresIn: "2h" }
    );

    // 3. Customer
    const customer = await Customer.create({
      name: "Pooja Sharma",
      phone: "+919876543210",
      email: "pooja@test.com",
      homeBranchId: branchId,
      organizationId: orgId,
    });
    customerId = customer._id;

    // 4. Products: retail_sale & salon_consumption
    retailProduct = await Product.create({
      name: "Moroccan Argan Shampoo 250ml",
      sku: "POS-SHAMP-001",
      category: "Hair Care",
      usageType: "retail_sale",
      stockUnit: "bottle",
      costPrice: 400,
      sellingPrice: 850,
      reorderLevel: 5,
      organizationId: orgId,
      createdBy: userId,
      updatedBy: userId,
    });

    salonOnlyProduct = await Product.create({
      name: "Bulk Bleach Powder 5kg",
      sku: "POS-BLEACH-001",
      category: "Color & Treatment",
      usageType: "salon_consumption",
      stockUnit: "kg",
      costPrice: 1200,
      sellingPrice: 0,
      reorderLevel: 2,
      organizationId: orgId,
      createdBy: userId,
      updatedBy: userId,
    });

    // 5. Seed stock for retailProduct
    await StockBalance.create({
      organizationId: orgId,
      branchId,
      productId: retailProduct._id,
      onHand: 10,
      allocated: 0,
    });
  });

  afterAll(async () => {
    await Organization.deleteMany({ _id: orgId });
    await Branch.deleteMany({ organizationId: orgId });
    await Role.deleteMany({ organizationId: orgId });
    await User.deleteMany({ organizationId: orgId });
    await Customer.deleteMany({ organizationId: orgId });
    await Product.deleteMany({ organizationId: orgId });
    await StockBalance.deleteMany({ organizationId: orgId });
    await StockMovement.deleteMany({ organizationId: orgId });
    await StockReservation.deleteMany({ organizationId: orgId });
    await Invoice.deleteMany({ organizationId: orgId });
    await Payment.deleteMany({ organizationId: orgId });
  });

  describe("1. Walk-in Retail-Only Checkout Flow", () => {
    let invoiceId;

    it("creates a draft retail invoice and atomically reserves stock (without deducting onHand)", async () => {
      const res = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          branchId: branchId.toString(),
          customerId: customerId.toString(),
          productLines: [
            {
              productId: retailProduct._id.toString(),
              quantity: 3,
            },
          ],
          notes: "Walk-in hair shampoo purchase",
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      const invoice = res.body.data;
      invoiceId = invoice._id;

      expect(invoice.invoiceType).toBe("retail");
      expect(invoice.lines).toHaveLength(1);
      expect(invoice.lines[0].lineType).toBe("product");
      expect(invoice.lines[0].sku).toBe("POS-SHAMP-001");
      expect(invoice.lines[0].unitPrice).toBe(850);
      expect(invoice.lines[0].quantity).toBe(3);
      expect(invoice.lines[0].lineTotal).toBe(2550);
      expect(invoice.payableAmount).toBe(2550);

      // Verify Stock Balance: onHand remains 10, allocated becomes 3
      const balance = await StockBalance.findOne({
        organizationId: orgId,
        branchId,
        productId: retailProduct._id,
      });
      expect(balance.onHand).toBe(10);
      expect(balance.allocated).toBe(3);

      // Verify active reservation created
      const reservations = await StockReservation.find({
        invoiceId,
        status: "active",
      });
      expect(reservations).toHaveLength(1);
      expect(reservations[0].quantity).toBe(3);
    });

    it("rejects creating draft when requested quantity exceeds available stock (onHand - allocated)", async () => {
      // Currently available = 10 - 3 = 7. Requesting 8 should fail.
      const res = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          branchId: branchId.toString(),
          customerId: customerId.toString(),
          productLines: [
            {
              productId: retailProduct._id.toString(),
              quantity: 8,
            },
          ],
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Insufficient available stock/i);
    });

    it("rejects adding salon_consumption only products to retail checkout", async () => {
      const res = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          branchId: branchId.toString(),
          customerId: customerId.toString(),
          productLines: [
            {
              productId: salonOnlyProduct._id.toString(),
              quantity: 1,
            },
          ],
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not designated for retail sale/i);
    });

    it("finalizes invoice and records payment, atomically committing stock deduction and pos_sale movement", async () => {
      // 1. Finalize invoice
      const finRes = await request(app)
        .post(`/api/v1/billing/invoices/${invoiceId}/finalize`)
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .send({});

      expect(finRes.status).toBe(200);
      expect(finRes.body.data.status).toBe("finalized");

      // 2. Record full payment
      const payRes = await request(app)
        .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          amount: 2550,
          method: "upi",
          referenceNote: "UPI-TXN-998877",
          idempotencyKey: `pay_${invoiceId}_1`,
        });

      expect([200, 201]).toContain(payRes.status);
      expect(payRes.body.data.invoice.paymentStatus).toBe("paid");

      // Verify StockBalance: onHand deducted from 10 to 7, allocated reduced from 3 to 0
      const balance = await StockBalance.findOne({
        organizationId: orgId,
        branchId,
        productId: retailProduct._id,
      });
      expect(balance.onHand).toBe(7);
      expect(balance.allocated).toBe(0);

      // Verify pos_sale movement recorded in ledger
      const movement = await StockMovement.findOne({
        organizationId: orgId,
        branchId,
        productId: retailProduct._id,
        movementType: "pos_sale",
      });
      expect(movement).toBeTruthy();
      expect(movement.quantityDelta).toBe(-3);
      expect(movement.balanceAfter).toBe(7);

      // Verify reservation consumed
      const resDoc = await StockReservation.findOne({ invoiceId });
      expect(resDoc.status).toBe("consumed");
    });
  });

  describe("2. Cart Abandonment & Cancellation Releases Stock Reservation", () => {
    let abandonedInvoiceId;

    it("releases allocated stock when a draft invoice is cancelled", async () => {
      // Create draft reserving 2 units (available is 7 -> becomes allocated: 2)
      const res = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          branchId: branchId.toString(),
          customerId: customerId.toString(),
          productLines: [
            {
              productId: retailProduct._id.toString(),
              quantity: 2,
            },
          ],
        });

      abandonedInvoiceId = res.body.data._id;
      let balance = await StockBalance.findOne({
        organizationId: orgId,
        branchId,
        productId: retailProduct._id,
      });
      expect(balance.onHand).toBe(7);
      expect(balance.allocated).toBe(2);

      // Cancel invoice
      const cancelRes = await request(app)
        .post(`/api/v1/billing/invoices/${abandonedInvoiceId}/cancel`)
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .send({ reason: "Customer changed mind at counter" });

      expect(cancelRes.status).toBe(200);

      // Verify allocated reversed back to 0
      balance = await StockBalance.findOne({
        organizationId: orgId,
        branchId,
        productId: retailProduct._id,
      });
      expect(balance.onHand).toBe(7);
      expect(balance.allocated).toBe(0);

      const reservation = await StockReservation.findOne({ invoiceId: abandonedInvoiceId });
      expect(reservation.status).toBe("released");
    });
  });

  describe("3. Combined Appointment Services + Retail Products Unified Checkout", () => {
    let appointmentId, combinedInvoiceId;

    beforeAll(async () => {
      const apt = await Appointment.create({
        organizationId: orgId,
        branchId,
        customerId,
        appointmentCode: "APT-COMB-101",
        date: "2026-11-14",
        appointmentDate: "2026-11-14",
        startTime: "11:00",
        endTime: "12:00",
        startAt: new Date(),
        endAt: new Date(Date.now() + 60 * 60000),
        totalDuration: 45,
        status: "completed",
        bookingType: "walk_in",
        services: [
          {
            serviceId: new mongoose.Types.ObjectId(),
            name: "Hair Styling & Blowdry",
            duration: 45,
            price: 1200,
            serviceType: "registered",
          },
        ],
        pricing: {
          subtotal: 1200,
          discount: 0,
          total: 1200,
        },
      });
      appointmentId = apt._id;
    });

    it("creates a combined invoice containing both appointment service lines and retail product lines", async () => {
      const res = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          branchId: branchId.toString(),
          appointmentId: appointmentId.toString(),
          productLines: [
            {
              productId: retailProduct._id.toString(),
              quantity: 2,
            },
          ],
        });

      expect(res.status).toBe(201);
      const inv = res.body.data;
      combinedInvoiceId = inv._id;

      expect(inv.invoiceType).toBe("combined");
      expect(inv.lines).toHaveLength(2);

      const serviceLine = inv.lines.find((l) => l.lineType === "service");
      const productLine = inv.lines.find((l) => l.lineType === "product");

      expect(serviceLine).toBeTruthy();
      expect(serviceLine.lineTotal).toBe(1200);

      expect(productLine).toBeTruthy();
      expect(productLine.sku).toBe("POS-SHAMP-001");
      expect(productLine.quantity).toBe(2);
      expect(productLine.lineTotal).toBe(1700); // 2 * 850

      // Subtotal = 1200 + 1700 = 2900
      expect(inv.subtotal).toBe(2900);
      expect(inv.payableAmount).toBe(2900);

      // Verify reservation
      const balance = await StockBalance.findOne({
        organizationId: orgId,
        branchId,
        productId: retailProduct._id,
      });
      expect(balance.allocated).toBe(2);
    });

    it("allows updating draft cart to change product quantity, recalculating totals and updating reservations", async () => {
      // Change quantity from 2 to 1
      const updateRes = await request(app)
        .patch(`/api/v1/billing/invoices/${combinedInvoiceId}`)
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          productLines: [
            {
              productId: retailProduct._id.toString(),
              quantity: 1,
            },
          ],
        });

      expect(updateRes.status).toBe(200);
      const inv = updateRes.body.data;

      // Subtotal = 1200 + 850 = 2050
      expect(inv.subtotal).toBe(2050);
      expect(inv.payableAmount).toBe(2050);

      // Allocated should now be 1
      const balance = await StockBalance.findOne({
        organizationId: orgId,
        branchId,
        productId: retailProduct._id,
      });
      expect(balance.allocated).toBe(1);
    });

    it("finalizes and pays combined invoice, committing 1 unit of retail product stock", async () => {
      await request(app)
        .post(`/api/v1/billing/invoices/${combinedInvoiceId}/finalize`)
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .send({});

      const payRes = await request(app)
        .post(`/api/v1/billing/invoices/${combinedInvoiceId}/payments`)
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          amount: 2050,
          method: "card",
          idempotencyKey: `pay_${combinedInvoiceId}`,
        });

      expect([200, 201]).toContain(payRes.status);

      // On hand was 7, deducted 1 -> now 6
      const balance = await StockBalance.findOne({
        organizationId: orgId,
        branchId,
        productId: retailProduct._id,
      });
      expect(balance.onHand).toBe(6);
      expect(balance.allocated).toBe(0);
    });
  });

  describe("4. Separate Financial Refund & Physical Restocking Workflow", () => {
    beforeAll(async () => {
      // Create, finalize, and pay for 2 bottles
      const invRes = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          branchId: branchId.toString(),
          customerId: customerId.toString(),
          productLines: [{ productId: retailProduct._id.toString(), quantity: 2 }],
        });

      paidInvoiceId = invRes.body.data._id;
      productLineId = invRes.body.data.lines[0]._id;

      await request(app)
        .post(`/api/v1/billing/invoices/${paidInvoiceId}/finalize`)
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .send({});

      await request(app)
        .post(`/api/v1/billing/invoices/${paidInvoiceId}/payments`)
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .send({ amount: 1700, method: "cash", idempotencyKey: `pay_${paidInvoiceId}` });
    });

    it("accepts return of 1 item with physical restock confirmed, restoring onHand inventory and logging adjustment", async () => {
      // Prior onHand was 4 (6 - 2 = 4)
      let balance = await StockBalance.findOne({
        organizationId: orgId,
        branchId,
        productId: retailProduct._id,
      });
      expect(balance.onHand).toBe(4);

      const returnRes = await request(app)
        .post(`/api/v1/billing/invoices/${paidInvoiceId}/returns`)
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .set("Idempotency-Key", `RETURN-RESTOCK-${paidInvoiceId}`)
        .send({
          items: [
            {
              lineId: productLineId.toString(),
              quantity: 1,
              condition: "unopened",
              acceptPhysicalRestock: true,
              restockReason: "Unopened seal intact - returned to shelf",
            },
          ],
          refundPaymentMethod: "cash",
          reason: "Customer purchased duplicate by mistake",
        });

      expect(returnRes.status === 200 ? 200 : returnRes.body).toBe(200);
      expect(returnRes.status).toBe(200);
      expect(returnRes.body.data.totalRefundAmount).toBe(850);
      expect(returnRes.body.data.restockedMovements).toHaveLength(1);

      // Verify onHand restocked from 4 to 5
      balance = await StockBalance.findOne({
        organizationId: orgId,
        branchId,
        productId: retailProduct._id,
      });
      expect(balance.onHand).toBe(5);

      // Verify negative refund payment logged
      const refundPay = await Payment.findOne({
        invoiceId: paidInvoiceId,
        amount: -850,
      });
      expect(refundPay).toBeTruthy();
      expect(refundPay.method).toBe("cash");
    });

    it("processes refund for damaged goods with acceptPhysicalRestock=false without restocking damaged unit to onHand", async () => {
      // onHand is 5
      const returnRes = await request(app)
        .post(`/api/v1/billing/invoices/${paidInvoiceId}/returns`)
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .set("Idempotency-Key", `RETURN-DAMAGED-${paidInvoiceId}`)
        .send({
          items: [
            {
              lineId: productLineId.toString(),
              quantity: 1,
              condition: "damaged",
              acceptPhysicalRestock: false, // Rule 9: Do NOT restock broken/damaged goods
              restockReason: "Broken cap / leaking nozzle",
            },
          ],
          refundPaymentMethod: "cash",
          reason: "Damaged packaging discovered by customer",
        });

      expect(returnRes.status === 200 ? 200 : returnRes.body).toBe(200);
      expect(returnRes.status).toBe(200);
      expect(returnRes.body.data.totalRefundAmount).toBe(850);
      expect(returnRes.body.data.restockedMovements).toHaveLength(0); // Zero restock movements

      // Verify onHand remains 5 (damaged product was NOT restocked)
      const balance = await StockBalance.findOne({
        organizationId: orgId,
        branchId,
        productId: retailProduct._id,
      });
      expect(balance.onHand).toBe(5);
    });

    it("rejects duplicate or excessive returns exceeding the purchased quantity", async () => {
      // 1 item was restocked in test 1, 1 item was refunded as damaged in test 2. Total returned = 2.
      // Attempting to return even 1 more item must be rejected with 400.
      const excessReturnRes = await request(app)
        .post(`/api/v1/billing/invoices/${paidInvoiceId}/returns`)
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .set("Idempotency-Key", `RETURN-EXCESS-${paidInvoiceId}`)
        .send({
          items: [
            {
              lineId: productLineId.toString(),
              quantity: 1,
              acceptPhysicalRestock: true,
            },
          ],
          refundPaymentMethod: "cash",
          reason: "Trying to return a 3rd item when only 2 were purchased",
        });

      expect(excessReturnRes.status).toBe(400);
      expect(excessReturnRes.body.message).toMatch(/exceeds remaining returnable quantity/i);
    });
  });

  describe("5. Transactional Reservation Expiry & Worker Deduplication", () => {
    it("releases allocated quantity exactly once when reservation expires and handles worker retries idempotently", async () => {
      // Initial stock: onHand = 5, allocated = 0
      const createRes = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          customerId: customerId.toString(),
          productLines: [{ productId: retailProduct._id.toString(), quantity: 2 }],
        });

      expect(createRes.status).toBe(201);
      const invoiceId = createRes.body.data._id;

      let balance = await StockBalance.findOne({ organizationId: orgId, branchId, productId: retailProduct._id });
      expect(balance.allocated).toBe(2);

      // Force reservation expiresAt into the past
      await StockReservation.updateMany(
        { invoiceId, status: "active" },
        { $set: { expiresAt: new Date(Date.now() - 60000) } }
      );

      // Run cleanup worker 1st time
      const result1 = await inventoryService.cleanupExpiredReservations(10);
      expect(result1.processedCount).toBe(1);

      balance = await StockBalance.findOne({ organizationId: orgId, branchId, productId: retailProduct._id });
      expect(balance.allocated).toBe(0); // Allocated safely released

      const resDoc = await StockReservation.findOne({ invoiceId });
      expect(resDoc.status).toBe("expired");

      // Run cleanup worker 2nd time (simulating worker retry or duplicate execution)
      const result2 = await inventoryService.cleanupExpiredReservations(10);
      expect(result2.processedCount).toBe(0);

      // Allocated balance must still be exactly 0 (no double decrement below 0)
      balance = await StockBalance.findOne({ organizationId: orgId, branchId, productId: retailProduct._id });
      expect(balance.allocated).toBe(0);
    });
  });

  describe("6. Subscription + Retail Products Unified Invoice Checkout", () => {
    let serviceId, subDoc;

    beforeAll(async () => {
      const cat = await ServiceCategory.create({
        name: "Hair Services",
        organizationId: orgId,
      });

      const srv = await Service.create({
        name: "Deluxe Hair Spa",
        organizationId: orgId,
        categoryId: cat._id,
        duration: 45,
        pricing: {
          basePrice: 1200,
        },
        status: "active",
      });
      serviceId = srv._id;

      subDoc = await Subscription.create({
        organizationId: orgId,
        customerId,
        payerCustomerId: customerId,
        subscriptionCode: `SUB-POS-${Date.now()}`,
        price: 3000,
        startDate: new Date(),
        endDate: new Date(Date.now() + 30 * 86400000),
        status: "pending_payment",
        permittedBranchIds: [branchId],
        members: [
          {
            customerId,
            status: "pending_payment",
            permittedBranchIds: [branchId],
            entitlements: [
              {
                serviceId,
                serviceName: "Deluxe Hair Spa",
                totalQuantity: 3,
                remainingQuantity: 3,
              },
            ],
          },
        ],
      });
    });

    it("creates a unified invoice with subscription + retail product lines and atomically commits both on full payment", async () => {
      // 1. Create combined subscription + retail product invoice
      const createRes = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          subscriptionId: subDoc._id.toString(),
          productLines: [{ productId: retailProduct._id.toString(), quantity: 1 }],
          notes: "Subscription package plus shampoo bottle",
        });

      expect(createRes.status === 201 ? 201 : createRes.body).toBe(201);
      expect(createRes.status).toBe(201);
      const invoice = createRes.body.data;
      expect(invoice.invoiceType).toBe("combined");
      expect(invoice.lines).toHaveLength(2); // 1 subscription line + 1 product line

      // 3000 (sub) + 850 (product) = 3850
      expect(invoice.payableAmount).toBe(3850);

      // Verify product stock was reserved
      let balance = await StockBalance.findOne({ organizationId: orgId, branchId, productId: retailProduct._id });
      expect(balance.allocated).toBe(1);

      // 2. Finalize invoice
      const finRes = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/finalize`)
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .send();
      expect(finRes.status).toBe(200);

      // 3. Partial payment (Rs. 1850) - stock must NOT be committed yet
      const partPayRes = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/payments`)
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          amount: 1850,
          paymentMethod: "card",
        });
      expect([200, 201]).toContain(partPayRes.status);
      expect(partPayRes.body.data.invoice.paymentStatus).toBe("partially_paid");
      expect(partPayRes.body.data.invoice.amountDue).toBe(2000);

      // Still allocated, onHand unchanged (5)
      balance = await StockBalance.findOne({ organizationId: orgId, branchId, productId: retailProduct._id });
      expect(balance.allocated).toBe(1);
      expect(balance.onHand).toBe(5);

      // 4. Settle remaining balance (Rs. 2000)
      const settlePayRes = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/payments`)
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          amount: 2000,
          paymentMethod: "cash",
        });
      expect([200, 201]).toContain(settlePayRes.status);
      expect(settlePayRes.body.data.invoice.paymentStatus).toBe("paid");

      // Verify stock was permanently decremented: onHand 5 -> 4, allocated 1 -> 0
      balance = await StockBalance.findOne({ organizationId: orgId, branchId, productId: retailProduct._id });
      expect(balance.onHand).toBe(4);
      expect(balance.allocated).toBe(0);

      // Verify pos_sale movement was written
      const movement = await StockMovement.findOne({
        "reference.entityId": invoice._id,
        movementType: "pos_sale",
      });
      expect(movement).toBeTruthy();
      expect(movement.quantityDelta).toBe(-1);

      // Verify subscription was activated upon full payment
      const updatedSub = await Subscription.findById(subDoc._id);
      expect(updatedSub.status).toBe("active");
    });
  });

  describe("7. Tenant and Branch Isolation Enforcement", () => {
    let foreignOrgId, foreignBranchId, foreignProduct;

    beforeAll(async () => {
      const foreignOrg = await Organization.create({
        name: "Foreign Tenant Salon",
        ownerEmail: `foreign_${Date.now()}@test.com`,
      });
      foreignOrgId = foreignOrg._id;

      const foreignBranch = await Branch.create({
        name: "Foreign Branch",
        organizationId: foreignOrgId,
        address: "Foreign Street",
      });
      foreignBranchId = foreignBranch._id;

      foreignProduct = await Product.create({
        name: "Foreign Retail Serum",
        sku: `SKU-FOREIGN-${Date.now()}`,
        category: "Skin",
        usageType: "retail_sale",
        stockUnit: "piece",
        costPrice: 500,
        sellingPrice: 1200,
        status: "active",
        organizationId: foreignOrgId,
      });
    });

    it("rejects processing return from a mismatched branch", async () => {
      // Attempting to return via branch2 (mismatched branch)
      const res = await request(app)
        .post(`/api/v1/billing/invoices/${paidInvoiceId}/returns`)
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branch2Id.toString()) // Different branch header
        .set("Idempotency-Key", `RETURN-WRONG-BRANCH-${paidInvoiceId}`)
        .send({
          items: [{ lineId: productLineId.toString(), quantity: 1, acceptPhysicalRestock: true }],
          refundPaymentMethod: "cash",
          reason: "Cross-branch return attempt",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/branch/i);
    });

    it("rejects adding a foreign organization's product to checkout (cross-tenant isolation)", async () => {
      const crossOrgRes = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          customerId: customerId.toString(),
          productLines: [{ productId: foreignProduct._id.toString(), quantity: 1 }],
        });

      expect(crossOrgRes.status).toBe(404);
      expect(crossOrgRes.body.message).toMatch(/Product not found/i);
    });
  });

  describe("8. Duplicate Payment Gateway Callbacks & Idempotency", () => {
    it("handles duplicate payment submissions idempotently without duplicate stock deductions", async () => {
      // 1. Create walk-in draft invoice
      const invRes = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          customerId: customerId.toString(),
          productLines: [{ productId: retailProduct._id.toString(), quantity: 1 }],
        });
      expect(invRes.status).toBe(201);
      const testInvoiceId = invRes.body.data._id;

      // Finalize invoice
      await request(app)
        .post(`/api/v1/billing/invoices/${testInvoiceId}/finalize`)
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .send();

      const idempotencyKey = `gw_callback_${testInvoiceId}_${Date.now()}`;

      // 2. Initial payment callback
      const pay1 = await request(app)
        .post(`/api/v1/billing/invoices/${testInvoiceId}/payments`)
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          amount: 850,
          paymentMethod: "card",
          idempotencyKey,
        });
      expect([200, 201]).toContain(pay1.status);

      // Verify stock was deducted exactly once (e.g. from 4 to 3)
      let balance = await StockBalance.findOne({ organizationId: orgId, branchId, productId: retailProduct._id });
      expect(balance.onHand).toBe(3);

      const movements1 = await StockMovement.find({
        "reference.entityId": testInvoiceId,
        movementType: "pos_sale",
      });
      expect(movements1).toHaveLength(1);

      // 3. Duplicate payment callback with identical idempotencyKey
      const pay2 = await request(app)
        .post(`/api/v1/billing/invoices/${testInvoiceId}/payments`)
        .set("Authorization", `Bearer ${token}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          amount: 850,
          paymentMethod: "card",
          idempotencyKey,
        });

      // Returns 200 with idempotent replay flag
      expect(pay2.status).toBe(200);
      expect(pay2.body.data.isIdempotentReplay).toBe(true);

      // Verify stock was NOT deducted again (still 3)
      balance = await StockBalance.findOne({ organizationId: orgId, branchId, productId: retailProduct._id });
      expect(balance.onHand).toBe(3);

      // Verify movements count is still exactly 1
      const movements2 = await StockMovement.find({
        "reference.entityId": testInvoiceId,
        movementType: "pos_sale",
      });
      expect(movements2).toHaveLength(1);
    });
  });
});
