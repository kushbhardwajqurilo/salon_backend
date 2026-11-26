import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { OutboxEvent } from "../../models/notifications/outboxEvent.model.js";
import { emitBillingOutboxEvent } from "../../services/billing/billingNotificationOutbox.service.js";

describe("Stage 2E — Billing & Payment Notification Outbox Integration", () => {
  const orgId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();
  const invId = new mongoose.Types.ObjectId();
  const payerId = new mongoose.Types.ObjectId();
  const beneficiaryId = new mongoose.Types.ObjectId();

  const baseInvoice = {
    _id: invId,
    organizationId: orgId,
    branchId,
    customerId: payerId,
    invoiceNumber: "INV-001",
    paymentStatus: "partial",
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("emits invoice.created, payment_recorded, partial_payment, settled, refund, reversal, and voided", async () => {
    const createSpy = jest
      .spyOn(OutboxEvent, "create")
      .mockImplementation(async (doc) => ({ ...doc, _id: new mongoose.Types.ObjectId() }));

    const events = [
      ["invoice.created", "create-1"],
      ["invoice.payment_recorded", "pay-1"],
      ["invoice.partial_payment", "pay-1"],
      ["invoice.settled", "settle-1"],
      ["invoice.refunded", "ref-1"],
      ["invoice.payment_reversed", "rev-1"],
      ["invoice.voided", "void-1"],
    ];

    for (const [eventType, operationId] of events) {
      const res = await emitBillingOutboxEvent({
        eventType,
        invoice: baseInvoice,
        operationId,
        payerCustomerId: payerId,
        beneficiaryCustomerId: beneficiaryId,
        amountInPaise: 50000,
      });
      expect(res.created).toBe(true);
      expect(res.event.eventType).toBe(eventType);
      expect(res.event.payload.payerCustomerId).toBe(String(payerId));
      expect(res.event.payload.beneficiaryCustomerId).toBe(String(beneficiaryId));
    }

    expect(createSpy).toHaveBeenCalledTimes(7);
  });

  it("handles duplicate billing event idempotently", async () => {
    jest.spyOn(OutboxEvent, "create").mockRejectedValue({ code: 11000 });
    jest.spyOn(OutboxEvent, "findOne").mockResolvedValue({
      eventId: "existing-bill-evt",
      eventType: "invoice.settled",
    });

    const res = await emitBillingOutboxEvent({
      eventType: "invoice.settled",
      invoice: baseInvoice,
      operationId: "pay-dup",
    });

    expect(res.created).toBe(false);
    expect(res.duplicate).toBe(true);
  });
});
