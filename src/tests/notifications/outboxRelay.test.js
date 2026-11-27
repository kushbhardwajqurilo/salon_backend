import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { OutboxEvent } from "../../models/notifications/outboxEvent.model.js";
import { Appointment } from "../../models/appointments/appointment.model.js";
import { notificationQueue } from "../../queues/client.js";
import {
  claimPendingOutboxEvents,
  recoverStaleProcessingClaims,
  publishClaimedOutboxEvent,
  runOutboxRelayCycle,
} from "../../services/notifications/outboxRelay.service.js";

describe("Outbox Relay & Recovery Service (Stage 2B)", () => {
  const orgId = new mongoose.Types.ObjectId();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("claims pending events atomically up to batch limit and stops when empty", async () => {
    const doc1 = { _id: "1", eventId: "evt-1", status: "processing", attempts: 1 };
    const findSpy = jest
      .spyOn(OutboxEvent, "findOneAndUpdate")
      .mockResolvedValueOnce(doc1)
      .mockResolvedValueOnce(null);

    const claimed = await claimPendingOutboxEvents({ limit: 5, workerId: "w-1" });

    expect(claimed).toEqual([doc1]);
    expect(findSpy).toHaveBeenCalledTimes(2);
    expect(findSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: "pending" }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: "processing", claimedBy: "w-1" }),
        $inc: { attempts: 1 },
      }),
      expect.objectContaining({ new: true }),
    );
  });

  it("publishes claimed event with stable jobId=eventId and marks published", async () => {
    const event = {
      _id: "mongo-1",
      eventId: "evt-stable-1",
      organizationId: orgId,
      branchId: null,
      eventType: "invoice.settled",
      idempotencyKey: "inv-1",
      schemaVersion: 1,
      payload: { invoiceId: "1" },
      attempts: 1,
      claimedBy: "w-1",
    };

    const queueSpy = jest
      .spyOn(notificationQueue, "add")
      .mockResolvedValue({ id: "evt-stable-1" });
    const updateSpy = jest
      .spyOn(OutboxEvent, "updateOne")
      .mockResolvedValue({ modifiedCount: 1 });

    const res = await publishClaimedOutboxEvent(event);

    expect(res).toEqual({ status: "published", eventId: "evt-stable-1" });
    expect(queueSpy).toHaveBeenCalledWith(
      "invoice.settled",
      expect.objectContaining({ eventId: "evt-stable-1", organizationId: String(orgId) }),
      { jobId: "evt-stable-1" },
    );
    expect(updateSpy).toHaveBeenCalledWith(
      { _id: "mongo-1", status: "processing", claimedBy: "w-1" },
      expect.objectContaining({
        $set: expect.objectContaining({ status: "published", claimedAt: null }),
      }),
    );
  });

  it("schedules retry with backoff on queue failure and marks failed at maxAttempts", async () => {
    const now = new Date("2026-11-26T12:00:00.000Z");
    jest.spyOn(notificationQueue, "add").mockRejectedValue(new Error("Redis down"));
    const updateSpy = jest
      .spyOn(OutboxEvent, "updateOne")
      .mockResolvedValue({ modifiedCount: 1 });

    const retryRes = await publishClaimedOutboxEvent(
      { _id: "m1", eventId: "e1", organizationId: orgId, eventType: "invoice.settled", attempts: 1, claimedBy: "w-1", availableAt: now },
      { now, maxAttempts: 3, baseBackoffMs: 5000 },
    );
    expect(retryRes.status).toBe("pending");
    expect(updateSpy).toHaveBeenCalledWith(
      { _id: "m1", status: "processing", claimedBy: "w-1" },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "pending",
          availableAt: new Date(now.getTime() + 5000),
        }),
      }),
    );

    const terminalRes = await publishClaimedOutboxEvent(
      { _id: "m2", eventId: "e2", organizationId: orgId, eventType: "invoice.settled", attempts: 3, availableAt: now },
      { now, maxAttempts: 3, baseBackoffMs: 5000 },
    );
    expect(terminalRes.status).toBe("failed");
  });

  it("recovers stale processing claims", async () => {
    const now = new Date("2026-11-26T12:05:00.000Z");
    const updateManySpy = jest
      .spyOn(OutboxEvent, "updateMany")
      .mockResolvedValue({ modifiedCount: 2 });

    const count = await recoverStaleProcessingClaims({ staleAfterMs: 60000, now });

    expect(count).toBe(2);
    expect(updateManySpy).toHaveBeenCalledWith(
      { status: "processing", claimedAt: { $lte: new Date(now.getTime() - 60000) } },
      expect.objectContaining({
        $set: expect.objectContaining({ status: "pending", claimedAt: null, claimedBy: null }),
      }),
    );
  });

  it("runs a full relay cycle cleanly on empty queue", async () => {
    jest.spyOn(Appointment, "find").mockReturnValue({
      select: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([]),
        }),
      }),
    });
    jest.spyOn(OutboxEvent, "updateMany").mockResolvedValue({ modifiedCount: 0 });
    jest.spyOn(OutboxEvent, "findOneAndUpdate").mockResolvedValue(null);

    const summary = await runOutboxRelayCycle({ limit: 10 });
    expect(summary).toEqual({
      recoveredCount: 0,
      claimedCount: 0,
      publishedCount: 0,
      failedCount: 0,
    });
  });
});
