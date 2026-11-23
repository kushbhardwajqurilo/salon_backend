import { describe, expect, it, beforeAll, afterAll, beforeEach, jest } from "@jest/globals";
import mongoose from "mongoose";
import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../../app.mjs";
import { getIsolatedTestMongoUri } from "../testSetup.js";
import { Organization } from "../../models/organizations/organization.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { User } from "../../models/users/user.model.js";
import { Role } from "../../models/roles/role.model.js";
import { Permission } from "../../models/permissions/permission.model.js";
import { Expense } from "../../models/expenses/expense.model.js";
import { PettyCashTransaction } from "../../models/expenses/pettyCash.model.js";
import { CANONICAL_PERMISSIONS } from "../../config/permissions.js";
import { redis } from "../../utils/redis.js";

jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");

describe("Expenses & Petty Cash Integration Suite", () => {
  jest.setTimeout(40000);

  let dbUri;
  let organization;
  let branchA;
  let branchB;
  let managerUser;
  let cashierUser;
  let managerToken;
  let cashierToken;

  beforeAll(async () => {
    dbUri = getIsolatedTestMongoUri("expenses_test");
    await mongoose.connect(dbUri);

    // Sync all canonical permissions
    const permissionDocs = [];
    for (const perm of CANONICAL_PERMISSIONS) {
      const doc = await Permission.findOneAndUpdate(
        { name: perm.name },
        { ...perm },
        { upsert: true, new: true }
      );
      permissionDocs.push(doc);
    }

    // Create Organization with threshold 5000
    organization = await Organization.create({
      name: "Test Glamour Salon",
      expenseApprovalThreshold: 5000,
      allowedExpenseCategories: ["utilities", "maintenance", "consumables", "refreshments", "marketing", "other"],
    });

    // Create Manager Role (all permissions)
    const managerRole = await Role.create({
      name: "manager",
      description: "Manager with full permissions",
      permissions: permissionDocs.map((p) => p._id),
      isSystem: true,
    });

    // Create Cashier Role (expenses.view, expenses.create)
    const cashierPerms = permissionDocs.filter((p) =>
      ["expenses.view", "expenses.create"].includes(p.name)
    );
    const cashierRole = await Role.create({
      name: "cashier",
      description: "Cashier role",
      organizationId: organization._id,
      permissions: cashierPerms.map((p) => p._id),
      isSystem: false,
    });

    // Create Branches
    branchA = await Branch.create({
      name: "Branch Alpha",
      organizationId: organization._id,
      timezone: "Asia/Kolkata",
    });

    branchB = await Branch.create({
      name: "Branch Beta",
      organizationId: organization._id,
      timezone: "Asia/Kolkata",
    });

    // Create Users
    managerUser = await User.create({
      name: "Test Manager",
      email: "manager@glamour.test",
      phone: "+919999999901",
      password: "password123",
      organizationId: organization._id,
      role: managerRole._id,
      roles: [managerRole._id],
      hasOrgWideAccess: true,
      branchAccess: [
        { branchId: branchA._id, branchName: branchA.name, isActive: true },
        { branchId: branchB._id, branchName: branchB.name, isActive: true },
      ],
    });

    cashierUser = await User.create({
      name: "Test Cashier",
      email: "cashier@glamour.test",
      phone: "+919999999902",
      password: "password123",
      organizationId: organization._id,
      role: cashierRole._id,
      roles: [cashierRole._id],
      hasOrgWideAccess: false,
      branchAccess: [{ branchId: branchA._id, branchName: branchA.name, isActive: true }],
    });

    const jwtSecret = process.env.JWT_SECRET || "fallback_test_jwt_secret_32bytes_long";
    managerToken = jwt.sign(
      {
        id: managerUser._id.toString(),
        userId: managerUser._id.toString(),
        organizationId: organization._id.toString(),
        email: managerUser.email,
        roles: ["manager"],
      },
      jwtSecret,
      { expiresIn: "1h" }
    );

    cashierToken = jwt.sign(
      {
        id: cashierUser._id.toString(),
        userId: cashierUser._id.toString(),
        organizationId: organization._id.toString(),
        email: cashierUser.email,
        roles: ["cashier"],
      },
      jwtSecret,
      { expiresIn: "1h" }
    );
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  describe("1. Petty Cash Replenishment & Derived Balance", () => {
    it("replenishes petty cash drawer idempotently and correctly computes derived balance", async () => {
      const idempotencyKey = "REPL_TEST_KEY_001";
      const payload = { amount: 10000, description: "Initial drawer float" };

      const res1 = await request(app)
        .post("/api/v1/expenses/petty-cash/replenish")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchA._id.toString())
        .set("Idempotency-Key", idempotencyKey)
        .send(payload);

      expect(res1.status).toBe(201);
      expect(res1.body.success).toBe(true);
      expect(res1.body.data.amount).toBe(10000);
      expect(res1.body.data.type).toBe("replenishment");

      // Idempotent retry with same payload returns existing record
      const res2 = await request(app)
        .post("/api/v1/expenses/petty-cash/replenish")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchA._id.toString())
        .set("Idempotency-Key", idempotencyKey)
        .send(payload);

      expect(res2.status).toBe(201);
      expect(res2.body.data.id).toBe(res1.body.data.id);

      // Replaying with differing payload returns 409 Conflict
      const res3 = await request(app)
        .post("/api/v1/expenses/petty-cash/replenish")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchA._id.toString())
        .set("Idempotency-Key", idempotencyKey)
        .send({ amount: 20000, description: "Differing description" });

      expect(res3.status).toBe(409);

      // Verify derived balance
      const balanceRes = await request(app)
        .get("/api/v1/expenses/petty-cash/balance")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(balanceRes.status).toBe(200);
      expect(balanceRes.body.data.currentBalance).toBe(10000);
      expect(balanceRes.body.data.totalInflow).toBe(10000);
      expect(balanceRes.body.data.totalOutflow).toBe(0);
    });
  });

  describe("2. Under-threshold Petty Cash Expense", () => {
    it("creates approved expense and atomically generates petty cash payout, deducting drawer balance", async () => {
      const expensePayload = {
        category: "refreshments",
        amount: 800,
        paymentMethod: "petty_cash",
        payeeName: "Metro Coffee Mart",
        description: "Coffee and biscuits for salon clients",
      };

      const res = await request(app)
        .post("/api/v1/expenses")
        .set("Authorization", `Bearer ${cashierToken}`)
        .set("X-Branch-Id", branchA._id.toString())
        .send(expensePayload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.approvalStatus).toBe("approved");
      expect(res.body.data.paymentStatus).toBe("settled");
      expect(res.body.data.expenseCode).toMatch(/^EXP-\d{8}-\d{4}$/);
      expect(res.body.data.pettyCashTransactionId).toBeDefined();

      // Verify drawer balance was reduced
      const balanceRes = await request(app)
        .get("/api/v1/expenses/petty-cash/balance")
        .set("Authorization", `Bearer ${cashierToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(balanceRes.status).toBe(200);
      expect(balanceRes.body.data.currentBalance).toBe(9200); // 10000 - 800
      expect(balanceRes.body.data.totalOutflow).toBe(800);
    });
  });

  describe("3. Over-threshold Petty Cash Expense & Approval", () => {
    let pendingExpenseId;

    it("creates over-threshold expense with approvalStatus 'pending_approval' and zero drawer deduction", async () => {
      const expensePayload = {
        category: "maintenance",
        amount: 8500, // > 5000 threshold
        paymentMethod: "petty_cash",
        payeeName: "AC Chill Tech",
        description: "Emergency compressor servicing",
      };

      const res = await request(app)
        .post("/api/v1/expenses")
        .set("Authorization", `Bearer ${cashierToken}`)
        .set("X-Branch-Id", branchA._id.toString())
        .send(expensePayload);

      expect(res.status).toBe(201);
      expect(res.body.data.approvalStatus).toBe("pending_approval");
      expect(res.body.data.paymentStatus).toBe("unpaid");
      expect(res.body.data.pettyCashTransactionId).toBeUndefined();
      pendingExpenseId = res.body.data.id;

      // Drawer balance remains untouched
      const balanceRes = await request(app)
        .get("/api/v1/expenses/petty-cash/balance")
        .set("Authorization", `Bearer ${cashierToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(balanceRes.body.data.currentBalance).toBe(9200);
    });

    it("cashier cannot approve expense (requires expenses.update)", async () => {
      const res = await request(app)
        .patch(`/api/v1/expenses/${pendingExpenseId}/approve`)
        .set("Authorization", `Bearer ${cashierToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(res.status).toBe(403);
    });

    it("manager approves expense, atomically creating payout and deducting drawer balance", async () => {
      const res = await request(app)
        .patch(`/api/v1/expenses/${pendingExpenseId}/approve`)
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(res.status).toBe(200);
      expect(res.body.data.approvalStatus).toBe("approved");
      expect(res.body.data.paymentStatus).toBe("settled");
      expect(res.body.data.pettyCashTransactionId).toBeDefined();

      // Drawer balance updated
      const balanceRes = await request(app)
        .get("/api/v1/expenses/petty-cash/balance")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(balanceRes.body.data.currentBalance).toBe(700); // 9200 - 8500
      expect(balanceRes.body.data.totalOutflow).toBe(9300); // 800 + 8500
    });
  });

  describe("4. Non-Petty-Cash Expense Settlement & Rejection", () => {
    it("handles over-threshold settled non-petty-cash expense and preserves proof upon rejection", async () => {
      const expensePayload = {
        category: "utilities",
        amount: 15000,
        paymentMethod: "bank_transfer",
        payeeName: "Electric Power Board",
        invoiceNumber: "ELEC-2026-99",
        receiptUrl: "https://res.cloudinary.com/salon/sample-bill.pdf",
        description: "Monthly electricity bill",
      };

      const res = await request(app)
        .post("/api/v1/expenses")
        .set("Authorization", `Bearer ${cashierToken}`)
        .set("X-Branch-Id", branchA._id.toString())
        .send(expensePayload);

      expect(res.status).toBe(201);
      expect(res.body.data.approvalStatus).toBe("pending_approval");
      expect(res.body.data.paymentStatus).toBe("settled"); // Paid externally
      expect(res.body.data.receiptUrl).toBe(expensePayload.receiptUrl);

      // Manager rejects expense
      const rejectRes = await request(app)
        .patch(`/api/v1/expenses/${res.body.data.id}/reject`)
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchA._id.toString())
        .send({ reason: "Duplicate invoice submitted by power board" });

      expect(rejectRes.status).toBe(200);
      expect(rejectRes.body.data.approvalStatus).toBe("rejected");
      expect(rejectRes.body.data.paymentStatus).toBe("settled");
      expect(rejectRes.body.data.receiptUrl).toBe(expensePayload.receiptUrl);
      expect(rejectRes.body.data.rejectionReason).toBe("Duplicate invoice submitted by power board");
    });
  });

  describe("5. Soft-Delete and Controlled Cash Recovery", () => {
    let expenseToRecover;
    let originalPayout;

    beforeAll(async () => {
      // Create and settle an expense of 2000
      const res = await request(app)
        .post("/api/v1/expenses")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchA._id.toString())
        .send({
          category: "consumables",
          amount: 2000,
          paymentMethod: "petty_cash",
          payeeName: "Beauty Supplies Direct",
          description: "Towels and disposable capes",
        });

      expenseToRecover = res.body.data;
      originalPayout = await PettyCashTransaction.findById(expenseToRecover.pettyCashTransactionId);
    });

    it("soft-deleting an expense marks isDeleted: true and NEVER alters the petty cash ledger", async () => {
      const balanceBefore = await request(app)
        .get("/api/v1/expenses/petty-cash/balance")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      const delRes = await request(app)
        .delete(`/api/v1/expenses/${expenseToRecover.id}`)
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(delRes.status).toBe(200);

      const balanceAfter = await request(app)
        .get("/api/v1/expenses/petty-cash/balance")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(balanceAfter.body.data.currentBalance).toBe(balanceBefore.body.data.currentBalance);
    });

    it("recovering cash creates payout_reversal and serializes concurrent/cumulative recovery up to amount", async () => {
      const recoveryKey1 = "REC_KEY_PARTIAL_1";
      const recPayload1 = {
        linkedExpenseId: expenseToRecover.id,
        originalPayoutId: originalPayout._id.toString(),
        recoveredAmount: 1200,
        reason: "Returned 3 boxes of unused capes",
      };

      const recRes1 = await request(app)
        .post("/api/v1/expenses/petty-cash/recover-payout")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchA._id.toString())
        .set("Idempotency-Key", recoveryKey1)
        .send(recPayload1);

      expect(recRes1.status).toBe(201);
      expect(recRes1.body.data.type).toBe("payout_reversal");
      expect(recRes1.body.data.amount).toBe(1200);

      // Attempting to recover 1000 more (1200 + 1000 = 2200 > 2000 original amount) fails with 400
      const recoveryKey2 = "REC_KEY_PARTIAL_2";
      const recPayload2 = {
        linkedExpenseId: expenseToRecover.id,
        originalPayoutId: originalPayout._id.toString(),
        recoveredAmount: 1000,
        reason: "Excess recovery attempt",
      };

      const recRes2 = await request(app)
        .post("/api/v1/expenses/petty-cash/recover-payout")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchA._id.toString())
        .set("Idempotency-Key", recoveryKey2)
        .send(recPayload2);

      expect(recRes2.status).toBe(400);
      expect(recRes2.body.message).toMatch(/Cumulative recovery exceeds original payout amount/i);

      // Recovering remaining exact balance of 800 succeeds
      const recoveryKey3 = "REC_KEY_PARTIAL_3";
      const recPayload3 = {
        linkedExpenseId: expenseToRecover.id,
        originalPayoutId: originalPayout._id.toString(),
        recoveredAmount: 800,
        reason: "Remaining items returned",
      };

      const recRes3 = await request(app)
        .post("/api/v1/expenses/petty-cash/recover-payout")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchA._id.toString())
        .set("Idempotency-Key", recoveryKey3)
        .send(recPayload3);

      expect(recRes3.status).toBe(201);
    });
  });

  describe("6. Branch Isolation", () => {
    it("cashier assigned to Branch A cannot access or mutate Branch B", async () => {
      const res = await request(app)
        .post("/api/v1/expenses")
        .set("Authorization", `Bearer ${cashierToken}`)
        .set("X-Branch-Id", branchB._id.toString())
        .send({
          category: "utilities",
          amount: 500,
          paymentMethod: "petty_cash",
          payeeName: "Branch B Vendor",
        });

      expect([400, 403]).toContain(res.status);
    });
  });
});
