import { jest } from "@jest/globals";
import { authorize } from "../../middleware/rbac.js";
import { RoleRepository } from "../../repositories/roles/role.repository.js";
import { redis } from "../../utils/redis.js";
import { AppError } from "../../utils/errors.js";

RoleRepository.prototype.findByNameInOrg = jest.fn();
RoleRepository.prototype.findByName = jest.fn();

const store = {};
redis.get = jest.fn().mockImplementation(async (key) => store[key] || null);
redis.setex = jest.fn().mockImplementation(async (key, seconds, value) => {
  store[key] = value;
  return "OK";
});
redis.del = jest.fn().mockImplementation(async (key) => {
  delete store[key];
  return 1;
});

// Helper to run express middleware and capture resolve/reject from next()
const runMiddleware = (middleware, req, res = {}) => {
  return new Promise((resolve, reject) => {
    middleware(req, res, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
};

describe("RBAC Authorization Middleware", () => {
  let req;
  let res;

  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(store)) {
      delete store[key];
    }

    req = {
      user: {
        id: "user-123",
        role: "stylist",
        organizationId: "org-1",
        branchAccess: [{ branchId: "branch-1", isActive: true }],
      },
      params: {},
      query: {},
      body: {},
    };

    res = {};
  });

  it("should not bypass permission checks for admin based on role name alone (empty permissions denial)", async () => {
    req.user.role = "admin";
    const middleware = authorize("customers.create");

    RoleRepository.prototype.findByNameInOrg.mockResolvedValue({
      name: "admin",
      isSystem: false,
      organizationId: "org-1",
      permissions: [],
    });

    await expect(runMiddleware(middleware, req, res)).rejects.toThrow(
      new AppError("Access denied. You do not have the required permissions.", 403)
    );
  });

  it("should authorize request and cache permissions in tenant cache on cache miss", async () => {
    const mockRoleObj = {
      name: "stylist",
      isSystem: false,
      organizationId: "org-1",
      permissions: [
        { name: "customers.view" },
        { name: "customers.create" },
      ],
    };

    RoleRepository.prototype.findByNameInOrg.mockResolvedValue(mockRoleObj);

    const middleware = authorize("customers.create");
    await expect(runMiddleware(middleware, req, res)).resolves.toBeUndefined();

    const expectedCacheKey = "rbac:org:org-1:role:stylist:permissions";
    expect(redis.get).toHaveBeenCalledWith(expectedCacheKey);
    expect(redis.setex).toHaveBeenCalledWith(
      expectedCacheKey,
      86400,
      JSON.stringify(["customers.view", "customers.create"])
    );
  });

  it("should authorize request from Redis cache on cache hit", async () => {
    const tenantCacheKey = "rbac:org:org-1:role:stylist:permissions";
    await redis.setex(
      tenantCacheKey,
      86400,
      JSON.stringify(["customers.view", "customers.create"])
    );

    RoleRepository.prototype.findByNameInOrg.mockReset();

    const middleware = authorize("customers.create");
    await expect(runMiddleware(middleware, req, res)).resolves.toBeUndefined();

    expect(RoleRepository.prototype.findByNameInOrg).not.toHaveBeenCalled();
  });

  it("should block request and throw 403 if role doesn't have the permission", async () => {
    const tenantCacheKey = "rbac:org:org-1:role:stylist:permissions";
    await redis.setex(
      tenantCacheKey,
      86400,
      JSON.stringify(["customers.view"])
    );

    const middleware = authorize("customers.create");

    await expect(runMiddleware(middleware, req, res)).rejects.toThrow(
      new AppError("Access denied. You do not have the required permissions.", 403)
    );
  });

  it("should prove a tenant-owned role cannot fall back to a global cache entry on tenant cache miss", async () => {
    // Seed global cache with permissions
    const globalCacheKey = "rbac:org:global:role:stylist:permissions";
    await redis.setex(
      globalCacheKey,
      86400,
      JSON.stringify(["customers.create", "customers.view"])
    );

    // DB returns tenant-owned role with only customers.view
    RoleRepository.prototype.findByNameInOrg.mockResolvedValue({
      name: "stylist",
      isSystem: false,
      organizationId: "org-1",
      permissions: [{ name: "customers.view" }],
    });

    const middleware = authorize("customers.create");

    // Must NOT receive customers.create from global cache and must be rejected
    await expect(runMiddleware(middleware, req, res)).rejects.toThrow(
      new AppError("Access denied. You do not have the required permissions.", 403)
    );

    // Verify tenant cache was checked, but global cache was NOT checked for this tenant request
    expect(redis.get).toHaveBeenCalledWith("rbac:org:org-1:role:stylist:permissions");
    expect(redis.get).not.toHaveBeenCalledWith(globalCacheKey);
  });

  it("should cache permissions in tenant cache for user with organizationId assigned a system role and reuse on subsequent requests", async () => {
    req.user.organizationId = "org-1";
    req.user.role = "owner";

    const mockSystemRole = {
      name: "owner",
      isSystem: true,
      organizationId: null,
      permissions: [
        { name: "customers.view" },
        { name: "customers.create" },
      ],
    };

    RoleRepository.prototype.findByNameInOrg.mockResolvedValue(mockSystemRole);

    const middleware = authorize("customers.create");

    // 1st request: Cache miss -> queries DB -> caches in both global and tenant key
    await expect(runMiddleware(middleware, req, res)).resolves.toBeUndefined();

    const tenantCacheKey = "rbac:org:org-1:role:owner:permissions";
    const globalCacheKey = "rbac:org:global:role:owner:permissions";

    expect(redis.setex).toHaveBeenCalledWith(
      globalCacheKey,
      86400,
      JSON.stringify(["customers.view", "customers.create"])
    );
    expect(redis.setex).toHaveBeenCalledWith(
      tenantCacheKey,
      86400,
      JSON.stringify(["customers.view", "customers.create"])
    );

    // 2nd request: Subsequent request by user with organizationId must hit tenant cache without calling DB
    RoleRepository.prototype.findByNameInOrg.mockReset();
    await expect(runMiddleware(middleware, req, res)).resolves.toBeUndefined();
    expect(RoleRepository.prototype.findByNameInOrg).not.toHaveBeenCalled();
  });

  it("should prove system roles use the global cache when user has no organizationId", async () => {
    req.user.organizationId = null;
    req.user.role = "superadmin";

    const globalCacheKey = "rbac:org:global:role:superadmin:permissions";
    await redis.setex(
      globalCacheKey,
      86400,
      JSON.stringify(["customers.view", "customers.create"])
    );

    const middleware = authorize("customers.create");
    await expect(runMiddleware(middleware, req, res)).resolves.toBeUndefined();

    expect(redis.get).toHaveBeenCalledWith(globalCacheKey);
    expect(RoleRepository.prototype.findByName).not.toHaveBeenCalled();
    expect(RoleRepository.prototype.findByNameInOrg).not.toHaveBeenCalled();
  });

  it("should check and block branch scoping if target branch is unauthorized", async () => {
    const tenantCacheKey = "rbac:org:org-1:role:stylist:permissions";
    await redis.setex(
      tenantCacheKey,
      86400,
      JSON.stringify(["customers.create"])
    );

    req.params.branchId = "branch-2";

    const middleware = authorize("customers.create", true);

    await expect(runMiddleware(middleware, req, res)).rejects.toThrow(
      new AppError("Access denied. You do not have access to this branch.", 403)
    );
  });

  it("should allow branch scoping if target branch is authorized and active in user branchAccess", async () => {
    const tenantCacheKey = "rbac:org:org-1:role:stylist:permissions";
    await redis.setex(
      tenantCacheKey,
      86400,
      JSON.stringify(["customers.create"])
    );

    req.params.branchId = "branch-1";

    const middleware = authorize("customers.create", true);

    await expect(runMiddleware(middleware, req, res)).resolves.toBeUndefined();
  });
});
