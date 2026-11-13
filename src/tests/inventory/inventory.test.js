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
import { AuditLog, AUDIT_ACTIONS } from "../../../src/models/audit/auditLog.model.js";

jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");

describe("Inventory MVP Foundation Suite", () => {
  jest.setTimeout(45000);

  let orgAId, orgBId;
  let branchA1Id, branchA2Id, branchB1Id;
  let managerTokenA, staffTokenA, noPermTokenA, managerTokenB;
  let managerUserA, staffUserA, noPermUserA, managerUserB;
  let shampooProduct, serumProduct;

  const createAuthToken = (user) => {
    return jwt.sign(
      {
        id: user._id.toString(),
        userId: user._id.toString(),
        email: user.email,
        role: user.role.toString(),
        organizationId: user.organizationId.toString()
      },
      env.JWT_SECRET,
      { expiresIn: "1h" }
    );
  };

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    const testUri = getIsolatedTestMongoUri("checkout_queue_test");
    await mongoose.connect(testUri);
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    // Clean collections
    await Product.deleteMany({});
    await StockBalance.deleteMany({});
    await StockMovement.deleteMany({});
    await AuditLog.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Permission.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});

    // Setup Organizations
    const orgA = await Organization.create({
      name: "Salon Org A",
      slug: "salon-org-a",
      email: "org-a@example.com"
    });
    orgAId = orgA._id;

    const orgB = await Organization.create({
      name: "Salon Org B",
      slug: "salon-org-b",
      email: "org-b@example.com"
    });
    orgBId = orgB._id;

    // Setup Branches
    const branchA1 = await Branch.create({
      organizationId: orgAId,
      name: "Branch A1 Downtown",
      branchCode: "BA1",
      city: "Downtown"
    });
    branchA1Id = branchA1._id;

    const branchA2 = await Branch.create({
      organizationId: orgAId,
      name: "Branch A2 Uptown",
      branchCode: "BA2",
      city: "Uptown"
    });
    branchA2Id = branchA2._id;

    const branchB1 = await Branch.create({
      organizationId: orgBId,
      name: "Branch B1 Metropolis",
      branchCode: "BB1",
      city: "Metropolis"
    });
    branchB1Id = branchB1._id;

    // Permissions
    const permView = await Permission.create({
      name: "inventory.view",
      module: "Inventory",
      action: "View",
      description: "Monitor stock counts and movements."
    });
    const permConsume = await Permission.create({
      name: "inventory.consume",
      module: "Inventory",
      action: "Log Consumption",
      description: "Log internal product consumption."
    });
    const permAdjust = await Permission.create({
      name: "inventory.adjust",
      module: "Inventory",
      action: "Adjust",
      description: "Adjust inventory counts."
    });
    const permTransfer = await Permission.create({
      name: "inventory.transfer",
      module: "Inventory",
      action: "Transfer",
      description: "Transfer stock between branches."
    });

    // Roles for Org A
    const managerRole = await Role.create({
      organizationId: orgAId,
      name: "Inventory Manager",
      permissions: [permView._id, permConsume._id, permAdjust._id, permTransfer._id]
    });

    const staffRole = await Role.create({
      organizationId: orgAId,
      name: "Stylist",
      permissions: [permView._id, permConsume._id]
    });

    const noPermRole = await Role.create({
      organizationId: orgAId,
      name: "Trainee",
      permissions: []
    });

    // Roles for Org B
    const managerRoleB = await Role.create({
      organizationId: orgBId,
      name: "Inventory Manager B",
      permissions: [permView._id, permConsume._id, permAdjust._id, permTransfer._id]
    });

    // Users
    managerUserA = await User.create({
      name: "Manager A",
      email: `manager_${Date.now()}@test.com`,
      phone: "+919999990001",
      password: "Password@123",
      role: managerRole._id,
      organizationId: orgAId,
      status: "active",
      hasOrgWideAccess: true,
      branchAccess: [{ branchId: branchA1Id, branchName: "Branch A1 Downtown", isActive: true }]
    });
    managerTokenA = createAuthToken(managerUserA);

    staffUserA = await User.create({
      name: "Staff A",
      email: `staff_${Date.now()}@test.com`,
      phone: "+919999990002",
      password: "Password@123",
      role: staffRole._id,
      organizationId: orgAId,
      status: "active",
      hasOrgWideAccess: false,
      branchAccess: [{ branchId: branchA1Id, branchName: "Branch A1 Downtown", isActive: true }]
    });
    staffTokenA = createAuthToken(staffUserA);

    noPermUserA = await User.create({
      name: "Trainee A",
      email: `trainee_${Date.now()}@test.com`,
      phone: "+919999990003",
      password: "Password@123",
      role: noPermRole._id,
      organizationId: orgAId,
      status: "active",
      hasOrgWideAccess: false,
      branchAccess: [{ branchId: branchA1Id, branchName: "Branch A1 Downtown", isActive: true }]
    });
    noPermTokenA = createAuthToken(noPermUserA);

    managerUserB = await User.create({
      name: "Manager B",
      email: `manager_b_${Date.now()}@test.com`,
      phone: "+919999990004",
      password: "Password@123",
      role: managerRoleB._id,
      organizationId: orgBId,
      status: "active",
      hasOrgWideAccess: true,
      branchAccess: [{ branchId: branchB1Id, branchName: "Branch B1 Metropolis", isActive: true }]
    });
    managerTokenB = createAuthToken(managerUserB);

    // Initial products
    shampooProduct = await Product.create({
      organizationId: orgAId,
      name: "Professional Keratin Shampoo",
      sku: "KER-SHAMP-500",
      category: "Hair Care",
      usageType: "both",
      stockUnit: "bottle",
      costPrice: 400,
      sellingPrice: 800,
      reorderLevel: 5
    });

    serumProduct = await Product.create({
      organizationId: orgAId,
      name: "Argan Hair Serum",
      sku: "ARG-SERUM-100",
      category: "Hair Care",
      usageType: "salon_consumption",
      stockUnit: "ml",
      costPrice: 50,
      sellingPrice: 0,
      reorderLevel: 100
    });
  });

  // 1. PRODUCT CATALOGUE & VALIDATION
  describe("1. Product Catalogue", () => {
    it("creates a product with valid SKU, usageType, and unit", async () => {
      const res = await request(app)
        .post("/api/v1/inventory/products")
        .set("Authorization", `Bearer ${managerTokenA}`)
        .send({
          name: "Organic Conditioner",
          sku: "org-cond-250",
          category: "Hair Care",
          usageType: "retail_sale",
          stockUnit: "bottle",
          costPrice: 200,
          sellingPrice: 450,
          reorderLevel: 10
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.sku).toBe("ORG-COND-250");
      expect(res.body.data.usageType).toBe("retail_sale");
    });

    it("enforces unique SKU per organization", async () => {
      const res = await request(app)
        .post("/api/v1/inventory/products")
        .set("Authorization", `Bearer ${managerTokenA}`)
        .send({
          name: "Duplicate Keratin Shampoo",
          sku: "KER-SHAMP-500",
          category: "Hair Care",
          usageType: "both",
          stockUnit: "bottle"
        });

      expect(res.status).toBe(409);
      expect(res.body.message).toContain("already exists");
    });

    it("rejects unauthorized user creating product", async () => {
      const res = await request(app)
        .post("/api/v1/inventory/products")
        .set("Authorization", `Bearer ${noPermTokenA}`)
        .send({
          name: "Unauthorized Product",
          sku: "UNAUTH-1",
          category: "Care",
          usageType: "both",
          stockUnit: "piece"
        });

      expect(res.status).toBe(403);
    });

    it("lists products isolated to authenticated organization", async () => {
      // Product in Org B
      await Product.create({
        organizationId: orgBId,
        name: "Org B Exclusive Gel",
        sku: "GEL-B-100",
        category: "Styling",
        usageType: "both",
        stockUnit: "piece"
      });

      const res = await request(app)
        .get("/api/v1/inventory/products")
        .set("Authorization", `Bearer ${managerTokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(2);
      expect(res.body.data.some((p) => p.sku === "GEL-B-100")).toBe(false);
    });
  });

  // 2. STOCK ADJUSTMENT & UNIT PRECISION
  describe("2. Stock Adjustment and Unit Precision", () => {
    it("successfully adjusts stock and creates immutable movement", async () => {
      const res = await request(app)
        .post("/api/v1/inventory/adjust")
        .set("Authorization", `Bearer ${managerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          branchId: branchA1Id.toString(),
          productId: shampooProduct._id.toString(),
          quantityDelta: 25,
          reason: "Initial Stock Inward",
          notes: "Shipment batch arrived"
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.balance.onHand).toBe(25);
      expect(res.body.data.movement.movementType).toBe("adjustment");
      expect(res.body.data.movement.quantityDelta).toBe(25);
      expect(res.body.data.movement.balanceAfter).toBe(25);

      // Verify Audit Log
      const audit = await AuditLog.findOne({
        action: AUDIT_ACTIONS.INVENTORY_ADJUSTED
      });
      expect(audit).not.toBeNull();
    });

    it("allows up to 3 decimal places for continuous units (ml)", async () => {
      const res = await request(app)
        .post("/api/v1/inventory/adjust")
        .set("Authorization", `Bearer ${managerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          branchId: branchA1Id.toString(),
          productId: serumProduct._id.toString(),
          quantityDelta: 150.125,
          reason: "Bulk liquid restock"
        });

      expect(res.status).toBe(200);
      expect(res.body.data.balance.onHand).toBe(150.125);
    });

    it("rejects quantities exceeding 3 decimal places", async () => {
      const res = await request(app)
        .post("/api/v1/inventory/adjust")
        .set("Authorization", `Bearer ${managerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          branchId: branchA1Id.toString(),
          productId: serumProduct._id.toString(),
          quantityDelta: 10.1234,
          reason: "Excess precision"
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("cannot exceed 3 decimal places");
    });

    it("strictly rejects fractional quantities for discrete units (bottle/piece)", async () => {
      const res = await request(app)
        .post("/api/v1/inventory/adjust")
        .set("Authorization", `Bearer ${managerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          branchId: branchA1Id.toString(),
          productId: shampooProduct._id.toString(),
          quantityDelta: 2.5,
          reason: "Partial bottle attempt"
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("Discrete unit 'bottle' requires integer quantity");
    });

    it("rejects adjustments that would drive stock below zero", async () => {
      // Current onHand is 0
      const res = await request(app)
        .post("/api/v1/inventory/adjust")
        .set("Authorization", `Bearer ${managerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          branchId: branchA1Id.toString(),
          productId: shampooProduct._id.toString(),
          quantityDelta: -5,
          reason: "Damaged bottles"
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("Cannot adjust stock below zero");
    });
  });

  // 3. MANUAL SALON CONSUMPTION & IDEMPOTENCY
  describe("3. Manual Salon Consumption", () => {
    beforeEach(async () => {
      // Stock 500ml serum at Branch A1
      await request(app)
        .post("/api/v1/inventory/adjust")
        .set("Authorization", `Bearer ${managerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          branchId: branchA1Id.toString(),
          productId: serumProduct._id.toString(),
          quantityDelta: 500,
          reason: "Initial supply"
        });
    });

    it("successfully deducts stock and records movement", async () => {
      const res = await request(app)
        .post("/api/v1/inventory/consume")
        .set("Authorization", `Bearer ${staffTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          branchId: branchA1Id.toString(),
          productId: serumProduct._id.toString(),
          quantity: 25.5,
          notes: "Used for deep conditioning service"
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.balance.onHand).toBe(474.5);
      expect(res.body.data.movement.movementType).toBe("service_consumption");
      expect(res.body.data.movement.quantityDelta).toBe(-25.5);
      expect(res.body.data.movement.balanceAfter).toBe(474.5);
    });

    it("rejects consumption when stock is insufficient without mutating balance", async () => {
      const res = await request(app)
        .post("/api/v1/inventory/consume")
        .set("Authorization", `Bearer ${staffTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          branchId: branchA1Id.toString(),
          productId: serumProduct._id.toString(),
          quantity: 999,
          notes: "Excessive consumption"
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("Insufficient stock");

      const balance = await StockBalance.findOne({
        branchId: branchA1Id,
        productId: serumProduct._id
      });
      expect(balance.onHand).toBe(500);
    });

    it("rejects consumption for products restricted to retail_sale", async () => {
      const retailOnlyProduct = await Product.create({
        organizationId: orgAId,
        name: "Retail Perfume",
        sku: "RET-PERF-1",
        category: "Fragrance",
        usageType: "retail_sale",
        stockUnit: "bottle"
      });

      const res = await request(app)
        .post("/api/v1/inventory/consume")
        .set("Authorization", `Bearer ${staffTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          branchId: branchA1Id.toString(),
          productId: retailOnlyProduct._id.toString(),
          quantity: 1
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("is not designated for salon consumption");
    });

    it("protects against duplicate requests via idempotency key", async () => {
      const idempotencyKey = "unique-consume-tx-001";

      const firstReq = await request(app)
        .post("/api/v1/inventory/consume")
        .set("Authorization", `Bearer ${staffTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .set("Idempotency-Key", idempotencyKey)
        .send({
          branchId: branchA1Id.toString(),
          productId: serumProduct._id.toString(),
          quantity: 20
        });

      expect(firstReq.status).toBe(200);
      expect(firstReq.body.data.idempotentReplay).toBe(false);
      expect(firstReq.body.data.balance.onHand).toBe(480);

      // Replay identical request
      const secondReq = await request(app)
        .post("/api/v1/inventory/consume")
        .set("Authorization", `Bearer ${staffTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .set("Idempotency-Key", idempotencyKey)
        .send({
          branchId: branchA1Id.toString(),
          productId: serumProduct._id.toString(),
          quantity: 20
        });

      expect(secondReq.status).toBe(200);
      expect(secondReq.body.data.idempotentReplay).toBe(true);

      // Verify stock was deducted exactly ONCE
      const balance = await StockBalance.findOne({
        branchId: branchA1Id,
        productId: serumProduct._id
      });
      expect(balance.onHand).toBe(480);
    });
  });

  // 4. INTER-BRANCH TRANSFER
  describe("4. Inter-Branch Transfer", () => {
    beforeEach(async () => {
      // Stock 10 bottles at Branch A1
      await request(app)
        .post("/api/v1/inventory/adjust")
        .set("Authorization", `Bearer ${managerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          branchId: branchA1Id.toString(),
          productId: shampooProduct._id.toString(),
          quantityDelta: 10,
          reason: "Branch A1 initial stock"
        });
    });

    it("atomically transfers stock between branches creating dual movements", async () => {
      const res = await request(app)
        .post("/api/v1/inventory/transfer")
        .set("Authorization", `Bearer ${managerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          fromBranchId: branchA1Id.toString(),
          toBranchId: branchA2Id.toString(),
          productId: shampooProduct._id.toString(),
          quantity: 4,
          notes: "Transfer urgent stock to Uptown"
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify balances at both branches
      const sourceBal = await StockBalance.findOne({ branchId: branchA1Id, productId: shampooProduct._id });
      const destBal = await StockBalance.findOne({ branchId: branchA2Id, productId: shampooProduct._id });

      expect(sourceBal.onHand).toBe(6);
      expect(destBal.onHand).toBe(4);

      // Verify dual movements
      const outMove = await StockMovement.findOne({ branchId: branchA1Id, movementType: "transfer_out" });
      const inMove = await StockMovement.findOne({ branchId: branchA2Id, movementType: "transfer_in" });

      expect(outMove.quantityDelta).toBe(-4);
      expect(outMove.balanceAfter).toBe(6);
      expect(inMove.quantityDelta).toBe(4);
      expect(inMove.balanceAfter).toBe(4);
    });

    it("rejects transfer when source branch has insufficient stock", async () => {
      const res = await request(app)
        .post("/api/v1/inventory/transfer")
        .set("Authorization", `Bearer ${managerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          fromBranchId: branchA1Id.toString(),
          toBranchId: branchA2Id.toString(),
          productId: shampooProduct._id.toString(),
          quantity: 20
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("Insufficient stock at source branch");

      // Verify no changes at either branch
      const sourceBal = await StockBalance.findOne({ branchId: branchA1Id, productId: shampooProduct._id });
      expect(sourceBal.onHand).toBe(10);
    });

    it("rejects transfer between same branch", async () => {
      const res = await request(app)
        .post("/api/v1/inventory/transfer")
        .set("Authorization", `Bearer ${managerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          fromBranchId: branchA1Id.toString(),
          toBranchId: branchA1Id.toString(),
          productId: shampooProduct._id.toString(),
          quantity: 2
        });

      expect(res.status).toBe(400);
    });
  });

  // 5. ISOLATION & PERMISSION DENIAL
  describe("5. Permissions and Tenant Isolation", () => {
    it("denies access when user lacks required permission", async () => {
      const res = await request(app)
        .post("/api/v1/inventory/adjust")
        .set("Authorization", `Bearer ${staffTokenA}`) // Staff has consume & view, but NOT adjust
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          branchId: branchA1Id.toString(),
          productId: shampooProduct._id.toString(),
          quantityDelta: 5,
          reason: "Unauthorized adjustment attempt"
        });

      expect(res.status).toBe(403);
    });

    it("prevents cross-organization access to products and balances", async () => {
      // Manager B from Org B attempts to consume Org A's product
      const res = await request(app)
        .post("/api/v1/inventory/consume")
        .set("Authorization", `Bearer ${managerTokenB}`)
        .set("X-Branch-Id", branchB1Id.toString())
        .send({
          branchId: branchB1Id.toString(),
          productId: shampooProduct._id.toString(),
          quantity: 1
        });

      expect(res.status).toBe(404);
      expect(res.body.message).toContain("Product not found");
    });
  });
});
