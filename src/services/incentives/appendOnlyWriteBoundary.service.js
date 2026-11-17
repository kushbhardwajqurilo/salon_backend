import mongoose from "mongoose";
import { IncentiveLedger } from "../../models/incentives/incentiveLedger.model.js";
import { IncentiveEvaluationRevision } from "../../models/incentives/incentiveEvaluationRevision.model.js";
import { AppError } from "../../utils/errors.js";

const MAX_SAFE_PAISE = 10_000_000_000_000; // 10^13 paise

/**
 * Service managing append-only write boundaries for IncentiveLedger and IncentiveEvaluationRevision.
 * Strictly guarantees that no update or delete operations are exposed for immutable earning facts
 * or revision histories.
 */
export class AppendOnlyWriteBoundaryService {
  /**
   * Appends an immutable financial record to the IncentiveLedger.
   *
   * @param {Object} data
   * @param {mongoose.Types.ObjectId|string} organizationId
   * @param {Object} [options]
   * @param {mongoose.ClientSession} [options.session]
   * @returns {Promise<IncentiveLedger>}
   */
  async appendLedgerEntry(data, organizationId, options = {}) {
    if (!organizationId) {
      throw new AppError("Organization scope is required", 400);
    }
    const {
      branchId,
      staffId,
      schemeId,
      entryType,
      sourceType = "service_commission",
      evaluationId = null,
      settlementEventId,
      invoiceId,
      lineItemId,
      fulfillmentStatus = "confirmed",
      sourceRevenueInPaise,
      attributedRevenueInPaise,
      amountInPaise,
      idempotencyKey,
      payoutBatchId = null,
      fulfillmentConfirmedAt = null,
      fulfillmentConfirmedBy = null,
      reversesLedgerId = null,
      refundAmountInPaise = null,
    } = data;

    if (
      !branchId ||
      !staffId ||
      !schemeId ||
      !entryType ||
      !idempotencyKey
    ) {
      throw new AppError("Missing required ledger fields", 400);
    }
    if (
      ([
        "service_commission",
        "subscription_sale_commission",
        "membership_sale_commission",
        "retail_sale_commission",
      ].includes(sourceType) &&
        (!settlementEventId || !invoiceId || !lineItemId)) ||
      (sourceType === "attendance_bonus" && !evaluationId)
    ) {
      throw new AppError("Ledger source references are incomplete", 400);
    }

    if (
      !Number.isInteger(amountInPaise) ||
      amountInPaise < 0 ||
      amountInPaise > MAX_SAFE_PAISE
    ) {
      throw new AppError("amountInPaise must be a non-negative integer within safe range", 400);
    }

    const orgObjectId = new mongoose.Types.ObjectId(organizationId);
    const session = options.session || null;

    // Check idempotency key first
    const existing = await IncentiveLedger.findOne(
      { organizationId: orgObjectId, idempotencyKey },
      null,
      session ? { session } : {}
    );
    if (existing) {
      // Stage 2 Close Check: Verify incoming earning facts match existing entry
      const matchesFacts =
        existing.staffId.toString() === staffId.toString() &&
        existing.schemeId.toString() === schemeId.toString() &&
        existing.entryType === entryType &&
        existing.sourceType === sourceType &&
        (![
          "service_commission",
          "subscription_sale_commission",
          "membership_sale_commission",
          "retail_sale_commission",
        ].includes(sourceType) ||
          (existing.invoiceId?.toString() === invoiceId.toString() &&
            existing.lineItemId?.toString() === lineItemId.toString())) &&
        (sourceType !== "attendance_bonus" ||
          existing.evaluationId?.toString() === evaluationId.toString()) &&
        (reversesLedgerId === null ||
          existing.reversesLedgerId?.toString() === reversesLedgerId.toString()) &&
        (refundAmountInPaise === null ||
          existing.refundAmountInPaise === refundAmountInPaise) &&
        existing.amountInPaise === amountInPaise;

      if (!matchesFacts) {
        throw new AppError(
          `Idempotency conflict: key '${idempotencyKey}' already exists with differing earning facts`,
          409
        );
      }
      return existing; // Safe idempotent return
    }

    try {
      const [entry] = await IncentiveLedger.create(
        [
          {
            organizationId: orgObjectId,
            branchId: new mongoose.Types.ObjectId(branchId),
            staffId: new mongoose.Types.ObjectId(staffId),
            schemeId: new mongoose.Types.ObjectId(schemeId),
            entryType,
            sourceType,
            evaluationId: evaluationId ? new mongoose.Types.ObjectId(evaluationId) : null,
            settlementEventId: settlementEventId ? new mongoose.Types.ObjectId(settlementEventId) : null,
            invoiceId: invoiceId ? new mongoose.Types.ObjectId(invoiceId) : null,
            lineItemId: lineItemId ? new mongoose.Types.ObjectId(lineItemId) : null,
            fulfillmentStatus,
            fulfillmentConfirmedAt,
            fulfillmentConfirmedBy: fulfillmentConfirmedBy
              ? new mongoose.Types.ObjectId(fulfillmentConfirmedBy)
              : null,
            reversesLedgerId: reversesLedgerId
              ? new mongoose.Types.ObjectId(reversesLedgerId)
              : null,
            refundAmountInPaise,
            sourceRevenueInPaise,
            attributedRevenueInPaise,
            amountInPaise,
            idempotencyKey,
            payoutBatchId: payoutBatchId ? new mongoose.Types.ObjectId(payoutBatchId) : null,
          },
        ],
        session ? { session } : {}
      );

      return entry;
    } catch (err) {
      if (err.code === 11000) {
        const isLedgerKey =
          err.keyPattern?.organizationId && err.keyPattern?.idempotencyKey;
        if (isLedgerKey || err.message?.includes("organizationId_1_idempotencyKey_1")) {
          // Fetch and return existing record idempotently
          const created = await IncentiveLedger.findOne(
            { organizationId: orgObjectId, idempotencyKey },
            null,
            session ? { session } : {}
          );
          if (created) return created;
        }
      }
      throw err;
    }
  }

