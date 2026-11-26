import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { OutboxEvent } from "../../models/notifications/outboxEvent.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { createOutboxEvent } from "../../services/notifications/outbox.service.js";
import {
  validateOutboxEventInput,
  redactSensitiveText,
} from "../../services/notifications/notificationEventContract.js";

describe("OutboxEvent Model, Contract & Outbox Service (Stage 2A)", () => {
  const orgA = new mongoose.Types.ObjectId();
  const orgB = new mongoose.Types.ObjectId();
  const branchA = new mongoose.Types.ObjectId();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("Model schema & indexes", () => {
    it("defines required indexes including org-scoped unique idempotency", () => {
      const indexes = OutboxEvent.schema.indexes();
      const hasOrgIdempotency = indexes.some(
        ([fields, opts]) =>
          fields.organizationId === 1 &&
          fields.idempotencyKey === 1 &&
          opts?.unique === true,
      );
      const hasPollingIndex = indexes.some(
        ([fields]) => fields.status === 1 && fields.availableAt === 1,
      );
      const hasLeaseIndex = indexes.some(
        ([fields]) => fields.status === 1 && fields.claimedAt === 1,
      );

      expect(hasOrgIdempotency).toBe(true);
      expect(hasPollingIndex).toBe(true);
      expect(hasLeaseIndex).toBe(true);
    });

    it("applies expected status and attempt defaults", () => {
      const doc = new OutboxEvent({
        eventId: "evt-1",
        organizationId: orgA,
        eventType: "invoice.settled",
        idempotencyKey: "inv-1",
      });
      expect(doc.status).toBe("pending");
      expect(doc.attempts).toBe(0);
      expect(doc.schemaVersion).toBe(1);
      expect(doc.branchId).toBeNull();
    });
  });

  describe("Event identity & payload contract", () => {
    it("rejects missing organizationId", () => {
      expect(() =>
        validateOutboxEventInput({
          eventType: "invoice.settled",
          idempotencyKey: "inv-1",
        }),
      ).toThrow();
    });

    it("rejects invalid eventType and empty/oversized idempotencyKey", () => {
      expect(() =>
        validateOutboxEventInput({
          organizationId: orgA,
          eventType: "unknown.event",
          idempotencyKey: "k1",
        }),
      ).toThrow();

      expect(() =>
        validateOutboxEventInput({
          organizationId: orgA,
          eventType: "invoice.settled",
          idempotencyKey: "   ",
        }),
      ).toThrow();

      expect(() =>
        validateOutboxEventInput({
          organizationId: orgA,
          eventType: "invoice.settled",
          idempotencyKey: "x".repeat(201),
        }),
      ).toThrow();
    });

    it("rejects sensitive payload keys (nested, array, case variations)", () => {
      for (const key of ["OTP", "Password", "SALARY", "authToken"]) {
        expect(() =>
          validateOutboxEventInput({
            organizationId: orgA,
            eventType: "auth.otp_requested",
            idempotencyKey: `key-${key}`,
            payload: { nested: { items: [{ [key]: "secret-value" }] } },
          }),
        ).toThrow(/Sensitive field/i);
      }
    });

    it("rejects circular references, non-plain objects, JWT strings, and oversized payloads", () => {
      const circular = {};
      circular.self = circular;
      expect(() =>
        validateOutboxEventInput({
          organizationId: orgA,
          eventType: "invoice.settled",
          idempotencyKey: "circ-1",
          payload: circular,
        }),
      ).toThrow(/Circular reference/i);

      expect(() =>
        validateOutboxEventInput({
          organizationId: orgA,
          eventType: "invoice.settled",
          idempotencyKey: "date-1",
          payload: { createdAt: new Date() },
        }),
      ).toThrow(/non-plain object/i);

      expect(() =>
        validateOutboxEventInput({
          organizationId: orgA,
          eventType: "auth.otp_requested",
          idempotencyKey: "jwt-1",
          payload: {
            header: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
          },
        }),
      ).toThrow(/token-like/i);

      expect(() =>
        validateOutboxEventInput({
          organizationId: orgA,
          eventType: "invoice.settled",
          idempotencyKey: "big-1",
          payload: { data: "x".repeat(17000) },
        }),
      ).toThrow(/exceeds maximum size/i);
    });

    it("redacts sensitive patterns in error text", () => {
      const redacted = redactSensitiveText(
        "Failed with Bearer abc.def.ghi and otp=123456",
      );
      expect(redacted).toContain("Bearer [REDACTED]");
      expect(redacted).toContain("otp=[REDACTED]");
      expect(redacted).not.toContain("123456");
    });
  });

  describe("createOutboxEvent service", () => {
    it("creates event in best_effort mode when no session is supplied", async () => {
      const createSpy = jest
        .spyOn(OutboxEvent, "create")
        .mockImplementation(async (doc) => ({
          ...doc,
          _id: new mongoose.Types.ObjectId(),
        }));

      const res = await createOutboxEvent({
        organizationId: orgA,
        eventType: "invoice.settled",
        idempotencyKey: "inv-100",
        payload: { invoiceId: "100" },
      });

      expect(res.created).toBe(true);
      expect(res.duplicate).toBe(false);
      expect(res.persistenceMode).toBe("best_effort");
      expect(res.event.status).toBe("pending");
      expect(createSpy).toHaveBeenCalledTimes(1);
    });

    it("attaches session and uses transactional mode when session is supplied", async () => {
      const fakeSession = { id: "session-1" };
      const branchExistsSpy = jest
        .spyOn(Branch, "exists")
        .mockReturnValue({
          session: jest.fn().mockResolvedValue({ _id: branchA }),
        });
      const createSpy = jest
        .spyOn(OutboxEvent, "create")
        .mockImplementation(async (docs) => [
          { ...docs[0], _id: new mongoose.Types.ObjectId() },
        ]);

      const res = await createOutboxEvent(
        {
          organizationId: orgA,
          branchId: branchA,
          eventType: "appointment.created",
          idempotencyKey: "apt-100",
          payload: { appointmentId: "100" },
        },
        { session: fakeSession },
      );

      expect(branchExistsSpy).toHaveBeenCalledWith({
        _id: branchA,
        organizationId: orgA,
        isActive: true,
      });
      expect(createSpy).toHaveBeenCalledWith(expect.any(Array), {
        session: fakeSession,
      });
      expect(res.created).toBe(true);
      expect(res.persistenceMode).toBe("transactional");
    });

    it("rethrows 11000 inside a session so aborted transactions are not hidden", async () => {
      const fakeSession = { id: "session-abort" };
      jest.spyOn(OutboxEvent, "create").mockRejectedValue({ code: 11000 });

      await expect(
        createOutboxEvent(
          {
            organizationId: orgA,
            eventType: "invoice.settled",
            idempotencyKey: "tx-dup",
          },
          { session: fakeSession, validateBranch: false },
        ),
      ).rejects.toMatchObject({ code: 11000 });
    });

    it("handles duplicate idempotencyKey within same organization via 11000 (best_effort)", async () => {
      const existingDoc = {
        eventId: "existing-uuid",
        organizationId: orgA,
        idempotencyKey: "dup-key",
        status: "pending",
      };
      jest.spyOn(OutboxEvent, "create").mockRejectedValue({ code: 11000 });
      jest.spyOn(OutboxEvent, "findOne").mockResolvedValue(existingDoc);

      const res = await createOutboxEvent({
        organizationId: orgA,
        eventType: "invoice.settled",
        idempotencyKey: "dup-key",
      });

      expect(res.created).toBe(false);
      expect(res.duplicate).toBe(true);
      expect(res.event).toEqual(existingDoc);
    });

    it("allows same idempotencyKey across different organizations", async () => {
      jest
        .spyOn(OutboxEvent, "create")
        .mockImplementation(async (doc) => ({
          ...doc,
          _id: new mongoose.Types.ObjectId(),
        }));

      const resA = await createOutboxEvent({
        organizationId: orgA,
        eventType: "invoice.settled",
        idempotencyKey: "shared-key",
      });
      const resB = await createOutboxEvent({
        organizationId: orgB,
        eventType: "invoice.settled",
        idempotencyKey: "shared-key",
      });

      expect(resA.created).toBe(true);
      expect(resB.created).toBe(true);
      expect(resA.event.organizationId).toEqual(orgA);
      expect(resB.event.organizationId).toEqual(orgB);
    });
  });
});
