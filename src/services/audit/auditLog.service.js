import mongoose from "mongoose";
import { AuditLogRepository } from "../../repositories/audit/auditLog.repository.js";

const toObjectIdOrSelf = (val) => {
  if (!val) return val;
  if (typeof val === "string" && mongoose.Types.ObjectId.isValid(val)) {
    return new mongoose.Types.ObjectId(val);
  }
  return val;
};

export class AuditLogService {
  constructor(auditRepo = null) {
    this.auditRepo = auditRepo || new AuditLogRepository();
  }

  async createAuditLog(data, organizationId, userId, session = null) {
    return this.auditRepo.create(data, organizationId, userId, session);
  }

  async getAuditLogs(filter = {}, options = {}, organizationId) {
    const queryFilter = { ...filter };

    if (organizationId !== undefined) {
      queryFilter.organizationId = organizationId;
    }

    if (filter.startDate !== undefined || filter.endDate !== undefined) {
      delete queryFilter.startDate;
      delete queryFilter.endDate;
      queryFilter.createdAt = {};
      if (filter.startDate !== undefined) {
        queryFilter.createdAt.$gte = new Date(`${filter.startDate}T00:00:00.000Z`);
      }
      if (filter.endDate !== undefined) {
        queryFilter.createdAt.$lte = new Date(`${filter.endDate}T23:59:59.999Z`);
      }
    }

    const findOptions = {
      ...options,
      sort: options.sort || { createdAt: -1, _id: -1 },
    };

    return this.auditRepo.find(queryFilter, findOptions, [
      { path: "actorId", select: "name email" },
    ]);
  }
}
