import mongoose from "mongoose";
import { IncentiveRecoveryObligation } from "../../models/incentives/incentiveRecoveryObligation.model.js";
import { AppError } from "../../utils/errors.js";

const MAX_SAFE_PAISE = 10_000_000_000_000; // 10^13 paise

/**
 * Service managing the lifecycle, reservation, confirmation, release,
 * and reversal of clawback recovery obligations.
 */
export class RecoveryObligationService {
  /**
   * Reserves an allocation amount for a payout batch under atomic balance preconditions.
   *
   * @param {Object} params
   * @param {mongoose.Types.ObjectId|string} params.obligationId
   * @param {mongoose.Types.ObjectId|string} params.organizationId
   * @param {mongoose.Types.ObjectId|string} params.payoutBatchId
   * @param {string} params.allocationEventId
   * @param {number} params.amountInPaise
   * @param {mongoose.ClientSession} params.session
   * @returns {Promise<IncentiveRecoveryObligation>}
   */
  async reserveAllocation({
    obligationId,
    organizationId,
    payoutBatchId,
    allocationEventId,
    amountInPaise,
    session,
  }) {
    if (!session) {
      throw new AppError("reserveAllocation requires an active MongoDB ClientSession", 500);
    }
    if (!Number.isInteger(amountInPaise) || amountInPaise <= 0 || amountInPaise > MAX_SAFE_PAISE) {
      throw new AppError("amountInPaise must be a positive integer within safe range", 400);
    }

    const obligationObjectId = new mongoose.Types.ObjectId(obligationId);
    const orgObjectId = new mongoose.Types.ObjectId(organizationId);
    const batchObjectId = new mongoose.Types.ObjectId(payoutBatchId);
    const allocEventIdStr = String(allocationEventId);

    // 1. Check idempotency: if allocationEventId already exists, verify idempotency
    const existing = await IncentiveRecoveryObligation.findOne(
      {
        _id: obligationObjectId,
        organizationId: orgObjectId,
        "allocations.allocationEventId": allocEventIdStr,
      },
      null,
      { session }
    );

    if (existing) {
      const alloc = existing.allocations.find((a) => a.allocationEventId === allocEventIdStr);
      if (alloc.allocatedPaise === amountInPaise && alloc.state === "reserved") {
        return existing; // Idempotent return
      }
      throw new AppError(`Allocation event '${allocEventIdStr}' already exists in state '${alloc.state}'`, 409);
    }

    // 2. Perform atomic reservation with unrecovered balance precondition
    // Available unrecovered balance = originalClawbackInPaise - (totalRecoveredInPaise + totalReservedInPaise)
    const updateResult = await IncentiveRecoveryObligation.updateOne(
      {
        _id: obligationObjectId,
        organizationId: orgObjectId,
        status: { $in: ["pending", "partially_recovered"] },
        // Precondition: remaining unallocated balance must be at least amountInPaise
        $expr: {
          $gte: [
            {
              $subtract: [
                "$originalClawbackInPaise",
                { $add: ["$totalRecoveredInPaise", "$totalReservedInPaise"] },
              ],
            },
            amountInPaise,
          ],
        },
      },
      {
        $inc: { totalReservedInPaise: amountInPaise },
        $push: {
          allocations: {
            allocationEventId: allocEventIdStr,
            payoutBatchId: batchObjectId,
            allocatedPaise: amountInPaise,
            state: "reserved",
            reservedAt: new Date(),
          },
        },
      },
      { session }
    );

    if (updateResult.matchedCount === 0) {
      // Determine precise cause of failure
      const doc = await IncentiveRecoveryObligation.findOne(
        { _id: obligationObjectId, organizationId: orgObjectId },
        null,
        { session }
      );
      if (!doc) throw new AppError("Recovery obligation not found", 404);
      const remaining = doc.originalClawbackInPaise - (doc.totalRecoveredInPaise + doc.totalReservedInPaise);
      throw new AppError(
        `Insufficient unrecovered clawback balance: requested ${amountInPaise} paise, but only ${remaining} paise remains available`,
        409
      );
    }

    return IncentiveRecoveryObligation.findById(obligationObjectId, null, { session });
  }

