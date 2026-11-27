import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { OutboxEvent } from "../../models/notifications/outboxEvent.model.js";
import { User } from "../../models/users/user.model.js";
import { emitAttendanceOutboxEvent } from "../../services/attendance/attendanceNotificationOutbox.service.js";
import { resolveRecipientsForEvent } from "../../services/notifications/recipientResolver.service.js";

describe("Stage 2G.3 — Attendance Notification Integration", () => {
  const orgId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();
  const attId = new mongoose.Types.ObjectId();
  const empUserId = new mongoose.Types.ObjectId();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("emits attendance.marked and attendance.corrected with minimal payload and deterministic key", async () => {
    jest
      .spyOn(OutboxEvent, "create")
      .mockImplementation(async (doc) => ({ ...doc, _id: new mongoose.Types.ObjectId() }));

    const marked = await emitAttendanceOutboxEvent({
      eventType: "attendance.marked",
      attendance: { _id: attId, branchId, rawProviderPayload: { biometric: "secret" } },
      employeeUserId: empUserId,
      organizationId: orgId,
      operationId: "2026-11-26",
    });

    expect(marked.created).toBe(true);
    expect(marked.event.idempotencyKey).toBe(`attendance.marked:${attId}:2026-11-26`);
    expect(marked.event.payload).toEqual({
      attendanceId: String(attId),
      employeeUserId: String(empUserId),
      branchId: String(branchId),
    });
    expect(marked.event.payload.rawProviderPayload).toBeUndefined();

    const corrected = await emitAttendanceOutboxEvent({
      eventType: "attendance.corrected",
      attendance: { _id: attId, branchId },
      employeeUserId: empUserId,
      organizationId: orgId,
      operationId: "corr-1",
    });
    expect(corrected.created).toBe(true);
    expect(corrected.event.idempotencyKey).toBe(`attendance.corrected:${attId}:corr-1`);
  });

  it("handles duplicate provider retries idempotently", async () => {
    jest.spyOn(OutboxEvent, "create").mockRejectedValue({ code: 11000 });
    jest.spyOn(OutboxEvent, "findOne").mockResolvedValue({ eventId: "existing-att" });

    const res = await emitAttendanceOutboxEvent({
      eventType: "attendance.marked",
      attendance: { _id: attId, branchId },
      employeeUserId: empUserId,
      organizationId: orgId,
      operationId: "2026-11-26",
    });

    expect(res.created).toBe(false);
    expect(res.duplicate).toBe(true);
  });

  it("resolves active employee with operational purpose", async () => {
    jest.spyOn(User, "findOne").mockResolvedValue({ _id: empUserId, email: "emp@salon.com", isActive: true });

    const targets = await resolveRecipientsForEvent({
      organizationId: orgId,
      eventType: "attendance.marked",
      payload: { employeeUserId: String(empUserId) },
    });

    expect(targets).toHaveLength(1);
    expect(targets[0].recipientType).toBe("employee");
    expect(targets[0].purpose).toBe("operational");
  });
});