  /**
   * Appends an immutable evaluation revision audit document and atomically updates
   * the parent IncentiveEvaluation document in the same transaction.
   *
   * @param {Object} data
   * @param {mongoose.Types.ObjectId|string} organizationId
   * @param {mongoose.Types.ObjectId|string} userId
   * @param {Object} [options]
   * @param {mongoose.ClientSession} [options.session]
   * @returns {Promise<IncentiveEvaluationRevision>}
   */
  async appendEvaluationRevision(data, organizationId, userId, options = {}) {
    if (!organizationId) {
      throw new AppError("Organization scope is required", 400);
    }
    const {
      evaluationId,
      previousValueInPaise,
      newValueInPaise,
      deltaInPaise,
      reason,
      updateEvaluation = false,
    } = data;

    if (!evaluationId || !reason) {
      throw new AppError("evaluationId and reason are required", 400);
    }

    if (
      !Number.isInteger(previousValueInPaise) ||
      !Number.isInteger(newValueInPaise) ||
      !Number.isInteger(deltaInPaise)
    ) {
      throw new AppError("All monetary fields must be valid integer paise values", 400);
    }

    const orgObjectId = new mongoose.Types.ObjectId(organizationId);
    const evalObjectId = new mongoose.Types.ObjectId(evaluationId);
    const userObjectId = new mongoose.Types.ObjectId(userId);
    const maxRetries = options.maxRetries || 5;

    // Use external session or manage local transaction to guarantee atomic evaluation update
    const session = options.session || (await mongoose.startSession());
    const isLocalSession = !options.session;
    if (isLocalSession) {
      session.startTransaction();
    }

    try {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          // Verify target evaluation exists within organization
          const evalDoc = await mongoose.model("IncentiveEvaluation").findOne(
            { _id: evalObjectId, organizationId: orgObjectId },
            null,
            { session }
          );
          if (!evalDoc) {
            throw new AppError("Incentive evaluation not found", 404);
          }

          // Determine the next monotonic revisionNumber
          const lastRev = await IncentiveEvaluationRevision.findOne(
            { organizationId: orgObjectId, evaluationId: evalObjectId },
            null,
            { session }
          ).sort({ revisionNumber: -1 });

          const nextRevisionNumber = lastRev ? lastRev.revisionNumber + 1 : 1;

          const [revision] = await IncentiveEvaluationRevision.create(
            [
              {
                organizationId: orgObjectId,
                evaluationId: evalObjectId,
                revisionNumber: nextRevisionNumber,
                previousValueInPaise,
                newValueInPaise,
                deltaInPaise,
                reason,
                adjustedBy: userObjectId,
                adjustedAt: new Date(),
              },
            ],
            { session }
          );

          if (updateEvaluation) {
            evalDoc.bonusAwardedInPaise = newValueInPaise;
            evalDoc.status = "overridden";
            await evalDoc.save({ session });
          }

          if (isLocalSession) {
            await session.commitTransaction();
          }

          return revision;
        } catch (err) {
          // Handle race condition on compound unique index { organizationId, evaluationId, revisionNumber }
          if (err.code === 11000 && attempt < maxRetries) {
            const isRevKey =
              err.keyPattern?.organizationId &&
              err.keyPattern?.evaluationId &&
              err.keyPattern?.revisionNumber;

            if (isRevKey || err.message?.includes("organizationId_1_evaluationId_1_revisionNumber_1")) {
              await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
              continue;
            }
          }
          throw err;
        }
      }

      throw new AppError("Failed to record evaluation revision due to concurrent revision conflicts", 409);
    } catch (err) {
      if (isLocalSession) {
        await session.abortTransaction();
      }
      throw err;
    } finally {
      if (isLocalSession) {
        await session.endSession();
      }
    }
  }
}

export const appendOnlyWriteBoundaryService = new AppendOnlyWriteBoundaryService();
