import { AuditLogRepository } from "../../repositories/audit/auditLog.repository.js";
import { getAuditContext, markRequestAudited } from "../../utils/auditContext.js";

const SENSITIVE_KEYS = new Set([
  "password",
  "passwordhash",
  "newpassword",
  "oldpassword",
  "currentpassword",
  "otp",
  "otpcode",
  "token",
  "accesstoken",
  "refreshtoken",
  "resettoken",
  "secret",
  "apikey",
  "authorization",
  "cookie",
]);

export const sanitizeAuditMetadata = (value) => {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sanitizeAuditMetadata);
  if (value instanceof Date || typeof value !== "object") return value;

  const sanitized = {};
  for (const [key, val] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      sanitized[key] = "[REDACTED]";
    } else if (val && typeof val === "object" && !(val instanceof Date)) {
      sanitized[key] = sanitizeAuditMetadata(val);
    } else {
      sanitized[key] = val;
    }
  }
  return sanitized;
};

export const buildBeforeAfterMetadata = (before = {}, after = {}, fields = null) => {
  const keys = fields || Array.from(new Set([...Object.keys(before || {}), ...Object.keys(after || {})]));
  const diffBefore = {};
  const diffAfter = {};
  for (const key of keys) {
    const bVal = before?.[key];
    const aVal = after?.[key];
    if (JSON.stringify(bVal) !== JSON.stringify(aVal)) {
      diffBefore[key] = bVal;
      diffAfter[key] = aVal;
    }
  }
  return sanitizeAuditMetadata({ before: diffBefore, after: diffAfter });
};

export const extractAuditContext = (req) => {
  if (!req) return {};
  return {
    ipAddress: req.ip || req.headers?.["x-forwarded-for"] || null,
    userAgent: req.headers?.["user-agent"] || null,
    source: "web",
  };
};

export class AuditLogService {
  constructor(auditRepo = null) {
    this.auditRepo = auditRepo || new AuditLogRepository();
  }

  async createAuditLog(data, organizationId, userId, session = null) {
    try {
      markRequestAudited();
      const ctx = getAuditContext();
      const sanitizedData = {
        ...(ctx?.ipAddress && !data.ipAddress ? { ipAddress: ctx.ipAddress } : {}),
        ...(ctx?.userAgent && !data.userAgent ? { userAgent: ctx.userAgent } : {}),
        ...(ctx?.source && !data.source ? { source: ctx.source } : {}),
        ...(ctx?.actorType && !data.actorType ? { actorType: ctx.actorType } : {}),
        ...data,
        metadata: sanitizeAuditMetadata(data.metadata || {}),
      };
      return await this.auditRepo.create(sanitizedData, organizationId, userId, session);
    } catch (error) {
      // Structured logging for audit persistence failures; never silently swallow
      console.error("[AUDIT_LOG_PERSISTENCE_ERROR]", {
        action: data?.action,
        entityType: data?.entityType,
        entityId: data?.entityId,
        organizationId,
        error: error.message,
      });
      throw error;
    }
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
