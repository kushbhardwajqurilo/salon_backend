import { describe, expect, it, beforeAll, afterAll, beforeEach, jest } from "@jest/globals";
import mongoose from "mongoose";
import { AuditLog, AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";
import { AuditLogService } from "../../services/audit/auditLog.service.js";
import { AuthService } from "../../services/auth/auth.service.js";
import * as rbacController from "../../controllers/rbac/rbac.controller.js";
import { RoleService } from "../../services/roles/role.service.js";
import * as branchController from "../../controllers/branches/branch.controller.js";
import { Branch } from "../../models/branches/branch.model.js";
import { runStockReservationExpiryPass } from "../../workers/stockReservationExpiry.worker.js";
import { inventoryService } from "../../services/inventory/inventory.service.js";
import { runSubscriptionReconciliationPass } from "../../workers/subscriptionReconciliation.worker.js";
import { subscriptionService } from "../../services/subscriptions/subscription.service.js";
import { getIsolatedTestMongoUri } from "../testSetup.js";

const mockRes = () => {
  const res = {
    statusCode: 200,
    body: null,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(p) {
      this.body = p;
      return this;
    },
  };
  return res;
};

describe("Remaining Audit Module Integration Coverage", () => {
  jest.setTimeout(30000);

  const orgId = new mongoose.Types.ObjectId();
  const actorId = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    const uri = getIsolatedTestMongoUri("audit_test");
    await mongoose.connect(uri);
    await AuditLog.syncIndexes();
  });

  afterAll(async () => {
    await AuditLog.collection.deleteMany({});
    await Branch.deleteMany({ organizationId: orgId });
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await AuditLog.collection.deleteMany({});
  });

  describe("1. RBAC & Branches", () => {
    it("records ROLE_CREATED, ROLE_PERMISSIONS_UPDATED, ROLE_DELETED", async () => {
      const roleId = new mongoose.Types.ObjectId();
      jest.spyOn(RoleService.prototype, "createRole").mockResolvedValue({ _id: roleId, name: "cashier" });
      jest.spyOn(RoleService.prototype, "assignPermissionsToRole").mockResolvedValue({ _id: roleId, name: "cashier", organizationId: orgId });
      jest.spyOn(RoleService.prototype, "deleteRole").mockResolvedValue({ _id: roleId, name: "cashier", organizationId: orgId });

      const req = {
        organizationId: orgId,
        user: { _id: actorId, id: actorId },
        params: { roleId: roleId.toString() },
        body: { name: "cashier", permissions: ["billing.view"] },
        headers: {},
        ip: "127.0.0.1",
      };

      await rbacController.createRole(req, mockRes(), jest.fn());
      await rbacController.assignPermissionsToRole(req, mockRes(), jest.fn());
      await rbacController.deleteRole(req, mockRes(), jest.fn());

      expect(await AuditLog.countDocuments({ action: AUDIT_ACTIONS.ROLE_CREATED })).toBe(1);
      expect(await AuditLog.countDocuments({ action: AUDIT_ACTIONS.ROLE_PERMISSIONS_UPDATED })).toBe(1);
      expect(await AuditLog.countDocuments({ action: AUDIT_ACTIONS.ROLE_DELETED })).toBe(1);
    });

    it("records BRANCH_CREATED and BRANCH_UPDATED with before/after metadata", async () => {
      const reqCreate = {
        user: { organizationId: orgId, userId: actorId },
        body: { name: "Downtown Branch", address: "123 Main St", phone: "9999999999" },
        headers: {},
        ip: "127.0.0.1",
      };
      const resCreate = mockRes();
      await branchController.createBranch(reqCreate, resCreate, jest.fn());
      const branchId = resCreate.body.data.id;

      const reqUpdate = {
        params: { id: branchId },
        user: { organizationId: orgId, userId: actorId },
        body: { name: "Uptown Branch" },
        headers: {},
        ip: "127.0.0.1",
      };
      await branchController.updateBranch(reqUpdate, mockRes(), jest.fn());

      const updatedLog = await AuditLog.findOne({ action: AUDIT_ACTIONS.BRANCH_UPDATED }).lean();
      expect(updatedLog).toBeTruthy();
      expect(updatedLog.metadata.before.name).toBe("Downtown Branch");
      expect(updatedLog.metadata.after.name).toBe("Uptown Branch");
    });
  });

  describe("2. Auth Lifecycle", () => {
    it("records AUTH_ACCOUNT_LOCKED on 5th failed login and AUTH_LOGOUT_ALL without secrets", async () => {
      const userDoc = {
        _id: actorId,
        organizationId: orgId,
        status: "active",
        failedLoginAttempts: 4,
        comparePassword: jest.fn().mockResolvedValue(false),
        save: jest.fn().mockResolvedValue(true),
      };
      const userRepo = {
        findByEmailOrUsername: jest.fn().mockResolvedValue(userDoc),
        findById: jest.fn().mockResolvedValue(userDoc),
      };
      const sessionRepo = { invalidateAllUserSessions: jest.fn().mockResolvedValue(true) };
      const authService = new AuthService(userRepo, {}, sessionRepo, new AuditLogService(), {});

      await expect(authService.login("staff@salon.com", "WrongPass!", "127.0.0.1", "Jest")).rejects.toThrow();
      await authService.logoutAllDevices(actorId);

      const locked = await AuditLog.findOne({ action: AUDIT_ACTIONS.AUTH_ACCOUNT_LOCKED }).lean();
      const logoutAll = await AuditLog.findOne({ action: AUDIT_ACTIONS.AUTH_LOGOUT_ALL }).lean();
      expect(locked).toBeTruthy();
      expect(locked.metadata.locked).toBe(true);
      expect(JSON.stringify(locked.metadata)).not.toContain("WrongPass!");
      expect(logoutAll).toBeTruthy();
    });
  });

  describe("3. Remaining Background Workers", () => {
    it("records STOCK_RESERVATION_EXPIRED and SUBSCRIPTION_RECONCILED with background_job actor", async () => {
      jest.spyOn(inventoryService, "cleanupExpiredReservations").mockResolvedValue({ processedCount: 3 });
      jest.spyOn(subscriptionService, "reconcileIncompleteRedemptions").mockResolvedValue({
        inspected: 2,
        reconciledCompleted: 1,
        reconciledRestored: 1,
        errors: 0,
      });

      await runStockReservationExpiryPass(10);
      await runSubscriptionReconciliationPass();

      const stockLog = await AuditLog.findOne({ action: AUDIT_ACTIONS.STOCK_RESERVATION_EXPIRED }).lean();
      const subLog = await AuditLog.findOne({ action: AUDIT_ACTIONS.SUBSCRIPTION_RECONCILED }).lean();

      expect(stockLog.actorType).toBe("background_job");
      expect(stockLog.source).toBe("scheduled_job");
      expect(stockLog.metadata.processedCount).toBe(3);

      expect(subLog.actorType).toBe("background_job");
      expect(subLog.source).toBe("scheduled_job");
      expect(subLog.metadata.inspected).toBe(2);
    });
  });
});
