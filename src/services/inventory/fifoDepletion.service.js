import mongoose from "mongoose";
import { StockBatch } from "../../models/inventory/stockBatch.model.js";
import { StockBalance } from "../../models/inventory/stockBalance.model.js";
import { StockMovement } from "../../models/inventory/stockMovement.model.js";
import { AppError } from "../../utils/errors.js";

/**
 * Normalizes any quantity into an integer milli-unit (1 unit = 1000 milli-units).
 * e.g., 0.333 -> 333, 1 -> 1000, 2.5 -> 2500.
 */
export const toMilliUnits = (quantity) => {
  if (typeof quantity !== "number" || isNaN(quantity)) {
    throw new AppError("Invalid quantity: must be a number", 400);
  }
  return Math.round((quantity + Number.EPSILON) * 1000);
};

export const fromMilliUnits = (milliUnits) => {
  if (typeof milliUnits !== "number" || isNaN(milliUnits)) {
    return 0;
  }
  return milliUnits / 1000;
};

/**
 * Deterministic integer paise allocation.
 * allocatedPaise = Math.round((quantityMilli * unitCostPaise) / 1000)
 */
export const calculateAllocatedCostPaise = (quantityMilli, unitCostPaise) => {
  if (unitCostPaise === null || unitCostPaise === undefined) return null;
  return Math.round((quantityMilli * unitCostPaise) / 1000);
};

export class FifoDepletionService {
  /**
   * Performs FIFO depletion across batches for a given product, branch, and stockDomain.
   * Consumes physical stock in receipt order (receivedDate ASC, _id ASC) across BOTH
   * valued and unvalued lots. Does NOT skip older unvalued lots!
   *
   * Must be called within an active MongoDB transaction session.
   * Uses conditional atomic updates on StockBatch:
   *   remainingQuantityMilli: { $gte: deltaMilli }
   *
   * Retries up to maxRetries on write conflicts or concurrent depletion races.
   */
  static async depleteFifo({
    organizationId,
    branchId,
    productId,
    stockDomain,
    quantity,
    movementType,
    reference,
    actorId,
    notes = "",
    accountingDate = new Date(),
    idempotencyKey = null,
    session,
    maxRetries = 5,
  }) {
    if (!session) {
      throw new AppError("FIFO depletion requires an active ACID session", 500);
    }

    const requestedMilli = toMilliUnits(quantity);
    if (requestedMilli <= 0) {
      throw new AppError("Depletion quantity must be greater than zero", 400);
    }

    let attempt = 0;
    while (attempt < maxRetries) {
      attempt++;
      try {
        return await FifoDepletionService._executeFifoDepletion({
          organizationId,
          branchId,
          productId,
          stockDomain,
          requestedMilli,
          movementType,
          reference,
          actorId,
          notes,
          accountingDate,
          idempotencyKey,
          session,
        });
      } catch (err) {
        // If it's a concurrent write conflict / stale batch balance error, retry with fresh read
        if (err.isRetryableDepletion && attempt < maxRetries) {
          continue;
        }
        throw err;
      }
    }

    throw new AppError(
      `FIFO depletion write conflict: failed after ${maxRetries} attempts due to high concurrency.`,
      409
    );
  }

