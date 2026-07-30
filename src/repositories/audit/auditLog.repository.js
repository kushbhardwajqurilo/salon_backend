import { BaseRepository } from "../../shared/repositories/base.repository.js";
import { AuditLog } from "../../models/audit/auditLog.model.js";

export class AuditLogRepository extends BaseRepository {
  constructor() {
    super(AuditLog);
  }

  async create(data, organizationId, userId = null, session = null) {
    const doc = new this.model({
      ...data,
      organizationId,
      actorId: userId,
    });
    return doc.save({ session });
  }

  async findByEntity(entityType, entityId, organizationId, options = {}) {
    const filter = { entityType, entityId, organizationId };
    return this.find(filter, options);
  }
}
