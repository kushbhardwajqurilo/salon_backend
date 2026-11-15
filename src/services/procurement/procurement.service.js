import { AppError } from "../../utils/errors.js";
import { runInTransaction } from "../../utils/transaction.js";
import { supplierRepository } from "../../repositories/procurement/supplier.repository.js";
import { purchaseOrderRepository } from "../../repositories/procurement/purchaseOrder.repository.js";
import { goodsReceiptRepository } from "../../repositories/procurement/goodsReceipt.repository.js";
import { supplierInvoiceRepository } from "../../repositories/procurement/supplierInvoice.repository.js";
import { supplierPaymentRepository } from "../../repositories/procurement/supplierPayment.repository.js";
import { productRepository } from "../../repositories/inventory/product.repository.js";
import { stockMovementRepository } from "../../repositories/inventory/stockMovement.repository.js";
import { StockBalance } from "../../models/inventory/stockBalance.model.js";
import { PurchaseOrder } from "../../models/procurement/purchaseOrder.model.js";
import { SupplierInvoice } from "../../models/procurement/supplierInvoice.model.js";
import { AuditLog, AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";
import { validateQuantityForUnit } from "../../validation/inventory/inventory.validation.js";

export class ProcurementService {
  roundQuantity(val) {
    return Math.round((val + Number.EPSILON) * 1000) / 1000;
  }

  generateNumber(prefix, count) {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const randomHex = Math.floor(1000 + Math.random() * 9000);
    return `${prefix}-${dateStr}-${String(count + 1).padStart(4, "0")}-${randomHex}`;
  }

  // ---------------------------------------------------------
  // 1. SUPPLIERS
  // ---------------------------------------------------------
  async createSupplier(data, organizationId, userId) {
    const supplier = await supplierRepository.create({
      ...data,
      organizationId,
      createdBy: userId,
      updatedBy: userId,
    });

    const audit = new AuditLog({
      organizationId,
      actorId: userId,
      action: AUDIT_ACTIONS.PROCUREMENT_SUPPLIER_CREATED,
      entityType: "Supplier",
      entityId: supplier._id,
      description: `Supplier created: ${supplier.name}`,
      metadata: { name: supplier.name, phone: supplier.phone },
    });
    await audit.save();

    return supplier;
  }

  async updateSupplier(id, data, organizationId, userId) {
    const existing = await supplierRepository.findById(id, organizationId);
    if (!existing) {
      throw new AppError("Supplier not found", 404);
    }

    const updated = await supplierRepository.update(id, organizationId, {
      ...data,
      updatedBy: userId,
    });

    const audit = new AuditLog({
      organizationId,
      actorId: userId,
      action: AUDIT_ACTIONS.PROCUREMENT_SUPPLIER_UPDATED,
      entityType: "Supplier",
      entityId: updated._id,
      description: `Supplier updated: ${updated.name}`,
      metadata: data,
    });
    await audit.save();

    return updated;
  }

  async getSupplierById(id, organizationId) {
    const supplier = await supplierRepository.findById(id, organizationId);
    if (!supplier) {
      throw new AppError("Supplier not found", 404);
    }
    return supplier;
  }

  async listSuppliers(filter, pagination) {
    const query = { organizationId: filter.organizationId, isDeleted: false };
    if (filter.status) query.status = filter.status;
    if (filter.search) {
      query.$or = [
        { name: { $regex: filter.search, $options: "i" } },
        { contactPerson: { $regex: filter.search, $options: "i" } },
        { phone: { $regex: filter.search, $options: "i" } },
        { email: { $regex: filter.search, $options: "i" } },
      ];
    }

    const page = pagination.page || 1;
    const limit = pagination.limit || 20;
    const skip = (page - 1) * limit;

    const { suppliers, total } = await supplierRepository.list(query, {
      skip,
      limit,
    });

    return {
      suppliers,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ---------------------------------------------------------
  // 2. PURCHASE ORDERS
  // ---------------------------------------------------------
  async createPurchaseOrder(payload, organizationId, branchId, userId) {
    const targetBranchId = payload.branchId || branchId;
    if (!targetBranchId) {
      throw new AppError("Branch ID is required for purchase orders", 400);
    }

    const supplier = await supplierRepository.findById(payload.supplierId, organizationId);
    if (!supplier) {
      throw new AppError("Supplier not found", 404);
    }
    if (supplier.status !== "active") {
      throw new AppError("Cannot issue purchase order to an inactive supplier", 400);
    }

    let totalAmount = 0;
    const validatedItems = [];

    for (const item of payload.items) {
      const product = await productRepository.findById(item.productId, organizationId);
      if (!product) {
        throw new AppError(`Product not found: ${item.productId}`, 404);
      }
      if (product.status !== "active") {
        throw new AppError(`Cannot order inactive product '${product.name}'`, 400);
      }

      // Check domain match against product usageType
      if (item.targetDomain === "salon_consumables" && !["salon_consumption", "both"].includes(product.usageType)) {
        throw new AppError(
          `Product '${product.name}' (${product.usageType}) cannot be assigned to Salon Consumables domain`,
          400
        );
      }
      if (item.targetDomain === "retail_products" && !["retail_sale", "both"].includes(product.usageType)) {
        throw new AppError(
          `Product '${product.name}' (${product.usageType}) cannot be assigned to Retail Products domain`,
          400
        );
      }

      const unitCheck = validateQuantityForUnit(item.orderedQuantity, product.stockUnit);
      if (!unitCheck.valid) {
        throw new AppError(unitCheck.message, 400);
      }

      const lineTotal = Math.round(item.orderedQuantity * item.unitCostPrice * 100) / 100;
      totalAmount += lineTotal;

      validatedItems.push({
        productId: product._id,
        targetDomain: item.targetDomain,
        orderedQuantity: this.roundQuantity(item.orderedQuantity),
        receivedQuantity: 0,
        unitCostPrice: item.unitCostPrice,
        lineTotal,
      });
    }

    const orderCount = await purchaseOrderRepository.countByOrganization(organizationId);
    const poNumber = this.generateNumber("PO", orderCount);

    const po = await purchaseOrderRepository.create({
      organizationId,
      branchId: targetBranchId,
      poNumber,
      supplierId: supplier._id,
      items: validatedItems,
      totalAmount: Math.round(totalAmount * 100) / 100,
      status: "draft",
      expectedDeliveryDate: payload.expectedDeliveryDate ? new Date(payload.expectedDeliveryDate) : null,
      notes: payload.notes || "",
      createdBy: userId,
      updatedBy: userId,
    });

    const audit = new AuditLog({
      organizationId,
      branchId: targetBranchId,
      actorId: userId,
      action: AUDIT_ACTIONS.PROCUREMENT_ORDER_CREATED,
      entityType: "PurchaseOrder",
      entityId: po._id,
      description: `Purchase order created: ${poNumber} for ${supplier.name}`,
      metadata: { poNumber, totalAmount: po.totalAmount, itemsCount: validatedItems.length },
    });
    await audit.save();

    return po;
  }

  async updatePurchaseOrderStatus(id, { status, cancelReason }, organizationId, userId) {
    const po = await purchaseOrderRepository.findById(id, organizationId);
    if (!po) {
      throw new AppError("Purchase order not found", 404);
    }

    if (po.status === "received") {
      throw new AppError("Cannot change status of a fully received purchase order", 400);
    }
    if (po.status === "cancelled") {
      throw new AppError("Purchase order is already cancelled", 400);
    }

    const updateData = { updatedBy: userId };

    if (status === "ordered") {
      if (po.status !== "draft") {
        throw new AppError(`Cannot mark as ordered from status '${po.status}'`, 400);
      }
      updateData.status = "ordered";
      updateData.orderedAt = new Date();
    } else if (status === "cancelled") {
      if (po.items.some((it) => it.receivedQuantity > 0)) {
        throw new AppError("Cannot cancel a purchase order with partially received items", 400);
      }
      updateData.status = "cancelled";
      updateData.cancelledAt = new Date();
      updateData.cancelledBy = userId;
      updateData.cancelReason = cancelReason || "";
    } else {
      throw new AppError(`Invalid status transition to '${status}'`, 400);
    }

    const updated = await purchaseOrderRepository.update(id, organizationId, updateData);

    const audit = new AuditLog({
      organizationId,
      branchId: po.branchId._id || po.branchId,
      actorId: userId,
      action: AUDIT_ACTIONS.PROCUREMENT_ORDER_STATUS_UPDATED,
      entityType: "PurchaseOrder",
      entityId: po._id,
      description: `Purchase order ${po.poNumber} transitioned to ${status}`,
      metadata: { status, cancelReason },
    });
    await audit.save();

    return updated;
  }

  async getPurchaseOrderById(id, organizationId) {
    const po = await purchaseOrderRepository.findById(id, organizationId);
    if (!po) {
      throw new AppError("Purchase order not found", 404);
    }
    return po;
  }

  async listPurchaseOrders(filter, pagination) {
    const query = { organizationId: filter.organizationId };
    if (filter.branchId) query.branchId = filter.branchId;
    if (filter.supplierId) query.supplierId = filter.supplierId;
    if (filter.status) query.status = filter.status;
    if (filter.search) {
      query.poNumber = { $regex: filter.search, $options: "i" };
    }

    const page = pagination.page || 1;
    const limit = pagination.limit || 20;
    const skip = (page - 1) * limit;

    const { orders, total } = await purchaseOrderRepository.list(query, {
      skip,
      limit,
    });

    return {
      orders,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ---------------------------------------------------------
  // 3. GOODS RECEIVING / GRN
  // ---------------------------------------------------------
  async receiveGoods(poId, payload, organizationId, userId) {
    const { items, notes, idempotencyKey } = payload;

    // 1. Idempotency Check
    if (idempotencyKey) {
      const existingGRN = await goodsReceiptRepository.findByIdempotencyKey(
        organizationId,
        idempotencyKey
      );
      if (existingGRN) {
        return {
          idempotentReplay: true,
          receipt: existingGRN,
          message: "Goods receipt already processed",
        };
      }
    }

    return await runInTransaction(async (session) => {
      // 2. Fetch Purchase Order inside session
      const po = await PurchaseOrder.findOne({ _id: poId, organizationId }).session(session);
      if (!po) {
        throw new AppError("Purchase order not found", 404);
      }

      if (["draft", "cancelled"].includes(po.status)) {
        throw new AppError(`Cannot receive goods for purchase order in '${po.status}' status`, 400);
      }

      const receivedItemsRecord = [];
      let totalReceivedAmount = 0;

      for (const receiveItem of items) {
        const poLine = po.items.find(
          (line) => line.productId.toString() === receiveItem.productId.toString()
        );
        if (!poLine) {
          throw new AppError(
            `Product ${receiveItem.productId} is not part of Purchase Order ${po.poNumber}`,
            400
          );
        }

        const remainingQty = this.roundQuantity(poLine.orderedQuantity - poLine.receivedQuantity);
        if (receiveItem.receivedQuantity > remainingQty) {
          throw new AppError(
            `Cannot receive ${receiveItem.receivedQuantity}. Remaining quantity for product is ${remainingQty}`,
            400
          );
        }

        const product = await productRepository.findById(poLine.productId, organizationId, session);
        if (!product) {
          throw new AppError(`Product not found: ${poLine.productId}`, 404);
        }

        const unitCheck = validateQuantityForUnit(receiveItem.receivedQuantity, product.stockUnit);
        if (!unitCheck.valid) {
          throw new AppError(unitCheck.message, 400);
        }

        const lineAmount = Math.round(receiveItem.receivedQuantity * poLine.unitCostPrice * 100) / 100;
        totalReceivedAmount += lineAmount;

        // Atomic stock balance increment across aggregate onHand and domain-specific onHand
        const domainIncField =
          poLine.targetDomain === "salon_consumables"
            ? "onHandConsumables"
            : "onHandRetail";

        const updatedBalance = await StockBalance.findOneAndUpdate(
          {
            organizationId,
            branchId: po.branchId,
            productId: product._id,
          },
          {
            $inc: {
              onHand: receiveItem.receivedQuantity,
              [domainIncField]: receiveItem.receivedQuantity,
            },
            $set: { lastMovementAt: new Date() },
          },
          { session, upsert: true, new: true, setDefaultsOnInsert: true }
        );

        // Immutable StockMovement ledger entry
        await stockMovementRepository.create(
          {
            organizationId,
            branchId: po.branchId,
            productId: product._id,
            quantityDelta: receiveItem.receivedQuantity,
            balanceAfter: this.roundQuantity(updatedBalance.onHand),
            movementType: "purchase_in",
            stockDomain: poLine.targetDomain,
            reference: {
              entityType: "PurchaseOrder",
              entityId: po._id,
              identifier: po.poNumber,
            },
            actorId: userId,
            notes: `Goods received for PO #${po.poNumber} [${poLine.targetDomain}]`,
            idempotencyKey: idempotencyKey ? `${idempotencyKey}_${product._id}` : null,
          },
          session
        );

        poLine.receivedQuantity = this.roundQuantity(poLine.receivedQuantity + receiveItem.receivedQuantity);

        receivedItemsRecord.push({
          productId: product._id,
          targetDomain: poLine.targetDomain,
          receivedQuantity: receiveItem.receivedQuantity,
          unitCostPrice: poLine.unitCostPrice,
          lineTotal: lineAmount,
        });
      }

      // Update PO Status
      const allFullyReceived = po.items.every(
        (line) => line.receivedQuantity >= line.orderedQuantity
      );
      po.status = allFullyReceived ? "received" : "partially_received";
      po.updatedBy = userId;
      await po.save({ session });

      // Create Goods Receipt Note record
      const grnCount = await goodsReceiptRepository.countByOrganization(organizationId);
      const grnNumber = this.generateNumber("GRN", grnCount);

      const grn = await goodsReceiptRepository.create(
        {
          organizationId,
          branchId: po.branchId,
          grnNumber,
          purchaseOrderId: po._id,
          supplierId: po.supplierId,
          items: receivedItemsRecord,
          totalAmount: Math.round(totalReceivedAmount * 100) / 100,
          receivedBy: userId,
          receivedAt: new Date(),
          notes: notes || "",
          idempotencyKey: idempotencyKey || null,
        },
        session
      );

      // Audit Log
      const audit = new AuditLog({
        organizationId,
        branchId: po.branchId,
        actorId: userId,
        action: AUDIT_ACTIONS.PROCUREMENT_GOODS_RECEIVED,
        entityType: "GoodsReceiptNote",
        entityId: grn._id,
        description: `Goods receipt ${grnNumber} processed for PO ${po.poNumber}`,
        metadata: {
          grnNumber,
          poNumber: po.poNumber,
          poStatus: po.status,
          totalReceivedAmount: grn.totalAmount,
        },
      });
      await audit.save({ session });

      return {
        receipt: grn,
        purchaseOrder: po,
      };
    });
  }

  async listGoodsReceipts(filter, pagination) {
    const query = { organizationId: filter.organizationId };
    if (filter.branchId) query.branchId = filter.branchId;
    if (filter.purchaseOrderId) query.purchaseOrderId = filter.purchaseOrderId;
    if (filter.supplierId) query.supplierId = filter.supplierId;

    const page = pagination.page || 1;
    const limit = pagination.limit || 20;
    const skip = (page - 1) * limit;

    const { receipts, total } = await goodsReceiptRepository.list(query, {
      skip,
      limit,
    });

    return {
      receipts,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ---------------------------------------------------------
  // 4. SUPPLIER INVOICES / BILLS
  // ---------------------------------------------------------
  async createSupplierInvoice(payload, organizationId, branchId, userId) {
    const targetBranchId = payload.branchId || branchId;
    if (!targetBranchId) {
      throw new AppError("Branch ID is required for supplier invoices", 400);
    }

    const supplier = await supplierRepository.findById(payload.supplierId, organizationId);
    if (!supplier) {
      throw new AppError("Supplier not found", 404);
    }

    if (payload.purchaseOrderId) {
      const po = await purchaseOrderRepository.findById(payload.purchaseOrderId, organizationId);
      if (!po) {
        throw new AppError("Purchase order not found", 404);
      }
    }

    const invCount = await supplierInvoiceRepository.countByOrganization(organizationId);
    const invoiceNumber = this.generateNumber("SINV", invCount);

    const invoiceDate = payload.invoiceDate ? new Date(payload.invoiceDate) : new Date();
    const dueDate = payload.dueDate
      ? new Date(payload.dueDate)
      : new Date(invoiceDate.getTime() + (supplier.paymentTermsDays || 30) * 86400000);

    const invoice = await supplierInvoiceRepository.create({
      organizationId,
      branchId: targetBranchId,
      invoiceNumber,
      supplierInvoiceRef: payload.supplierInvoiceRef || "",
      supplierId: supplier._id,
      purchaseOrderId: payload.purchaseOrderId || null,
      goodsReceiptId: payload.goodsReceiptId || null,
      invoiceDate,
      dueDate,
      totalAmount: payload.totalAmount,
      amountPaid: 0,
      status: "unpaid",
      notes: payload.notes || "",
      createdBy: userId,
    });

    const audit = new AuditLog({
      organizationId,
      branchId: targetBranchId,
      actorId: userId,
      action: AUDIT_ACTIONS.PROCUREMENT_INVOICE_CREATED,
      entityType: "SupplierInvoice",
      entityId: invoice._id,
      description: `Supplier invoice logged: ${invoiceNumber} (${supplier.name})`,
      metadata: { invoiceNumber, totalAmount: invoice.totalAmount },
    });
    await audit.save();

    return invoice;
  }

  async getSupplierInvoiceById(id, organizationId) {
    const invoice = await supplierInvoiceRepository.findById(id, organizationId);
    if (!invoice) {
      throw new AppError("Supplier invoice not found", 404);
    }
    return invoice;
  }

  async listSupplierInvoices(filter, pagination) {
    const query = { organizationId: filter.organizationId };
    if (filter.branchId) query.branchId = filter.branchId;
    if (filter.supplierId) query.supplierId = filter.supplierId;
    if (filter.status) query.status = filter.status;

    const page = pagination.page || 1;
    const limit = pagination.limit || 20;
    const skip = (page - 1) * limit;

    const { invoices, total } = await supplierInvoiceRepository.list(query, {
      skip,
      limit,
    });

    return {
      invoices,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ---------------------------------------------------------
  // 5. SUPPLIER PAYMENTS
  // ---------------------------------------------------------
  async recordSupplierPayment(payload, organizationId, branchId, userId) {
    const { supplierInvoiceId, amount, paymentMethod, referenceNote, paymentDate, idempotencyKey } = payload;

    // Idempotency check
    if (idempotencyKey) {
      const existingPayment = await supplierPaymentRepository.findByIdempotencyKey(
        organizationId,
        idempotencyKey
      );
      if (existingPayment) {
        return {
          idempotentReplay: true,
          payment: existingPayment,
          message: "Payment already recorded",
        };
      }
    }

    return await runInTransaction(async (session) => {
      const invoice = await SupplierInvoice.findOne({
        _id: supplierInvoiceId,
        organizationId,
      }).session(session);

      if (!invoice) {
        throw new AppError("Supplier invoice not found", 404);
      }

      if (invoice.status === "paid") {
        throw new AppError("Invoice is already fully paid", 400);
      }
      if (invoice.status === "cancelled") {
        throw new AppError("Cannot record payment for a cancelled invoice", 400);
      }

      const outstanding = Math.max(0, invoice.totalAmount - (invoice.amountPaid || 0));
      if (amount > outstanding) {
        throw new AppError(
          `Payment amount (${amount}) exceeds outstanding invoice balance (${outstanding})`,
          400
        );
      }

      const newAmountPaid = Math.round(((invoice.amountPaid || 0) + amount) * 100) / 100;
      invoice.amountPaid = newAmountPaid;
      invoice.status = newAmountPaid >= invoice.totalAmount ? "paid" : "partially_paid";
      await invoice.save({ session });

      const payCount = await supplierPaymentRepository.countByOrganization(organizationId);
      const paymentNumber = this.generateNumber("SPAY", payCount);

      const payment = await supplierPaymentRepository.create(
        {
          organizationId,
          branchId: invoice.branchId,
          paymentNumber,
          supplierId: invoice.supplierId,
          supplierInvoiceId: invoice._id,
          amount,
          paymentMethod,
          referenceNote: referenceNote || "",
          paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
          recordedBy: userId,
          idempotencyKey: idempotencyKey || null,
        },
        session
      );

      const audit = new AuditLog({
        organizationId,
        branchId: invoice.branchId,
        actorId: userId,
        action: AUDIT_ACTIONS.PROCUREMENT_PAYMENT_RECORDED,
        entityType: "SupplierPayment",
        entityId: payment._id,
        description: `Supplier payment ${paymentNumber} recorded for invoice ${invoice.invoiceNumber}`,
        metadata: {
          paymentNumber,
          amount,
          invoiceNumber: invoice.invoiceNumber,
          invoiceStatus: invoice.status,
        },
      });
      await audit.save({ session });

      return {
        payment,
        invoice,
      };
    });
  }

  async listSupplierPayments(filter, pagination) {
    const query = { organizationId: filter.organizationId };
    if (filter.branchId) query.branchId = filter.branchId;
    if (filter.supplierId) query.supplierId = filter.supplierId;
    if (filter.supplierInvoiceId) query.supplierInvoiceId = filter.supplierInvoiceId;

    const page = pagination.page || 1;
    const limit = pagination.limit || 20;
    const skip = (page - 1) * limit;

    const { payments, total } = await supplierPaymentRepository.list(query, {
      skip,
      limit,
    });

    return {
      payments,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ---------------------------------------------------------
  // 6. PROCUREMENT DASHBOARD OVERVIEW METRICS
  // ---------------------------------------------------------
  async getProcurementOverview(organizationId, branchId = null) {
    const supplierFilter = { organizationId, isDeleted: false, status: "active" };
    const poFilter = { organizationId };
    const invFilter = { organizationId };

    if (branchId) {
      poFilter.branchId = branchId;
      invFilter.branchId = branchId;
    }

    const [
      activeSuppliers,
      pendingOrders,
      awaitingDelivery,
      partiallyReceived,
      unpaidInvoices,
      allInvoices,
      recentOrders,
      recentReceipts,
    ] = await Promise.all([
      supplierRepository.list(supplierFilter, { limit: 1 }),
      PurchaseOrder.countDocuments({ ...poFilter, status: "draft" }),
      PurchaseOrder.countDocuments({ ...poFilter, status: "ordered" }),
      PurchaseOrder.countDocuments({ ...poFilter, status: "partially_received" }),
      SupplierInvoice.countDocuments({ ...invFilter, status: { $in: ["unpaid", "partially_paid"] } }),
      SupplierInvoice.find(invFilter).select("totalAmount amountPaid status"),
      purchaseOrderRepository.list(poFilter, { limit: 5 }),
      goodsReceiptRepository.list(poFilter, { limit: 5 }),
    ]);

    let outstandingBalance = 0;
    for (const inv of allInvoices) {
      if (inv.status !== "cancelled") {
        outstandingBalance += Math.max(0, (inv.totalAmount || 0) - (inv.amountPaid || 0));
      }
    }

    return {
      activeSuppliersCount: activeSuppliers.total,
      draftOrdersCount: pendingOrders,
      awaitingDeliveryCount: awaitingDelivery,
      partiallyReceivedCount: partiallyReceived,
      unpaidInvoicesCount: unpaidInvoices,
      outstandingSupplierBalance: Math.round(outstandingBalance * 100) / 100,
      recentOrders: recentOrders.orders,
      recentReceipts: recentReceipts.receipts,
    };
  }
}

export const procurementService = new ProcurementService();

