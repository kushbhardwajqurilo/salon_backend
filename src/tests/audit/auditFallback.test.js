import { jest } from "@jest/globals";
import { EventEmitter } from "node:events";
import { auditFallbackMiddleware } from "../../middleware/auditFallback.js";
import { AuditLogService } from "../../services/audit/auditLog.service.js";
import { AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";
import { runWithAuditContext, isRequestAudited } from "../../utils/auditContext.js";

describe("Audit Fallback Middleware & Context", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("logs API_MUTATION_EXECUTED for 2xx mutating request without explicit audit", async () => {
    const createSpy = jest
      .spyOn(AuditLogService.prototype, "createAuditLog")
      .mockResolvedValue({ _id: "audit_1" });

    const req = {
      method: "POST",
      originalUrl: "/api/v1/procurement/invoices",
      ip: "127.0.0.1",
      headers: { "user-agent": "jest-agent" },
      user: { _id: "user_1", organizationId: "org_1", branchId: "branch_1" },
      params: {},
      body: { amount: 500, password: "secret" },
    };

    const res = new EventEmitter();
    res.statusCode = 201;

    await new Promise((resolve) => {
      auditFallbackMiddleware(req, res, () => {
        res.emit("finish");
        setImmediate(resolve);
      });
    });

    expect(createSpy).toHaveBeenCalledTimes(1);
    const [payload, orgId, userId] = createSpy.mock.calls[0];
    expect(payload.action).toBe(AUDIT_ACTIONS.API_MUTATION_EXECUTED);
    expect(payload.entityType).toBe("Procurement");
    expect(orgId).toBe("org_1");
    expect(userId).toBe("user_1");
  });

  test("does NOT duplicate log when explicit createAuditLog was already called", async () => {
    const repoCreateSpy = jest.fn().mockResolvedValue({ _id: "audit_explicit" });
    const fallbackSpy = jest
      .spyOn(AuditLogService.prototype, "createAuditLog");

    const req = {
      method: "PATCH",
      originalUrl: "/api/v1/branches/123",
      headers: {},
      user: { _id: "user_1", organizationId: "org_1" },
      params: { id: "123" },
      body: { name: "Updated" },
    };

    const res = new EventEmitter();
    res.statusCode = 200;

    await new Promise((resolve) => {
      auditFallbackMiddleware(req, res, async () => {
        const svc = new AuditLogService({ create: repoCreateSpy });
        await svc.createAuditLog(
          {
            action: AUDIT_ACTIONS.CUSTOMER_UPDATED,
            entityType: "Branch",
            description: "Explicit",
          },
          "org_1",
          "user_1"
        );
        expect(isRequestAudited()).toBe(true);
        res.emit("finish");
        setImmediate(resolve);
      });
    });

    // Only the explicit call happened; fallback did not fire
    expect(repoCreateSpy).toHaveBeenCalledTimes(1);
    expect(fallbackSpy).toHaveBeenCalledTimes(1);
    expect(fallbackSpy.mock.calls[0][0].action).toBe(AUDIT_ACTIONS.CUSTOMER_UPDATED);
  });

  test("ignores GET requests and 4xx/5xx responses", async () => {
    const createSpy = jest
      .spyOn(AuditLogService.prototype, "createAuditLog")
      .mockResolvedValue({});

    const getReq = { method: "GET", originalUrl: "/api/v1/users", headers: {} };
    const getRes = new EventEmitter();
    getRes.statusCode = 200;

    const errReq = { method: "POST", originalUrl: "/api/v1/users", headers: {} };
    const errRes = new EventEmitter();
    errRes.statusCode = 400;

    await new Promise((resolve) => {
      auditFallbackMiddleware(getReq, getRes, () => {
        getRes.emit("finish");
        auditFallbackMiddleware(errReq, errRes, () => {
          errRes.emit("finish");
          setImmediate(resolve);
        });
      });
    });

    expect(createSpy).not.toHaveBeenCalled();
  });

  test("runWithAuditContext isolates context for system/background jobs", () => {
    const result = runWithAuditContext(
      { actorType: "background_job", source: "scheduled_job" },
      () => isRequestAudited()
    );
    expect(result).toBe(false);
  });

  test("redacts sensitive fields recursively in fallback audit body without mutating req.body", async () => {
    const createSpy = jest
      .spyOn(AuditLogService.prototype, "createAuditLog")
      .mockResolvedValue({ _id: "audit_redacted" });

    const originalBody = {
      customerName: "Asha",
      amount: 1200,
      confirmPassword: "MySecretPassword!",
      access_token: "jwt-access-123",
      refreshToken: "jwt-refresh-456",
      nested: {
        otp: "998877",
        headers: {
          authorization: "Bearer secret-token",
          cookie: "session=abc",
        },
      },
      credentials: [{ api_key: "key-123", label: "POS" }],
      items: [{ api_key: "key-456", label: "POS" }],
    };

    const req = {
      method: "POST",
      originalUrl: "/api/v1/auth/activate",
      ip: "127.0.0.1",
      headers: {
        "user-agent": "jest-agent",
        authorization: "Bearer header-secret",
        cookie: "refreshToken=xyz",
      },
      user: { _id: "user_1", organizationId: "org_1", branchId: "branch_1" },
      params: {},
      body: originalBody,
    };

    const res = new EventEmitter();
    res.statusCode = 200;

    await new Promise((resolve) => {
      auditFallbackMiddleware(req, res, () => {
        res.emit("finish");
        setImmediate(resolve);
      });
    });

    expect(createSpy).toHaveBeenCalledTimes(1);
    const [payload] = createSpy.mock.calls[0];
    const loggedBody = payload.metadata.body;

    expect(loggedBody.customerName).toBe("Asha");
    expect(loggedBody.amount).toBe(1200);
    expect(loggedBody.confirmPassword).toBe("[REDACTED]");
    expect(loggedBody.access_token).toBe("[REDACTED]");
    expect(loggedBody.refreshToken).toBe("[REDACTED]");
    expect(loggedBody.nested.otp).toBe("[REDACTED]");
    expect(loggedBody.nested.headers.authorization).toBe("[REDACTED]");
    expect(loggedBody.nested.headers.cookie).toBe("[REDACTED]");
    expect(loggedBody.credentials).toBe("[REDACTED]");
    expect(loggedBody.items[0].api_key).toBe("[REDACTED]");
    expect(loggedBody.items[0].label).toBe("POS");

    // Ensure original req.body was not mutated
    expect(originalBody.confirmPassword).toBe("MySecretPassword!");
    expect(originalBody.nested.otp).toBe("998877");
  });
});