  /**
   * Confirms a reserved allocation upon successful settlement of a payout batch.
   * Derives confirmed amount from persisted allocation record inside the transaction.
   *
   * @param {Object} params
   * @param {mongoose.Types.ObjectId|string} params.obligationId
   * @param {mongoose.Types.ObjectId|string} params.organizationId
   * @param {string} params.allocationEventId
   * @param {string} params.confirmEventId
   * @param {mongoose.ClientSession} params.session
   * @returns {Promise<IncentiveRecoveryObligation>}
   */
  async confirmAllocation({
    obligationId,
    organizationId,
    allocationEventId,
    confirmEventId,
    session,
  }) {
    if (!session) {
      throw new AppError("confirmAllocation requires an active MongoDB ClientSession", 500);
    }

    const obligationObjectId = new mongoose.Types.ObjectId(obligationId);
    const orgObjectId = new mongoose.Types.ObjectId(organizationId);
    const allocEventIdStr = String(allocationEventId);
    const confirmEventIdStr = String(confirmEventId);

    // 1. Initial State Lookup to inspect persisted allocation
    const obligation = await IncentiveRecoveryObligation.findOne(
      {
        _id: obligationObjectId,
        organizationId: orgObjectId,
        allocations: {
          $elemMatch: {
            allocationEventId: allocEventIdStr,
          },
        },
      },
      null,
      { session }
    );

    if (!obligation) {
      throw new AppError("Recovery obligation or allocation event not found", 404);
    }

    const targetAlloc = obligation.allocations.find((a) => a.allocationEventId === allocEventIdStr);
    if (targetAlloc.state === "confirmed") {
      // Idempotent success
      return obligation;
    }
    if (targetAlloc.state !== "reserved") {
      throw new AppError(`Cannot confirm allocation in state '${targetAlloc.state}'`, 409);
    }

    const allocatedPaise = targetAlloc.allocatedPaise;

    // 2. Final Atomic Confirmation Mutation using updateOne with arrayFilters
    const updateResult = await IncentiveRecoveryObligation.updateOne(
      {
        _id: obligationObjectId,
        organizationId: orgObjectId,
        totalReservedInPaise: { $gte: allocatedPaise },
        allocations: {
          $elemMatch: {
            allocationEventId: allocEventIdStr,
            state: "reserved",
            allocatedPaise: allocatedPaise,
          },
        },
      },
      {
        $inc: {
          totalReservedInPaise: -allocatedPaise,
          totalRecoveredInPaise: allocatedPaise,
        },
        $set: {
          "allocations.$[elem].state": "confirmed",
          "allocations.$[elem].confirmedAt": new Date(),
          "allocations.$[elem].confirmedEventId": confirmEventIdStr,
        },
      },
      {
        session,
        arrayFilters: [{ "elem.allocationEventId": allocEventIdStr }],
      }
    );

    if (updateResult.matchedCount === 0) {
      throw new AppError("Concurrency conflict or state mismatch while confirming recovery allocation", 409);
    }

    // Check if fully recovered and update status
    const updatedDoc = await IncentiveRecoveryObligation.findById(obligationObjectId, null, { session });
    if (updatedDoc.totalRecoveredInPaise >= updatedDoc.originalClawbackInPaise) {
      updatedDoc.status = "recovered";
      await updatedDoc.save({ session });
    } else {
      updatedDoc.status = "partially_recovered";
      await updatedDoc.save({ session });
    }

    return updatedDoc;
  }

  /**
   * Releases a reserved allocation back to the available obligation pool (e.g. batch cancelled).
   *
   * @param {Object} params
   * @param {mongoose.Types.ObjectId|string} params.obligationId
   * @param {mongoose.Types.ObjectId|string} params.organizationId
   * @param {string} params.allocationEventId
   * @param {string} params.releaseEventId
   * @param {mongoose.ClientSession} params.session
   * @returns {Promise<IncentiveRecoveryObligation>}
   */
  async releaseAllocation({
    obligationId,
    organizationId,
    allocationEventId,
    releaseEventId,
    session,
  }) {
    if (!session) {
      throw new AppError("releaseAllocation requires an active MongoDB ClientSession", 500);
    }

    const obligationObjectId = new mongoose.Types.ObjectId(obligationId);
    const orgObjectId = new mongoose.Types.ObjectId(organizationId);
    const allocEventIdStr = String(allocationEventId);
    const releaseEventIdStr = String(releaseEventId);

    const obligation = await IncentiveRecoveryObligation.findOne(
      {
        _id: obligationObjectId,
        organizationId: orgObjectId,
        allocations: {
          $elemMatch: {
            allocationEventId: allocEventIdStr,
          },
        },
      },
      null,
      { session }
    );

    if (!obligation) {
      throw new AppError("Recovery obligation or allocation event not found", 404);
    }

    const targetAlloc = obligation.allocations.find((a) => a.allocationEventId === allocEventIdStr);
    if (targetAlloc.state === "released") {
      return obligation; // Idempotent return
    }
    if (targetAlloc.state !== "reserved") {
      throw new AppError(`Cannot release allocation in state '${targetAlloc.state}'`, 409);
    }

    const allocatedPaise = targetAlloc.allocatedPaise;

    const updateResult = await IncentiveRecoveryObligation.updateOne(
      {
        _id: obligationObjectId,
        organizationId: orgObjectId,
        totalReservedInPaise: { $gte: allocatedPaise },
        allocations: {
          $elemMatch: {
            allocationEventId: allocEventIdStr,
            state: "reserved",
            allocatedPaise: allocatedPaise,
          },
        },
      },
      {
        $inc: {
          totalReservedInPaise: -allocatedPaise,
        },
        $set: {
          "allocations.$[elem].state": "released",
          "allocations.$[elem].releasedAt": new Date(),
          "allocations.$[elem].releasedEventId": releaseEventIdStr,
        },
      },
      {
        session,
        arrayFilters: [{ "elem.allocationEventId": allocEventIdStr }],
      }
    );

    if (updateResult.matchedCount === 0) {
      throw new AppError("Concurrency conflict or state mismatch while releasing recovery allocation", 409);
    }

    return IncentiveRecoveryObligation.findById(obligationObjectId, null, { session });
  }

