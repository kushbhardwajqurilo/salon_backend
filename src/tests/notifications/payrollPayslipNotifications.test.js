import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { OutboxEvent } from "../../models/notifications/outboxEvent.model.js";
import { User } from "../../models/users/user.model.js";
import { emitPayslipPublishedOutboxEvent } from "../../services/payroll/payrollNotificationOutbox.service.js";
import { resolveRecipientsForEvent } from "../../services/notifications/recipientResolver.service.js";

describe("Stage 2G.2 — Payroll Payslip Published Notification Integration", () => {
  const orgId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();
  const payslipId = new mongoose.Types.ObjectId();
  const empUserId = new mongoose.Types.ObjectId();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("emits payroll.payslip_published with portalLinkOnly and zero confidential data", async () => {
    jest
      .spyOn(OutboxEvent, "create")
      .mockImplementation(async (doc) => ({ ...doc, _id: new mongoose.Types.ObjectId() }));

    const res = await emitPayslipPublishedOutboxEvent({
      payrollRecord: { _id: payslipId, branchId, netPay: 50000, bankAccount: "1234" },
      employeeUserId: empUserId,
      organizationId: orgId,
    });

    expect(res.created).toBe(true);
    expect(res.event.idempotencyKey).toBe(`payroll.payslip_published:${payslipId}`);
    expect(res.event.payload).toEqual({
      payslipId: String(payslipId),
      employeeUserId: String(empUserId),
      branchId: String(branchId),
      portalLinkOnly: true,
    });
    expect(res.event.payload.netPay).toBeUndefined();
    expect(res.event.payload.bankAccount).toBeUndefined();
  });

  it("excludes inactive employees in recipient resolution", async () => {
    jest.spyOn(User, "findOne").mockResolvedValue(null);

    const targets = await resolveRecipientsForEvent({
      organizationId: orgId,
      eventType: "payroll.payslip_published",
      payload: { employeeUserId: String(empUserId) },
    });

    expect(targets).toEqual([]);
  });

  it("logs and does not throw on best-effort outbox failure", async () => {
    jest.spyOn(OutboxEvent, "create").mockRejectedValue(new Error("Mongo timeout"));

    const res = await emitPayslipPublishedOutboxEvent({
      payrollRecord: { _id: payslipId, branchId },
      employeeUserId: empUserId,
      organizationId: orgId,
    });

    expect(res.error).toBe(true);
  });
});
