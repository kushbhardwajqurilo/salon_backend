import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { OutboxEvent } from "../../models/notifications/outboxEvent.model.js";
import { User } from "../../models/users/user.model.js";
import { emitLeaveStatusOutboxEvent } from "../../services/leaves/leaveNotificationOutbox.service.js";
import { resolveRecipientsForEvent } from "../../services/notifications/recipientResolver.service.js";

describe("Stage 2G.1 — Leave Status Notification Integration", () => {
  const orgId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();
  const leaveId = new mongoose.Types.ObjectId();
  const empUserId = new mongoose.Types.ObjectId();
  const fakeSession = { id: "tx-leave" };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("emits leave.approved, leave.rejected, and leave.cancelled with session and minimal payload", async () => {
    const createSpy = jest
      .spyOn(OutboxEvent, "create")
      .mockImplementation(async (docs) => [{ ...docs[0], _id: new mongoose.Types.ObjectId() }]);

    for (const [eventType, status] of [
      ["leave.approved", "approved"],
      ["leave.rejected", "rejected"],
      ["leave.cancelled", "cancelled"],
    ]) {
      const res = await emitLeaveStatusOutboxEvent({
        eventType,
        leave: {
          _id: leaveId,
          branchId,
          userId: empUserId,
          status,
          reason: "Private medical reason",
        },
        organizationId: orgId,
        session: fakeSession,
      });

      expect(res.created).toBe(true);
      expect(res.persistenceMode).toBe("transactional");
      expect(res.event.idempotencyKey).toBe(`${eventType}:${leaveId}`);
      expect(res.event.payload).toEqual({
        leaveId: String(leaveId),
        employeeUserId: String(empUserId),
        status,
        branchId: String(branchId),
      });
      expect(res.event.payload.reason).toBeUndefined();
    }

    expect(createSpy).toHaveBeenCalledTimes(3);
  });

  it("resolves active employee recipient with operational purpose (never customer or marketing)", async () => {
    jest.spyOn(User, "findOne").mockResolvedValue({
      _id: empUserId,
      email: "emp@salon.com",
      isActive: true,
    });

    const targets = await resolveRecipientsForEvent({
      organizationId: orgId,
      eventType: "leave.approved",
      payload: { employeeUserId: String(empUserId) },
    });

    expect(targets).toHaveLength(1);
    expect(targets[0].recipientType).toBe("employee");
    expect(targets[0].purpose).toBe("operational");
  });
});
