import { AuditLogRepository } from "../../repositories/audit/auditLog.repository.js";

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
    // Force newest first
    const findOptions = {
      ...options,
      sort: { createdAt: -1, _id: -1 },
    };
    return this.auditRepo.find(queryFilter, findOptions);
  }
}
