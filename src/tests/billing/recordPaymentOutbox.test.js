import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { OutboxEvent } from "../../models/notifications/outboxEvent.model.js";
import { emitBillingOutboxEvent } from "../../services/billing/billingNotificationOutbox.service.js";
import { VERIFIED_EVENT_TYPES } from "../../services/notifications/notificationEventContract.js";

describe("TASK 02 — recordPayment Outbox Event Regression", () => {
  const orgId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();
  const invId = new mongoose.Types.ObjectId();
  const paymentId = new mongoose.Types.ObjectId();

  const settledInvoice = {
    _id: invId,
    organizationId: orgId,
    branchId,
    customerId: new mongoose.Types.ObjectId(),
    invoiceNumber: "INV-2026-001",
    paymentStatus: "paid",
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("emits invoice.payment_recorded (and not invoice.payment_reversed) with session", async () => {
    const createSpy = jest
      .spyOn(OutboxEvent, "create")
      .mockImplementation(async (docs) => {
        const doc = Array.isArray(docs) ? docs[0] : docs;
        return [{ ...doc, _id: new mongoose.Types.ObjectId() }];
      });

    const fakeSession = { id: "mock-session" };

    const res = await emitBillingOutboxEvent({
      eventType: "invoice.payment_recorded",
      invoice: settledInvoice,
      operationId: String(paymentId),
      amountInPaise: 150000,
      session: fakeSession,
    });

    expect(VERIFIED_EVENT_TYPES).toContain("invoice.payment_recorded");
    expect(res.created).toBe(true);
    expect(res.event.eventType).toBe("invoice.payment_recorded");
    expect(res.event.eventType).not.toBe("invoice.payment_reversed");
    expect(res.event.idempotencyKey).toBe(
      `invoice.payment_recorded:${invId}:${paymentId}`,
    );
    expect(res.event.payload.amountInPaise).toBe(150000);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0][1]).toEqual({ session: fakeSession });
  });

  it("does not persist outbox event when OutboxEvent.create fails (e.g. transaction abort)", async () => {
    jest
      .spyOn(OutboxEvent, "create")
      .mockRejectedValue(new Error("Transaction aborted"));

    await expect(
      emitBillingOutboxEvent({
        eventType: "invoice.payment_recorded",
        invoice: settledInvoice,
        operationId: String(paymentId),
        amountInPaise: 150000,
        session: { id: "aborted-session" },
      }),
    ).rejects.toThrow("Transaction aborted");
  });
});
