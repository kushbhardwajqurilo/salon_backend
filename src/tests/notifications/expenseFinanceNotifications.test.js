import { jest } from "@jest/globals";
import mongoose from "mongoose";

import { VERIFIED_EVENT_TYPES } from "../../services/notifications/notificationEventContract.js";
import { resolveRecipientsForEvent } from "../../services/notifications/recipientResolver.service.js";
import { resolveAndRenderNotificationTemplate } from "../../services/notifications/notificationTemplate.service.js";
import { NotificationTemplate } from "../../models/notifications/notificationTemplate.model.js";
import { OrganizationSettings } from "../../models/settings/organizationSettings.model.js";
import { Role } from "../../models/roles/role.model.js";
import { User } from "../../models/users/user.model.js";
import { OutboxEvent } from "../../models/notifications/outboxEvent.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { emitExpenseOutboxEvent } from "../../services/expenses/expenseNotificationOutbox.service.js";
import { emitFinanceDayClosureOutboxEvent } from "../../services/finance/financeNotificationOutbox.service.js";

describe("Expense & Finance Notification Integration", () => {
  afterEach(() => jest.restoreAllMocks());

  it("adds the verified expense and finance events", () => {
    for (const eventType of [
      "expense.submitted",
      "expense.approved",
      "expense.rejected",
      "expense.payout_reversed",
      "finance.day_closure_submitted",
      "finance.day_closure_approved",
    ]) {
      expect(VERIFIED_EVENT_TYPES).toContain(eventType);
    }
  });

  it("renders operational and approval templates without financial secrets", async () => {
    const orgId = new mongoose.Types.ObjectId();
    jest.spyOn(OrganizationSettings, "findOne").mockReturnValue({
      lean: jest.fn().mockResolvedValue({ profile: { displayName: "GLAM SALOON" } }),
    });
    jest.spyOn(NotificationTemplate, "findOne").mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    });

    const submitted = await resolveAndRenderNotificationTemplate({
      organizationId: orgId,
      eventType: "expense.submitted",
      channel: "email",
      variables: { expenseCode: "EXP-001", bankAccount: "123456", salary: 50000 },
    });
    expect(submitted.body).toContain("EXP-001");
    expect(submitted.body).not.toContain("123456");
    expect(submitted.body).not.toContain("50000");

    const approved = await resolveAndRenderNotificationTemplate({
      organizationId: orgId,
      eventType: "expense.approved",
      channel: "email",
      variables: { employeeName: "Asha", expenseCode: "EXP-001" },
    });
    expect(approved.body).toContain("Asha");
  });

  it("resolves expense and finance recipients only through permissioned staff roles", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    const roleId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();

    jest.spyOn(Role, "find").mockReturnValue({
      populate: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([{
          _id: roleId,
          permissions: [{ name: "expenses.update" }],
        }]),
      }),
    });
    jest.spyOn(User, "find").mockReturnValue({
      lean: jest.fn().mockResolvedValue([{
        _id: userId,
        name: "Manager",
        email: "manager@example.com",
        organizationId: orgId,
        status: "active",
      }]),
    });

    const targets = await resolveRecipientsForEvent({
      organizationId: orgId,
      branchId,
      eventType: "expense.submitted",
      payload: { expenseId: new mongoose.Types.ObjectId().toString() },
    });

    expect(targets).toHaveLength(1);
    expect(targets[0].recipientType).toBe("staff");
    expect(targets[0].recipientId).toBe(userId);
    expect(targets[0].purpose).toBe("operational");
    expect(targets[0].channels).toEqual(["in_app", "email"]);
  });

  it("emits expense events with branch scope and stable business idempotency", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    const expenseId = new mongoose.Types.ObjectId();
    const session = { id: "expense-session" };

    jest.spyOn(OutboxEvent, "create").mockImplementation(async (docs) => [
      { ...docs[0], _id: new mongoose.Types.ObjectId() },
    ]);
    jest.spyOn(Branch, "exists").mockReturnValue({
      session: jest.fn().mockResolvedValue({ _id: branchId }),
    });

    await emitExpenseOutboxEvent({
      eventType: "expense.approved",
      expense: {
        _id: expenseId,
        organizationId: orgId,
        branchId,
        expenseCode: "EXP-001",
        recordedBy: new mongoose.Types.ObjectId(),
      },
      operationId: "approved",
      session,
    });

    const [docs, options] = OutboxEvent.create.mock.calls[0];
    expect(docs[0]).toEqual(expect.objectContaining({
      organizationId: orgId,
      branchId,
      eventType: "expense.approved",
      idempotencyKey: `expense.approved:${expenseId}:approved`,
    }));
    expect(docs[0].payload).not.toHaveProperty("amount");
    expect(docs[0].payload).not.toHaveProperty("bankAccount");
    expect(options).toEqual({ session });
  });

  it("emits day closure events without reconciliation or financial details", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    const closureId = new mongoose.Types.ObjectId();

    const createSpy = jest.spyOn(OutboxEvent, "create").mockImplementation(async (doc) => doc);

    for (const eventType of ["finance.day_closure_submitted", "finance.day_closure_approved"]) {
      await emitFinanceDayClosureOutboxEvent({
        eventType,
        closure: {
          _id: closureId,
          organizationId: orgId,
          branchId,
          businessDate: "2026-11-27",
          reconciliationResult: "discrepant",
          systemTotals: { cash: 1000, totalCollected: 2000 },
          physicalCounts: { cash: 900 },
          discrepancy: { cashDelta: -100, reason: "Confidential review detail" },
          managerNotes: "Internal notes",
        },
      });

      const doc = createSpy.mock.calls.at(-1)[0];
      expect(doc.idempotencyKey).toBe(`${eventType}:${closureId}`);
      expect(doc.payload).toEqual({
        closureId: String(closureId),
        businessDate: "2026-11-27",
        reconciliationResult: "discrepant",
      });
      expect(JSON.stringify(doc.payload)).not.toMatch(/1000|2000|900|Confidential|Internal notes/);
    }
  });

  it("returns without a notification on best-effort outbox failure", async () => {
    jest.spyOn(OutboxEvent, "create").mockRejectedValue(new Error("Outbox down"));

    await expect(emitExpenseOutboxEvent({
      eventType: "expense.submitted",
      expense: {
        _id: new mongoose.Types.ObjectId(),
        organizationId: new mongoose.Types.ObjectId(),
        branchId: new mongoose.Types.ObjectId(),
        expenseCode: "EXP-002",
      },
      operationId: "created",
      session: null,
    })).resolves.toBeNull();
  });
});