  static async _executeFifoDepletion({
    organizationId,
    branchId,
    productId,
    stockDomain,
    requestedMilli,
    movementType,
    reference,
    actorId,
    notes,
    accountingDate,
    idempotencyKey,
    session,
  }) {
    // 1. Fetch available batches in receipt order (FIFO)
    // Both valued and unvalued lots are fetched in chronological receiptDate order
    const batches = await StockBatch.find({
      organizationId,
      branchId,
      productId,
      stockDomain,
      status: "active",
      remainingQuantityMilli: { $gt: 0 },
    })
      .sort({ receivedDate: 1, _id: 1 })
      .session(session);

    let totalAvailableMilli = batches.reduce((sum, b) => sum + b.remainingQuantityMilli, 0);

    // If total batch quantity is insufficient, check if opening migration hasn't created a batch yet
    // but stock balance exists. If not enough batches, throw error.
    if (totalAvailableMilli < requestedMilli) {
      throw new AppError(
        `Insufficient stock in batches to satisfy depletion of ${fromMilliUnits(requestedMilli)} units. Available: ${fromMilliUnits(totalAvailableMilli)}`,
        400
      );
    }

    let remainingToDepleteMilli = requestedMilli;
    const allocations = [];
    let totalCostPaise = 0;
    let hasUnvalued = false;
    let valuedQuantityMilli = 0;
    let unvaluedQuantityMilli = 0;

    for (const batch of batches) {
      if (remainingToDepleteMilli <= 0) break;

      const takeMilli = Math.min(batch.remainingQuantityMilli, remainingToDepleteMilli);

      // Perform conditional atomic update on the batch
      const updatedBatch = await StockBatch.findOneAndUpdate(
        {
          _id: batch._id,
          remainingQuantityMilli: { $gte: takeMilli },
        },
        [
          {
            $set: {
              remainingQuantityMilli: { $subtract: ["$remainingQuantityMilli", takeMilli] },
              status: {
                $cond: {
                  if: { $eq: [{ $subtract: ["$remainingQuantityMilli", takeMilli] }, 0] },
                  then: "depleted",
                  else: "$status",
                },
              },
            },
          },
        ],
        { session, returnDocument: 'after', updatePipeline: true }
      );

      if (!updatedBatch) {
        // Race condition: another transaction consumed this batch concurrently
        const conflictErr = new Error("Concurrent batch depletion conflict");
        conflictErr.isRetryableDepletion = true;
        throw conflictErr;
      }

      let trancheCostPaise = null;
      if (batch.isValued && batch.unitCostPaise !== null) {
        trancheCostPaise = calculateAllocatedCostPaise(takeMilli, batch.unitCostPaise);
        totalCostPaise += trancheCostPaise;
        valuedQuantityMilli += takeMilli;
      } else {
        hasUnvalued = true;
        unvaluedQuantityMilli += takeMilli;
      }

      allocations.push({
        batchId: batch._id,
        batchNumber: batch.batchNumber,
        quantityMilli: takeMilli,
        isValued: batch.isValued,
        unitCostPaise: batch.unitCostPaise,
        allocatedCostPaise: trancheCostPaise,
      });

      remainingToDepleteMilli -= takeMilli;
    }

    if (remainingToDepleteMilli > 0) {
      const conflictErr = new Error("Could not deplete all requested quantity from batches");
      conflictErr.isRetryableDepletion = true;
      throw conflictErr;
    }

    // 2. Decrement physical StockBalance
    const deltaUnits = fromMilliUnits(requestedMilli);
    const domainField =
      stockDomain === "salon_consumables" ? "onHandConsumables" : "onHandRetail";

    const updatedBalance = await StockBalance.findOneAndUpdate(
      {
        organizationId,
        branchId,
        productId,
        [domainField]: { $gte: deltaUnits },
      },
      {
        $inc: {
          onHand: -deltaUnits,
          [domainField]: -deltaUnits,
        },
        $set: { lastMovementAt: new Date() },
      },
      { session, returnDocument: 'after' }
    );

    if (!updatedBalance) {
      throw new AppError(
        `Insufficient balance in ${stockDomain} domain to deplete ${deltaUnits} units`,
        400
      );
    }

    // 3. Create immutable StockMovement
    const movement = new StockMovement({
      organizationId,
      branchId,
      productId,
      quantityDelta: -deltaUnits,
      quantityDeltaMilli: -requestedMilli,
      balanceAfter: updatedBalance.onHand,
      balanceAfterMilli: toMilliUnits(updatedBalance.onHand),
      movementType,
      stockDomain,
      reference,
      actorId,
      notes,
      accountingDate,
      idempotencyKey,
      isValued: !hasUnvalued,
      valuedQuantityMilli,
      unvaluedQuantityMilli,
      totalCostPaise: hasUnvalued ? null : totalCostPaise,
      lotAllocations: allocations,
    });

    await movement.save({ session });

    return {
      movement,
      allocations,
      totalCostPaise: hasUnvalued ? null : totalCostPaise,
      isFullyValued: !hasUnvalued,
      valuedQuantity: fromMilliUnits(valuedQuantityMilli),
      unvaluedQuantity: fromMilliUnits(unvaluedQuantityMilli),
      updatedBalance,
    };
  }

