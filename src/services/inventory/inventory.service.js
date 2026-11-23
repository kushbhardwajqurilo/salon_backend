import mongoose from "mongoose";
import { AppError } from "../../utils/errors.js";
import { runInTransaction } from "../../utils/transaction.js";
import { productRepository } from "../../repositories/inventory/product.repository.js";
import { stockBalanceRepository } from "../../repositories/inventory/stockBalance.repository.js";
import { stockMovementRepository } from "../../repositories/inventory/stockMovement.repository.js";
import { validateQuantityForUnit } from "../../validation/inventory/inventory.validation.js";
import { assertCanManageBranches } from "../../utils/branchAuthorization.js";
import { AuditLog, AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";
import { StockBalance } from "../../models/inventory/stockBalance.model.js";
import { StockBatch } from "../../models/inventory/stockBatch.model.js";
import { FifoDepletionService, toMilliUnits } from "./fifoDepletion.service.js";
import { stockReservationRepository } from "../../repositories/inventory/stockReservation.repository.js";

export class InventoryService {
  /**
   * Helper to round numbers to 3 decimal places
   */
  roundQuantity(val) {
    return Math.round((val + Number.EPSILON) * 1000) / 1000;
  }

  // 1. PRODUCT CATALOGUE
  async createProduct(data, organizationId, userId) {
    const existing = await productRepository.findBySku(
      data.sku,
      organizationId,
    );
    if (existing) {
      throw new AppError(
        `Product with SKU '${data.sku.toUpperCase()}' already exists`,
        409,
      );
    }

    const product = await productRepository.create({
      ...data,
      sku: data.sku.trim().toUpperCase(),
      organizationId,
      createdBy: userId,
      updatedBy: userId,
    });

    const audit = new AuditLog({
      organizationId,
      actorId: userId,
      action: AUDIT_ACTIONS.INVENTORY_PRODUCT_CREATED,
      entityType: "Product",
      entityId: product._id,
      description: `Product created: ${product.name} (${product.sku})`,
      metadata: {
        sku: product.sku,
        usageType: product.usageType,
        stockUnit: product.stockUnit,
      },
    });
    await audit.save();

    return product;
  }

  async updateProduct(id, data, organizationId, userId) {
    const existing = await productRepository.findById(id, organizationId);
    if (!existing) {
      throw new AppError("Product not found", 404);
    }

    if (data.sku && data.sku.toUpperCase() !== existing.sku) {
      const duplicateSku = await productRepository.findBySku(
        data.sku,
        organizationId,
      );
      if (duplicateSku && duplicateSku._id.toString() !== id.toString()) {
        throw new AppError(
          `Product with SKU '${data.sku.toUpperCase()}' already exists`,
          409,
        );
      }
    }

    const updateData = {
      ...data,
      updatedBy: userId,
    };
    if (data.sku) updateData.sku = data.sku.trim().toUpperCase();

    const updated = await productRepository.update(
      id,
      organizationId,
      updateData,
    );

    const audit = new AuditLog({
      organizationId,
      actorId: userId,
      action: AUDIT_ACTIONS.INVENTORY_PRODUCT_UPDATED,
      entityType: "Product",
      entityId: updated._id,
      description: `Product updated: ${updated.name} (${updated.sku})`,
      metadata: updateData,
    });
    await audit.save();

    return updated;
  }

  async getProductById(id, organizationId) {
    const product = await productRepository.findById(id, organizationId);
    if (!product) {
      throw new AppError("Product not found", 404);
    }
    return product;
  }

  async listProducts(filter, pagination) {
    const query = { organizationId: filter.organizationId };
    if (filter.category) query.category = filter.category;
    if (filter.usageType) {
      if (filter.usageType === "retail_sale") {
        query.usageType = { $in: ["retail_sale", "both"] };
      } else if (filter.usageType === "salon_consumption") {
        query.usageType = { $in: ["salon_consumption", "both"] };
      } else {
        query.usageType = filter.usageType;
      }
    }
    if (filter.status) query.status = filter.status;
    if (filter.search) {
      query.$or = [
        { name: { $regex: filter.search, $options: "i" } },
        { sku: { $regex: filter.search, $options: "i" } },
      ];
    }

    const page = pagination.page || 1;
    const limit = pagination.limit || 20;
    const skip = (page - 1) * limit;

    const { products, total } = await productRepository.list(query, {
      skip,
      limit,
    });
    return {
      products,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // 2. STOCK BALANCE LISTING
  async listBranchStock(organizationId, branchId, options = {}) {
    const query = { organizationId };
    if (branchId) query.branchId = branchId;

    const page = options.page || 1;
    const limit = options.limit || 20;
    const skip = (page - 1) * limit;

    const { balances, total } = await stockBalanceRepository.list(query, {
      skip,
      limit,
    });

    let resultBalances = balances;
    if (options.lowStock === "true") {
      resultBalances = balances.filter(
        (b) => b.productId && b.onHand <= (b.productId.reorderLevel || 0),
      );
    }

    return {
      balances: resultBalances,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // 3. MANUAL SALON CONSUMPTION (ACID TRANSACTION + IDEMPOTENCY)
  async recordManualConsumption(payload, organizationId, userId) {
    const {
      branchId,
      productId,
      quantity,
      serviceId,
      appointmentId,
      notes,
      idempotencyKey,
    } = payload;

    // Idempotency check before transaction
    if (idempotencyKey) {
      const existingMovement =
        await stockMovementRepository.findByIdempotencyKey(
          organizationId,
          idempotencyKey,
        );
      if (existingMovement) {
        return {
          idempotentReplay: true,
          movement: existingMovement,
          message: "Request already processed",
        };
      }
    }

    return await runInTransaction(async (session) => {
      // 1. Validate Product
      const product = await productRepository.findById(
        productId,
        organizationId,
        session,
      );
      if (!product) {
        throw new AppError("Product not found", 404);
      }
      if (product.status !== "active") {
        throw new AppError(
          `Cannot consume inactive product '${product.name}'`,
          400,
        );
      }
      if (!["salon_consumption", "both"].includes(product.usageType)) {
        throw new AppError(
          `Product '${product.name}' with usage type '${product.usageType}' is not designated for salon consumption`,
          400,
        );
      }

      // 2. Validate unit & quantity precision
      const validation = validateQuantityForUnit(quantity, product.stockUnit);
      if (!validation.valid) {
        throw new AppError(validation.message, 400);
      }

      // Check if StockBatch lots exist for this product and domain.
      // If batches exist, perform FIFO batch depletion atomically.
      const batchCount = await StockBatch.countDocuments({
        organizationId,
        branchId,
        productId,
        stockDomain: "salon_consumables",
        status: "active",
        remainingQuantityMilli: { $gt: 0 },
      }).session(session);

      let movement;
      let balance;

      if (batchCount > 0) {
        const fifoResult = await FifoDepletionService.depleteFifo({
          organizationId,
          branchId,
          productId,
          stockDomain: "salon_consumables",
          quantity,
          movementType: "service_consumption",
          reference: {
            entityType: appointmentId
              ? "Appointment"
              : serviceId
                ? "Service"
                : "ManualConsumption",
            entityId: appointmentId || serviceId || null,
            identifier: idempotencyKey || null,
          },
          actorId: userId,
          notes: notes || "Salon consumption logged by staff",
          accountingDate: new Date(),
          idempotencyKey: idempotencyKey || null,
          session,
        });
        movement = fifoResult.movement;
        balance = fifoResult.updatedBalance;
      } else {
        // Fallback for pre-migration unbatched inventory
        const isBothUsage = product.usageType === "both";

        const balanceQuery = {
          organizationId,
          branchId,
          productId,
          onHand: { $gte: quantity },
        };

        if (isBothUsage) {
          balanceQuery.onHandConsumables = { $gte: quantity };
        } else {
          balanceQuery.$or = [
            { onHandConsumables: { $gte: quantity } },
            { onHandConsumables: 0, onHandRetail: 0 },
          ];
        }

        balance = await StockBalance.findOneAndUpdate(
          balanceQuery,
          [
            {
              $set: {
                lastMovementAt: new Date(),
                onHand: { $subtract: ["$onHand", quantity] },
                onHandConsumables: {
                  $cond: {
                    if: { $gte: ["$onHandConsumables", quantity] },
                    then: { $subtract: ["$onHandConsumables", quantity] },
                    else: 0,
                  },
                },
              },
            },
          ],
          { session, returnDocument: "after", updatePipeline: true },
        );

        if (!balance) {
          const currentBalance = await StockBalance.findOne({
            organizationId,
            branchId,
            productId,
          }).session(session);
          const available = currentBalance ? currentBalance.onHand : 0;
          throw new AppError(
            `Insufficient stock for '${product.name}'. Required: ${quantity} ${product.stockUnit}, Available: ${available} ${product.stockUnit}`,
            400,
          );
        }

        movement = await stockMovementRepository.create(
          {
            organizationId,
            branchId,
            productId,
            quantityDelta: -quantity,
            quantityDeltaMilli: -toMilliUnits(quantity),
            balanceAfter: this.roundQuantity(balance.onHand),
            balanceAfterMilli: toMilliUnits(balance.onHand),
            movementType: "service_consumption",
            stockDomain: "salon_consumables",
            reference: {
              entityType: appointmentId
                ? "Appointment"
                : serviceId
                  ? "Service"
                  : "ManualConsumption",
              entityId: appointmentId || serviceId || null,
              identifier: idempotencyKey || null,
            },
            actorId: userId,
            notes: notes || "Salon consumption logged by staff",
            idempotencyKey: idempotencyKey || null,
            isValued: false,
            unvaluedQuantityMilli: toMilliUnits(quantity),
            totalCostPaise: null,
            lotAllocations: [],
          },
          session,
        );
      }

      // 5. Audit Log
      const audit = new AuditLog({
        organizationId,
        branchId,
        actorId: userId,
        action: AUDIT_ACTIONS.INVENTORY_CONSUMED,
        entityType: "Product",
        entityId: productId,
        description: `Consumed ${quantity} ${product.stockUnit} of ${product.name}`,
        metadata: {
          quantity,
          unit: product.stockUnit,
          balanceAfter: balance.onHand,
          movementId: movement._id,
          idempotencyKey,
        },
      });
      await audit.save({ session });

      return {
        idempotentReplay: false,
        movement,
        balance,
      };
    });
  }

  // 4. STOCK ADJUSTMENTS (ACID TRANSACTION)
  async recordAdjustment(payload, organizationId, userId) {
    const {
      branchId,
      productId,
      quantityDelta,
      reason,
      notes,
      idempotencyKey,
    } = payload;

    if (idempotencyKey) {
      const existingMovement =
        await stockMovementRepository.findByIdempotencyKey(
          organizationId,
          idempotencyKey,
        );
      if (existingMovement) {
        return {
          idempotentReplay: true,
          movement: existingMovement,
          message: "Request already processed",
        };
      }
    }

    return await runInTransaction(async (session) => {
      const product = await productRepository.findById(
        productId,
        organizationId,
        session,
      );
      if (!product) {
        throw new AppError("Product not found", 404);
      }

      const absDelta = Math.abs(quantityDelta);
      const validation = validateQuantityForUnit(absDelta, product.stockUnit);
      if (!validation.valid) {
        throw new AppError(validation.message, 400);
      }

      // Ensure balance record exists
      await stockBalanceRepository.findOrCreate(
        organizationId,
        branchId,
        productId,
        session,
      );

      let balance;
      let movement;

      if (quantityDelta < 0) {
        // Negative adjustment (Stock loss/shrinkage/breakage):
        // Check if StockBatch lots exist to deplete via FIFO
        const batchCount = await StockBatch.countDocuments({
          organizationId,
          branchId,
          productId,
          status: "active",
          remainingQuantityMilli: { $gt: 0 },
        }).session(session);

        if (batchCount > 0) {
          // Determine dominant domain from available batches or product
          const domainBatch = await StockBatch.findOne({
            organizationId,
            branchId,
            productId,
            status: "active",
            remainingQuantityMilli: { $gt: 0 },
          }).sort({ receivedDate: 1 }).session(session);
          const targetDomain = domainBatch ? domainBatch.stockDomain : "salon_consumables";

          const fifoResult = await FifoDepletionService.depleteFifo({
            organizationId,
            branchId,
            productId,
            stockDomain: targetDomain,
            quantity: absDelta,
            movementType: "adjustment",
            reference: {
              entityType: "StockAdjustment",
              identifier: reason,
            },
            actorId: userId,
            notes: notes ? `${reason}: ${notes}` : reason,
            accountingDate: new Date(),
            idempotencyKey: idempotencyKey || null,
            session,
          });
          movement = fifoResult.movement;
          balance = fifoResult.updatedBalance;
        } else {
          // Pre-migration fallback without batches
          balance = await StockBalance.findOneAndUpdate(
            {
              organizationId,
              branchId,
              productId,
              onHand: { $gte: absDelta },
            },
            {
              $inc: { onHand: quantityDelta },
              $set: { lastMovementAt: new Date() },
            },
            { session, returnDocument: "after" },
          );

          if (!balance) {
            const current = await StockBalance.findOne({
              organizationId,
              branchId,
              productId,
            }).session(session);
            const available = current ? current.onHand : 0;
            throw new AppError(
              `Cannot adjust stock below zero. Requested reduction: ${absDelta}, Available: ${available}`,
              400,
            );
          }

          movement = await stockMovementRepository.create(
            {
              organizationId,
              branchId,
              productId,
              quantityDelta,
              quantityDeltaMilli: -toMilliUnits(absDelta),
              balanceAfter: this.roundQuantity(balance.onHand),
              balanceAfterMilli: toMilliUnits(balance.onHand),
              movementType: "adjustment",
              reference: {
                entityType: "StockAdjustment",
                identifier: reason,
              },
              actorId: userId,
              notes: notes ? `${reason}: ${notes}` : reason,
              idempotencyKey: idempotencyKey || null,
              isValued: false,
              unvaluedQuantityMilli: toMilliUnits(absDelta),
              totalCostPaise: null,
              lotAllocations: [],
            },
            session,
          );
        }
      } else {
        // Positive adjustment (Found stock/Opening lot addition):
        // Increment physical onHand
        const targetDomain =
          product.usageType === "retail_sale" ? "retail_products" : "salon_consumables";
        const domainIncField =
          targetDomain === "salon_consumables" ? "onHandConsumables" : "onHandRetail";

        balance = await StockBalance.findOneAndUpdate(
          {
            organizationId,
            branchId,
            productId,
          },
          {
            $inc: {
              onHand: quantityDelta,
              [domainIncField]: quantityDelta,
            },
            $set: { lastMovementAt: new Date() },
          },
          { session, returnDocument: "after" },
        );

        // Create an explicitly UNVALUED StockBatch for the positive adjustment (never assume zero cost!)
        const batchCount = await StockBatch.countDocuments({ organizationId }).session(session);
        const batchNumber = `BAT-ADJ-${String(batchCount + 1).padStart(6, "0")}`;
        const qtyMilli = toMilliUnits(quantityDelta);

        const newBatch = new StockBatch({
          organizationId,
          branchId,
          productId,
          stockDomain: targetDomain,
          batchNumber,
          sourceType: "manual_adjustment",
          sourceReference: {
            entityType: "StockAdjustment",
            identifier: reason,
          },
          receivedDate: new Date(),
          initialQuantityMilli: qtyMilli,
          remainingQuantityMilli: qtyMilli,
          isValued: false, // Explicitly unvalued: unknown cost is NOT zero cost
          unitCostPaise: null,
          totalCostPaise: null,
          status: "active",
          openingValuationMetadata: {
            valuedBy: null,
            valuedAt: null,
            sourceDocumentRef: null,
            notes: notes || `Manual positive stock adjustment: ${reason}`,
          },
          createdBy: userId,
        });
        await newBatch.save({ session });

        movement = await stockMovementRepository.create(
          {
            organizationId,
            branchId,
            productId,
            quantityDelta,
            quantityDeltaMilli: qtyMilli,
            balanceAfter: this.roundQuantity(balance.onHand),
            balanceAfterMilli: toMilliUnits(balance.onHand),
            movementType: "adjustment",
            stockDomain: targetDomain,
            reference: {
              entityType: "StockAdjustment",
              identifier: reason,
            },
            actorId: userId,
            notes: notes ? `${reason}: ${notes}` : reason,
            idempotencyKey: idempotencyKey || null,
            isValued: false,
            unvaluedQuantityMilli: qtyMilli,
            totalCostPaise: null,
            lotAllocations: [
              {
                batchId: newBatch._id,
                batchNumber: newBatch.batchNumber,
                quantityMilli: qtyMilli,
                isValued: false,
                unitCostPaise: null,
                allocatedCostPaise: null,
              },
            ],
          },
          session,
        );
      }

      const audit = new AuditLog({
        organizationId,
        branchId,
        actorId: userId,
        action: AUDIT_ACTIONS.INVENTORY_ADJUSTED,
        entityType: "Product",
        entityId: productId,
        description: `Adjusted stock by ${quantityDelta > 0 ? "+" : ""}${quantityDelta} ${product.stockUnit}. Reason: ${reason}`,
        metadata: {
          quantityDelta,
          reason,
          balanceAfter: balance.onHand,
          movementId: movement._id,
        },
      });
      await audit.save({ session });

      return {
        idempotentReplay: false,
        movement,
        balance,
      };
    });
  }

  // 5. INTER-BRANCH TRANSFER (ATOMIC SOURCE & DESTINATION)
  async recordTransfer(payload, organizationId, userId, user = null) {
    const {
      fromBranchId,
      toBranchId,
      productId,
      quantity,
      notes,
      idempotencyKey,
    } = payload;

    if (fromBranchId.toString() === toBranchId.toString()) {
      throw new AppError(
        "Source and destination branch cannot be the same",
        400,
      );
    }

    // Enforce branch authorization for both source and destination branches
    if (user) {
      await assertCanManageBranches(
        user,
        [fromBranchId, toBranchId],
        organizationId,
      );
    }

    if (idempotencyKey) {
      const existingMovement =
        await stockMovementRepository.findByIdempotencyKey(
          organizationId,
          idempotencyKey,
        );
      if (existingMovement) {
        return {
          idempotentReplay: true,
          movement: existingMovement,
          message: "Request already processed",
        };
      }
    }

    return await runInTransaction(async (session) => {
      const product = await productRepository.findById(
        productId,
        organizationId,
        session,
      );
      if (!product) {
        throw new AppError("Product not found", 404);
      }

      const validation = validateQuantityForUnit(quantity, product.stockUnit);
      if (!validation.valid) {
        throw new AppError(validation.message, 400);
      }

      // 1. Deduct from source branch
      const sourceBalance = await StockBalance.findOneAndUpdate(
        {
          organizationId,
          branchId: fromBranchId,
          productId,
          onHand: { $gte: quantity },
        },
        {
          $inc: { onHand: -quantity },
          $set: { lastMovementAt: new Date() },
        },
        { session, returnDocument: "after" },
      );

      if (!sourceBalance) {
        const curSource = await StockBalance.findOne({
          organizationId,
          branchId: fromBranchId,
          productId,
        }).session(session);
        const available = curSource ? curSource.onHand : 0;
        throw new AppError(
          `Insufficient stock at source branch. Required: ${quantity} ${product.stockUnit}, Available: ${available} ${product.stockUnit}`,
          400,
        );
      }

      // 2. Ensure dest balance exists & add to dest branch
      await stockBalanceRepository.findOrCreate(
        organizationId,
        toBranchId,
        productId,
        session,
      );

      const destBalance = await StockBalance.findOneAndUpdate(
        {
          organizationId,
          branchId: toBranchId,
          productId,
        },
        {
          $inc: { onHand: quantity },
          $set: { lastMovementAt: new Date() },
        },
        { session, returnDocument: "after" },
      );

      // 3. Create transfer_out movement
      const outMovement = await stockMovementRepository.create(
        {
          organizationId,
          branchId: fromBranchId,
          productId,
          quantityDelta: -quantity,
          balanceAfter: this.roundQuantity(sourceBalance.onHand),
          movementType: "transfer_out",
          reference: {
            entityType: "BranchTransfer",
            identifier: `To Branch: ${toBranchId}`,
          },
          actorId: userId,
          notes: notes || `Transfer out to branch ${toBranchId}`,
          idempotencyKey: idempotencyKey ? `${idempotencyKey}_out` : null,
        },
        session,
      );

      // 4. Create transfer_in movement
      const inMovement = await stockMovementRepository.create(
        {
          organizationId,
          branchId: toBranchId,
          productId,
          quantityDelta: quantity,
          balanceAfter: this.roundQuantity(destBalance.onHand),
          movementType: "transfer_in",
          reference: {
            entityType: "BranchTransfer",
            identifier: `From Branch: ${fromBranchId}`,
          },
          actorId: userId,
          notes: notes || `Transfer in from branch ${fromBranchId}`,
          idempotencyKey: idempotencyKey || null,
        },
        session,
      );

      // 5. Audit logs for both branches
      const audit = new AuditLog({
        organizationId,
        branchId: fromBranchId,
        actorId: userId,
        action: AUDIT_ACTIONS.INVENTORY_TRANSFERRED,
        entityType: "Product",
        entityId: productId,
        description: `Transferred ${quantity} ${product.stockUnit} of ${product.name} from branch ${fromBranchId} to ${toBranchId}`,
        metadata: {
          fromBranchId,
          toBranchId,
          quantity,
          transferOutId: outMovement._id,
          transferInId: inMovement._id,
        },
      });
      await audit.save({ session });

      return {
        idempotentReplay: false,
        outMovement,
        inMovement,
        sourceBalance,
        destBalance,
      };
    });
  }

  // 6. STOCK MOVEMENTS HISTORY
  async listStockMovements(filter, pagination) {
    const query = { organizationId: filter.organizationId };
    if (filter.branchId) query.branchId = filter.branchId;
    if (filter.productId) query.productId = filter.productId;
    if (filter.movementType) query.movementType = filter.movementType;
    if (filter.startDate || filter.endDate) {
      query.createdAt = {};
      if (filter.startDate) query.createdAt.$gte = new Date(filter.startDate);
      if (filter.endDate) query.createdAt.$lte = new Date(filter.endDate);
    }

    const page = pagination.page || 1;
    const limit = pagination.limit || 20;
    const skip = (page - 1) * limit;

    const { movements, total } = await stockMovementRepository.list(query, {
      skip,
      limit,
    });
    return {
      movements,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // 6b. STOCK BATCHES LISTING
  async listBatches(filter, pagination) {
    const query = { organizationId: filter.organizationId };
    if (filter.branchId) query.branchId = filter.branchId;
    if (filter.productId) query.productId = filter.productId;
    if (filter.stockDomain) query.stockDomain = filter.stockDomain;
    if (filter.isValued !== undefined) query.isValued = filter.isValued;
    if (filter.status) query.status = filter.status;

    const page = pagination.page || 1;
    const limit = pagination.limit || 20;
    const skip = (page - 1) * limit;

    const [batches, total] = await Promise.all([
      StockBatch.find(query)
        .populate("productId", "name sku stockUnit")
        .sort({ receivedDate: -1, _id: -1 })
        .skip(skip)
        .limit(limit),
      StockBatch.countDocuments(query),
    ]);

    return {
      batches,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // 6c. MOVEMENT REVERSAL
  async reverseMovement({
    movementId,
    organizationId,
    actorId,
    reason,
    returnQuantity,
    idempotencyKey,
  }) {
    return await runInTransaction(async (session) => {
      return await FifoDepletionService.reverseMovement({
        movementId,
        organizationId,
        actorId,
        reason,
        returnQuantity,
        idempotencyKey,
        session,
      });
    });
  }

  // 6d. OPENING-STOCK VALUATION WORKFLOW
  /**
   * Sets valuation on an unvalued opening batch for remaining physical quantity.
   * Crucially, this does NOT retroactively alter historical stock movements or previously recognized COGS.
   */
  async valueOpeningStockBatch({
    batchId,
    organizationId,
    branchId,
    unitCostPrice,
    notes,
    sourceDocumentRef,
    actorId,
  }) {
    if (!unitCostPrice || unitCostPrice <= 0) {
      throw new AppError("Unit cost price must be a positive number", 400);
    }
    if (!notes || !notes.trim()) {
      throw new AppError("Valuation reason/notes are mandatory for audit trail", 400);
    }

    return await runInTransaction(async (session) => {
      const batch = await StockBatch.findOne({
        _id: batchId,
        organizationId,
        branchId,
      }).session(session);

      if (!batch) {
        throw new AppError("Stock batch not found in branch scope", 404);
      }

      if (batch.isValued) {
        throw new AppError("Batch is already valued and cannot be revalued", 400);
      }

      const unitCostPaise = Math.round((unitCostPrice + Number.EPSILON) * 100);
      const remainingPaise = Math.round((batch.remainingQuantityMilli * unitCostPaise) / 1000);

      batch.isValued = true;
      batch.unitCostPaise = unitCostPaise;
      batch.totalCostPaise = remainingPaise;
      batch.openingValuationMetadata = {
        valuedBy: actorId,
        valuedAt: new Date(),
        sourceDocumentRef: sourceDocumentRef || null,
        notes: notes.trim(),
      };

      await batch.save({ session });

      const audit = new AuditLog({
        organizationId,
        branchId,
        actorId,
        action: AUDIT_ACTIONS.INVENTORY_BATCH_VALUED,
        entityType: "StockBatch",
        entityId: batch._id,
        description: `Valued opening stock batch ${batch.batchNumber} at ₹${unitCostPrice} per unit (${batch.remainingQuantityMilli / 1000} units remaining)`,
        metadata: {
          batchId: batch._id,
          batchNumber: batch.batchNumber,
          unitCostPrice,
          unitCostPaise,
          remainingQuantity: batch.remainingQuantityMilli / 1000,
          totalValuationPaise: remainingPaise,
          notes: notes.trim(),
          sourceDocumentRef: sourceDocumentRef || null,
        },
      });
      await audit.save({ session });

      return batch;
    });
  }

  // 7. STOCK RESERVATIONS FOR POS CHECKOUT
  /**
   * Atomically reserve stock for invoice draft product lines without deducting on-hand stock.
   * Prevents overselling by incrementing `allocated` when (onHand - allocated) >= requested quantity.
   */
  async reserveStockForInvoice(arg1, arg2, arg3, arg4, arg5, arg6) {
    let invoiceId,
      branchId,
      organizationId,
      items,
      session,
      reservationTtlMinutes;

    if (
      arg1 &&
      typeof arg1 === "object" &&
      !mongoose.isValidObjectId(arg1) &&
      !arg1._bsontype
    ) {
      ({
        invoiceId,
        branchId,
        organizationId,
        items,
        session,
        reservationTtlMinutes = 30,
      } = arg1);
    } else {
      invoiceId = arg1;
      organizationId = arg2;
      branchId = arg3;
      items = arg4;
      // If arg5 is a number, it was passed as reservationTtlMinutes with session omitted
      if (typeof arg5 === "number") {
        reservationTtlMinutes = arg5;
        session = null;
      } else {
        session = arg5 || null;
        reservationTtlMinutes = arg6 || 30;
      }
    }

    const expiresAt = new Date(Date.now() + reservationTtlMinutes * 60 * 1000);
    const reservations = [];

    // First release any prior active reservations for this invoice (e.g. cart modification)
    await this.releaseReservationsForInvoice(
      invoiceId,
      organizationId,
      session,
    );

    for (const item of items) {
      const { productId, quantity } = item;
      if (!quantity || quantity <= 0) continue;

      const product = await productRepository.findById(
        productId,
        organizationId,
        session,
      );
      if (!product) {
        throw new AppError(`Product not found: ${productId}`, 404);
      }
      if (product.status !== "active") {
        throw new AppError(
          `Cannot sell inactive product '${product.name}'`,
          400,
        );
      }
      if (!["retail_sale", "both"].includes(product.usageType)) {
        throw new AppError(
          `Product '${product.name}' is not designated for retail sale`,
          400,
        );
      }

      // Check unit precision
      const validation = validateQuantityForUnit(quantity, product.stockUnit);
      if (!validation.valid) {
        throw new AppError(validation.message, 400);
      }

      // Atomically allocate stock with retail domain awareness
      // For products with usageType: "retail_sale", onHand is exclusively retail.
      // For products with usageType: "both", onHandRetail MUST be allocated and sufficient.
      // Unallocated historical stock for "both" CANNOT be reserved or sold.
      const isBothUsage = product.usageType === "both";

      const allocQuery = {
        organizationId,
        branchId,
        productId,
        $expr: {
          $gte: [{ $subtract: ["$onHand", "$allocated"] }, quantity],
        },
      };

      if (isBothUsage) {
        allocQuery.$expr = {
          $and: [
            { $gte: [{ $subtract: ["$onHand", "$allocated"] }, quantity] },
            {
              $gte: [
                {
                  $subtract: [
                    { $ifNull: ["$onHandRetail", 0] },
                    { $ifNull: ["$allocatedRetail", 0] },
                  ],
                },
                quantity,
              ],
            },
          ],
        };
      } else {
        allocQuery.$or = [
          {
            $expr: {
              $gte: [
                {
                  $subtract: [
                    { $ifNull: ["$onHandRetail", 0] },
                    { $ifNull: ["$allocatedRetail", 0] },
                  ],
                },
                quantity,
              ],
            },
          },
          { onHandConsumables: 0, onHandRetail: 0 },
        ];
      }

      const updatedBalance = await StockBalance.findOneAndUpdate(
        allocQuery,
        [
          {
            $set: {
              lastMovementAt: new Date(),
              allocated: { $add: ["$allocated", quantity] },
              allocatedRetail: {
                $cond: {
                  if: { $gt: [{ $ifNull: ["$onHandRetail", 0] }, 0] },
                  then: {
                    $add: [{ $ifNull: ["$allocatedRetail", 0] }, quantity],
                  },
                  else: { $ifNull: ["$allocatedRetail", 0] },
                },
              },
            },
          },
        ],
        { session, returnDocument: "after", updatePipeline: true },
      );

      if (!updatedBalance) {
        const currentBalance = await StockBalance.findOne({
          organizationId,
          branchId,
          productId,
        }).session(session);

        const onHand = currentBalance?.onHand || 0;
        const allocated = currentBalance?.allocated || 0;
        const available = Math.max(0, this.roundQuantity(onHand - allocated));
        throw new AppError(
          `Insufficient available stock for '${product.name}' (${product.sku}). Required: ${quantity} ${product.stockUnit}, Available: ${available} ${product.stockUnit}`,
          400,
        );
      }

      const reservation = await stockReservationRepository.create(
        {
          organizationId,
          branchId,
          invoiceId,
          productId,
          quantity,
          status: "active",
          expiresAt,
          notes: `POS Cart Reservation for Invoice ${invoiceId}`,
        },
        session,
      );
      reservations.push(reservation);
    }

    return reservations;
  }

  /**
   * Release active reservations for an invoice (e.g. cart cleared, draft cancelled, or abandoned)
   */
  async releaseReservationsForInvoice(
    invoiceId,
    organizationId,
    session = null,
  ) {
    const activeReservations =
      await stockReservationRepository.findActiveByInvoice(
        invoiceId,
        organizationId,
        session,
      );

    for (const res of activeReservations) {
      await StockBalance.findOneAndUpdate(
        {
          organizationId,
          branchId: res.branchId,
          productId: res.productId,
        },
        {
          $inc: { allocated: -res.quantity },
          $set: { lastMovementAt: new Date() },
        },
        { session },
      );
    }

    if (activeReservations.length > 0) {
      await stockReservationRepository.updateStatusByInvoice(
        invoiceId,
        organizationId,
        "released",
        session,
      );
    }
  }

  /**
   * Atomically commit reservations into permanent `pos_sale` stock movements upon invoice payment.
   * Decrements both onHand and allocated atomically.
   */
  async commitReservationsForInvoice({ invoice, actorId, session }) {
    const activeReservations =
      await stockReservationRepository.findActiveByInvoice(
        invoice._id,
        invoice.organizationId,
        session,
      );

    const movements = [];

    for (const res of activeReservations) {
      const product = await productRepository.findById(
        res.productId,
        invoice.organizationId,
        session,
      );

      // Check if StockBatch lots exist for retail domain
      const batchCount = await StockBatch.countDocuments({
        organizationId: invoice.organizationId,
        branchId: res.branchId,
        productId: res.productId,
        stockDomain: "retail_products",
        status: "active",
        remainingQuantityMilli: { $gt: 0 },
      }).session(session);

      let movement;

      if (batchCount > 0) {
        // FIFO Depletion from batches
        const fifoResult = await FifoDepletionService.depleteFifo({
          organizationId: invoice.organizationId,
          branchId: res.branchId,
          productId: res.productId,
          stockDomain: "retail_products",
          quantity: res.quantity,
          movementType: "pos_sale",
          reference: {
            entityType: "Invoice",
            entityId: invoice._id,
            identifier: invoice.invoiceNumber,
          },
          actorId,
          notes: `POS Retail Sale: Invoice #${invoice.invoiceNumber} (${product ? product.name : "Product"})`,
          accountingDate: invoice.invoiceDate || new Date(),
          idempotencyKey: `pos_sale_${invoice._id}_${res.productId}`,
          session,
        });

        // Also decrement allocated counters since this was a reservation
        await StockBalance.findOneAndUpdate(
          {
            organizationId: invoice.organizationId,
            branchId: res.branchId,
            productId: res.productId,
          },
          [
            {
              $set: {
                allocated: { $subtract: ["$allocated", res.quantity] },
                allocatedRetail: {
                  $cond: {
                    if: { $gte: ["$allocatedRetail", res.quantity] },
                    then: { $subtract: ["$allocatedRetail", res.quantity] },
                    else: 0,
                  },
                },
              },
            },
          ],
          { session, updatePipeline: true },
        );

        movement = fifoResult.movement;
      } else {
        // Fallback for pre-migration unbatched inventory
        const updatedBalance = await StockBalance.findOneAndUpdate(
          {
            organizationId: invoice.organizationId,
            branchId: res.branchId,
            productId: res.productId,
          },
          [
            {
              $set: {
                lastMovementAt: new Date(),
                onHand: { $subtract: ["$onHand", res.quantity] },
                allocated: { $subtract: ["$allocated", res.quantity] },
                onHandRetail: {
                  $cond: {
                    if: { $gte: ["$onHandRetail", res.quantity] },
                    then: { $subtract: ["$onHandRetail", res.quantity] },
                    else: 0,
                  },
                },
                allocatedRetail: {
                  $cond: {
                    if: { $gte: ["$allocatedRetail", res.quantity] },
                    then: { $subtract: ["$allocatedRetail", res.quantity] },
                    else: 0,
                  },
                },
              },
            },
          ],
          { session, returnDocument: "after", updatePipeline: true },
        );

        movement = await stockMovementRepository.create(
          {
            organizationId: invoice.organizationId,
            branchId: res.branchId,
            productId: res.productId,
            quantityDelta: -res.quantity,
            quantityDeltaMilli: -toMilliUnits(res.quantity),
            balanceAfter: this.roundQuantity(
              updatedBalance ? updatedBalance.onHand : 0,
            ),
            balanceAfterMilli: toMilliUnits(
              updatedBalance ? updatedBalance.onHand : 0,
            ),
            movementType: "pos_sale",
            stockDomain: "retail_products",
            reference: {
              entityType: "Invoice",
              entityId: invoice._id,
              identifier: invoice.invoiceNumber,
            },
            actorId,
            notes: `POS Retail Sale: Invoice #${invoice.invoiceNumber} (${product ? product.name : "Product"})`,
            idempotencyKey: `pos_sale_${invoice._id}_${res.productId}`,
            accountingDate: invoice.invoiceDate || new Date(),
            isValued: false,
            unvaluedQuantityMilli: toMilliUnits(res.quantity),
            totalCostPaise: null,
            lotAllocations: [],
          },
          session,
        );
      }

      movements.push(movement);
    }

    if (activeReservations.length > 0) {
      await stockReservationRepository.updateStatusByInvoice(
        invoice._id,
        invoice.organizationId,
        "consumed",
        session,
      );
    }

    return movements;
  }

  /**
   * Transactional worker to clean up expired stock reservations.
   * Decrements allocated quantity exactly once per expired reservation.
   * Concurrency-safe against race conditions with simultaneous payment commitments.
   */
  async cleanupExpiredReservations(batchSize = 100) {
    const expiredList =
      await stockReservationRepository.findExpiredActiveReservations(batchSize);
    let expiredCount = 0;

    for (const item of expiredList) {
      await runInTransaction(async (session) => {
        // Double-check and transition reservation status to expired atomically within the session
        const expiredDoc =
          await stockReservationRepository.atomicallyExpireReservation(
            item._id,
            session,
          );
        if (!expiredDoc) {
          // Already consumed, released, or expired by another worker/request
          return;
        }

        // Decrement allocated quantity exactly once
        await StockBalance.findOneAndUpdate(
          {
            organizationId: expiredDoc.organizationId,
            branchId: expiredDoc.branchId,
            productId: expiredDoc.productId,
          },
          {
            $inc: { allocated: -expiredDoc.quantity },
            $set: { lastMovementAt: new Date() },
          },
          { session },
        );

        expiredCount++;
      });
    }

    return { processedCount: expiredCount };
  }

  /**
   * Manager-controlled domain stock allocation for products with usageType: "both".
   * Safely allocates from onHandUnallocated to onHandRetail, onHandConsumables, or both.
   * Concurrency-safe, transactional, idempotent, and audited.
   */
  async recordDomainAllocation(payload, organizationId, userId) {
    const {
      branchId,
      productId,
      retailQuantity = 0,
      consumablesQuantity = 0,
      reason,
      notes = "",
      idempotencyKey,
    } = payload;

    const getIdempotentReplay = async (session = null) => {
      if (!idempotencyKey) return null;

      const retailMovement = await stockMovementRepository.findByIdempotencyKey(
        organizationId,
        `${idempotencyKey}_retail`,
        session,
      );
      const consumablesMovement =
        await stockMovementRepository.findByIdempotencyKey(
          organizationId,
          `${idempotencyKey}_consumables`,
          session,
        );
      if (!retailMovement && !consumablesMovement) return null;

      const matchesMovement = (movement, quantity, domain, label) => {
        if (quantity === 0) return movement === null;
        return (
          movement !== null &&
          String(movement.branchId) === String(branchId) &&
          String(movement.productId) === String(productId) &&
          movement.movementType === "domain_allocation" &&
          movement.stockDomain === domain &&
          Number(movement.quantityDelta) === Number(quantity) &&
          movement.notes ===
            `Manager allocation to ${label}: ${reason}. Notes: ${notes}`
        );
      };

      if (
        !matchesMovement(
          retailMovement,
          retailQuantity,
          "retail_products",
          "Retail Products",
        ) ||
        !matchesMovement(
          consumablesMovement,
          consumablesQuantity,
          "salon_consumables",
          "Salon Consumables",
        )
      ) {
        throw new AppError(
          "Idempotency key was already used for a different stock allocation",
          409,
        );
      }

      const balance = await stockBalanceRepository.findByBranchAndProduct(
        organizationId,
        branchId,
        productId,
        session,
      );
      if (!balance) {
        throw new AppError("Allocated stock balance could not be found", 409);
      }

      return {
        message:
          "Stock domain allocation already processed (idempotent replay)",
        isIdempotentReplay: true,
        balance,
      };
    };

    const existingReplay = await getIdempotentReplay();
    if (existingReplay) return existingReplay;

    const totalToAllocate = this.roundQuantity(
      retailQuantity + consumablesQuantity,
    );
    if (totalToAllocate <= 0) {
      throw new AppError(
        "Total allocation quantity must be greater than zero",
        400,
      );
    }

    return await runInTransaction(async (session) => {
      const replay = await getIdempotentReplay(session);
      if (replay) return replay;

      const product = await productRepository.findById(
        productId,
        organizationId,
        session,
      );
      if (!product) {
        throw new AppError(`Product not found: ${productId}`, 404);
      }
      if (product.usageType !== "both") {
        throw new AppError(
          `Domain allocation is only applicable to products with usageType: 'both'. Current product is '${product.usageType}'`,
          400,
        );
      }

      if (retailQuantity > 0) {
        const retCheck = validateQuantityForUnit(
          retailQuantity,
          product.stockUnit,
        );
        if (!retCheck.valid)
          throw new AppError(`Retail quantity: ${retCheck.message}`, 400);
      }
      if (consumablesQuantity > 0) {
        const conCheck = validateQuantityForUnit(
          consumablesQuantity,
          product.stockUnit,
        );
        if (!conCheck.valid)
          throw new AppError(`Consumables quantity: ${conCheck.message}`, 400);
      }

      // Ensure stock balance exists
      const current = await stockBalanceRepository.findOrCreate(
        organizationId,
        branchId,
        productId,
        session,
      );

      // Determine available unallocated stock
      // If onHandUnallocated is explicitly recorded, use it.
      // If legacy balance has onHand > 0 and (onHandConsumables + onHandRetail === 0),
      // the initial unallocated quantity is onHand.
      let currentUnallocated = current.onHandUnallocated;
      if (
        (currentUnallocated === 0 || currentUnallocated === undefined) &&
        current.onHand > 0 &&
        (current.onHandConsumables || 0) + (current.onHandRetail || 0) === 0
      ) {
        currentUnallocated = current.onHand;
      }

      if (totalToAllocate > currentUnallocated) {
        throw new AppError(
          `Requested allocation (${totalToAllocate} ${product.stockUnit}) exceeds available unallocated stock (${currentUnallocated} ${product.stockUnit})`,
          400,
        );
      }

      // Atomic allocation mutation
      const updatedBalance = await StockBalance.findOneAndUpdate(
        {
          organizationId,
          branchId,
          productId,
          $or: [
            { onHandUnallocated: { $gte: totalToAllocate } },
            // Legacy unmigrated state where domain fields are absent or 0 but aggregate onHand >= totalToAllocate
            {
              $and: [
                {
                  $or: [
                    { onHandUnallocated: { $exists: false } },
                    { onHandUnallocated: 0 },
                  ],
                },
                {
                  $or: [
                    { onHandConsumables: { $exists: false } },
                    { onHandConsumables: 0 },
                  ],
                },
                {
                  $or: [
                    { onHandRetail: { $exists: false } },
                    { onHandRetail: 0 },
                  ],
                },
                { onHand: { $gte: totalToAllocate } },
              ],
            },
          ],
        },
        [
          {
            $set: {
              lastMovementAt: new Date(),
              onHandConsumables: {
                $add: [
                  { $ifNull: ["$onHandConsumables", 0] },
                  consumablesQuantity,
                ],
              },
              onHandRetail: {
                $add: [{ $ifNull: ["$onHandRetail", 0] }, retailQuantity],
              },
              onHandUnallocated: {
                $cond: {
                  if: { $gt: [{ $ifNull: ["$onHandUnallocated", 0] }, 0] },
                  then: { $subtract: ["$onHandUnallocated", totalToAllocate] },
                  else: { $subtract: ["$onHand", totalToAllocate] },
                },
              },
            },
          },
        ],
        { session, returnDocument: "after", updatePipeline: true },
      );

      if (!updatedBalance) {
        throw new AppError(
          "Concurrent allocation conflict or insufficient unallocated stock. Please retry.",
          409,
        );
      }

      // Log domain_allocation movement for retail pool if retailQuantity > 0
      if (retailQuantity > 0) {
        await stockMovementRepository.create(
          {
            organizationId,
            branchId,
            productId,
            quantityDelta: retailQuantity,
            balanceAfter: updatedBalance.onHandRetail,
            movementType: "domain_allocation",
            stockDomain: "retail_products",
            reference: {
              entityType: "StockBalance",
              entityId: updatedBalance._id,
              identifier: `ALLOC_RETAIL_${Date.now()}`,
            },
            actorId: userId,
            notes: `Manager allocation to Retail Products: ${reason}. Notes: ${notes}`,
            idempotencyKey: idempotencyKey ? `${idempotencyKey}_retail` : null,
          },
          session,
        );
      }

      // Log domain_allocation movement for consumables pool if consumablesQuantity > 0
      if (consumablesQuantity > 0) {
        await stockMovementRepository.create(
          {
            organizationId,
            branchId,
            productId,
            quantityDelta: consumablesQuantity,
            balanceAfter: updatedBalance.onHandConsumables,
            movementType: "domain_allocation",
            stockDomain: "salon_consumables",
            reference: {
              entityType: "StockBalance",
              entityId: updatedBalance._id,
              identifier: `ALLOC_CONSUMABLE_${Date.now()}`,
            },
            actorId: userId,
            notes: `Manager allocation to Salon Consumables: ${reason}. Notes: ${notes}`,
            idempotencyKey: idempotencyKey
              ? `${idempotencyKey}_consumables`
              : null,
          },
          session,
        );
      }

      // Audit Log entry
      await AuditLog.create(
        [
          {
            organizationId,
            branchId,
            actorId: userId,
            action: AUDIT_ACTIONS.INVENTORY_DOMAIN_ALLOCATED,
            entityType: "StockBalance",
            entityId: updatedBalance._id,
            description: `Allocated ${totalToAllocate} ${product.stockUnit} of ${product.name} (Retail: ${retailQuantity}, Consumables: ${consumablesQuantity})`,
            metadata: {
              productId,
              productName: product.name,
              sku: product.sku,
              sourceUnallocated: currentUnallocated,
              retailAllocated: retailQuantity,
              consumablesAllocated: consumablesQuantity,
              remainingUnallocated: updatedBalance.onHandUnallocated,
              reason,
              notes,
            },
          },
        ],
        { session },
      );

      return {
        message: "Domain stock allocation completed successfully",
        balance: updatedBalance,
        allocation: {
          allocatedTotal: totalToAllocate,
          retailAllocated: retailQuantity,
          consumablesAllocated: consumablesQuantity,
          remainingUnallocated: updatedBalance.onHandUnallocated,
          reason,
        },
      };
    });
  }
}

export const inventoryService = new InventoryService();
