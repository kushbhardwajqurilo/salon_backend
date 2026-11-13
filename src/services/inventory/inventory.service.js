import { AppError } from "../../utils/errors.js";
import { runInTransaction } from "../../utils/transaction.js";
import { productRepository } from "../../repositories/inventory/product.repository.js";
import { stockBalanceRepository } from "../../repositories/inventory/stockBalance.repository.js";
import { stockMovementRepository } from "../../repositories/inventory/stockMovement.repository.js";
import { validateQuantityForUnit } from "../../validation/inventory/inventory.validation.js";
import { AuditLog, AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";
import { StockBalance } from "../../models/inventory/stockBalance.model.js";

export class InventoryService {
  /**
   * Helper to round numbers to 3 decimal places
   */
  roundQuantity(val) {
    return Math.round((val + Number.EPSILON) * 1000) / 1000;
  }

  // 1. PRODUCT CATALOGUE
  async createProduct(data, organizationId, userId) {
    const existing = await productRepository.findBySku(data.sku, organizationId);
    if (existing) {
      throw new AppError(`Product with SKU '${data.sku.toUpperCase()}' already exists`, 409);
    }

    const product = await productRepository.create({
      ...data,
      sku: data.sku.trim().toUpperCase(),
      organizationId,
      createdBy: userId,
      updatedBy: userId
    });

    const audit = new AuditLog({
      organizationId,
      actorId: userId,
      action: AUDIT_ACTIONS.INVENTORY_PRODUCT_CREATED,
      entityType: "Product",
      entityId: product._id,
      description: `Product created: ${product.name} (${product.sku})`,
      metadata: { sku: product.sku, usageType: product.usageType, stockUnit: product.stockUnit }
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
      const duplicateSku = await productRepository.findBySku(data.sku, organizationId);
      if (duplicateSku && duplicateSku._id.toString() !== id.toString()) {
        throw new AppError(`Product with SKU '${data.sku.toUpperCase()}' already exists`, 409);
      }
    }

    const updateData = {
      ...data,
      updatedBy: userId
    };
    if (data.sku) updateData.sku = data.sku.trim().toUpperCase();

    const updated = await productRepository.update(id, organizationId, updateData);

    const audit = new AuditLog({
      organizationId,
      actorId: userId,
      action: AUDIT_ACTIONS.INVENTORY_PRODUCT_UPDATED,
      entityType: "Product",
      entityId: updated._id,
      description: `Product updated: ${updated.name} (${updated.sku})`,
      metadata: updateData
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
    if (filter.usageType) query.usageType = filter.usageType;
    if (filter.status) query.status = filter.status;
    if (filter.search) {
      query.$or = [
        { name: { $regex: filter.search, $options: "i" } },
        { sku: { $regex: filter.search, $options: "i" } }
      ];
    }

    const page = pagination.page || 1;
    const limit = pagination.limit || 20;
    const skip = (page - 1) * limit;

    const { products, total } = await productRepository.list(query, { skip, limit });
    return {
      products,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    };
  }

  // 2. STOCK BALANCE LISTING
  async listBranchStock(organizationId, branchId, options = {}) {
    const query = { organizationId };
    if (branchId) query.branchId = branchId;

    const page = options.page || 1;
    const limit = options.limit || 20;
    const skip = (page - 1) * limit;

    const { balances, total } = await stockBalanceRepository.list(query, { skip, limit });

    let resultBalances = balances;
    if (options.lowStock === "true") {
      resultBalances = balances.filter(
        (b) => b.productId && b.onHand <= (b.productId.reorderLevel || 0)
      );
    }

    return {
      balances: resultBalances,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    };
  }

  // 3. MANUAL SALON CONSUMPTION (ACID TRANSACTION + IDEMPOTENCY)
  async recordManualConsumption(payload, organizationId, userId) {
    const { branchId, productId, quantity, serviceId, appointmentId, notes, idempotencyKey } = payload;

    // Idempotency check before transaction
    if (idempotencyKey) {
      const existingMovement = await stockMovementRepository.findByIdempotencyKey(
        organizationId,
        idempotencyKey
      );
      if (existingMovement) {
        return {
          idempotentReplay: true,
          movement: existingMovement,
          message: "Request already processed"
        };
      }
    }

    return await runInTransaction(async (session) => {
      // 1. Validate Product
      const product = await productRepository.findById(productId, organizationId, session);
      if (!product) {
        throw new AppError("Product not found", 404);
      }
      if (product.status !== "active") {
        throw new AppError(`Cannot consume inactive product '${product.name}'`, 400);
      }
      if (!["salon_consumption", "both"].includes(product.usageType)) {
        throw new AppError(
          `Product '${product.name}' with usage type '${product.usageType}' is not designated for salon consumption`,
          400
        );
      }

      // 2. Validate unit & quantity precision
      const validation = validateQuantityForUnit(quantity, product.stockUnit);
      if (!validation.valid) {
        throw new AppError(validation.message, 400);
      }

      // 3. Atomically check and deduct stock
      const balance = await StockBalance.findOneAndUpdate(
        {
          organizationId,
          branchId,
          productId,
          onHand: { $gte: quantity }
        },
        {
          $inc: { onHand: -quantity },
          $set: { lastMovementAt: new Date() }
        },
        { session, returnDocument: "after" }
      );

      if (!balance) {
        // Find existing balance to report current available stock
        const currentBalance = await StockBalance.findOne({
          organizationId,
          branchId,
          productId
        }).session(session);
        const available = currentBalance ? currentBalance.onHand : 0;
        throw new AppError(
          `Insufficient stock for '${product.name}'. Required: ${quantity} ${product.stockUnit}, Available: ${available} ${product.stockUnit}`,
          400
        );
      }

      // 4. Create immutable StockMovement
      const movement = await stockMovementRepository.create(
        {
          organizationId,
          branchId,
          productId,
          quantityDelta: -quantity,
          balanceAfter: this.roundQuantity(balance.onHand),
          movementType: "salon_consumption",
          reference: {
            entityType: appointmentId ? "Appointment" : serviceId ? "Service" : "ManualConsumption",
            entityId: appointmentId || serviceId || null,
            identifier: idempotencyKey || null
          },
          actorId: userId,
          notes: notes || "Salon consumption logged by staff",
          idempotencyKey: idempotencyKey || null
        },
        session
      );

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
          idempotencyKey
        }
      });
      await audit.save({ session });

      return {
        idempotentReplay: false,
        movement,
        balance
      };
    });
  }

  // 4. STOCK ADJUSTMENTS (ACID TRANSACTION)
  async recordAdjustment(payload, organizationId, userId) {
    const { branchId, productId, quantityDelta, reason, notes, idempotencyKey } = payload;

    if (idempotencyKey) {
      const existingMovement = await stockMovementRepository.findByIdempotencyKey(
        organizationId,
        idempotencyKey
      );
      if (existingMovement) {
        return {
          idempotentReplay: true,
          movement: existingMovement,
          message: "Request already processed"
        };
      }
    }

    return await runInTransaction(async (session) => {
      const product = await productRepository.findById(productId, organizationId, session);
      if (!product) {
        throw new AppError("Product not found", 404);
      }

      const absDelta = Math.abs(quantityDelta);
      const validation = validateQuantityForUnit(absDelta, product.stockUnit);
      if (!validation.valid) {
        throw new AppError(validation.message, 400);
      }

      // Ensure balance record exists
      await stockBalanceRepository.findOrCreate(organizationId, branchId, productId, session);

      let balance;
      if (quantityDelta < 0) {
        // Decrease stock - verify sufficient onHand
        balance = await StockBalance.findOneAndUpdate(
          {
            organizationId,
            branchId,
            productId,
            onHand: { $gte: absDelta }
          },
          {
            $inc: { onHand: quantityDelta },
            $set: { lastMovementAt: new Date() }
          },
          { session, returnDocument: "after" }
        );

        if (!balance) {
          const current = await StockBalance.findOne({ organizationId, branchId, productId }).session(session);
          const available = current ? current.onHand : 0;
          throw new AppError(
            `Cannot adjust stock below zero. Requested reduction: ${absDelta}, Available: ${available}`,
            400
          );
        }
      } else {
        // Increase stock
        balance = await StockBalance.findOneAndUpdate(
          {
            organizationId,
            branchId,
            productId
          },
          {
            $inc: { onHand: quantityDelta },
            $set: { lastMovementAt: new Date() }
          },
          { session, returnDocument: "after" }
        );
      }

      // Record immutable movement
      const movement = await stockMovementRepository.create(
        {
          organizationId,
          branchId,
          productId,
          quantityDelta,
          balanceAfter: this.roundQuantity(balance.onHand),
          movementType: "adjustment",
          reference: {
            entityType: "StockAdjustment",
            identifier: reason
          },
          actorId: userId,
          notes: notes ? `${reason}: ${notes}` : reason,
          idempotencyKey: idempotencyKey || null
        },
        session
      );

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
          movementId: movement._id
        }
      });
      await audit.save({ session });

      return {
        idempotentReplay: false,
        movement,
        balance
      };
    });
  }

  // 5. INTER-BRANCH TRANSFER (ATOMIC SOURCE & DESTINATION)
  async recordTransfer(payload, organizationId, userId) {
    const { fromBranchId, toBranchId, productId, quantity, notes, idempotencyKey } = payload;

    if (fromBranchId.toString() === toBranchId.toString()) {
      throw new AppError("Source and destination branch cannot be the same", 400);
    }

    if (idempotencyKey) {
      const existingMovement = await stockMovementRepository.findByIdempotencyKey(
        organizationId,
        idempotencyKey
      );
      if (existingMovement) {
        return {
          idempotentReplay: true,
          movement: existingMovement,
          message: "Request already processed"
        };
      }
    }

    return await runInTransaction(async (session) => {
      const product = await productRepository.findById(productId, organizationId, session);
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
          onHand: { $gte: quantity }
        },
        {
          $inc: { onHand: -quantity },
          $set: { lastMovementAt: new Date() }
        },
        { session, returnDocument: "after" }
      );

      if (!sourceBalance) {
        const curSource = await StockBalance.findOne({
          organizationId,
          branchId: fromBranchId,
          productId
        }).session(session);
        const available = curSource ? curSource.onHand : 0;
        throw new AppError(
          `Insufficient stock at source branch. Required: ${quantity} ${product.stockUnit}, Available: ${available} ${product.stockUnit}`,
          400
        );
      }

      // 2. Ensure dest balance exists & add to dest branch
      await stockBalanceRepository.findOrCreate(organizationId, toBranchId, productId, session);

      const destBalance = await StockBalance.findOneAndUpdate(
        {
          organizationId,
          branchId: toBranchId,
          productId
        },
        {
          $inc: { onHand: quantity },
          $set: { lastMovementAt: new Date() }
        },
        { session, returnDocument: "after" }
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
            identifier: `To Branch: ${toBranchId}`
          },
          actorId: userId,
          notes: notes || `Transfer out to branch ${toBranchId}`,
          idempotencyKey: idempotencyKey ? `${idempotencyKey}_out` : null
        },
        session
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
            identifier: `From Branch: ${fromBranchId}`
          },
          actorId: userId,
          notes: notes || `Transfer in from branch ${fromBranchId}`,
          idempotencyKey: idempotencyKey || null
        },
        session
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
          transferInId: inMovement._id
        }
      });
      await audit.save({ session });

      return {
        idempotentReplay: false,
        outMovement,
        inMovement,
        sourceBalance,
        destBalance
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

    const { movements, total } = await stockMovementRepository.list(query, { skip, limit });
    return {
      movements,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    };
  }
}

export const inventoryService = new InventoryService();
