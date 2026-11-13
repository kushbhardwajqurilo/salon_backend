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
import { AuditLog } from "../../../src/models/audit/auditLog.model.js";
import { stockMovementRepository } from "../../../src/repositories/inventory/stockMovement.repository.js";

jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");

describe("Inventory MVP High-Risk Integrity & Concurrency Suite", () => {
  jest.setTimeout(45000);

  let orgAId;
  let branchA1Id, branchA2Id;
  let singleBranchUserToken;
  let managerToken;
  let testProduct;

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
    await Product.deleteMany({});
    await StockBalance.deleteMany({});
    await StockMovement.deleteMany({});
    await AuditLog.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Permission.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});

    const orgA = await Organization.create({
      name: "Integrity Org",
      slug: "integrity-org",
      email: "integrity@example.com"
    });
    orgAId = orgA._id;

    const b1 = await Branch.create({
      organizationId: orgAId,
      name: "Source Branch A1",
      branchCode: "SBA1",
      city: "Downtown"
    });
    branchA1Id = b1._id;

    const b2 = await Branch.create({
      organizationId: orgAId,
      name: "Dest Branch A2",
      branchCode: "DBA2",
      city: "Uptown"
    });
    branchA2Id = b2._id;

    const permView = await Permission.create({
      name: "inventory.view",
      module: "Inventory",
      action: "View",
      description: "View inventory"
    });
    const permConsume = await Permission.create({
      name: "inventory.consume",
      module: "Inventory",
      action: "Log Consumption",
      description: "Log consumption"
    });
    const permAdjust = await Permission.create({
      name: "inventory.adjust",
      module: "Inventory",
      action: "Adjust",
      description: "Adjust inventory"
    });
    const permTransfer = await Permission.create({
      name: "inventory.transfer",
      module: "Inventory",
      action: "Transfer",
      description: "Transfer stock"
    });

    const managerRole = await Role.create({
      organizationId: orgAId,
      name: "Manager Role",
      permissions: [permView._id, permConsume._id, permAdjust._id, permTransfer._id]
    });

    const singleBranchUser = await User.create({
      name: "Single Branch Staff",
      email: `single_${Date.now()}@test.com`,
      phone: "+919999991111",
      password: "Password@123",
      role: managerRole._id,
      organizationId: orgAId,
      status: "active",
      hasOrgWideAccess: false,
      branchAccess: [{ branchId: branchA1Id, branchName: "Source Branch A1", isActive: true }]
    });
    singleBranchUserToken = createAuthToken(singleBranchUser);

    const managerUser = await User.create({
      name: "Orgwide Manager",
      email: `mgr_${Date.now()}@test.com`,
      phone: "+919999992222",
      password: "Password@123",
      role: managerRole._id,
      organizationId: orgAId,
      status: "active",
      hasOrgWideAccess: true,
      branchAccess: [{ branchId: branchA1Id, branchName: "Source Branch A1", isActive: true }]
    });
    managerToken = createAuthToken(managerUser);

    testProduct = await Product.create({
      organizationId: orgAId,
      name: "Hair Mask 500ml",
      sku: "HM-500",
      category: "Hair Care",
      usageType: "salon_consumption",
      stockUnit: "ml",
      costPrice: 500,
      sellingPrice: 1200,
      reorderLevel: 50
    });
  });

  describe("1. Transfer Destination Authorization Enforcement", () => {
    it("rejects transfer when user is authorized for source branch but NOT destination branch", async () => {
      // Stock 200ml at Branch A1
      await request(app)
        .post("/api/v1/inventory/adjust")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          branchId: branchA1Id.toString(),
          productId: testProduct._id.toString(),
          quantityDelta: 200,
          reason: "Initial stock"
        });

      // User with branchAccess only to branchA1 attempts to transfer to branchA2
      const res = await request(app)
        .post("/api/v1/inventory/transfer")
        .set("Authorization", `Bearer ${singleBranchUserToken}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          fromBranchId: branchA1Id.toString(),
          toBranchId: branchA2Id.toString(),
          productId: testProduct._id.toString(),
          quantity: 50,
          notes: "Attempt unauthorized dest transfer"
        });

      expect(res.status).toBe(403);
      expect(res.body.message).toContain("Access denied");

      // Verify no stock mutated
      const sourceBal = await StockBalance.findOne({ branchId: branchA1Id, productId: testProduct._id });
      const destBal = await StockBalance.findOne({ branchId: branchA2Id, productId: testProduct._id });
      expect(sourceBal.onHand).toBe(200);
      expect(destBal).toBeNull();

      const movements = await StockMovement.find({ productId: testProduct._id, movementType: { $in: ["transfer_out", "transfer_in"] } });
      expect(movements.length).toBe(0);
    });
  });

  describe("2. Concurrent Over-Consumption Protection", () => {
    it("deducts only the available stock when two concurrent requests exceed balance", async () => {
      // Starting balance: 80ml
      await request(app)
        .post("/api/v1/inventory/adjust")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          branchId: branchA1Id.toString(),
          productId: testProduct._id.toString(),
          quantityDelta: 80,
          reason: "Baseline 80ml"
        });

      // Submit two concurrent consumption requests of 50ml each (total 100ml > 80ml available)
      const req1 = request(app)
        .post("/api/v1/inventory/consume")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .set("Idempotency-Key", `conc-c1-${Date.now()}`)
        .send({
          branchId: branchA1Id.toString(),
          productId: testProduct._id.toString(),
          quantity: 50,
          notes: "Concurrent req 1"
        });

      const req2 = request(app)
        .post("/api/v1/inventory/consume")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .set("Idempotency-Key", `conc-c2-${Date.now()}`)
        .send({
          branchId: branchA1Id.toString(),
          productId: testProduct._id.toString(),
          quantity: 50,
          notes: "Concurrent req 2"
        });

      const [res1, res2] = await Promise.all([req1, req2]);

      const statuses = [res1.status, res2.status].sort();
      // Exactly one must succeed (200) and one must be rejected (400)
      expect(statuses).toEqual([200, 400]);

      const successRes = res1.status === 200 ? res1 : res2;
      const failureRes = res1.status === 400 ? res1 : res2;

      expect(successRes.body.success).toBe(true);
      expect(failureRes.body.message).toContain("Insufficient stock");

      // Ending stock balance must be exactly 30ml (80 - 50) and never negative
      const endingBalance = await StockBalance.findOne({
        branchId: branchA1Id,
        productId: testProduct._id
      });
      expect(endingBalance.onHand).toBe(30);

      // Ledger must contain exactly 1 service_consumption movement
      const consumptionMovements = await StockMovement.find({
        branchId: branchA1Id,
        productId: testProduct._id,
        movementType: "service_consumption"
      });
      expect(consumptionMovements.length).toBe(1);
      expect(consumptionMovements[0].quantityDelta).toBe(-50);
      expect(consumptionMovements[0].balanceAfter).toBe(30);
    });
  });

  describe("3. ACID Transaction Rollback on Failure", () => {
    it("rolls back stock balance mutation if ledger entry write fails", async () => {
      // Starting balance: 100ml
      await request(app)
        .post("/api/v1/inventory/adjust")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          branchId: branchA1Id.toString(),
          productId: testProduct._id.toString(),
          quantityDelta: 100,
          reason: "Baseline 100ml"
        });

      // Simulate a ledger write failure by mocking stockMovementRepository.create to throw
      const originalCreate = stockMovementRepository.create;
      jest.spyOn(stockMovementRepository, "create").mockImplementationOnce(() => {
        throw new Error("Simulated Disk/DB Failure during StockMovement write");
      });

      const res = await request(app)
        .post("/api/v1/inventory/consume")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          branchId: branchA1Id.toString(),
          productId: testProduct._id.toString(),
          quantity: 40,
          notes: "Rollback test"
        });

      expect(res.status).toBe(500);

      // Restore original repository create
      stockMovementRepository.create = originalCreate;

      // Balance must still be exactly 100ml (rolled back)
      const balance = await StockBalance.findOne({
        branchId: branchA1Id,
        productId: testProduct._id
      });
      expect(balance.onHand).toBe(100);

      // No service_consumption movement should exist
      const movements = await StockMovement.find({
        branchId: branchA1Id,
        productId: testProduct._id,
        movementType: "service_consumption"
      });
      expect(movements.length).toBe(0);
    });
  });

  describe("4. Concurrent Idempotent Requests with Same Key", () => {
    it("handles concurrent requests with the identical idempotency key without duplicate deduction", async () => {
      // Starting balance: 100ml
      await request(app)
        .post("/api/v1/inventory/adjust")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          branchId: branchA1Id.toString(),
          productId: testProduct._id.toString(),
          quantityDelta: 100,
          reason: "Baseline 100ml"
        });

      const sharedKey = `shared-concurrent-key-${Date.now()}`;

      // Fire 2 simultaneous requests with the SAME idempotency key
      const req1 = request(app)
        .post("/api/v1/inventory/consume")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .set("Idempotency-Key", sharedKey)
        .send({
          branchId: branchA1Id.toString(),
          productId: testProduct._id.toString(),
          quantity: 25,
          notes: "Concurrent key test"
        });

      const req2 = request(app)
        .post("/api/v1/inventory/consume")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .set("Idempotency-Key", sharedKey)
        .send({
          branchId: branchA1Id.toString(),
          productId: testProduct._id.toString(),
          quantity: 25,
          notes: "Concurrent key test"
        });

      const [res1, res2] = await Promise.all([req1, req2]);

      // Exactly one succeeds with 200, and the concurrent colliding request is caught by the
      // compound unique index on { organizationId: 1, idempotencyKey: 1 } returning 400 (duplicate error)
      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([200, 400]);

      // Final stock balance must be 75ml (deducted once)
      const balance = await StockBalance.findOne({
        branchId: branchA1Id,
        productId: testProduct._id
      });
      expect(balance.onHand).toBe(75);

      // Exactly ONE ledger movement must be recorded
      const movements = await StockMovement.find({
        branchId: branchA1Id,
        productId: testProduct._id,
        idempotencyKey: sharedKey
      });
      expect(movements.length).toBe(1);
      expect(movements[0].quantityDelta).toBe(-25);
      expect(movements[0].balanceAfter).toBe(75);
    });
  });
});

