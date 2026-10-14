import { BaseRepository } from "../../shared/repositories/base.repository.js";
import { LoyaltyTransaction } from "../../models/loyalty/loyaltyTransaction.model.js";

export class LoyaltyTransactionRepository extends BaseRepository {
  constructor() {
    super(LoyaltyTransaction);
  }

  async findBySourceEventKey(organizationId, sourceEventKey, session = null) {
    const query = this.model.findOne({ organizationId, sourceEventKey });
    if (session) {
      query.session(session);
    }
    return await query.exec();
  }

  async findByIdempotencyKey(organizationId, idempotencyKey, session = null) {
    const query = this.model.findOne({ organizationId, idempotencyKey });
    if (session) {
      query.session(session);
    }
    return await query.exec();
  }

  async listCustomerLedger(customerId, organizationId, filter = {}, pagination = {}) {
    const { page = 1, limit = 20, type, startDate, endDate, sortBy = "createdAt", sortOrder = "desc" } = {
      ...filter,
      ...pagination,
    };

    const query = {
      customerId,
      organizationId,
    };

    if (type) {
      query.type = type;
    }

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) {
        query.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        query.createdAt.$lte = new Date(endDate);
      }
    }

    const numericPage = Math.max(1, parseInt(page, 10));
    const numericLimit = Math.max(1, Math.min(100, parseInt(limit, 10)));
    const skip = (numericPage - 1) * numericLimit;
    const sortDirection = sortOrder === "asc" ? 1 : -1;

    const [items, total] = await Promise.all([
      this.model
        .find(query)
        .populate("branchId", "name")
        .populate("actorId", "name")
        .populate("invoiceId", "invoiceNumber")
        .populate("paymentId", "paymentNumber")
        .sort({ [sortBy]: sortDirection, _id: sortDirection })
        .skip(skip)
        .limit(numericLimit)
        .exec(),
      this.model.countDocuments(query).exec(),
    ]);

    const totalPages = Math.ceil(total / numericLimit) || 1;

    return {
      items,
      pagination: {
        page: numericPage,
        limit: numericLimit,
        total,
        totalPages,
        hasNextPage: numericPage < totalPages,
        hasPrevPage: numericPage > 1,
      },
    };
  }

  async listLedger(customerId, organizationId, filter = {}, pagination = {}) {
    return await this.listCustomerLedger(customerId, organizationId, filter, pagination);
  }
}

export const loyaltyTransactionRepository = new LoyaltyTransactionRepository();
