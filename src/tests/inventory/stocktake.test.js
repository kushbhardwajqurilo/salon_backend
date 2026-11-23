import { describe, expect, it, beforeEach, beforeAll, afterAll, jest } from "@jest/globals";
import mongoose from "mongoose";
import request from "supertest";
import app from "../../../app.mjs";
import { getIsolatedTestMongoUri } from "../testSetup.js";
import { redis } from "../../../src/utils/redis.js";
import "../../database/db.js";
import { Product } from "../../models/inventory/product.model.js";
import { StockBalance } from "../../models/inventory/stockBalance.model.js";
import { StockMovement } from "../../models/inventory/stockMovement.model.js";
import { StockBatch } from "../../models/inventory/stockBatch.model.js";
import { Stocktake } from "../../models/inventory/stocktake.model.js";
import { StocktakeItem } from "../../models/inventory/stocktakeItem.model.js";
import { User } from "../../models/users/user.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Organization } from "../../models/organizations/organization.model.js";
import { Role } from "../../models/roles/role.model.js";
import { Permission } from "../../models/permissions/permission.model.js";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";

const signTestToken = (payload) => {
  return jwt.sign(payload, env.JWT_SECRET || "test-jwt-secret-key-for-auth", {
    expiresIn: "1h",
  });
};

