import { PurchaseOrder } from "../../models/procurement/purchaseOrder.model.js";

export class PurchaseOrderRepository {
  async findById(id, organizationId, session = null) {
    let query = PurchaseOrder.findOne({ _id: id, organizationId })
      .populate("supplierId", "name contactPerson phone email paymentTermsDays")
      .populate("branchId", "name branchCode")
      .populate("items.productId", "name sku stockUnit usageType costPrice sellingPrice")
      .populate("createdBy", "name email");
    if (session) query = query.session(session);
    return await query.exec();
  }

  async create(data, session = null) {
    const docs = await PurchaseOrder.create([data], { session });
    return docs[0];
  }

  async update(id, organizationId, updateData, session = null) {
    let query = PurchaseOrder.findOneAndUpdate(
      { _id: id, organizationId },
      { $set: updateData },
      { new: true, runValidators: true, session }
    );
    return await query.exec();
  }

  async list(filter, { skip = 0, limit = 20, sort = { createdAt: -1 } } = {}) {
    const [orders, total] = await Promise.all([
      PurchaseOrder.find(filter)
        .populate("supplierId", "name contactPerson phone email")
        .populate("branchId", "name branchCode")
        .populate("items.productId", "name sku stockUnit")
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      PurchaseOrder.countDocuments(filter),
    ]);
    return { orders, total };
  }

  async countByOrganization(organizationId) {
    return await PurchaseOrder.countDocuments({ organizationId });
  }
}

export const purchaseOrderRepository = new PurchaseOrderRepository();

