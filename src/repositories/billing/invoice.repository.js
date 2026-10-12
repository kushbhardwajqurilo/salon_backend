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
    const {
      startDate,
      endDate,
      startDateBoundary,
      endDateBoundary,
      search,
      status,
      paymentStatus,
      customerId,
      appointmentId,
      ...otherFilters
    } = filter;

    const matchQuery = {
      ...otherFilters,
      isDeleted: false,
    };

    if (organizationId) {
      matchQuery.organizationId =
        typeof organizationId === "string" && mongoose.Types.ObjectId.isValid(organizationId)
          ? new mongoose.Types.ObjectId(organizationId)
          : organizationId;
    }

    if (branchId) {
      matchQuery.branchId =
        typeof branchId === "string" && mongoose.Types.ObjectId.isValid(branchId)
          ? new mongoose.Types.ObjectId(branchId)
          : branchId;
    }

    if (status) {
      matchQuery.status = status;
    }

    if (paymentStatus) {
      matchQuery.paymentStatus = paymentStatus;
    }

    if (customerId) {
      matchQuery.customerId =
        typeof customerId === "string" && mongoose.Types.ObjectId.isValid(customerId)
          ? new mongoose.Types.ObjectId(customerId)
          : customerId;
    }

    if (appointmentId) {
      matchQuery.appointmentId =
        typeof appointmentId === "string" && mongoose.Types.ObjectId.isValid(appointmentId)
          ? new mongoose.Types.ObjectId(appointmentId)
          : appointmentId;
    }

    // 1. Date Range Filtering on createdAt
    const startBoundary = filter.startDateBoundary || (startDate ? new Date(`${startDate}T00:00:00.000Z`) : null);
    const endBoundary = filter.endDateBoundary || (endDate ? new Date(`${endDate}T23:59:59.999Z`) : null);

    if (startBoundary || endBoundary) {
      matchQuery.createdAt = {};
      if (startBoundary) {
        matchQuery.createdAt.$gte = startBoundary;
      }
      if (endBoundary) {
        matchQuery.createdAt.$lte = endBoundary;
      }
    }

    // Search query on invoiceNumber, appointmentCode, customerSnapshot.name, customerSnapshot.phone
    if (search && String(search).trim()) {
      const term = String(search).trim();
      matchQuery.$or = [
        { invoiceNumber: { $regex: term, $options: "i" } },
        { appointmentCode: { $regex: term, $options: "i" } },
        { "customerSnapshot.name": { $regex: term, $options: "i" } },
        { "customerSnapshot.phone": { $regex: term, $options: "i" } },
      ];
    }

    const {
      page = 1,
      limit = 10,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = pagination;

    const parsedPage = Math.max(1, Number(page) || 1);
    const parsedLimit = Math.max(1, Number(limit) || 10);
    const skip = (parsedPage - 1) * parsedLimit;
    const sortDirection = sortOrder === "asc" ? 1 : -1;

    const facetPipeline = [
      { $match: matchQuery },
      {
        $facet: {
          paginatedData: [
            { $sort: { [sortBy]: sortDirection } },
            { $skip: skip },
            { $limit: parsedLimit },
            {
              $lookup: {
                from: "branches",
                localField: "branchId",
                foreignField: "_id",
                as: "branchId",
                pipeline: [{ $project: { name: 1 } }],
              },
            },
            {
              $unwind: {
                path: "$branchId",
                preserveNullAndEmptyArrays: true,
              },
            },
            {
              $lookup: {
                from: "customers",
                localField: "customerId",
                foreignField: "_id",
                as: "customerId",
                pipeline: [{ $project: { name: 1, phone: 1, email: 1 } }],
              },
            },
            {
              $unwind: {
                path: "$customerId",
                preserveNullAndEmptyArrays: true,
              },
            },
            {
              $lookup: {
                from: "users",
                localField: "createdBy",
                foreignField: "_id",
                as: "createdBy",
                pipeline: [{ $project: { name: 1 } }],
              },
            },
            {
              $unwind: {
                path: "$createdBy",
                preserveNullAndEmptyArrays: true,
              },
            },
          ],
          totalCount: [{ $count: "count" }],
          summary: [
            { $match: { status: { $ne: "cancelled" } } },
            {
              $group: {
                _id: null,
                totalInvoices: { $sum: 1 },
                totalBilled: { $sum: "$payableAmount" },
                totalPaid: { $sum: "$amountPaid" },
                totalOutstanding: { $sum: "$amountDue" },
              },
            },
          ],
        },
      },
    ];

    const [aggregationResult] = await this.model.aggregate(facetPipeline);

    const total = aggregationResult?.totalCount?.[0]?.count ?? 0;
    const summaryResult = aggregationResult?.summary?.[0] || {};

    const summary = {
      totalInvoices: summaryResult.totalInvoices ?? 0,
      totalBilled: summaryResult.totalBilled ?? 0,
      totalPaid: summaryResult.totalPaid ?? 0,
      totalOutstanding: summaryResult.totalOutstanding ?? 0,
    };

    const meta = {
      total,
      page: parsedPage,
      limit: parsedLimit,
      totalPages: Math.ceil(total / parsedLimit) || (total === 0 ? 0 : 1),
      summary,
    };

    const paginatedDocs = (aggregationResult?.paginatedData || []).map((doc) => {
      return {
        ...doc,
        id: doc._id.toString(),
      };
    });

    return {
      data: paginatedDocs,
      meta,
      pagination: meta,
    };
  }
}

export const invoiceRepository = new InvoiceRepository();
