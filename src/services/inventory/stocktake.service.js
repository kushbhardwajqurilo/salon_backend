import { AppError } from "../../utils/errors.js";
import { runInTransaction } from "../../utils/transaction.js";
import { Stocktake } from "../../models/inventory/stocktake.model.js";
import { StocktakeItem } from "../../models/inventory/stocktakeItem.model.js";
import { StockBalance } from "../../models/inventory/stockBalance.model.js";
import { StockMovement } from "../../models/inventory/stockMovement.model.js";
import { StockBatch } from "../../models/inventory/stockBatch.model.js";
import { Product } from "../../models/inventory/product.model.js";
import { validateQuantityForUnit } from "../../validation/inventory/inventory.validation.js";
import { AuditLog, AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";
import {
  toMilliUnits,
  fromMilliUnits,
  calculateAllocatedCostPaise,
} from "./fifoDepletion.service.js";

export class StocktakeService {
  /**
   * Generates a unique stocktake number within the tenant
   */
  async _generateStocktakeNumber(organizationId, session = null) {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const count = await Stocktake.countDocuments({
      organizationId,
      createdAt: {
        $gte: new Date(new Date().setHours(0, 0, 0, 0)),
      },
    }).session(session);
    return `STK-${today}-${String(count + 1).padStart(4, "0")}`;
  }

  /**
   * Helper to round decimal quantities to 3 places
   */
  _roundQuantity(val) {
    return Math.round(Number(val) * 1000) / 1000;
  }

  /**
   * 1. CREATE STOCKTAKE SESSION
   * Snapshots active products and their domain balances for the authenticated branch.
   */
  async createStocktake({ organizationId, branchId, userId, title, targetDomain = "all", notes = "" }) {
    if (!branchId) {
      throw new AppError("Branch context is required to initiate a stocktake", 400);
    }

    return await runInTransaction(async (session) => {
      // 1. Fetch eligible active products for this tenant
      const productFilter = {
        organizationId,
        status: "active",
        isDeleted: { $ne: true },
      };

      if (targetDomain === "salon_consumables") {
        productFilter.usageType = { $in: ["salon_consumption", "both"] };
      } else if (targetDomain === "retail_products") {
        productFilter.usageType = { $in: ["retail_sale", "both"] };
      }

      const products = await Product.find(productFilter).session(session);
      if (!products || products.length === 0) {
        throw new AppError("No active products available for the selected stock domain scope", 400);
      }

      const productIds = products.map((p) => p._id);
      const balances = await StockBalance.find({
        organizationId,
        branchId,
        productId: { $in: productIds },
      }).session(session);

      const balanceMap = new Map();
      balances.forEach((b) => {
        balanceMap.set(b.productId.toString(), b);
      });

      // 2. Generate stocktake number & parent record
      const stocktakeNumber = await this._generateStocktakeNumber(organizationId, session);
      const stocktake = new Stocktake({
        organizationId,
        branchId,
        stocktakeNumber,
        status: "draft",
        title: title || "Physical Stocktake",
        targetDomain,
        initiatedBy: userId,
        notes: notes || "",
      });

      const itemsToInsert = [];

      for (const product of products) {
        const bal = balanceMap.get(product._id.toString());
        const snapshotMovementAt = bal?.lastMovementAt || bal?.updatedAt || new Date(0);

        // Salon Consumables domain check
        if (
          (targetDomain === "all" || targetDomain === "salon_consumables") &&
          ["salon_consumption", "both"].includes(product.usageType)
        ) {
          itemsToInsert.push({
            organizationId,
            branchId,
            stocktakeId: stocktake._id,
            productId: product._id,
            stockDomain: "salon_consumables",
            stockUnit: product.stockUnit,
            snapshotQuantity: this._roundQuantity(bal ? bal.onHandConsumables : 0),
            snapshotMovementAt,
            countedQuantity: null,
            status: "uncounted",
          });
        }

        // Retail Products domain check
        if (
          (targetDomain === "all" || targetDomain === "retail_products") &&
          ["retail_sale", "both"].includes(product.usageType)
        ) {
          itemsToInsert.push({
            organizationId,
            branchId,
            stocktakeId: stocktake._id,
            productId: product._id,
            stockDomain: "retail_products",
            stockUnit: product.stockUnit,
            snapshotQuantity: this._roundQuantity(bal ? bal.onHandRetail : 0),
            snapshotMovementAt,
            countedQuantity: null,
            status: "uncounted",
          });
        }
      }

      stocktake.totalItems = itemsToInsert.length;
      await stocktake.save({ session });

      if (itemsToInsert.length > 0) {
        await StocktakeItem.insertMany(itemsToInsert, { session });
      }

      const audit = new AuditLog({
        organizationId,
        branchId,
        actorId: userId,
        action: AUDIT_ACTIONS.INVENTORY_STOCKTAKE,
        entityType: "Stocktake",
        entityId: stocktake._id,
        description: `Initiated stocktake session ${stocktake.stocktakeNumber} with ${itemsToInsert.length} lines`,
        metadata: {
          stocktakeNumber: stocktake.stocktakeNumber,
          targetDomain,
          totalItems: itemsToInsert.length,
        },
      });
      await audit.save({ session });

      return stocktake;
    });
  }

  /**
   * 2. LIST STOCKTAKES
   */
  async listStocktakes({ organizationId, branchId, status, targetDomain, page = 1, limit = 20 }) {
    const query = { organizationId };
    if (branchId) query.branchId = branchId;
    if (status) query.status = status;
    if (targetDomain) query.targetDomain = targetDomain;

    const skip = (page - 1) * limit;
    const [stocktakes, total] = await Promise.all([
      Stocktake.find(query)
        .populate("initiatedBy", "name email")
        .populate("postedBy", "name email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Stocktake.countDocuments(query),
    ]);

    return {
      stocktakes: stocktakes.map((st) => ({
        ...st,
        id: st._id.toString(),
      })),
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * 3. GET STOCKTAKE DETAILS WITH ITEMS
   */
  async getStocktakeById({ stocktakeId, organizationId, branchId }) {
    const query = { _id: stocktakeId, organizationId };
    if (branchId) query.branchId = branchId;

    const stocktake = await Stocktake.findOne(query)
      .populate("initiatedBy", "name email")
      .populate("postedBy", "name email")
      .lean();

    if (!stocktake) {
      throw new AppError("Stocktake session not found", 404);
    }

    const items = await StocktakeItem.find({
      stocktakeId: stocktake._id,
      organizationId,
    })
      .populate("productId", "name sku stockUnit usageType category")
      .sort({ "productId.name": 1, stockDomain: 1 })
      .lean();

    const productIds = items.map((it) =>
      it.productId && typeof it.productId === "object" ? it.productId._id : it.productId,
    );
    const liveBalances = await StockBalance.find({
      organizationId,
      branchId: stocktake.branchId,
      productId: { $in: productIds },
    }).lean();

    const balMap = new Map();
    liveBalances.forEach((b) => balMap.set(b.productId.toString(), b));

    const formattedItems = items.map((item) => {
      const isPopulatedProd = item.productId && typeof item.productId === "object";
      const prodIdStr = isPopulatedProd
        ? item.productId._id.toString()
        : item.productId?.toString();
      const bal = prodIdStr ? balMap.get(prodIdStr) : undefined;
      const liveDomainBalance =
        item.stockDomain === "salon_consumables"
          ? bal?.onHandConsumables || 0
          : bal?.onHandRetail || 0;

      return {
        ...item,
        id: item._id.toString(),
        liveBalance: this._roundQuantity(liveDomainBalance),
        product: isPopulatedProd
          ? {
              id: item.productId._id.toString(),
              name: item.productId.name,
              sku: item.productId.sku,
              stockUnit: item.productId.stockUnit,
              usageType: item.productId.usageType,
              category: item.productId.category,
            }
          : undefined,
        productId: prodIdStr,
      };
    });

    return {
      ...stocktake,
      id: stocktake._id.toString(),
      items: formattedItems,
    };
  }

  /**
   * 4. RECORD PHYSICAL COUNTS
   * Validates fractional quantities against stockUnit, records server timestamp,
   * captures live lastMovementAt on StockBalance as verifiedMovementAt, and updates status.
   */
  async recordCounts({ stocktakeId, organizationId, branchId, userId, items }) {
    if (!items || !Array.isArray(items) || items.length === 0) {
      throw new AppError("No count items provided", 400);
    }

    return await runInTransaction(async (session) => {
      const stocktake = await Stocktake.findOne({
        _id: stocktakeId,
        organizationId,
        branchId,
      }).session(session);

      if (!stocktake) {
        throw new AppError("Stocktake session not found", 404);
      }

      if (["completed", "cancelled"].includes(stocktake.status)) {
        throw new AppError(`Cannot update counts for a stocktake in '${stocktake.status}' status`, 400);
      }

      const serverCountTime = new Date();

      for (const entry of items) {
        const { productId, stockDomain, countedQuantity, notes } = entry;

        if (countedQuantity === null || countedQuantity === undefined || countedQuantity < 0) {
          throw new AppError("Counted quantity must be a non-negative number", 400);
        }

        const stocktakeItem = await StocktakeItem.findOne({
          stocktakeId,
          productId,
          stockDomain,
          organizationId,
          branchId,
        }).session(session);

        if (!stocktakeItem) {
          throw new AppError(`Product ${productId} in domain '${stockDomain}' is not part of this stocktake`, 404);
        }

        if (countedQuantity !== 0) {
          const unitCheck = validateQuantityForUnit(countedQuantity, stocktakeItem.stockUnit);
          if (!unitCheck.valid) {
            throw new AppError(`Item count invalid for unit '${stocktakeItem.stockUnit}': ${unitCheck.message}`, 400);
          }
        }

        // Fetch live StockBalance to capture verifiedMovementAt timestamp
        const liveBal = await StockBalance.findOne({
          organizationId,
          branchId,
          productId,
        }).session(session);

        const currentMovementAt = liveBal?.lastMovementAt || liveBal?.updatedAt || new Date(0);

        stocktakeItem.countedQuantity = this._roundQuantity(countedQuantity);
        stocktakeItem.countedAt = serverCountTime;
        stocktakeItem.verifiedMovementAt = currentMovementAt;
        stocktakeItem.countedBy = userId;
        stocktakeItem.status = "counted";
        if (notes !== undefined) stocktakeItem.notes = notes;

        await stocktakeItem.save({ session });
      }

      // Update parent counts & transition draft -> in_progress
      const [totalCounted, totalDiscrepancies] = await Promise.all([
        StocktakeItem.countDocuments({
          stocktakeId,
          countedQuantity: { $ne: null },
        }).session(session),
        StocktakeItem.countDocuments({
          stocktakeId,
          countedQuantity: { $ne: null },
          $expr: { $ne: ["$countedQuantity", "$snapshotQuantity"] },
        }).session(session),
      ]);

      stocktake.countedItemsCount = totalCounted;
      stocktake.discrepancyCount = totalDiscrepancies;
      if (stocktake.status === "draft") {
        stocktake.status = "in_progress";
      }

      await stocktake.save({ session });

      return {
        stocktakeId: stocktake._id,
        status: stocktake.status,
        totalItems: stocktake.totalItems,
        countedItemsCount: totalCounted,
        discrepancyCount: totalDiscrepancies,
      };
    });
  }

  /**
   * 5. GET READ-ONLY DISCREPANCY PREVIEW
   * Compares recorded physical counts against live domain balances without altering state.
   */
  async getDiscrepancies({ stocktakeId, organizationId, branchId }) {
    const stocktake = await Stocktake.findOne({
      _id: stocktakeId,
      organizationId,
      branchId,
    }).lean();

    if (!stocktake) {
      throw new AppError("Stocktake session not found", 404);
    }

    const items = await StocktakeItem.find({
      stocktakeId,
      organizationId,
    })
      .populate("productId", "name sku stockUnit category")
      .lean();

    const productIds = items.map((it) => it.productId._id || it.productId);
    const liveBalances = await StockBalance.find({
      organizationId,
      branchId,
      productId: { $in: productIds },
    }).lean();

    const balMap = new Map();
    liveBalances.forEach((b) => balMap.set(b.productId.toString(), b));

    let uncountedCount = 0;
    let discrepanciesCount = 0;

    const previewItems = items.map((item) => {
      const prodIdStr = (item.productId._id || item.productId).toString();
      const bal = balMap.get(prodIdStr);

      const liveDomainBalance =
        item.stockDomain === "salon_consumables"
          ? bal?.onHandConsumables || 0
          : bal?.onHandRetail || 0;

      const isCounted = item.countedQuantity !== null;
      if (!isCounted) uncountedCount++;

      const varianceAgainstLive = isCounted
        ? this._roundQuantity(item.countedQuantity - liveDomainBalance)
        : null;

      const varianceAgainstSnapshot = isCounted
        ? this._roundQuantity(item.countedQuantity - item.snapshotQuantity)
        : null;

      if (varianceAgainstLive !== null && varianceAgainstLive !== 0) {
        discrepanciesCount++;
      }

      const prodObj = item.productId && typeof item.productId === "object" ? item.productId : null;
      const prodName = prodObj?.name || "Product";
      const sku = prodObj?.sku || "";

      return {
        _id: item._id,
        itemId: item._id.toString(),
        productId: item.productId,
        productName: prodName,
        sku,
        stockDomain: item.stockDomain,
        stockUnit: item.stockUnit,
        snapshotQuantity: item.snapshotQuantity,
        liveBalance: this._roundQuantity(liveDomainBalance),
        countedQuantity: item.countedQuantity,
        countedAt: item.countedAt,
        varianceAgainstLive,
        varianceAgainstSnapshot,
        status: item.status,
      };
    });

    const isPostable = uncountedCount === 0 && ["draft", "in_progress"].includes(stocktake.status);
    const recountRequiredCount = items.filter((i) => i.status === "recount_required").length;
    const blockers = [];
    if (uncountedCount > 0) {
      blockers.push(`${uncountedCount} line item(s) are uncounted. All lines must be counted before posting.`);
    }
    if (recountRequiredCount > 0) {
      blockers.push(`${recountRequiredCount} line item(s) require physical recount due to intervening inventory movements.`);
    }
    if (!["draft", "in_progress"].includes(stocktake.status)) {
      blockers.push(`Stocktake is currently in '${stocktake.status}' status and cannot be posted.`);
    }

    return {
      stocktakeId: stocktake._id,
      stocktakeNumber: stocktake.stocktakeNumber,
      status: stocktake.status,
      totalItems: stocktake.totalItems,
      uncountedCount,
      uncountedItems: uncountedCount,
      discrepanciesCount,
      discrepantItems: discrepanciesCount,
      matchedItems: Math.max(0, stocktake.totalItems - discrepanciesCount - uncountedCount),
      recountRequiredCount,
      isPostable,
      canPost: isPostable && recountRequiredCount === 0,
      blockers,
      items: previewItems,
      discrepancies: previewItems,
    };
  }

  /**
   * 6. POST STOCKTAKE (TRANSACTIONAL, ATOMIC & IDEMPOTENT)
   * Enforces:
   * - Conditional test-and-set lock: status draft/in_progress -> posting
   * - Incomplete stocktake rejection (no silent 0 conversions)
   * - Race-safe concurrency detection: verifiedMovementAt vs live StockBalance.lastMovementAt AND StockMovement query
   * - On-the-fly reconciliation: writes StockMovement(stocktake) only for non-zero variance
   * - Atomic StockBalance domain update and aggregate onHand recalculation
   * - Session completion and idempotency replay
   */
  async postStocktake({ stocktakeId, organizationId, branchId, userId, idempotencyKey = null }) {
    // 1. Idempotent replay check (outside transaction for high performance)
    if (idempotencyKey) {
      const existingStocktake = await Stocktake.findOne({
        organizationId,
        idempotencyKey,
      });
      if (existingStocktake) {
        if (existingStocktake._id.toString() === stocktakeId.toString()) {
          return {
            stocktake: existingStocktake,
            replayed: true,
            message: "Stocktake previously posted successfully (idempotent replay)",
          };
        } else {
          throw new AppError("Idempotency key has already been used for another stocktake", 409);
        }
      }
    }

    // 2. Execute transactional posting
    try {
      return await runInTransaction(async (session) => {
      // Step A: Acquire atomic state transition lock: status in ['draft', 'in_progress'] -> 'posting'
      const stocktake = await Stocktake.findOneAndUpdate(
        {
          _id: stocktakeId,
          organizationId,
          branchId,
          status: { $in: ["draft", "in_progress"] },
        },
        {
          $set: { status: "posting" },
        },
        { session, returnDocument: "after" }
      );

      if (!stocktake) {
        const current = await Stocktake.findOne({ _id: stocktakeId, organizationId, branchId }).session(session);
        if (!current) {
          throw new AppError("Stocktake session not found", 404);
        }
        if (current.status === "completed") {
          if (idempotencyKey && current.idempotencyKey === idempotencyKey) {
            return {
              stocktake: current,
              replayed: true,
              message: "Stocktake previously posted successfully (idempotent replay)",
            };
          }
          throw new AppError("Stocktake has already been completed and posted", 409);
        }
        if (current.status === "posting") {
          throw new AppError("Stocktake is currently being posted by another concurrent process", 409);
        }
        throw new AppError(`Cannot post stocktake in '${current.status}' status`, 400);
      }

      // Step B: Fetch all stocktake items
      const items = await StocktakeItem.find({
        stocktakeId,
        organizationId,
        branchId,
      }).session(session);

      if (!items || items.length === 0) {
        throw new AppError("Stocktake has no items to reconcile", 400);
      }

      // Step C: Strict validation - reject uncounted lines
      const uncounted = items.filter((it) => it.countedQuantity === null);
      if (uncounted.length > 0) {
        throw new AppError(
          `Cannot post stocktake: ${uncounted.length} item(s) have not been physically counted. All lines must be explicitly counted.`,
          400
        );
      }

      // Step D: Race-safe conflict detection across all items
      const conflicts = [];
      const productIds = items.map((it) => it.productId);

      // Lock-read live balances with session
      const balances = await StockBalance.find({
        organizationId,
        branchId,
        productId: { $in: productIds },
      }).session(session);

      const balMap = new Map();
      balances.forEach((b) => balMap.set(b.productId.toString(), b));

      for (const item of items) {
        const prodIdStr = item.productId.toString();
        const liveBal = balMap.get(prodIdStr);

        // Movement-level conflict check
        const interveningMovement = await StockMovement.findOne({
          organizationId,
          branchId,
          productId: item.productId,
          stockDomain: item.stockDomain,
          createdAt: { $gt: item.countedAt },
        }).session(session);

        // Balance-level shared version/movement check
        const currentBalMovementAt = liveBal?.lastMovementAt || liveBal?.updatedAt || new Date(0);
        const verifiedAt = item.verifiedMovementAt ? new Date(item.verifiedMovementAt).getTime() : 0;
        const currentAt = new Date(currentBalMovementAt).getTime();

        if (interveningMovement || currentAt > verifiedAt) {
          conflicts.push({
            productId: item.productId,
            stockDomain: item.stockDomain,
            countedAt: item.countedAt,
            movementDetectedAt: interveningMovement ? interveningMovement.createdAt : currentBalMovementAt,
            movementType: interveningMovement?.movementType || "external_balance_update",
            quantityDelta: interveningMovement?.quantityDelta || null,
          });
        }
      }

      // If any concurrent stock activity occurred after counting, throw conflict error to abort transaction
      if (conflicts.length > 0) {
        const err = new AppError(
          "Stock movements occurred after physical counts were recorded. Recount required for flagged lines.",
          409
        );
        err.conflicts = conflicts;
        err.requiresRecount = true;
        throw err;
      }

      // Step E: Apply adjustments to StockBalance, FIFO StockBatches, and write StockMovement
      const movementsToInsert = [];
      let nonZeroVariancesCount = 0;

      for (const item of items) {
        const prodIdStr = item.productId.toString();
        const liveBal = balMap.get(prodIdStr);

        const domainField =
          item.stockDomain === "salon_consumables" ? "onHandConsumables" : "onHandRetail";

        const currentLiveDomainQty = this._roundQuantity(liveBal ? liveBal[domainField] : 0);
        const physicalCountedQty = this._roundQuantity(item.countedQuantity);
        const variance = this._roundQuantity(physicalCountedQty - currentLiveDomainQty);

        item.systemQuantityAtPost = currentLiveDomainQty;
        item.varianceQuantity = variance;

        if (variance !== 0) {
          nonZeroVariancesCount++;

          // Deterministic unique reference identifier for movement idempotency
          const movementIdentifier = `STK_${stocktake.stocktakeNumber}_${item.productId}_${item.stockDomain}`;
          const varianceMilli = toMilliUnits(variance);
          const absVarianceMilli = Math.abs(varianceMilli);

          let lotAllocations = [];
          let totalCostPaise = null;
          let isValued = false;
          let valuedQuantityMilli = 0;
          let unvaluedQuantityMilli = 0;

          if (variance < 0) {
            // NEGATIVE VARIANCE (Inventory shrinkage / shortage):
            // Check if active batches exist for this product and stockDomain
            const batches = await StockBatch.find({
              organizationId,
              branchId,
              productId: item.productId,
              stockDomain: item.stockDomain,
              status: "active",
              remainingQuantityMilli: { $gt: 0 },
            })
              .sort({ receivedDate: 1, _id: 1 })
              .session(session);

            if (batches.length > 0) {
              let remainingToDepleteMilli = absVarianceMilli;
              let accumulatedCostPaise = 0;
              let hasUnvalued = false;

              for (const batch of batches) {
                if (remainingToDepleteMilli <= 0) break;

                const takeMilli = Math.min(batch.remainingQuantityMilli, remainingToDepleteMilli);

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
                  { session, returnDocument: "after", updatePipeline: true }
                );

                if (!updatedBatch) {
                  throw new AppError(
                    `Concurrent batch depletion race on batch ${batch.batchNumber}`,
                    409
                  );
                }

                let trancheCostPaise = null;
                if (batch.isValued && batch.unitCostPaise !== null) {
                  trancheCostPaise = calculateAllocatedCostPaise(takeMilli, batch.unitCostPaise);
                  accumulatedCostPaise += trancheCostPaise;
                  valuedQuantityMilli += takeMilli;
                } else {
                  hasUnvalued = true;
                  unvaluedQuantityMilli += takeMilli;
                }

                lotAllocations.push({
                  batchId: batch._id,
                  batchNumber: batch.batchNumber,
                  quantityMilli: takeMilli,
                  isValued: batch.isValued,
                  unitCostPaise: batch.unitCostPaise,
                  allocatedCostPaise: trancheCostPaise,
                });

                remainingToDepleteMilli -= takeMilli;
              }

              // If stock had fewer batches than requested reduction (e.g. pre-migration or partial lots),
              // record leftover shortage as unvalued
              if (remainingToDepleteMilli > 0) {
                hasUnvalued = true;
                unvaluedQuantityMilli += remainingToDepleteMilli;
              }

              isValued = !hasUnvalued;
              totalCostPaise = hasUnvalued ? null : accumulatedCostPaise;
            } else {
              // Pre-migration fallback: no batches initialized yet
              unvaluedQuantityMilli = absVarianceMilli;
              isValued = false;
              totalCostPaise = null;
            }
          } else {
            // POSITIVE VARIANCE (Found stock / overage):
            // Create an explicitly UNVALUED StockBatch for the positive variance (never invent purchase cost!)
            const batchCount = await StockBatch.countDocuments({ organizationId }).session(session);
            const batchNumber = `BAT-STK-${String(batchCount + 1).padStart(6, "0")}`;

            const newBatch = new StockBatch({
              organizationId,
              branchId,
              productId: item.productId,
              stockDomain: item.stockDomain,
              batchNumber,
              sourceType: "manual_adjustment",
              sourceReference: {
                entityType: "Stocktake",
                entityId: stocktake._id,
                identifier: stocktake.stocktakeNumber,
              },
              receivedDate: new Date(),
              initialQuantityMilli: absVarianceMilli,
              remainingQuantityMilli: absVarianceMilli,
              isValued: false, // Explicitly unvalued: unknown cost is NOT zero cost
              unitCostPaise: null,
              totalCostPaise: null,
              status: "active",
              openingValuationMetadata: {
                valuedBy: null,
                valuedAt: null,
                sourceDocumentRef: null,
                notes: `Stocktake #${stocktake.stocktakeNumber} positive variance found stock`,
              },
              createdBy: userId,
            });
            await newBatch.save({ session });

            lotAllocations = [
              {
                batchId: newBatch._id,
                batchNumber: newBatch.batchNumber,
                quantityMilli: absVarianceMilli,
                isValued: false,
                unitCostPaise: null,
                allocatedCostPaise: null,
              },
            ];
            isValued = false;
            unvaluedQuantityMilli = absVarianceMilli;
            totalCostPaise = null;
          }

          // Update StockBalance atomically
          const updatedBalance = await StockBalance.findOneAndUpdate(
            {
              organizationId,
              branchId,
              productId: item.productId,
            },
            [
              {
                $set: {
                  [domainField]: physicalCountedQty,
                  onHand: {
                    $add: [
                      {
                        $subtract: [
                          { $ifNull: ["$onHand", 0] },
                          { $ifNull: [`$${domainField}`, 0] },
                        ],
                      },
                      physicalCountedQty,
                    ],
                  },
                  lastMovementAt: new Date(),
                },
              },
            ],
            { session, upsert: true, returnDocument: "after", updatePipeline: true, setDefaultsOnInsert: true }
          );

          // Prepare immutable StockMovement record
          movementsToInsert.push({
            organizationId,
            branchId,
            productId: item.productId,
            quantityDelta: variance,
            quantityDeltaMilli: varianceMilli,
            balanceAfter: physicalCountedQty,
            balanceAfterMilli: toMilliUnits(physicalCountedQty),
            movementType: "stocktake",
            stockDomain: item.stockDomain,
            reference: {
              entityType: "Stocktake",
              entityId: stocktake._id,
              identifier: movementIdentifier,
            },
            actorId: userId,
            notes: `Physical Stocktake #${stocktake.stocktakeNumber} reconciliation [${item.stockDomain}]. Counted: ${physicalCountedQty}, Prior: ${currentLiveDomainQty}, Variance: ${variance}`,
            idempotencyKey: idempotencyKey ? `${idempotencyKey}_${item.productId}_${item.stockDomain}` : null,
            accountingDate: new Date(),
            isValued,
            valuedQuantityMilli,
            unvaluedQuantityMilli,
            totalCostPaise,
            lotAllocations,
          });
        }

        await item.save({ session });
      }

      if (movementsToInsert.length > 0) {
        await StockMovement.insertMany(movementsToInsert, { session });
      }

      // Step F: Mark Stocktake completed
      stocktake.status = "completed";
      stocktake.postedBy = userId;
      stocktake.postedAt = new Date();
      stocktake.discrepancyCount = nonZeroVariancesCount;
      if (idempotencyKey) {
        stocktake.idempotencyKey = idempotencyKey;
      }
      await stocktake.save({ session });

      const audit = new AuditLog({
        organizationId,
        branchId,
        actorId: userId,
        action: AUDIT_ACTIONS.INVENTORY_STOCKTAKE,
        entityType: "Stocktake",
        entityId: stocktake._id,
        description: `Posted stocktake session ${stocktake.stocktakeNumber}. Reconciled ${nonZeroVariancesCount} discrepancies.`,
        metadata: {
          stocktakeNumber: stocktake.stocktakeNumber,
          totalItems: items.length,
          reconciledDiscrepancies: nonZeroVariancesCount,
        },
      });
      await audit.save({ session });

      return {
        stocktake,
        movementsCreated: movementsToInsert.length,
        reconciledDiscrepancies: nonZeroVariancesCount,
        message: "Stocktake posted and inventory reconciled successfully",
      };
    });
    } catch (err) {
      // If posting aborted due to concurrent stock movement conflict,
      // persist recount_required status on affected items and reset session to in_progress outside the aborted transaction
      if (err.requiresRecount && err.conflicts?.length > 0) {
        const conflictedProdIds = err.conflicts.map((c) => c.productId);
        await StocktakeItem.updateMany(
          {
            stocktakeId,
            productId: { $in: conflictedProdIds },
          },
          { $set: { status: "recount_required" } }
        );

        await Stocktake.updateOne(
          { _id: stocktakeId, status: "posting" },
          { $set: { status: "in_progress" } }
        );
      } else {
        // In case of any other error during posting while locked in 'posting' state, revert back to in_progress
        await Stocktake.updateOne(
          { _id: stocktakeId, status: "posting" },
          { $set: { status: "in_progress" } }
        );
      }
      throw err;
    }
  }

  /**
   * 7. CANCEL STOCKTAKE
   */
  async cancelStocktake({ stocktakeId, organizationId, branchId, userId, reason = "" }) {
    return await runInTransaction(async (session) => {
      const stocktake = await Stocktake.findOne({
        _id: stocktakeId,
        organizationId,
        branchId,
      }).session(session);

      if (!stocktake) {
        throw new AppError("Stocktake session not found", 404);
      }

      if (["completed", "cancelled"].includes(stocktake.status)) {
        throw new AppError(`Cannot cancel a stocktake in '${stocktake.status}' status`, 400);
      }

      stocktake.status = "cancelled";
      stocktake.notes = stocktake.notes
        ? `${stocktake.notes} | Cancelled: ${reason}`
        : `Cancelled: ${reason}`;
      await stocktake.save({ session });

      const audit = new AuditLog({
        organizationId,
        branchId,
        actorId: userId,
        action: AUDIT_ACTIONS.INVENTORY_STOCKTAKE,
        entityType: "Stocktake",
        entityId: stocktake._id,
        description: `Cancelled stocktake session ${stocktake.stocktakeNumber}`,
        metadata: {
          stocktakeNumber: stocktake.stocktakeNumber,
          reason,
        },
      });
      await audit.save({ session });

      return stocktake;
    });
  }
}

export const stocktakeService = new StocktakeService();
