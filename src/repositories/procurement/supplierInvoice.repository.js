import { SupplierInvoice } from "../../models/procurement/supplierInvoice.model.js";

export class SupplierInvoiceRepository {
  async findById(id, organizationId, session = null) {
    let query = SupplierInvoice.findOne({ _id: id, organizationId })
      .populate("supplierId", "name contactPerson phone email paymentTermsDays")
      .populate("branchId", "name branchCode")
      .populate("purchaseOrderId", "poNumber status")
      .populate("goodsReceiptId", "grnNumber")
      .populate("createdBy", "name email");
    if (session) query = query.session(session);
    return await query.exec();
  }

  async create(data, session = null) {
    const docs = await SupplierInvoice.create([data], { session });
    return docs[0];
  }

  async update(id, organizationId, updateData, session = null) {
    let query = SupplierInvoice.findOneAndUpdate(
      { _id: id, organizationId },
      { $set: updateData },
      { returnDocument: 'after', runValidators: true, session }
    );
    return await query.exec();
  }

  async list(filter, { skip = 0, limit = 20, sort = { createdAt: -1 } } = {}) {
    const [invoices, total] = await Promise.all([
      SupplierInvoice.find(filter)
        .populate("supplierId", "name contactPerson phone email")
        .populate("branchId", "name branchCode")
        .populate("purchaseOrderId", "poNumber")
        .sort(sort)
        .skip(skip)
        .limit(limit),
      SupplierInvoice.countDocuments(filter),
    ]);
    return { invoices: invoices.map((inv) => inv.toJSON()), total };
  }

  async countByOrganization(organizationId) {
    return await SupplierInvoice.countDocuments({ organizationId });
  }
}

export const supplierInvoiceRepository = new SupplierInvoiceRepository();

