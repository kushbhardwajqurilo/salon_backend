import mongoose from "mongoose";
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

    const promises = [
      this.model.find(query)
        .populate("branchId", "name")
        .populate("customerId", "name phone email")
        .populate("createdBy", "name")
        .sort({ [sortBy]: sortOrder === "desc" ? -1 : 1 })
        .skip(skip)
        .limit(limit),
      this.model.countDocuments(query),
    ];

    if (query.customerId) {
      const matchStage = { ...query };
      if (typeof matchStage.customerId === "string" && mongoose.Types.ObjectId.isValid(matchStage.customerId)) {
        matchStage.customerId = new mongoose.Types.ObjectId(matchStage.customerId);
      }
      if (typeof matchStage.organizationId === "string" && mongoose.Types.ObjectId.isValid(matchStage.organizationId)) {
        matchStage.organizationId = new mongoose.Types.ObjectId(matchStage.organizationId);
      }
      if (typeof matchStage.branchId === "string" && mongoose.Types.ObjectId.isValid(matchStage.branchId)) {
        matchStage.branchId = new mongoose.Types.ObjectId(matchStage.branchId);
      }

      promises.push(
        this.model.aggregate([
          { $match: matchStage },
          {
            $group: {
              _id: null,
              totalInvoices: { $sum: 1 },
              totalBilled: { $sum: "$payableAmount" },
              totalPaid: { $sum: "$amountPaid" },
              totalOutstanding: { $sum: "$amountDue" },
            },
          },
        ])
      );
    }

    const [data, total, summaryAgg] = await Promise.all(promises);

    const meta = {
      total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(total / limit),
    };

    if (query.customerId) {
      const summaryStats = summaryAgg?.[0] || {};
      meta.summary = {
        totalInvoices: summaryStats.totalInvoices || 0,
        totalBilled: summaryStats.totalBilled || 0,
        totalPaid: summaryStats.totalPaid || 0,
        totalOutstanding: summaryStats.totalOutstanding || 0,
      };
    }

    return {
      data,
      pagination: meta,
    };
  }
}

export const invoiceRepository = new InvoiceRepository();