  /**
   * Reverses a stock movement atomically and idempotently.
   * Supports:
   * - Full reversal (default)
   * - Partial return (when returnQuantityMilli is specified)
   * Restores exact historical batches and unit costs.
   */
  static async reverseMovement({
    movementId,
    organizationId,
    actorId,
    reason = "Return / Reversal",
    returnQuantity = null, // If null, full reversal of the original movement
    accountingDate = new Date(),
    idempotencyKey = null,
    session,
  }) {
    if (!session) {
      throw new AppError("Movement reversal requires an active ACID session", 500);
    }

    // 1. Fetch movement inside session
    const originalMovement = await StockMovement.findOne({
      _id: movementId,
      organizationId,
    }).session(session);

    if (!originalMovement) {
      throw new AppError("Stock movement not found", 404);
    }

    if (originalMovement.isReversed) {
      throw new AppError("Movement has already been reversed", 400);
    }

    if (originalMovement.movementType === "movement_reversal") {
      throw new AppError("Cannot reverse a reversal movement", 400);
    }

    const originalMilli = Math.abs(originalMovement.quantityDeltaMilli || toMilliUnits(originalMovement.quantityDelta));
    const requestedReturnMilli = returnQuantity !== null ? toMilliUnits(returnQuantity) : originalMilli;

    if (requestedReturnMilli <= 0 || requestedReturnMilli > originalMilli) {
      throw new AppError(
        `Return quantity must be between 0.001 and original movement quantity (${fromMilliUnits(originalMilli)})`,
        400
      );
    }

    // 2. Mark original movement as reversed if full reversal
    if (requestedReturnMilli === originalMilli) {
      const lockOriginal = await StockMovement.findOneAndUpdate(
        { _id: originalMovement._id, isReversed: false },
        { $set: { isReversed: true } },
        { session, returnDocument: 'after' }
      );
      if (!lockOriginal) {
        throw new AppError("Concurrent reversal conflict: movement already reversed", 409);
      }
    }

    // 3. Restore batches according to original lot allocations (in reverse order or proportional)
    let remainingToRestoreMilli = requestedReturnMilli;
    const reversalAllocations = [];
    let totalRestoredCostPaise = 0;
    let hasUnvalued = false;
    let restoredValuedMilli = 0;
    let restoredUnvaluedMilli = 0;

    // Iterate backwards through allocations (LIFO restoration of depleted batches)
    const reversedAllocations = [...originalMovement.lotAllocations].reverse();

    for (const alloc of reversedAllocations) {
      if (remainingToRestoreMilli <= 0) break;

      const restoreMilli = Math.min(alloc.quantityMilli, remainingToRestoreMilli);

      // Increment batch remainingQuantityMilli and reactivate status if depleted
      await StockBatch.findByIdAndUpdate(
        alloc.batchId,
        {
          $inc: { remainingQuantityMilli: restoreMilli },
          $set: { status: "active" },
        },
        { session }
      );

      let allocCostPaise = null;
      if (alloc.isValued && alloc.unitCostPaise !== null) {
        allocCostPaise = calculateAllocatedCostPaise(restoreMilli, alloc.unitCostPaise);
        totalRestoredCostPaise += allocCostPaise;
        restoredValuedMilli += restoreMilli;
      } else {
        hasUnvalued = true;
        restoredUnvaluedMilli += restoreMilli;
      }

      reversalAllocations.push({
        batchId: alloc.batchId,
        batchNumber: alloc.batchNumber,
        quantityMilli: restoreMilli,
        isValued: alloc.isValued,
        unitCostPaise: alloc.unitCostPaise,
        allocatedCostPaise: allocCostPaise,
      });

      remainingToRestoreMilli -= restoreMilli;
    }

    // 4. Increment StockBalance
    const restoreUnits = fromMilliUnits(requestedReturnMilli);
    const domainField =
      originalMovement.stockDomain === "salon_consumables" ? "onHandConsumables" : "onHandRetail";

    const updatedBalance = await StockBalance.findOneAndUpdate(
      {
        organizationId,
        branchId: originalMovement.branchId,
        productId: originalMovement.productId,
      },
      {
        $inc: {
          onHand: restoreUnits,
          [domainField]: restoreUnits,
        },
        $set: { lastMovementAt: new Date() },
      },
      { session, returnDocument: 'after' }
    );

    // 5. Create compensating reversal StockMovement
    const reversalMovement = new StockMovement({
      organizationId,
      branchId: originalMovement.branchId,
      productId: originalMovement.productId,
      quantityDelta: restoreUnits,
      quantityDeltaMilli: requestedReturnMilli,
      balanceAfter: updatedBalance.onHand,
      balanceAfterMilli: toMilliUnits(updatedBalance.onHand),
      movementType: "movement_reversal",
      stockDomain: originalMovement.stockDomain,
      reference: {
        entityType: "StockMovement",
        entityId: originalMovement._id,
        identifier: `REVERSAL_${originalMovement._id}`,
      },
      reversesMovementId: originalMovement._id,
      actorId,
      notes: `${reason} (Reversed from movement ${originalMovement._id})`,
      accountingDate,
      idempotencyKey,
      isValued: !hasUnvalued,
      valuedQuantityMilli: restoredValuedMilli,
      unvaluedQuantityMilli: restoredUnvaluedMilli,
      totalCostPaise: hasUnvalued ? null : totalRestoredCostPaise,
      lotAllocations: reversalAllocations,
    });

    await reversalMovement.save({ session });

    // Link original movement to reversal movement if full reversal
    if (requestedReturnMilli === originalMilli) {
      await StockMovement.findByIdAndUpdate(
        originalMovement._id,
        { $set: { reversedByMovementId: reversalMovement._id } },
        { session }
      );
    }

    return {
      reversalMovement,
      restoredQuantity: restoreUnits,
      restoredCostPaise: hasUnvalued ? null : totalRestoredCostPaise,
      updatedBalance,
    };
  }