  /**
   * Reverses a previously confirmed recovery allocation (e.g. payroll rollback).
   *
   * @param {Object} params
   * @param {mongoose.Types.ObjectId|string} params.obligationId
   * @param {mongoose.Types.ObjectId|string} params.organizationId
   * @param {string} params.allocationEventId
   * @param {string} params.reversalEventId
   * @param {mongoose.ClientSession} params.session
   * @returns {Promise<IncentiveRecoveryObligation>}
   */
  async reverseAllocation({
    obligationId,
    organizationId,
    allocationEventId,
    reversalEventId,
    session,
  }) {
    if (!session) {
      throw new AppError("reverseAllocation requires an active MongoDB ClientSession", 500);
    }

    const obligationObjectId = new mongoose.Types.ObjectId(obligationId);
    const orgObjectId = new mongoose.Types.ObjectId(organizationId);
    const allocEventIdStr = String(allocationEventId);
    const reversalEventIdStr = String(reversalEventId);

    const obligation = await IncentiveRecoveryObligation.findOne(
      {
        _id: obligationObjectId,
        organizationId: orgObjectId,
        allocations: {
          $elemMatch: {
            allocationEventId: allocEventIdStr,
          },
        },
      },
      null,
      { session }
    );

    if (!obligation) {
      throw new AppError("Recovery obligation or allocation event not found", 404);
    }

    const targetAlloc = obligation.allocations.find((a) => a.allocationEventId === allocEventIdStr);
    if (targetAlloc.state === "reversed") {
      return obligation; // Idempotent return
    }
    if (targetAlloc.state !== "confirmed") {
      throw new AppError(`Cannot reverse allocation in state '${targetAlloc.state}'`, 409);
    }

    const allocatedPaise = targetAlloc.allocatedPaise;

    const updateResult = await IncentiveRecoveryObligation.updateOne(
      {
        _id: obligationObjectId,
        organizationId: orgObjectId,
        totalRecoveredInPaise: { $gte: allocatedPaise },
        allocations: {
          $elemMatch: {
            allocationEventId: allocEventIdStr,
            state: "confirmed",
            allocatedPaise: allocatedPaise,
          },
        },
      },
      {
        $inc: {
          totalRecoveredInPaise: -allocatedPaise,
        },
        $set: {
          "allocations.$[elem].state": "reversed",
          "allocations.$[elem].reversedAt": new Date(),
          "allocations.$[elem].reversalEventId": reversalEventIdStr,
        },
      },
      {
        session,
        arrayFilters: [{ "elem.allocationEventId": allocEventIdStr }],
      }
    );

    if (updateResult.matchedCount === 0) {
      throw new AppError("Concurrency conflict or state mismatch while reversing recovery allocation", 409);
    }

    const updatedDoc = await IncentiveRecoveryObligation.findById(obligationObjectId, null, { session });
    if (updatedDoc.totalRecoveredInPaise === 0) {
      updatedDoc.status = "pending";
    } else {
      updatedDoc.status = "partially_recovered";
    }
    await updatedDoc.save({ session });

    return updatedDoc;
  }
}

export const recoveryObligationService = new RecoveryObligationService();
