import dns from "dns";
import { describe, expect, it, beforeEach, afterEach, beforeAll, afterAll, jest } from "@jest/globals";
import request from "supertest";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import app from "../../../app.mjs";
import { env } from "../../../src/config/env.js";
import { redis } from "../../../src/utils/redis.js";
import "../../database/db.js";
import { getIsolatedTestMongoUri } from "../testSetup.js";

try {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch (_) {}

import { Organization } from "../../../src/models/organizations/organization.model.js";
import { Branch } from "../../../src/models/branches/branch.model.js";
import { Role } from "../../../src/models/roles/role.model.js";
import { Permission } from "../../../src/models/permissions/permission.model.js";
import { User } from "../../../src/models/users/user.model.js";
import { Product } from "../../../src/models/inventory/product.model.js";
import { StockBalance } from "../../../src/models/inventory/stockBalance.model.js";
import { StockMovement } from "../../../src/models/inventory/stockMovement.model.js";
import { Supplier } from "../../../src/models/procurement/supplier.model.js";
import { PurchaseOrder } from "../../../src/models/procurement/purchaseOrder.model.js";
import { GoodsReceiptNote } from "../../../src/models/procurement/goodsReceiptNote.model.js";
import { SupplierInvoice } from "../../../src/models/procurement/supplierInvoice.model.js";
import { SupplierPayment } from "../../../src/models/procurement/supplierPayment.model.js";

jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");

describe("Procurement & Supplier Management Backend Suite", () => {
  jest.setTimeout(45000);

  let orgAId, orgBId;
  let branchA1Id, branchB1Id;
  let managerTokenA, unauthorizedTokenA, managerTokenB;
  let managerUserA, unauthorizedUserA, managerUserB;
  let shampooProduct, conditionerProduct;
  let supplierA;

  const createAuthToken = (user) => {
    return jwt.sign(
      {
        id: user._id.toString(),
        userId: user._id.toString(),
        email: user.email,
        role: user.role.toString(),
        organizationId: user.organizationId.toString(),
      },
      env.JWT_SECRET,
      { expiresIn: "1h" }
    );
  };

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    const testUri = getIsolatedTestMongoUri("procurement_test");
    await mongoose.connect(testUri);
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    // Clean collections
    await Promise.all([
      Organization.deleteMany({}),
      Branch.deleteMany({}),
      Role.deleteMany({}),
      Permission.deleteMany({}),
      User.deleteMany({}),
      Product.deleteMany({}),
      StockBalance.deleteMany({}),
      StockMovement.deleteMany({}),
      Supplier.deleteMany({}),
      PurchaseOrder.deleteMany({}),
      GoodsReceiptNote.deleteMany({}),
      SupplierInvoice.deleteMany({}),
      SupplierPayment.deleteMany({}),
    ]);

    // Create Organizations
    const orgA = await Organization.create({ name: "Glamour Org A" });
    const orgB = await Organization.create({ name: "Competitor Org B" });
    orgAId = orgA._id;
    orgBId = orgB._id;

    // Create Branches
    const branchA1 = await Branch.create({
      organizationId: orgAId,
      name: "Branch Central",
      branchCode: "BC01",
    });
    const branchB1 = await Branch.create({
      organizationId: orgBId,
      name: "Branch West",
      branchCode: "BW01",
    });
    branchA1Id = branchA1._id;
    branchB1Id = branchB1._id;

    // Create Permissions
    const permNames = [
      "procurement.suppliers.view",
      "procurement.suppliers.manage",
      "procurement.orders.view",
      "procurement.orders.create",
      "procurement.orders.update",
      "procurement.invoices.manage",
      "procurement.payments.manage",
      "inventory.view",
    ];
    const permDocs = await Promise.all(
      permNames.map((name) =>
        Permission.create({
          name,
          module: "Procurement",
          action: "Manage",
          description: name,
        })
      )
    );
    const permIds = permDocs.map((p) => p._id);

    // Create Roles
    const managerRoleA = await Role.create({
      name: "manager",
      organizationId: orgAId,
      permissions: permIds,
    });
    const managerRoleB = await Role.create({
      name: "manager",
      organizationId: orgBId,
      permissions: permIds,
    });
    const emptyRole = await Role.create({
      name: "viewer",
      organizationId: orgAId,
      permissions: [],
    });

    // Create Users
    managerUserA = await User.create({
      organizationId: orgAId,
      name: "Manager Alice",
      email: "manager.alice@glamour.com",
      phone: "+919876543211",
      password: "password123",
      role: managerRoleA._id,
      branchAccess: [{ branchId: branchA1Id, branchName: "Branch Central", isActive: true }],
      status: "active",
    });
    unauthorizedUserA = await User.create({
      organizationId: orgAId,
      name: "Unauthorized Bob",
      email: "bob@glamour.com",
      phone: "+919876543212",
      password: "password123",
      role: emptyRole._id,
      branchAccess: [{ branchId: branchA1Id, branchName: "Branch Central", isActive: true }],
      status: "active",
    });
    managerUserB = await User.create({
      organizationId: orgBId,
      name: "Manager Eve",
      email: "manager.eve@competitor.com",
      phone: "+919876543213",
      password: "password123",
      role: managerRoleB._id,
      branchAccess: [{ branchId: branchB1Id, branchName: "Branch West", isActive: true }],
      status: "active",
    });

    managerTokenA = createAuthToken(managerUserA);
    unauthorizedTokenA = createAuthToken(unauthorizedUserA);
    managerTokenB = createAuthToken(managerUserB);

    // Create Products
    shampooProduct = await Product.create({
      organizationId: orgAId,
      name: "L'Oreal Professional Shampoo",
      sku: "LOR-SHA-01",
      category: "Haircare",
      usageType: "both",
      stockUnit: "bottle",
      costPrice: 500,
      sellingPrice: 850,
      status: "active",
    });

    conditionerProduct = await Product.create({
      organizationId: orgAId,
      name: "Keratin Treatment Mask",
      sku: "KER-MAS-01",
      category: "Haircare",
      usageType: "salon_consumption",
      stockUnit: "box",
      costPrice: 1200,
      sellingPrice: 0,
      status: "active",
    });

    // Create Initial Supplier
    supplierA = await Supplier.create({
      organizationId: orgAId,
      name: "L'Oreal Direct Distributors",
      contactPerson: "Rahul Verma",
      phone: "9876543210",
      email: "orders@loreal-dist.com",
      paymentTermsDays: 15,
      status: "active",
    });
  });

  // -------------------------------------------------------------
  // 1. Supplier CRUD & Tenant Isolation
  // -------------------------------------------------------------
  describe("Supplier Management", () => {
    it("creates a new supplier with organization-wide scoping", async () => {
      const res = await request(app)
        .post("/api/v1/procurement/suppliers")
        .set("Authorization", `Bearer ${managerTokenA}`)
        .send({
          name: "Schwarzkopf Pro Supply",
          contactPerson: "Priya Sharma",
          phone: "9123456780",
          email: "priya@schwarzkopf.com",
          paymentTermsDays: 30,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.name).toBe("Schwarzkopf Pro Supply");
      expect(res.body.data.organizationId).toBe(orgAId.toString());
    });

    it("denies access to create supplier without procurement.suppliers.manage", async () => {
      const res = await request(app)
        .post("/api/v1/procurement/suppliers")
        .set("Authorization", `Bearer ${unauthorizedTokenA}`)
        .send({
          name: "Unauthorized Supplier",
        });

      expect(res.status).toBe(403);
    });

    it("enforces strict tenant isolation: Org B cannot see Org A suppliers", async () => {
      const res = await request(app)
        .get("/api/v1/procurement/suppliers")
        .set("Authorization", `Bearer ${managerTokenB}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
    });

    it("updates supplier details successfully", async () => {
      const res = await request(app)
        .put(`/api/v1/procurement/suppliers/${supplierA._id}`)
        .set("Authorization", `Bearer ${managerTokenA}`)
        .send({
          paymentTermsDays: 45,
          contactPerson: "Rahul V. Updated",
        });

      expect(res.status).toBe(200);
      expect(res.body.data.paymentTermsDays).toBe(45);
      expect(res.body.data.contactPerson).toBe("Rahul V. Updated");
    });
  });

  // -------------------------------------------------------------
  // 2. Purchase Orders Workflow
  // -------------------------------------------------------------
  describe("Purchase Orders Workflow", () => {
    it("creates a purchase order with domain assignment validation", async () => {
      const res = await request(app)
        .post("/api/v1/procurement/orders")
        .set("Authorization", `Bearer ${managerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          supplierId: supplierA._id.toString(),
          notes: "Monthly restock",
          items: [
            {
              productId: shampooProduct._id.toString(),
              targetDomain: "retail_products",
              orderedQuantity: 10,
              unitCostPrice: 500,
            },
            {
              productId: conditionerProduct._id.toString(),
              targetDomain: "salon_consumables",
              orderedQuantity: 5,
              unitCostPrice: 1200,
            },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.data.poNumber).toMatch(/^PO-/);
      expect(res.body.data.status).toBe("draft");
      expect(res.body.data.totalAmount).toBe(10 * 500 + 5 * 1200); // 11000
    });

    it("rejects invalid target domain assignment for restricted product", async () => {
      // Conditioner is salon_consumption only, cannot be retail_products
      const res = await request(app)
        .post("/api/v1/procurement/orders")
        .set("Authorization", `Bearer ${managerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          supplierId: supplierA._id.toString(),
          items: [
            {
              productId: conditionerProduct._id.toString(),
              targetDomain: "retail_products",
              orderedQuantity: 2,
              unitCostPrice: 1200,
            },
          ],
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("cannot be assigned to Retail Products domain");
    });

    it("transitions PO status from draft to ordered", async () => {
      const po = await PurchaseOrder.create({
        organizationId: orgAId,
        branchId: branchA1Id,
        poNumber: "PO-TEST-001",
        supplierId: supplierA._id,
        items: [
          {
            productId: shampooProduct._id,
            targetDomain: "retail_products",
            orderedQuantity: 10,
            receivedQuantity: 0,
            unitCostPrice: 500,
            lineTotal: 5000,
          },
        ],
        totalAmount: 5000,
        status: "draft",
        createdBy: managerUserA._id,
      });

      const res = await request(app)
        .patch(`/api/v1/procurement/orders/${po._id}/status`)
        .set("Authorization", `Bearer ${managerTokenA}`)
        .send({ status: "ordered" });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("ordered");
      expect(res.body.data.orderedAt).toBeTruthy();
    });
  });

  // -------------------------------------------------------------
  // 3. Goods Receiving (GRN) & Stock Mutation
  // -------------------------------------------------------------
  describe("Goods Receiving & Stock Mutation", () => {
    it("receives goods partially, updates PO status, increments StockBalance and writes StockMovement", async () => {
      const po = await PurchaseOrder.create({
        organizationId: orgAId,
        branchId: branchA1Id,
        poNumber: "PO-RECV-001",
        supplierId: supplierA._id,
        items: [
          {
            productId: shampooProduct._id,
            targetDomain: "retail_products",
            orderedQuantity: 20,
            receivedQuantity: 0,
            unitCostPrice: 500,
            lineTotal: 10000,
          },
        ],
        totalAmount: 10000,
        status: "ordered",
        createdBy: managerUserA._id,
      });

      // Partial receipt of 8 units
      const res = await request(app)
        .post(`/api/v1/procurement/orders/${po._id}/receive`)
        .set("Authorization", `Bearer ${managerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          notes: "First batch received by courier",
          items: [
            {
              productId: shampooProduct._id.toString(),
              receivedQuantity: 8,
            },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.data.purchaseOrder.status).toBe("partially_received");
      expect(res.body.data.purchaseOrder.items[0].receivedQuantity).toBe(8);

      // Verify StockBalance was incremented
      const balance = await StockBalance.findOne({
        organizationId: orgAId,
        branchId: branchA1Id,
        productId: shampooProduct._id,
      });
      expect(balance).toBeTruthy();
      expect(balance.onHand).toBe(8);

      // Verify StockMovement ledger
      const movement = await StockMovement.findOne({
        organizationId: orgAId,
        branchId: branchA1Id,
        productId: shampooProduct._id,
        movementType: "purchase_in",
      });
      expect(movement).toBeTruthy();
      expect(movement.quantityDelta).toBe(8);
      expect(movement.balanceAfter).toBe(8);
      expect(movement.stockDomain).toBe("retail_products");
      expect(movement.reference.entityType).toBe("PurchaseOrder");
      expect(movement.reference.identifier).toBe(po.poNumber);
    });

    it("prevents over-receiving beyond ordered quantity", async () => {
      const po = await PurchaseOrder.create({
        organizationId: orgAId,
        branchId: branchA1Id,
        poNumber: "PO-OVER-001",
        supplierId: supplierA._id,
        items: [
          {
            productId: shampooProduct._id,
            targetDomain: "retail_products",
            orderedQuantity: 5,
            receivedQuantity: 3,
            unitCostPrice: 500,
            lineTotal: 2500,
          },
        ],
        totalAmount: 2500,
        status: "partially_received",
        createdBy: managerUserA._id,
      });

      // Try receiving 4 when only 2 remain
      const res = await request(app)
        .post(`/api/v1/procurement/orders/${po._id}/receive`)
        .set("Authorization", `Bearer ${managerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          items: [
            {
              productId: shampooProduct._id.toString(),
              receivedQuantity: 4,
            },
          ],
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("Remaining quantity for product is 2");
    });
  });

  // -------------------------------------------------------------
  // 4. Supplier Invoices & Payments Workflow
  // -------------------------------------------------------------
  describe("Supplier Invoices & Payments", () => {
    it("creates an invoice, records partial payment and marks as paid upon completion", async () => {
      // Create Invoice
      const invRes = await request(app)
        .post("/api/v1/procurement/invoices")
        .set("Authorization", `Bearer ${managerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          supplierId: supplierA._id.toString(),
          supplierInvoiceRef: "INV-LOREAL-8899",
          totalAmount: 10000,
          dueDate: new Date(Date.now() + 15 * 86400000).toISOString(),
        });

      expect(invRes.status).toBe(201);
      const invoiceId = invRes.body.data.id;
      expect(invRes.body.data.status).toBe("unpaid");

      // Record First Partial Payment of 4000
      const pay1Res = await request(app)
        .post("/api/v1/procurement/payments")
        .set("Authorization", `Bearer ${managerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          supplierId: supplierA._id.toString(),
          supplierInvoiceId: invoiceId,
          amount: 4000,
          paymentMethod: "bank_transfer",
          referenceNote: "NEFT-UTR-123456",
        });

      expect(pay1Res.status).toBe(201);
      expect(pay1Res.body.data.invoice.status).toBe("partially_paid");
      expect(pay1Res.body.data.invoice.amountPaid).toBe(4000);

      // Record Final Payment of 6000
      const pay2Res = await request(app)
        .post("/api/v1/procurement/payments")
        .set("Authorization", `Bearer ${managerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          supplierId: supplierA._id.toString(),
          supplierInvoiceId: invoiceId,
          amount: 6000,
          paymentMethod: "bank_transfer",
          referenceNote: "NEFT-UTR-789012",
        });

      expect(pay2Res.status).toBe(201);
      expect(pay2Res.body.data.invoice.status).toBe("paid");
      expect(pay2Res.body.data.invoice.amountPaid).toBe(10000);
    });

    it("rejects payment exceeding outstanding balance", async () => {
      const inv = await SupplierInvoice.create({
        organizationId: orgAId,
        branchId: branchA1Id,
        invoiceNumber: "SINV-EXCEED-001",
        supplierId: supplierA._id,
        totalAmount: 5000,
        amountPaid: 3000,
        status: "partially_paid",
        dueDate: new Date(),
        createdBy: managerUserA._id,
      });

      const res = await request(app)
        .post("/api/v1/procurement/payments")
        .set("Authorization", `Bearer ${managerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          supplierId: supplierA._id.toString(),
          supplierInvoiceId: inv._id.toString(),
          amount: 2500, // exceeds remaining 2000
          paymentMethod: "cash",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("exceeds outstanding invoice balance (2000)");
    });
  });

  // -------------------------------------------------------------
  // 5. Procurement Dashboard Overview
  // -------------------------------------------------------------
  describe("Procurement Overview Metrics", () => {
    it("returns operational summary cards data", async () => {
      const res = await request(app)
        .get("/api/v1/procurement/overview")
        .set("Authorization", `Bearer ${managerTokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("activeSuppliersCount");
      expect(res.body.data).toHaveProperty("draftOrdersCount");
      expect(res.body.data).toHaveProperty("awaitingDeliveryCount");
      expect(res.body.data).toHaveProperty("partiallyReceivedCount");
      expect(res.body.data).toHaveProperty("unpaidInvoicesCount");
      expect(res.body.data).toHaveProperty("outstandingSupplierBalance");
    });
  });
});

