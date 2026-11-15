import { GoodsReceiptNote } from "../../models/procurement/goodsReceiptNote.model.js";

export class GoodsReceiptRepository {
  async findById(id, organizationId, session = null) {
    let query = GoodsReceiptNote.findOne({ _id: id, organizationId })
      .populate("supplierId", "name contactPerson")
      .populate("branchId", "name branchCode")
      .populate("purchaseOrderId", "poNumber status")
      .populate("items.productId", "name sku stockUnit")
      .populate("receivedBy", "name email");
    if (session) query = query.session(session);
    return await query.exec();
  }

  async findByIdempotencyKey(organizationId, idempotencyKey, session = null) {
    let query = GoodsReceiptNote.findOne({ organizationId, idempotencyKey });
    if (session) query = query.session(session);
    return await query.exec();
  }

  async create(data, session = null) {
    const docs = await GoodsReceiptNote.create([data], { session });
    return docs[0];
  }

  async list(filter, { skip = 0, limit = 20, sort = { createdAt: -1 } } = {}) {
    const [receipts, total] = await Promise.all([
      GoodsReceiptNote.find(filter)
        .populate("supplierId", "name contactPerson")
        .populate("branchId", "name branchCode")
        .populate("purchaseOrderId", "poNumber")
        .populate("receivedBy", "name email")
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      GoodsReceiptNote.countDocuments(filter),
    ]);
    return { receipts, total };
  }

  async countByOrganization(organizationId) {
    return await GoodsReceiptNote.countDocuments({ organizationId });
  }
}

export const goodsReceiptRepository = new GoodsReceiptRepository();