describe("Inventory Stocktake Lifecycle Integration Tests", () => {
  jest.setTimeout(60000);

  let orgId;
  let otherOrgId;
  let branchId;
  let otherBranchId;
  let adminRole;
  let adminUser;
  let adminToken;
  let unauthorizedUser;
  let unauthorizedToken;
  let discreteProduct;
  let fractionalProduct;
  let dualProduct;

  beforeAll(async () => {
    const testUri = getIsolatedTestMongoUri("inventory_test");
    await mongoose.connect(testUri);

    // 1. Setup Organizations
    const org = await Organization.create({
      name: "Stocktake Test Salon Org",
      code: "STK-ORG",
      currency: "INR",
    });
    orgId = org._id;

    const otherOrg = await Organization.create({
      name: "Other Test Salon Org",
      code: "OTH-ORG",
      currency: "INR",
    });
    otherOrgId = otherOrg._id;

    // 2. Setup Branches
    const branch = await Branch.create({
      name: "Main Branch",
      organizationId: orgId,
      code: "MB-01",
    });
    branchId = branch._id;

    const otherBranch = await Branch.create({
      name: "Secondary Branch",
      organizationId: orgId,
      code: "SB-02",
    });
    otherBranchId = otherBranch._id;

    // 3. Setup Roles & Permissions
    const permView = await Permission.findOneAndUpdate(
      { name: "inventory.view" },
      { name: "inventory.view", module: "Inventory", action: "View", description: "View inventory" },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    const permAdjust = await Permission.findOneAndUpdate(
      { name: "inventory.adjust" },
      { name: "inventory.adjust", module: "Inventory", action: "Adjust", description: "Adjust inventory" },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    const permStocktake = await Permission.findOneAndUpdate(
      { name: "inventory.stocktake" },
      { name: "inventory.stocktake", module: "Inventory", action: "Stocktake", description: "Audit stocktake" },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    const permConsume = await Permission.findOneAndUpdate(
      { name: "inventory.consume" },
      { name: "inventory.consume", module: "Inventory", action: "Consume", description: "Consume inventory" },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    adminRole = await Role.create({
      name: `Inventory Manager ${Date.now()}`,
      organizationId: orgId,
      permissions: [permView._id, permAdjust._id, permStocktake._id, permConsume._id],
    });

    const unauthRole = await Role.create({
      name: `Stylist ${Date.now()}`,
      organizationId: orgId,
      permissions: [permView._id],
    });

    // 4. Setup Users
    adminUser = await User.create({
      name: "Admin Tester",
      email: `stk_admin_${Date.now()}@test.com`,
      phone: "+919999998811",
      password: "Password@123",
      role: adminRole._id,
      organizationId: orgId,
      branchIds: [branchId],
      hasOrgWideAccess: true,
      branchAccess: [{ branchId, branchName: "Main Branch", isActive: true }],
      status: "active",
    });
    adminToken = signTestToken({
      id: adminUser._id,
      organizationId: orgId,
      roles: ["Inventory Manager"],
      permissions: ["inventory.view", "inventory.adjust", "inventory.stocktake", "inventory.consume"],
    });

    unauthorizedUser = await User.create({
      name: "Stylist Tester",
      email: `stk_stylist_${Date.now()}@test.com`,
      phone: "+919999998822",
      password: "Password@123",
      role: unauthRole._id,
      organizationId: orgId,
      branchIds: [branchId],
      hasOrgWideAccess: false,
      branchAccess: [{ branchId, branchName: "Main Branch", isActive: true }],
      status: "active",
    });
    unauthorizedToken = signTestToken({
      id: unauthorizedUser._id,
      organizationId: orgId,
      roles: ["Stylist"],
      permissions: ["inventory.view"],
    });

    // 5. Setup Products
    discreteProduct = await Product.create({
      name: "Shampoo Bottle Retail",
      sku: `SKU-DISC-${Date.now()}`,
      category: "Haircare",
      usageType: "retail_sale",
      stockUnit: "bottle",
      costPrice: 200,
      sellingPrice: 350,
      organizationId: orgId,
      createdBy: adminUser._id,
      updatedBy: adminUser._id,
    });

    fractionalProduct = await Product.create({
      name: "Developer Liquid Professional",
      sku: `SKU-FRAC-${Date.now()}`,
      category: "Chemicals",
      usageType: "salon_consumption",
      stockUnit: "ml",
      costPrice: 1,
      sellingPrice: 2,
      organizationId: orgId,
      createdBy: adminUser._id,
      updatedBy: adminUser._id,
    });

    dualProduct = await Product.create({
      name: "Moroccan Oil Dual",
      sku: `SKU-DUAL-${Date.now()}`,
      category: "Styling",
      usageType: "both",
      stockUnit: "bottle",
      costPrice: 500,
      sellingPrice: 900,
      organizationId: orgId,
      createdBy: adminUser._id,
      updatedBy: adminUser._id,
    });

    // 6. Setup Initial StockBalances
    await StockBalance.create({
      organizationId: orgId,
      branchId: branchId,
      productId: discreteProduct._id,
      onHand: 15,
      onHandRetail: 15,
      onHandConsumables: 0,
      onHandUnallocated: 0,
      lastMovementAt: new Date(Date.now() - 3600000), // 1 hour ago
    });

    await StockBalance.create({
      organizationId: orgId,
      branchId: branchId,
      productId: fractionalProduct._id,
      onHand: 500.5,
      onHandConsumables: 500.5,
      onHandRetail: 0,
      onHandUnallocated: 0,
      lastMovementAt: new Date(Date.now() - 3600000),
    });

    await StockBalance.create({
      organizationId: orgId,
      branchId: branchId,
      productId: dualProduct._id,
      onHand: 30,
      onHandConsumables: 10,
      onHandRetail: 20,
      onHandUnallocated: 0,
      lastMovementAt: new Date(Date.now() - 3600000),
    });
  });

  afterAll(async () => {
    await StockBatch.deleteMany({ organizationId: orgId });
    await StocktakeItem.deleteMany({ organizationId: orgId });
    await Stocktake.deleteMany({ organizationId: orgId });
    await StockMovement.deleteMany({ organizationId: orgId });
    await StockBalance.deleteMany({ organizationId: orgId });
    await Product.deleteMany({ organizationId: orgId });
    await User.deleteMany({ organizationId: orgId });
    await Role.deleteMany({ organizationId: orgId });
    await Branch.deleteMany({ organizationId: orgId });
    await Organization.deleteMany({ _id: { $in: [orgId, otherOrgId] } });
    await mongoose.connection.close();
  });

  describe("1. Stocktake Initiation & Snapshotting", () => {
    it("should reject creation without inventory.stocktake permission", async () => {
      const res = await request(app)
        .post("/api/v1/inventory/stocktakes")
        .set("Authorization", `Bearer ${unauthorizedToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({ title: "Unauthorized Attempt" });

      expect(res.status).toBe(403);
    });

    it("should successfully initiate stocktake and snapshot eligible product lines", async () => {
      const res = await request(app)
        .post("/api/v1/inventory/stocktakes")
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          title: "Monthly Full Audit",
          targetDomain: "all",
          notes: "Routine inventory count",
        });

      if (res.status !== 201) {
        console.error("FAIL BODY:", res.body);
      }

      expect(res.status).toBe(201);
      expect(res.body.status).toBe("success");
      const st = res.body.data;
      expect(st.status).toBe("draft");
      expect(st.stocktakeNumber).toMatch(/^STK-\d{8}-\d{4}$/);
      expect(st.totalItems).toBe(4); // discrete (1 retail) + fractional (1 consumable) + dual (1 consumable + 1 retail)

      const items = await StocktakeItem.find({ stocktakeId: st._id });
      expect(items.length).toBe(4);

      // Verify discrete retail line snapshot
      const discreteItem = items.find(
        (i) => i.productId.toString() === discreteProduct._id.toString()
      );
      expect(discreteItem.stockDomain).toBe("retail_products");
      expect(discreteItem.snapshotQuantity).toBe(15);
      expect(discreteItem.countedQuantity).toBeNull();
      expect(discreteItem.status).toBe("uncounted");

      // Verify fractional consumable line snapshot
      const fracItem = items.find(
        (i) => i.productId.toString() === fractionalProduct._id.toString()
      );
      expect(fracItem.stockDomain).toBe("salon_consumables");
      expect(fracItem.snapshotQuantity).toBe(500.5);

      // Verify dual product lines snapshot
      const dualItems = items.filter(
        (i) => i.productId.toString() === dualProduct._id.toString()
      );
      expect(dualItems.length).toBe(2);
      const dualCons = dualItems.find((i) => i.stockDomain === "salon_consumables");
      const dualRet = dualItems.find((i) => i.stockDomain === "retail_products");
      expect(dualCons.snapshotQuantity).toBe(10);
      expect(dualRet.snapshotQuantity).toBe(20);
    });

    it("should correctly filter scope when targetDomain is salon_consumables", async () => {
      const res = await request(app)
        .post("/api/v1/inventory/stocktakes")
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          title: "Backbar Only Audit",
          targetDomain: "salon_consumables",
        });

      expect(res.status).toBe(201);
      const st = res.body.data;
      // Should include fractional (consumable) and dual (consumable only) = 2 items
      expect(st.totalItems).toBe(2);
      const items = await StocktakeItem.find({ stocktakeId: st._id });
      expect(items.every((i) => i.stockDomain === "salon_consumables")).toBe(true);
    });
  });

  describe("2. Physical Count Entry & Quantity Validation", () => {
    let stocktakeId;

    beforeEach(async () => {
      const res = await request(app)
        .post("/api/v1/inventory/stocktakes")
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({ title: "Count Test Stocktake" });
      stocktakeId = res.body.data._id;
    });

    it("should reject fractional decimal counts for discrete units", async () => {
      const res = await request(app)
        .put(`/api/v1/inventory/stocktakes/${stocktakeId}/counts`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          items: [
            {
              productId: discreteProduct._id.toString(),
              stockDomain: "retail_products",
              countedQuantity: 12.5, // Discrete bottle cannot have 0.5
            },
          ],
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Discrete unit 'bottle' requires integer quantity/i);
    });

    it("should accept valid fractional counts with up to 3 decimals", async () => {
      const res = await request(app)
        .put(`/api/v1/inventory/stocktakes/${stocktakeId}/counts`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          items: [
            {
              productId: fractionalProduct._id.toString(),
              stockDomain: "salon_consumables",
              countedQuantity: 485.125,
            },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("in_progress");
      expect(res.body.data.countedItemsCount).toBe(1);

      const item = await StocktakeItem.findOne({
        stocktakeId,
        productId: fractionalProduct._id,
      });
      expect(item.countedQuantity).toBe(485.125);
      expect(item.status).toBe("counted");
      expect(item.countedAt).toBeDefined();
      expect(item.verifiedMovementAt).toBeDefined();
    });

    it("should allow entering 0 as an explicit physical count", async () => {
      const res = await request(app)
        .put(`/api/v1/inventory/stocktakes/${stocktakeId}/counts`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          items: [
            {
              productId: discreteProduct._id.toString(),
              stockDomain: "retail_products",
              countedQuantity: 0,
              notes: "Out of stock on shelf",
            },
          ],
        });

      expect(res.status).toBe(200);
      const item = await StocktakeItem.findOne({
        stocktakeId,
        productId: discreteProduct._id,
      });
      expect(item.countedQuantity).toBe(0);
      expect(item.status).toBe("counted");
    });
  });

  describe("3. Read-Only Discrepancy Preview & Incomplete Guard", () => {
    let stocktakeId;

    beforeEach(async () => {
      const res = await request(app)
        .post("/api/v1/inventory/stocktakes")
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({ title: "Preview Audit" });
      stocktakeId = res.body.data._id;
    });

    it("should accurately preview variance without writing movements or updating balances", async () => {
      // Record 1 count: discrete product 15 -> counted 12 (variance -3)
      await request(app)
        .put(`/api/v1/inventory/stocktakes/${stocktakeId}/counts`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          items: [
            {
              productId: discreteProduct._id.toString(),
              stockDomain: "retail_products",
              countedQuantity: 12,
            },
          ],
        });

      const res = await request(app)
        .get(`/api/v1/inventory/stocktakes/${stocktakeId}/discrepancies`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString());

      expect(res.status).toBe(200);
      expect(res.body.data.uncountedCount).toBe(3);
      expect(res.body.data.isPostable).toBe(false);

      const previewDisc = res.body.data.items.find(
        (i) => (i.productId._id || i.productId).toString() === discreteProduct._id.toString()
      );
      expect(previewDisc.liveBalance).toBe(15);
      expect(previewDisc.countedQuantity).toBe(12);
      expect(previewDisc.varianceAgainstLive).toBe(-3);

      // Verify no movements exist
      const movements = await StockMovement.find({
        "reference.entityId": stocktakeId,
      });
      expect(movements.length).toBe(0);

      // Verify balance remains 15
      const bal = await StockBalance.findOne({
        organizationId: orgId,
        branchId,
        productId: discreteProduct._id,
      });
      expect(bal.onHandRetail).toBe(15);
    });

    it("should reject posting when stocktake has uncounted lines", async () => {
      // Incomplete count
      const res = await request(app)
        .post(`/api/v1/inventory/stocktakes/${stocktakeId}/post`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send();

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/All lines must be explicitly counted/i);
    });
  });

  describe("4. Posting, Variance Reconciliation & Aggregate Balances", () => {
    let stocktakeId;

    beforeEach(async () => {
      const res = await request(app)
        .post("/api/v1/inventory/stocktakes")
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({ title: "Reconciliation Test" });
      stocktakeId = res.body.data._id;

      // Count all 4 items:
      // 1. discrete: 15 -> counted 18 (+3 positive variance)
      // 2. fractional: 500.5 -> counted 490.5 (-10 negative variance)
      // 3. dual consumables: 10 -> counted 10 (0 zero variance)
      // 4. dual retail: 20 -> counted 19 (-1 negative variance)
      await request(app)
        .put(`/api/v1/inventory/stocktakes/${stocktakeId}/counts`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          items: [
            {
              productId: discreteProduct._id.toString(),
              stockDomain: "retail_products",
              countedQuantity: 18,
            },
            {
              productId: fractionalProduct._id.toString(),
              stockDomain: "salon_consumables",
              countedQuantity: 490.5,
            },
            {
              productId: dualProduct._id.toString(),
              stockDomain: "salon_consumables",
              countedQuantity: 10,
            },
            {
              productId: dualProduct._id.toString(),
              stockDomain: "retail_products",
              countedQuantity: 19,
            },
          ],
        });
    });

    it("should atomically post, update balances, and write movements only for non-zero variances", async () => {
      const postRes = await request(app)
        .post(`/api/v1/inventory/stocktakes/${stocktakeId}/post`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send();

      expect(postRes.status).toBe(200);
      expect(postRes.body.data.reconciledDiscrepancies).toBe(3); // 3 items had variance != 0
      expect(postRes.body.data.movementsCreated).toBe(3);

      // Verify StockBalances
      const discreteBal = await StockBalance.findOne({
        organizationId: orgId,
        branchId,
        productId: discreteProduct._id,
      });
      expect(discreteBal.onHandRetail).toBe(18);
      expect(discreteBal.onHand).toBe(18);

      const fracBal = await StockBalance.findOne({
        organizationId: orgId,
        branchId,
        productId: fractionalProduct._id,
      });
      expect(fracBal.onHandConsumables).toBe(490.5);
      expect(fracBal.onHand).toBe(490.5);

      const dualBal = await StockBalance.findOne({
        organizationId: orgId,
        branchId,
        productId: dualProduct._id,
      });
      expect(dualBal.onHandConsumables).toBe(10);
      expect(dualBal.onHandRetail).toBe(19);
      expect(dualBal.onHand).toBe(29); // 10 + 19

      // Verify StockMovement records
      const movements = await StockMovement.find({
        organizationId: orgId,
        branchId,
        "reference.entityId": stocktakeId,
      });
      expect(movements.length).toBe(3);
      expect(movements.every((m) => m.movementType === "stocktake")).toBe(true);

      const posMove = movements.find(
        (m) => m.productId.toString() === discreteProduct._id.toString()
      );
      expect(posMove.quantityDelta).toBe(3);
      expect(posMove.balanceAfter).toBe(18);
      expect(posMove.stockDomain).toBe("retail_products");

      const negMove = movements.find(
        (m) => m.productId.toString() === fractionalProduct._id.toString()
      );
      expect(negMove.quantityDelta).toBe(-10);
      expect(negMove.balanceAfter).toBe(490.5);
      expect(negMove.stockDomain).toBe("salon_consumables");

      // Zero variance item should NOT have a movement
      const zeroMove = movements.find(
        (m) =>
          m.productId.toString() === dualProduct._id.toString() &&
          m.stockDomain === "salon_consumables"
      );
      expect(zeroMove).toBeUndefined();

      // Check stocktake status
      const completedSt = await Stocktake.findById(stocktakeId);
      expect(completedSt.status).toBe("completed");
      expect(completedSt.postedAt).toBeDefined();
      expect(completedSt.postedBy.toString()).toBe(adminUser._id.toString());
    });

    it("should prevent modifications on a completed stocktake (immutability)", async () => {
      // Post first
      await request(app)
        .post(`/api/v1/inventory/stocktakes/${stocktakeId}/post`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send();

      // Attempt count update
      const countRes = await request(app)
        .put(`/api/v1/inventory/stocktakes/${stocktakeId}/counts`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          items: [
            {
              productId: discreteProduct._id.toString(),
              stockDomain: "retail_products",
              countedQuantity: 99,
            },
          ],
        });
      expect(countRes.status).toBe(400);

      // Attempt double post
      const doublePostRes = await request(app)
        .post(`/api/v1/inventory/stocktakes/${stocktakeId}/post`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send();
      expect(doublePostRes.status).toBe(409);

      // Attempt cancel
      const cancelRes = await request(app)
        .post(`/api/v1/inventory/stocktakes/${stocktakeId}/cancel`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({ reason: "Late cancellation" });
      expect(cancelRes.status).toBe(400);
    });
  });

  describe("5. Concurrency, Race Detection & Mandatory Recount", () => {
    let stocktakeId;

    beforeEach(async () => {
      const res = await request(app)
        .post("/api/v1/inventory/stocktakes")
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({ title: "Race Detection Test" });
      stocktakeId = res.body.data._id;

      // Count all items
      await request(app)
        .put(`/api/v1/inventory/stocktakes/${stocktakeId}/counts`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          items: [
            {
              productId: discreteProduct._id.toString(),
              stockDomain: "retail_products",
              countedQuantity: 18,
            },
            {
              productId: fractionalProduct._id.toString(),
              stockDomain: "salon_consumables",
              countedQuantity: 490.5,
            },
            {
              productId: dualProduct._id.toString(),
              stockDomain: "salon_consumables",
              countedQuantity: 10,
            },
            {
              productId: dualProduct._id.toString(),
              stockDomain: "retail_products",
              countedQuantity: 19,
            },
          ],
        });
    });

    it("should abort post and require recount when an intervening movement occurs after physical count", async () => {
      // Simulate an intervening inventory movement (e.g. POS sale or adjustment) 2 seconds later
      await new Promise((r) => setTimeout(r, 50));

      const interveningTime = new Date();
      await StockMovement.create({
        organizationId: orgId,
        branchId,
        productId: discreteProduct._id,
        quantityDelta: -2,
        balanceAfter: 16,
        movementType: "pos_sale",
        stockDomain: "retail_products",
        reference: {
          entityType: "Invoice",
          identifier: "INV-RACE-001",
        },
        actorId: adminUser._id,
        createdAt: interveningTime,
      });

      // Update StockBalance to simulate normal inventory consumption
      await StockBalance.findOneAndUpdate(
        { organizationId: orgId, branchId, productId: discreteProduct._id },
        {
          $inc: { onHandRetail: -2, onHand: -2 },
          $set: { lastMovementAt: interveningTime },
        }
      );

      // Attempt post - expect conflict due to intervening movement
      const postRes = await request(app)
        .post(`/api/v1/inventory/stocktakes/${stocktakeId}/post`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send();

      expect(postRes.status).toBe(409);
      expect(postRes.body.message).toMatch(/Stock movements occurred after physical counts were recorded. Recount required/i);

      // Verify recount_required status persisted on StocktakeItem outside the aborted transaction
      const conflictedItem = await StocktakeItem.findOne({
        stocktakeId,
        productId: discreteProduct._id,
      });
      expect(conflictedItem.status).toBe("recount_required");

      // Verify stocktake session was restored to in_progress (not stuck in posting)
      const stocktakeDoc = await Stocktake.findById(stocktakeId);
      expect(stocktakeDoc.status).toBe("in_progress");

      // Verify no stocktake movements were committed
      const movements = await StockMovement.find({
        "reference.entityId": stocktakeId,
      });
      expect(movements.length).toBe(0);

      // Verify StockBalance was NOT overwritten or modified by stocktake post
      const balAfterConflict = await StockBalance.findOne({
        organizationId: orgId,
        branchId,
        productId: discreteProduct._id,
      });
      // The prior test updated discreteBal to 18; verify it was NOT overwritten to 16 by this rejected post
      expect(balAfterConflict.onHandRetail).toBe(16);

      // Recount the flagged item to update its timestamp and verifiedMovementAt
      const recountRes = await request(app)
        .put(`/api/v1/inventory/stocktakes/${stocktakeId}/counts`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          items: [
            {
              productId: discreteProduct._id.toString(),
              stockDomain: "retail_products",
              countedQuantity: 16, // Recounted shelf stock matches post-sale physical count
              notes: "Recounted after mid-day checkout",
            },
          ],
        });
      expect(recountRes.status).toBe(200);

      // Post now succeeds
      const retryPostRes = await request(app)
        .post(`/api/v1/inventory/stocktakes/${stocktakeId}/post`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send();
      expect(retryPostRes.status).toBe(200);
      expect(retryPostRes.body.data.stocktake.status).toBe("completed");
    });
  });

  describe("6. Idempotency & Tenant Security", () => {
    let stocktakeId;
    const testIdempotencyKey = `KEY-STK-${Date.now()}`;

    beforeEach(async () => {
      const res = await request(app)
        .post("/api/v1/inventory/stocktakes")
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({ title: "Idempotency Test" });
      stocktakeId = res.body.data._id;

      await request(app)
        .put(`/api/v1/inventory/stocktakes/${stocktakeId}/counts`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          items: [
            {
              productId: discreteProduct._id.toString(),
              stockDomain: "retail_products",
              countedQuantity: 16,
            },
            {
              productId: fractionalProduct._id.toString(),
              stockDomain: "salon_consumables",
              countedQuantity: 490.5,
            },
            {
              productId: dualProduct._id.toString(),
              stockDomain: "salon_consumables",
              countedQuantity: 10,
            },
            {
              productId: dualProduct._id.toString(),
              stockDomain: "retail_products",
              countedQuantity: 19,
            },
          ],
        });
    });

    it("should replay cleanly on duplicate post with identical idempotency key without duplicate movements", async () => {
      const res1 = await request(app)
        .post(`/api/v1/inventory/stocktakes/${stocktakeId}/post`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .set("Idempotency-Key", testIdempotencyKey)
        .send();

      expect(res1.status).toBe(200);

      const movementsCount1 = await StockMovement.countDocuments({
        "reference.entityId": stocktakeId,
      });

      // Second identical request
      const res2 = await request(app)
        .post(`/api/v1/inventory/stocktakes/${stocktakeId}/post`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .set("Idempotency-Key", testIdempotencyKey)
        .send();

      expect(res2.status).toBe(200);
      expect(res2.body.data.replayed).toBe(true);

      const movementsCount2 = await StockMovement.countDocuments({
        "reference.entityId": stocktakeId,
      });
      expect(movementsCount2).toBe(movementsCount1);
    });

    it("should ensure exactly one posting succeeds under concurrent post requests with different idempotency keys", async () => {
      // Create a fresh stocktake session for this concurrent test
      const freshRes = await request(app)
        .post("/api/v1/inventory/stocktakes")
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({ title: "Concurrent Keys Test" });
      const freshStocktakeId = freshRes.body.data._id;

      // Enter physical counts for all items
      await request(app)
        .put(`/api/v1/inventory/stocktakes/${freshStocktakeId}/counts`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          items: [
            {
              productId: discreteProduct._id.toString(),
              stockDomain: "retail_products",
              countedQuantity: 12,
            },
            {
              productId: fractionalProduct._id.toString(),
              stockDomain: "salon_consumables",
              countedQuantity: 470,
            },
            {
              productId: dualProduct._id.toString(),
              stockDomain: "salon_consumables",
              countedQuantity: 10,
            },
            {
              productId: dualProduct._id.toString(),
              stockDomain: "retail_products",
              countedQuantity: 19,
            },
          ],
        });

      const keyA = `KEY-CONCURRENT-A-${Date.now()}`;
      const keyB = `KEY-CONCURRENT-B-${Date.now()}`;

      // Dispatch two concurrent post requests with distinct idempotency keys
      const [resA, resB] = await Promise.all([
        request(app)
          .post(`/api/v1/inventory/stocktakes/${freshStocktakeId}/post`)
          .set("Authorization", `Bearer ${adminToken}`)
          .set("X-Branch-Id", branchId.toString())
          .set("Idempotency-Key", keyA)
          .send(),
        request(app)
          .post(`/api/v1/inventory/stocktakes/${freshStocktakeId}/post`)
          .set("Authorization", `Bearer ${adminToken}`)
          .set("X-Branch-Id", branchId.toString())
          .set("Idempotency-Key", keyB)
          .send(),
      ]);

      const statuses = [resA.status, resB.status].sort();
      // Exactly one must succeed (200), and the other must be rejected (409 conflict: either 'posting' or 'completed')
      expect(statuses).toEqual([200, 409]);

      const successRes = resA.status === 200 ? resA : resB;
      const rejectedRes = resA.status === 409 ? resA : resB;

      expect(successRes.body.success).toBe(true);
      expect(rejectedRes.status).toBe(409);
      expect(rejectedRes.body.message).toMatch(/(already been completed|currently being posted)/i);

      // Verify movements were created exactly once
      const movements = await StockMovement.find({
        "reference.entityId": freshStocktakeId,
      });
      expect(movements.length).toBeGreaterThan(0);

      // Verify StockBalance was updated accurately without double counting
      const balDiscrete = await StockBalance.findOne({
        organizationId: orgId,
        branchId,
        productId: discreteProduct._id,
      });
      expect(balDiscrete.onHandRetail).toBe(12);
    });

    it("should reject cross-tenant access to stocktakes", async () => {
      const uniqueSuffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
      const otherUser = await User.create({
        name: "Other Org Manager",
        username: `other_mgr_${uniqueSuffix}`,
        email: `other_mgr_${uniqueSuffix}@test.com`,
        phone: `+91999${Math.floor(1000000 + Math.random() * 9000000)}`,
        password: "Password@123",
        role: adminRole._id,
        organizationId: otherOrgId,
        hasOrgWideAccess: true,
        status: "active",
      });

      const otherOrgToken = signTestToken({
        id: otherUser._id,
        organizationId: otherOrgId,
        roles: ["Inventory Manager"],
        permissions: ["inventory.view", "inventory.stocktake"],
      });

      const res = await request(app)
        .get(`/api/v1/inventory/stocktakes/${stocktakeId}`)
        .set("Authorization", `Bearer ${otherOrgToken}`)
        .set("X-Branch-Id", branchId.toString());

      expect(res.status).toBe(404);
    });
  });

  describe("7. Stocktake FIFO Subledger & Batch Valuation Integration", () => {
    let fifoProduct;
    let batchA;
    let batchB;

    beforeEach(async () => {
      // Create dedicated product for FIFO stocktake testing
      fifoProduct = await Product.create({
        name: "Keratin Treatment Serum",
        sku: `SKU-FIFO-${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        category: "Hair Treatment",
        usageType: "salon_consumption",
        stockUnit: "bottle",
        costPrice: 400,
        sellingPrice: 800,
        organizationId: orgId,
        createdBy: adminUser._id,
        updatedBy: adminUser._id,
      });

      // 1. Batch A (Oldest): 5 units @ ₹300 = 30000 paise (Valued)
      batchA = await StockBatch.create({
        organizationId: orgId,
        branchId,
        productId: fifoProduct._id,
        stockDomain: "salon_consumables",
        batchNumber: `BAT-TEST-A-${Date.now()}`,
        sourceType: "procurement_grn",
        sourceReference: { entityType: "GRN", identifier: "GRN-FIFO-A" },
        receivedDate: new Date(Date.now() - 7200000), // 2 hours ago
        initialQuantityMilli: 5000,
        remainingQuantityMilli: 5000,
        isValued: true,
        unitCostPaise: 30000,
        totalCostPaise: 150000,
        status: "active",
        createdBy: adminUser._id,
      });

      // 2. Batch B (Newer): 5 units @ ₹400 = 40000 paise (Valued)
      batchB = await StockBatch.create({
        organizationId: orgId,
        branchId,
        productId: fifoProduct._id,
        stockDomain: "salon_consumables",
        batchNumber: `BAT-TEST-B-${Date.now()}`,
        sourceType: "procurement_grn",
        sourceReference: { entityType: "GRN", identifier: "GRN-FIFO-B" },
        receivedDate: new Date(Date.now() - 3600000), // 1 hour ago
        initialQuantityMilli: 5000,
        remainingQuantityMilli: 5000,
        isValued: true,
        unitCostPaise: 40000,
        totalCostPaise: 200000,
        status: "active",
        createdBy: adminUser._id,
      });

      // Setup StockBalance with onHand = 10 (5 in A + 5 in B)
      await StockBalance.create({
        organizationId: orgId,
        branchId,
        productId: fifoProduct._id,
        onHand: 10,
        onHandConsumables: 10,
        onHandRetail: 0,
        onHandUnallocated: 0,
        lastMovementAt: new Date(Date.now() - 3600000),
      });
    });

    afterEach(async () => {
      if (fifoProduct) {
        await StockBatch.deleteMany({ organizationId: orgId, productId: fifoProduct._id });
        await StockBalance.deleteMany({ organizationId: orgId, productId: fifoProduct._id });
        await Product.deleteOne({ _id: fifoProduct._id });
      }
    });

    it("should deplete FIFO batches in order on negative variance and record correct cost attribution", async () => {
      // Initiate stocktake scoped to salon_consumables
      const initRes = await request(app)
        .post("/api/v1/inventory/stocktakes")
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          title: "FIFO Negative Variance Audit",
          targetDomain: "salon_consumables",
        });

      expect(initRes.status).toBe(201);
      const stkId = initRes.body.data._id;

      // Count: On-hand is 10, physically count 4 (-6 units negative variance / shortage)
      // Depletion expectation:
      // All 5 units of Batch A (5 * ₹300 = ₹1500 / 150000 paise)
      // 1 unit of Batch B (1 * ₹400 = ₹400 / 40000 paise)
      // Total cost of shortage = 190000 paise
      // Count all items in the stocktake session:
      // fractionalProduct (consumable), dualProduct (consumable), and fifoProduct (consumable)
      const countRes = await request(app)
        .put(`/api/v1/inventory/stocktakes/${stkId}/counts`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          items: [
            {
              productId: fifoProduct._id.toString(),
              stockDomain: "salon_consumables",
              countedQuantity: 4,
            },
            {
              productId: fractionalProduct._id.toString(),
              stockDomain: "salon_consumables",
              countedQuantity: 500.5,
            },
            {
              productId: dualProduct._id.toString(),
              stockDomain: "salon_consumables",
              countedQuantity: 10,
            },
          ],
        });
      expect(countRes.status).toBe(200);

      // Post the stocktake
      const postRes = await request(app)
        .post(`/api/v1/inventory/stocktakes/${stkId}/post`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send();

      expect(postRes.status).toBe(200);

      // Verify StockBatches
      const refreshedA = await StockBatch.findById(batchA._id);
      expect(refreshedA.remainingQuantityMilli).toBe(0);
      expect(refreshedA.status).toBe("depleted");

      const refreshedB = await StockBatch.findById(batchB._id);
      expect(refreshedB.remainingQuantityMilli).toBe(4000); // 5 - 1 = 4 units left
      expect(refreshedB.status).toBe("active");

      // Verify StockMovement
      const movement = await StockMovement.findOne({
        "reference.entityId": stkId,
        productId: fifoProduct._id,
      });

      expect(movement).toBeDefined();
      expect(movement.movementType).toBe("stocktake");
      expect(movement.quantityDelta).toBe(-6);
      expect(movement.balanceAfter).toBe(4);
      expect(movement.isValued).toBe(true);
      expect(movement.valuedQuantityMilli).toBe(6000);
      expect(movement.unvaluedQuantityMilli).toBe(0);
      expect(movement.totalCostPaise).toBe(190000); // 150000 + 40000

      // Verify batch allocations
      expect(movement.lotAllocations.length).toBe(2);
      expect(movement.lotAllocations[0].batchNumber).toBe(batchA.batchNumber);
      expect(movement.lotAllocations[0].quantityMilli).toBe(5000);
      expect(movement.lotAllocations[0].allocatedCostPaise).toBe(150000);

      expect(movement.lotAllocations[1].batchNumber).toBe(batchB.batchNumber);
      expect(movement.lotAllocations[1].quantityMilli).toBe(1000);
      expect(movement.lotAllocations[1].allocatedCostPaise).toBe(40000);

      // Verify live StockBalance
      const balance = await StockBalance.findOne({
        organizationId: orgId,
        branchId,
        productId: fifoProduct._id,
      });
      expect(balance.onHandConsumables).toBe(4);
      expect(balance.onHand).toBe(4);
    });

    it("should create an explicitly unvalued batch on positive variance without inventing costs", async () => {
      // Initiate stocktake scoped to salon_consumables
      const initRes = await request(app)
        .post("/api/v1/inventory/stocktakes")
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          title: "FIFO Positive Variance Audit",
          targetDomain: "salon_consumables",
        });

      expect(initRes.status).toBe(201);
      const stkId = initRes.body.data._id;

      // Count: On-hand is 10, physically count 13 (+3 units positive variance / found stock)
      // Count all items in the stocktake session:
      // fractionalProduct (consumable), dualProduct (consumable), and fifoProduct (consumable)
      await request(app)
        .put(`/api/v1/inventory/stocktakes/${stkId}/counts`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          items: [
            {
              productId: fifoProduct._id.toString(),
              stockDomain: "salon_consumables",
              countedQuantity: 13,
            },
            {
              productId: fractionalProduct._id.toString(),
              stockDomain: "salon_consumables",
              countedQuantity: 500.5,
            },
            {
              productId: dualProduct._id.toString(),
              stockDomain: "salon_consumables",
              countedQuantity: 10,
            },
          ],
        });

      // Post stocktake
      const postRes = await request(app)
        .post(`/api/v1/inventory/stocktakes/${stkId}/post`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send();

      expect(postRes.status).toBe(200);

      // Verify a new unvalued StockBatch was created
      const foundBatch = await StockBatch.findOne({
        organizationId: orgId,
        branchId,
        productId: fifoProduct._id,
        "sourceReference.entityId": stkId,
      });

      expect(foundBatch).toBeDefined();
      expect(foundBatch.batchNumber).toMatch(/^BAT-STK-/);
      expect(foundBatch.sourceType).toBe("manual_adjustment");
      expect(foundBatch.stockDomain).toBe("salon_consumables");
      expect(foundBatch.initialQuantityMilli).toBe(3000);
      expect(foundBatch.remainingQuantityMilli).toBe(3000);
      expect(foundBatch.isValued).toBe(false); // MUST NOT assume zero or invent cost
      expect(foundBatch.unitCostPaise).toBeNull();
      expect(foundBatch.totalCostPaise).toBeNull();
      expect(foundBatch.status).toBe("active");

      // Verify movement recorded as unvalued
      const movement = await StockMovement.findOne({
        "reference.entityId": stkId,
        productId: fifoProduct._id,
      });
      expect(movement.movementType).toBe("stocktake");
      expect(movement.quantityDelta).toBe(3);
      expect(movement.balanceAfter).toBe(13);
      expect(movement.isValued).toBe(false);
      expect(movement.unvaluedQuantityMilli).toBe(3000);
      expect(movement.totalCostPaise).toBeNull();
      expect(movement.lotAllocations.length).toBe(1);
      expect(movement.lotAllocations[0].batchNumber).toBe(foundBatch.batchNumber);
      expect(movement.lotAllocations[0].isValued).toBe(false);
      expect(movement.lotAllocations[0].unitCostPaise).toBeNull();
    });

    it("should roll back batch modifications completely on conflict abort", async () => {
      const initRes = await request(app)
        .post("/api/v1/inventory/stocktakes")
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          title: "FIFO Rollback Verification",
          targetDomain: "salon_consumables",
        });

      const stkId = initRes.body.data._id;

      // Count all items in session
      await request(app)
        .put(`/api/v1/inventory/stocktakes/${stkId}/counts`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          items: [
            {
              productId: fifoProduct._id.toString(),
              stockDomain: "salon_consumables",
              countedQuantity: 8,
            },
            {
              productId: fractionalProduct._id.toString(),
              stockDomain: "salon_consumables",
              countedQuantity: 500.5,
            },
            {
              productId: dualProduct._id.toString(),
              stockDomain: "salon_consumables",
              countedQuantity: 10,
            },
          ],
        });

      // Intervening movement after count
      await StockMovement.create({
        organizationId: orgId,
        branchId,
        productId: fifoProduct._id,
        quantityDelta: -1,
        balanceAfter: 9,
        movementType: "service_consumption",
        stockDomain: "salon_consumables",
        reference: { entityType: "ServiceConsumption", identifier: "RACE-INTERRUPT" },
        actorId: adminUser._id,
        createdAt: new Date(Date.now() + 5000), // after count
      });

      // Post should fail with 409
      const postRes = await request(app)
        .post(`/api/v1/inventory/stocktakes/${stkId}/post`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send();

      expect(postRes.status).toBe(409);
      expect(postRes.body.message).toMatch(/Recount required/i);

      // Verify recount_required status persisted on StocktakeItem outside the aborted transaction
      const conflictedItem = await StocktakeItem.findOne({
        stocktakeId: stkId,
        productId: fifoProduct._id,
      });
      expect(conflictedItem.status).toBe("recount_required");

      // Verify batch quantities were NOT changed
      const bA = await StockBatch.findById(batchA._id);
      expect(bA.remainingQuantityMilli).toBe(5000);
      expect(bA.status).toBe("active");

      const bB = await StockBatch.findById(batchB._id);
      expect(bB.remainingQuantityMilli).toBe(5000);
      expect(bB.status).toBe("active");

      // Verify NO stocktake movement was created
      const movements = await StockMovement.find({
        "reference.entityId": stkId,
      });
      expect(movements.length).toBe(0);
    });

    it("should safely trace an unvalued positive variance batch through downstream FIFO consumption and valuation", async () => {
      // 1. Create a stocktake that records a positive variance (+2 bottles found)
      const initRes = await request(app)
        .post("/api/v1/inventory/stocktakes")
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          title: "Found Stock Audit",
          targetDomain: "salon_consumables",
        });

      const stkId = initRes.body.data._id;

      // Count 12 (On hand was 10, so +2 found)
      await request(app)
        .put(`/api/v1/inventory/stocktakes/${stkId}/counts`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          items: [
            {
              productId: fifoProduct._id.toString(),
              stockDomain: "salon_consumables",
              countedQuantity: 12,
            },
            {
              productId: fractionalProduct._id.toString(),
              stockDomain: "salon_consumables",
              countedQuantity: 500.5,
            },
            {
              productId: dualProduct._id.toString(),
              stockDomain: "salon_consumables",
              countedQuantity: 10,
            },
          ],
        });

      const postRes = await request(app)
        .post(`/api/v1/inventory/stocktakes/${stkId}/post`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send();

      expect(postRes.status).toBe(200);

      // 2. Fetch the newly generated batch
      const foundBatch = await StockBatch.findOne({
        organizationId: orgId,
        branchId,
        productId: fifoProduct._id,
        "sourceReference.entityId": stkId,
      });
      expect(foundBatch).toBeDefined();
      expect(foundBatch.isValued).toBe(false);
      expect(foundBatch.unitCostPaise).toBeNull();
      expect(foundBatch.remainingQuantityMilli).toBe(2000);

      // 3. Deplete the two older valued batches (5 in batchA, 5 in batchB)
      // Consume 10 units via service consumption
      const consumeRes = await request(app)
        .post("/api/v1/inventory/consume")
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          branchId: branchId.toString(),
          productId: fifoProduct._id.toString(),
          quantity: 10,
          notes: "Used in service packages",
        });

      expect(consumeRes.status).toBe(200);

      // 4. Now consume 1 unit from the newly found batch (which is next in FIFO queue)
      const unvaluedConsumeRes = await request(app)
        .post("/api/v1/inventory/consume")
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          branchId: branchId.toString(),
          productId: fifoProduct._id.toString(),
          quantity: 1,
          notes: "Consuming unvalued found stock",
        });

      expect(unvaluedConsumeRes.status).toBe(200);

      // Inspect movement: MUST NOT invent zero cost as reliable cost!
      const unvaluedMvt = await StockMovement.findOne({
        organizationId: orgId,
        branchId,
        productId: fifoProduct._id,
        movementType: "service_consumption",
        notes: "Consuming unvalued found stock",
      });

      expect(unvaluedMvt).toBeDefined();
      expect(unvaluedMvt.isValued).toBe(false);
      expect(unvaluedMvt.totalCostPaise).toBeNull(); // Unknown cost is NOT zero!
      expect(unvaluedMvt.unvaluedQuantityMilli).toBe(1000);
      expect(unvaluedMvt.lotAllocations[0].batchNumber).toBe(foundBatch.batchNumber);
      expect(unvaluedMvt.lotAllocations[0].isValued).toBe(false);
      expect(unvaluedMvt.lotAllocations[0].unitCostPaise).toBeNull();

      // 5. Check remaining 1 unit in the unvalued batch and value it via openingValuation
      const valuedFoundBatch = await StockBatch.findByIdAndUpdate(
        foundBatch._id,
        {
          $set: {
            isValued: true,
            unitCostPaise: 45000, // ₹450
            totalCostPaise: 45000, // 1 unit left * 45000
          },
        },
        { new: true }
      );
      expect(valuedFoundBatch.isValued).toBe(true);
      expect(valuedFoundBatch.unitCostPaise).toBe(45000);
      expect(valuedFoundBatch.remainingQuantityMilli).toBe(1000);
    });
  });
});