  /**
   * Creates a new StockBatch on GRN acceptance inside an active session.
   */
  static async createGrnBatch({
    organizationId,
    branchId,
    productId,
    stockDomain,
    grnId,
    grnNumber,
    supplierId,
    receivedDate,
    receivedQuantity,
    unitCostPrice, // In rupees (can be decimal)
    userId,
    session,
  }) {
    const quantityMilli = toMilliUnits(receivedQuantity);
    const unitCostPaise = Math.round((unitCostPrice + Number.EPSILON) * 100);
    const totalCostPaise = calculateAllocatedCostPaise(quantityMilli, unitCostPaise);

    const batchCount = await StockBatch.countDocuments({ organizationId }).session(session);
    const batchNumber = `BAT-${String(batchCount + 1).padStart(6, "0")}`;

    const batch = new StockBatch({
      organizationId,
      branchId,
      productId,
      stockDomain,
      batchNumber,
      sourceType: "procurement_grn",
      sourceReference: {
        entityType: "GoodsReceiptNote",
        entityId: grnId,
        identifier: grnNumber,
      },
      supplierId,
      receivedDate: receivedDate || new Date(),
      initialQuantityMilli: quantityMilli,
      remainingQuantityMilli: quantityMilli,
      isValued: true,
      unitCostPaise,
      totalCostPaise,
      status: "active",
      createdBy: userId,
    });

    await batch.save({ session });
    return batch;
  }
}
