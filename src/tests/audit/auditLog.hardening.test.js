import { jest } from "@jest/globals";
import { AuditLog } from "../../models/audit/auditLog.model.js";
import {
  AuditLogService,
  sanitizeAuditMetadata,
  buildBeforeAfterMetadata,
} from "../../services/audit/auditLog.service.js";

describe("AuditLog Production Hardening", () => {
  test("sanitizeAuditMetadata redacts nested sensitive fields", () => {
    const input = {
      email: "user@example.com",
      password: "secretPassword",
      nested: {
        otp: "123456",
        refreshToken: "rt_abc",
        safeField: "ok",
      },
    };
    const sanitized = sanitizeAuditMetadata(input);
    expect(sanitized.email).toBe("user@example.com");
    expect(sanitized.password).toBe("[REDACTED]");
    expect(sanitized.nested.otp).toBe("[REDACTED]");
    expect(sanitized.nested.refreshToken).toBe("[REDACTED]");
    expect(sanitized.nested.safeField).toBe("ok");
  });

  test("buildBeforeAfterMetadata captures only changed fields", () => {
    const diff = buildBeforeAfterMetadata(
      { amount: 1000, status: "pending", note: "same" },
      { amount: 1500, status: "approved", note: "same" }
    );
    expect(diff).toEqual({
      before: { amount: 1000, status: "pending" },
      after: { amount: 1500, status: "approved" },
    });
  });

  test("AuditLog model enforces append-only immutability on update and delete hooks", async () => {
    await expect(AuditLog.updateOne({}, { description: "tamper" })).rejects.toThrow(
      "AuditLog records are immutable and append-only"
    );
    await expect(AuditLog.updateMany({}, { description: "tamper" })).rejects.toThrow(
      "AuditLog records are immutable and append-only"
    );
    await expect(AuditLog.findOneAndUpdate({}, { description: "tamper" })).rejects.toThrow(
      "AuditLog records are immutable and append-only"
    );
    await expect(AuditLog.deleteOne({})).rejects.toThrow(
      "AuditLog records are immutable and append-only"
    );
    await expect(AuditLog.deleteMany({})).rejects.toThrow(
      "AuditLog records are immutable and append-only"
    );
    await expect(AuditLog.findOneAndDelete({})).rejects.toThrow(
      "AuditLog records are immutable and append-only"
    );
  });

  test("AuditLogService.createAuditLog propagates persistence errors and forwards session", async () => {
    const fakeSession = { id: "session_1" };
    const mockRepo = {
      create: jest.fn().mockResolvedValue({ _id: "log_1" }),
    };
    const service = new AuditLogService(mockRepo);

    await service.createAuditLog(
      { action: "EXPENSE_CREATED", entityType: "Expense", description: "Created" },
      "org_1",
      "user_1",
      fakeSession
    );

    expect(mockRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ action: "EXPENSE_CREATED" }),
      "org_1",
      "user_1",
      fakeSession
    );

    const failingRepo = {
      create: jest.fn().mockRejectedValue(new Error("DB write failed")),
    };
    const failingService = new AuditLogService(failingRepo);
    await expect(
      failingService.createAuditLog(
        { action: "EXPENSE_CREATED", entityType: "Expense", description: "Created" },
        "org_1",
        "user_1",
        fakeSession
      )
    ).rejects.toThrow("DB write failed");
  });

  test("AuditLogService handles duplicate-key 11000 only when caller explicitly treats it as idempotent", async () => {
    const dupErr = Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
    const dupRepo = { create: jest.fn().mockRejectedValue(dupErr) };
    const service = new AuditLogService(dupRepo);

    await expect(
      service.createAuditLog(
        {
          action: "SUBSCRIPTION_AUTO_CANCELLED",
          entityType: "Subscription",
          entityId: "op_1",
          metadata: { idempotencyKey: "sub_cancel_op_1" },
        },
        "org_1",
        null
      )
    ).rejects.toThrow("E11000 duplicate key error");
  });
});
