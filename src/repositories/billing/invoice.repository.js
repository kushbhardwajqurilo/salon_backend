import { BaseRepository } from "../../shared/repositories/base.repository.js";
import { Invoice } from "../../models/billing/invoice.model.js";

export class InvoiceRepository extends BaseRepository {
  constructor() {
    super(Invoice);
  }

  async findByAppointmentId(appointmentId, organizationId) {
    return await this.model.findOne({
      appointmentId,
      organizationId,
      status: { $ne: "cancelled" },
      isDeleted: false,
    });
  }

  async findWithDetails(id, organizationId) {
    return await this.model.findOne({
      _id: id,
      organizationId,
      isDeleted: false,
    })
      .populate("branchId", "name")
      .populate("customerId", "name phone email")
      .populate("createdBy", "name")
      .populate("finalizedBy", "name")
      .populate("cancelledBy", "name");
  }

  async list(filter = {}, pagination = {}, organizationId, branchId = null) {
    const query = { ...filter, organizationId, isDeleted: false };
    if (branchId) {
      query.branchId = branchId;
    }

    const {
      page = 1,
      limit = 10,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = pagination;
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.model.find(query)
        .populate("branchId", "name")
        .populate("customerId", "name phone email")
        .populate("createdBy", "name")
        .sort({ [sortBy]: sortOrder === "desc" ? -1 : 1 })
        .skip(skip)
        .limit(limit),
      this.model.countDocuments(query),
    ]);

    return {
      data,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}

export const invoiceRepository = new InvoiceRepository();
