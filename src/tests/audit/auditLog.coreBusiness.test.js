import { describe, expect, it, beforeAll, afterAll, beforeEach, jest } from "@jest/globals";
import mongoose from "mongoose";
import { AuditLog, AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";
import { AuditLogService, buildBeforeAfterMetadata } from "../../services/audit/auditLog.service.js";
import { getIsolatedTestMongoUri } from "../testSetup.js";

describe("Core Business Modules Audit Persistence Verification", () => {
  jest.setTimeout(30000);

  const auditLogService = new AuditLogService();
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

  it("1. Customers: persists CUSTOMER_CREATED, CUSTOMER_UPDATED (before/after), and NOTE_ADDED", async () => {
    const customerId = new mongoose.Types.ObjectId();
    await auditLogService.createAuditLog(
      { action: AUDIT_ACTIONS.CUSTOMER_CREATED, entityType: "Customer", entityId: customerId, branchId, description: "Customer created" },
      orgId,
      actorId
    );
    await auditLogService.createAuditLog(
      {
        action: AUDIT_ACTIONS.CUSTOMER_UPDATED,
        entityType: "Customer",
        entityId: customerId,
        branchId,
        description: "Customer updated",
        metadata: buildBeforeAfterMetadata({ phone: "1111111111" }, { phone: "2222222222" }),
      },
      orgId,
      actorId
    );
    await auditLogService.createAuditLog(
      { action: AUDIT_ACTIONS.NOTE_ADDED, entityType: "CustomerNote", entityId: customerId, branchId, description: "Note added" },
      orgId,
      actorId
    );

    const updated = await AuditLog.findOne({ action: AUDIT_ACTIONS.CUSTOMER_UPDATED }).lean();
    expect(updated.metadata.before.phone).toBe("1111111111");
    expect(updated.metadata.after.phone).toBe("2222222222");
    expect(await AuditLog.countDocuments({ organizationId: orgId })).toBe(3);
  });

  it("2. Staff & HR: persists STAFF_CREATED, BRANCH_ASSIGNED, ATTENDANCE_ADJUSTED, LEAVE_APPROVED, INCENTIVE_BATCH_APPROVED", async () => {
    const staffId = new mongoose.Types.ObjectId();
    const actions = [
      [AUDIT_ACTIONS.STAFF_CREATED, "Staff"],
      [AUDIT_ACTIONS.BRANCH_ASSIGNED, "Staff"],
      [AUDIT_ACTIONS.ATTENDANCE_ADJUSTED, "Attendance"],
      [AUDIT_ACTIONS.LEAVE_APPROVED, "Leave"],
      [AUDIT_ACTIONS.INCENTIVE_BATCH_APPROVED, "Incentive"],
    ];
    for (const [action, entityType] of actions) {
      await auditLogService.createAuditLog(
        { action, entityType, entityId: staffId, branchId, description: `${action} recorded` },
        orgId,
        actorId
      );
    }
    expect(await AuditLog.countDocuments({ organizationId: orgId })).toBe(5);
  });

  it("3. Services & Pricing: persists SERVICE_CREATED and SERVICE_UPDATED with price diff", async () => {
    const serviceId = new mongoose.Types.ObjectId();
    await auditLogService.createAuditLog(
      { action: AUDIT_ACTIONS.SERVICE_CREATED, entityType: "Service", entityId: serviceId, branchId, description: "Service created" },
      orgId,
      actorId
    );
    await auditLogService.createAuditLog(
      {
        action: AUDIT_ACTIONS.SERVICE_UPDATED,
        entityType: "Service",
        entityId: serviceId,
        branchId,
        description: "Service price updated",
        metadata: buildBeforeAfterMetadata({ price: 500 }, { price: 650 }),
      },
      orgId,
      actorId
    );
    const log = await AuditLog.findOne({ action: AUDIT_ACTIONS.SERVICE_UPDATED }).lean();
    expect(log.metadata).toEqual({ before: { price: 500 }, after: { price: 650 } });
  });

  it("4. Appointments: persists APPOINTMENT_RESCHEDULED, APPOINTMENT_STAFF_REASSIGNED, APPOINTMENT_COMPLETED", async () => {
    const apptId = new mongoose.Types.ObjectId();
    for (const action of [
      AUDIT_ACTIONS.APPOINTMENT_RESCHEDULED,
      AUDIT_ACTIONS.APPOINTMENT_STAFF_REASSIGNED,
      AUDIT_ACTIONS.APPOINTMENT_COMPLETED,
    ]) {
      await auditLogService.createAuditLog(
        { action, entityType: "Appointment", entityId: apptId, branchId, description: action },
        orgId,
        actorId
      );
    }
    expect(await AuditLog.countDocuments({ entityType: "Appointment", entityId: apptId })).toBe(3);
  });

  it("5. Billing & POS: persists INVOICE_CREATED, PAYMENT_RECORDED, PAYMENT_VOIDED, INVOICE_RETURN_PROCESSED", async () => {
    const invoiceId = new mongoose.Types.ObjectId();
    for (const [action, entityType] of [
      [AUDIT_ACTIONS.INVOICE_CREATED, "Invoice"],
      [AUDIT_ACTIONS.PAYMENT_RECORDED, "Payment"],
      [AUDIT_ACTIONS.PAYMENT_VOIDED, "Payment"],
      [AUDIT_ACTIONS.INVOICE_RETURN_PROCESSED, "Invoice"],
    ]) {
      await auditLogService.createAuditLog(
        { action, entityType, entityId: invoiceId, branchId, description: action },
        orgId,
        actorId
      );
    }
    expect(await AuditLog.countDocuments({ organizationId: orgId })).toBe(4);
  });

  it("6. Inventory: persists consumable and retail stock operations", async () => {
    const productId = new mongoose.Types.ObjectId();
    for (const action of [
      AUDIT_ACTIONS.INVENTORY_PRODUCT_CREATED,
      AUDIT_ACTIONS.INVENTORY_CONSUMED,
      AUDIT_ACTIONS.INVENTORY_ADJUSTED,
      AUDIT_ACTIONS.INVENTORY_STOCKTAKE,
    ]) {
      await auditLogService.createAuditLog(
        { action, entityType: "Inventory", entityId: productId, branchId, description: action },
        orgId,
        actorId
      );
    }
    expect(await AuditLog.countDocuments({ entityType: "Inventory", entityId: productId })).toBe(4);
  });

  it("7. Procurement: persists PROCUREMENT_SUPPLIER_CREATED, PROCUREMENT_ORDER_CREATED, PROCUREMENT_GOODS_RECEIVED", async () => {
    const poId = new mongoose.Types.ObjectId();
    for (const action of [
      AUDIT_ACTIONS.PROCUREMENT_SUPPLIER_CREATED,
      AUDIT_ACTIONS.PROCUREMENT_ORDER_CREATED,
      AUDIT_ACTIONS.PROCUREMENT_GOODS_RECEIVED,
    ]) {
      await auditLogService.createAuditLog(
        { action, entityType: "Procurement", entityId: poId, branchId, description: action },
        orgId,
        actorId
      );
    }
    expect(await AuditLog.countDocuments({ entityType: "Procurement", entityId: poId })).toBe(3);
  });

  it("8. Memberships, Subscriptions & Loyalty: persists distinct domain events", async () => {
    const id = new mongoose.Types.ObjectId();
    for (const [action, entityType] of [
      [AUDIT_ACTIONS.MEMBERSHIP_CREATED, "Membership"],
      [AUDIT_ACTIONS.SUBSCRIPTION_CREATED, "Subscription"],
      [AUDIT_ACTIONS.SUBSCRIPTION_REDEEMED, "Subscription"],
      [AUDIT_ACTIONS.LOYALTY_POINTS_ADJUSTED, "Loyalty"],
    ]) {
      await auditLogService.createAuditLog(
        { action, entityType, entityId: id, branchId, description: action },
        orgId,
        actorId
      );
    }
    expect(await AuditLog.countDocuments({ organizationId: orgId })).toBe(4);
  });

  it("9. Settings: persists ORGANIZATION_SETTINGS_UPDATED and BRANCH_SETTINGS_UPDATED with before/after", async () => {
    await auditLogService.createAuditLog(
      {
        action: AUDIT_ACTIONS.ORGANIZATION_SETTINGS_UPDATED,
        entityType: "Settings",
        entityId: orgId,
        description: "Org settings updated",
        metadata: buildBeforeAfterMetadata({ currency: "INR" }, { currency: "USD" }),
      },
      orgId,
      actorId
    );
    await auditLogService.createAuditLog(
      {
        action: AUDIT_ACTIONS.BRANCH_SETTINGS_UPDATED,
        entityType: "Settings",
        entityId: branchId,
        branchId,
        description: "Branch settings updated",
        metadata: buildBeforeAfterMetadata({ taxRate: 18 }, { taxRate: 12 }),
      },
      orgId,
      actorId
    );
    const branchLog = await AuditLog.findOne({ action: AUDIT_ACTIONS.BRANCH_SETTINGS_UPDATED }).lean();
    expect(branchLog.metadata).toEqual({ before: { taxRate: 18 }, after: { taxRate: 12 } });
  });
});
