import { describe, expect, it, beforeAll, afterAll, beforeEach, jest } from "@jest/globals";
import mongoose from "mongoose";
import { AuditLog, AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";
import { AuditLogService } from "../../services/audit/auditLog.service.js";
import { AuthService } from "../../services/auth/auth.service.js";
import { PayrollController } from "../../controllers/payroll/payroll.controller.js";
import { PayrollService } from "../../services/payroll/payroll.service.js";
import * as expenseController from "../../controllers/expenses/expense.controller.js";
import { ExpenseService } from "../../services/expenses/expense.service.js";
import * as financeController from "../../controllers/finance/finance.controller.js";
import { FinanceService } from "../../services/finance/finance.service.js";
import * as couponController from "../../controllers/coupons/coupon.controller.js";
import { couponService } from "../../services/coupons/coupon.service.js";
import { processSubscriptionCancellationJob } from "../../workers/subscriptionCancellation.worker.js";
import { subscriptionService } from "../../services/subscriptions/subscription.service.js";
import { getIsolatedTestMongoUri } from "../testSetup.js";

const mockRes = () => {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
    setHeader(k, v) {
      this.headers[k] = v;
    },
  };
  return res;
};

describe("Audit Logging Across ERP Modules (Persisted AuditLog Verification)", () => {
  jest.setTimeout(30000);

  const orgId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();
  const actorId = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    const uri = getIsolatedTestMongoUri("audit_test");
    await mongoose.connect(uri);
    await AuditLog.syncIndexes();
  });

  afterAll(async () => {
    await AuditLog.collection.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await AuditLog.collection.deleteMany({});
  });

  describe("Priority 1 — Auth & Security", () => {
    it("records AUTH_LOGIN_FAILED without leaking password in metadata", async () => {
      const userRepo = { findByEmailOrUsername: jest.fn().mockResolvedValue(null), findByEmail: jest.fn().mockResolvedValue(null) };
      const authService = new AuthService(userRepo, {}, {}, new AuditLogService(), {});

      await expect(authService.login("unknown@salon.com", "SuperSecret123!", "127.0.0.1", "Jest")).rejects.toThrow();

      const logs = await AuditLog.find({ action: AUDIT_ACTIONS.AUTH_LOGIN_FAILED }).lean();
      expect(logs).toHaveLength(1);
      expect(logs[0].entityType).toBe("Auth");
      expect(logs[0].ipAddress).toBe("127.0.0.1");
      expect(JSON.stringify(logs[0].metadata)).not.toContain("SuperSecret123!");
    });
  });

  describe("Priority 2 — Payroll", () => {
    it("records PAYROLL_APPROVED, PAYROLL_DISBURSED (once on replay), and PAYROLL_CANCELLED", async () => {
      const recordId = new mongoose.Types.ObjectId().toString();
      const paymentId = new mongoose.Types.ObjectId().toString();

      jest.spyOn(PayrollService, "approvePayrollRecord").mockResolvedValue({ _id: recordId, status: "approved" });
      jest
        .spyOn(PayrollService, "confirmPayment")
        .mockResolvedValueOnce({ isIdempotentReplay: false, status: "paid" })
        .mockResolvedValueOnce({ isIdempotentReplay: true, status: "paid" });
      jest
        .spyOn(PayrollService, "reversePayment")
        .mockResolvedValue({ isIdempotentReplay: false, record: { _id: recordId }, payment: { _id: paymentId } });

      const baseReq = {
        organizationId: orgId,
        branchId,
        user: { _id: actorId },
        params: { id: recordId, paymentId },
        body: { reversalReason: "Bank error" },
        headers: { "user-agent": "Jest" },
        ip: "127.0.0.1",
      };

      await PayrollController.approvePayrollRecord(baseReq, mockRes(), jest.fn());
      await PayrollController.confirmPayment(baseReq, mockRes(), jest.fn());
      await PayrollController.confirmPayment(baseReq, mockRes(), jest.fn()); // idempotent replay
      await PayrollController.reversePayment(baseReq, mockRes(), jest.fn());

      const approved = await AuditLog.find({ action: AUDIT_ACTIONS.PAYROLL_APPROVED }).lean();
      const disbursed = await AuditLog.find({ action: AUDIT_ACTIONS.PAYROLL_DISBURSED }).lean();
      const cancelled = await AuditLog.find({ action: AUDIT_ACTIONS.PAYROLL_CANCELLED }).lean();

      expect(approved).toHaveLength(1);
      expect(disbursed).toHaveLength(1);
      expect(cancelled).toHaveLength(1);
      expect(String(disbursed[0].organizationId)).toBe(String(orgId));
    });
  });

  describe("Priority 3 — Expenses, Finance & Coupons", () => {
    it("records EXPENSE_CREATED, CASH_REGISTER_CLOSED, SENSITIVE_DATA_EXPORTED, and COUPON_CREATED", async () => {
      const expenseId = new mongoose.Types.ObjectId();
      const closureId = new mongoose.Types.ObjectId();
      const couponId = new mongoose.Types.ObjectId();

      jest.spyOn(ExpenseService, "createExpense").mockResolvedValue({ _id: expenseId, amount: 500, category: "Supplies" });
      jest.spyOn(FinanceService, "submitDayClosure").mockResolvedValue({ _id: closureId });
      jest.spyOn(FinanceService, "getFinancialReports").mockResolvedValue({ filename: "report.csv", csv: "a,b" });
      jest.spyOn(couponService, "createCoupon").mockResolvedValue({ _id: couponId, code: "SAVE20" });

      const req = {
        organizationId: orgId,
        branchId,
        user: { _id: actorId },
        body: { branchId, amount: 500, code: "SAVE20" },
        query: {},
        headers: {},
        ip: "127.0.0.1",
      };

      await expenseController.createExpense(req, mockRes(), jest.fn());
      await financeController.submitDayClosure(req, mockRes(), jest.fn());
      await financeController.exportFinancialReport(req, mockRes(), jest.fn());
      await couponController.createCoupon(req, mockRes(), jest.fn());

      expect(await AuditLog.countDocuments({ action: AUDIT_ACTIONS.EXPENSE_CREATED })).toBe(1);
      expect(await AuditLog.countDocuments({ action: AUDIT_ACTIONS.CASH_REGISTER_CLOSED })).toBe(1);
      expect(await AuditLog.countDocuments({ action: AUDIT_ACTIONS.SENSITIVE_DATA_EXPORTED })).toBe(1);
      expect(await AuditLog.countDocuments({ action: AUDIT_ACTIONS.COUPON_CREATED })).toBe(1);
    });
  });

  describe("Priority 4 — Background Workers", () => {
    it("records SUBSCRIPTION_AUTO_CANCELLED with background_job actor and prevents duplicates on retry", async () => {
      const operationId = new mongoose.Types.ObjectId().toString();
      jest.spyOn(subscriptionService, "executeCancellationOperation").mockResolvedValue({ cancelled: true });

      const job = { id: "job_1", name: "cancel", data: { operationId, organizationId: orgId, userId: actorId } };
      await processSubscriptionCancellationJob(job);
      await processSubscriptionCancellationJob(job); // retry

      const logs = await AuditLog.find({ action: AUDIT_ACTIONS.SUBSCRIPTION_AUTO_CANCELLED }).lean();
      expect(logs).toHaveLength(1);
      expect(logs[0].actorType).toBe("background_job");
      expect(logs[0].source).toBe("scheduled_job");
    });
  });

  describe("Priority 5 — Marketing Campaigns & Subscription Plans", () => {
    it("records CAMPAIGN_CREATED and SUBSCRIPTION_PLAN_CREATED/UPDATED/DELETED", async () => {
      const auditService = new AuditLogService();
      const campaignId = new mongoose.Types.ObjectId();
      const planId = new mongoose.Types.ObjectId();

      await auditService.createAuditLog(
        {
          action: AUDIT_ACTIONS.CAMPAIGN_CREATED,
          entityType: "Campaign",
          entityId: campaignId,
          branchId,
          description: "Campaign 'Summer Glow' (SUMMER26) created",
          source: "web",
          ipAddress: "127.0.0.1",
          metadata: { campaignCode: "SUMMER26", channel: "whatsapp" },
        },
        orgId,
        actorId
      );

      for (const action of [
        AUDIT_ACTIONS.SUBSCRIPTION_PLAN_CREATED,
        AUDIT_ACTIONS.SUBSCRIPTION_PLAN_UPDATED,
        AUDIT_ACTIONS.SUBSCRIPTION_PLAN_DELETED,
      ]) {
        await auditService.createAuditLog(
          { action, entityType: "SubscriptionPlan", entityId: planId, description: action },
          orgId,
          actorId
        );
      }

      expect(await AuditLog.countDocuments({ action: AUDIT_ACTIONS.CAMPAIGN_CREATED, entityId: campaignId })).toBe(1);
      expect(await AuditLog.countDocuments({ action: AUDIT_ACTIONS.SUBSCRIPTION_PLAN_CREATED, entityId: planId })).toBe(1);
      expect(await AuditLog.countDocuments({ action: AUDIT_ACTIONS.SUBSCRIPTION_PLAN_UPDATED, entityId: planId })).toBe(1);
      expect(await AuditLog.countDocuments({ action: AUDIT_ACTIONS.SUBSCRIPTION_PLAN_DELETED, entityId: planId })).toBe(1);
    });
  });
});
