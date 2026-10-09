import { BaseRepository } from "../../shared/repositories/base.repository.js";
import { Payment } from "../../models/billing/payment.model.js";

export class PaymentRepository extends BaseRepository {
  constructor() {
    super(Payment);
  }

  async findByInvoiceId(invoiceId, organizationId) {
    return await this.model.find({
      invoiceId,
      organizationId,
      isDeleted: false,
    })
      .populate("recordedBy", "name")
      .populate("voidedBy", "name")
      .sort({ createdAt: 1 });
  }

  async findWithDetails(id, organizationId) {
    return await this.model.findOne({
      _id: id,
      organizationId,
      isDeleted: false,
    })
      .populate("branchId", "name")
      .populate("invoiceId", "invoiceNumber status paymentStatus payableAmount amountPaid amountDue")
      .populate("customerId", "name phone email")
      .populate("recordedBy", "name")
      .populate("voidedBy", "name");
  }
}

export const paymentRepository = new PaymentRepository();
