import crypto from "node:crypto";
import { OutboxEvent } from "../../models/notifications/outboxEvent.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { validateOutboxEventInput } from "./notificationEventContract.js";
import { logger } from "../../utils/logger.js";

/**
 * Persists a domain notification event to the outbox.
 *
 * - When `options.session` is supplied, the insert participates in the caller's
 *   MongoDB transaction (`persistenceMode: "transactional"`). If a duplicate-key
 *   error (11000) occurs inside an active transaction, MongoDB aborts the
 *   transaction; this function rethrows the error so the caller can abort/retry
 *   rather than hiding an aborted transaction.
 * - When no session is supplied, the insert is `persistenceMode: "best_effort"`.
 *   A duplicate-key error (11000) safely fetches and returns the existing event.
 *
 * @param {object} input
 * @param {object} [options]
 * @param {import("mongoose").ClientSession} [options.session]
 * @param {boolean} [options.validateBranch=true]
 * @returns {Promise<{ created: boolean, duplicate: boolean, persistenceMode: "transactional" | "best_effort", event: object }>}
 */
export async function createOutboxEvent(input, options = {}) {
  const { session = null, validateBranch = true } = options;
  const persistenceMode = session ? "transactional" : "best_effort";

  const validated = validateOutboxEventInput(input);

  if (validated.branchId && validateBranch) {
    const branchQuery = Branch.exists({
      _id: validated.branchId,
      organizationId: validated.organizationId,
      isActive: true,
    });
    if (session) branchQuery.session(session);
    const branchExists = await branchQuery;
    if (!branchExists) {
      throw new Error("Active branch not found for the specified organization");
    }
  }

  const existingQuery = OutboxEvent.findOne({
    organizationId: validated.organizationId,
    idempotencyKey: validated.idempotencyKey,
  });
  if (session) existingQuery.session(session);
  const existing = await existingQuery;
  if (existing) {
    return {
      created: false,
      duplicate: true,
      persistenceMode,
      event: existing,
    };
  }

  const doc = {
    eventId: crypto.randomUUID(),
    organizationId: validated.organizationId,
    branchId: validated.branchId ?? null,
    eventType: validated.eventType,
    idempotencyKey: validated.idempotencyKey,
    schemaVersion: validated.schemaVersion,
    payload: validated.payload,
    status: "pending",
    attempts: 0,
    availableAt: validated.availableAt ?? new Date(),
  };

  try {
    const created = session
      ? (await OutboxEvent.create([doc], { session }))[0]
      : await OutboxEvent.create(doc);

    logger.info(
      `[OUTBOX_EVENT_CREATED] eventId=${created.eventId} type=${created.eventType} org=${created.organizationId} mode=${persistenceMode}`,
    );

    return {
      created: true,
      duplicate: false,
      persistenceMode,
      event: created,
    };
  } catch (err) {
    if (err?.code === 11000) {
      // Inside a MongoDB transaction, a duplicate-key error aborts the transaction.
      // Never swallow it or query on the aborted session.
      if (session) {
        logger.warn(
          `[OUTBOX_TX_DUPLICATE_ABORT] type=${validated.eventType} org=${validated.organizationId} key=${validated.idempotencyKey}`,
        );
        throw err;
      }

      const existing = await OutboxEvent.findOne({
        organizationId: validated.organizationId,
        idempotencyKey: validated.idempotencyKey,
      });

      logger.info(
        `[OUTBOX_EVENT_DUPLICATE] type=${validated.eventType} org=${validated.organizationId} key=${validated.idempotencyKey}`,
      );

      return {
        created: false,
        duplicate: true,
        persistenceMode,
        event: existing,
      };
    }
    throw err;
  }
}
