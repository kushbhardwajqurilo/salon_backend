import { SupplierPayment } from "../../models/procurement/supplierPayment.model.js";

export class SupplierPaymentRepository {
  async findById(id, organizationId, session = null) {
    let query = SupplierPayment.findOne({ _id: id, organizationId })
      .populate("supplierId", "name contactPerson phone email")
      .populate("branchId", "name branchCode")
      .populate("supplierInvoiceId", "invoiceNumber totalAmount amountPaid status")
      .populate("recordedBy", "name email");
    if (session) query = query.session(session);
    return await query.exec();
  }

  async findByIdempotencyKey(organizationId, idempotencyKey, session = null) {
    let query = SupplierPayment.findOne({ organizationId, idempotencyKey });
    if (session) query = query.session(session);
    return await query.exec();
  }

  async create(data, session = null) {
    const docs = await SupplierPayment.create([data], { session });
    return docs[0];
  }

  async countByOrganization(organizationId) {
    return await SupplierPayment.countDocuments({ organizationId });
  }

  async list(filter, { skip = 0, limit = 20, sort = { createdAt: -1 } } = {}) {
    const [payments, total] = await Promise.all([
      SupplierPayment.find(filter)
        .populate("supplierId", "name contactPerson")
        .populate("branchId", "name branchCode")
        .populate("supplierInvoiceId", "invoiceNumber totalAmount")
        .populate("recordedBy", "name email")
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      SupplierPayment.countDocuments(filter),
    ]);
    return { payments, total };
  }
}

export const supplierPaymentRepository = new SupplierPaymentRepository();

