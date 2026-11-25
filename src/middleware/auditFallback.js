import { AUDIT_ACTIONS } from "../models/audit/auditLog.model.js";
import { AuditLogService } from "../services/audit/auditLog.service.js";
import {
  runWithAuditContext,
  isRequestAudited,
} from "../utils/auditContext.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const auditService = new AuditLogService();

const deriveEntityTypeFromPath = (originalUrl = "") => {
  const cleanPath = originalUrl.split("?")[0];
  const segments = cleanPath.split("/").filter(Boolean);
  // e.g. /api/v1/procurement/invoices -> "procurement"
  const moduleSegment =
    segments[0] === "api" && segments[1]?.startsWith("v")
      ? segments[2]
      : segments[0];
  if (!moduleSegment) return "ApiRoute";
  return moduleSegment.charAt(0).toUpperCase() + moduleSegment.slice(1);
};

/**
 * Global audit context + fallback middleware.
 * 1. Establishes an AsyncLocalStorage audit context for every HTTP request.
 * 2. If a mutating request (POST/PUT/PATCH/DELETE) succeeds (2xx) without an explicit
 *    domain audit log from a controller/service, records a fallback API_MUTATION_EXECUTED log.
 */
export const auditFallbackMiddleware = (req, res, next) => {
  const initialContext = {
    ipAddress: req.ip || req.headers?.["x-forwarded-for"] || null,
    userAgent: req.headers?.["user-agent"] || null,
    source: "web",
    actorType: "user",
  };

  runWithAuditContext(initialContext, () => {
    if (MUTATING_METHODS.has(req.method)) {
      res.on("finish", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return;
        if (isRequestAudited()) return;
        if (req.originalUrl?.includes("/audit-logs")) return;

        const organizationId = req.user?.organizationId || null;
        const userId = req.user?._id || req.user?.id || null;
        const branchId = req.branchId || req.user?.branchId || null;

        auditService
          .createAuditLog(
            {
              action: AUDIT_ACTIONS.API_MUTATION_EXECUTED,
              entityType: deriveEntityTypeFromPath(req.originalUrl),
              entityId: req.params?.id || null,
              branchId,
              actorType: userId ? "user" : "system",
              source: "api",
              description: `${req.method} ${req.originalUrl.split("?")[0]}`,
              ipAddress: initialContext.ipAddress,
              userAgent: initialContext.userAgent,
              metadata: {
                method: req.method,
                path: req.originalUrl.split("?")[0],
                statusCode: res.statusCode,
                body: req.body && typeof req.body === "object" ? req.body : undefined,
              },
            },
            organizationId,
            userId
          )
          .catch((err) => {
            console.error("[AUDIT_FALLBACK_ERROR]", err.message);
          });
      });
    }

    next();
  });
};
