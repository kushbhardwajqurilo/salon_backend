import { jest } from "@jest/globals";
import { authorize } from "../../middleware/rbac.js";
import { RoleRepository } from "../../repositories/roles/role.repository.js";
import { redis } from "../../utils/redis.js";
import { AppError } from "../../utils/errors.js";

RoleRepository.prototype.findOne = jest.fn();

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

    req = {
      user: {
        id: "user-123",
        role: "stylist",
        branches: ["branch-1"],
      },
      params: {},
      query: {},
      body: {},
    };

    res = {};
  });

  it("should not bypass permission checks for admin based on role name alone", async () => {
    req.user.role = "admin";
    const middleware = authorize("customer:create");

    RoleRepository.prototype.findOne.mockResolvedValue({
      name: "admin",
      permissions: [],
    });

    await expect(runMiddleware(middleware, req, res)).rejects.toThrow(
      new AppError("Access denied. You do not have the required permissions.", 403)
    );
  });

  it("should authorize request and cache permissions on cache miss", async () => {
    const mockRoleObj = {
      name: "stylist",
      permissions: [
        { name: "customer:view" },
        { name: "customer:create" },
      ],
    };

    RoleRepository.prototype.findOne.mockResolvedValue(mockRoleObj);

    const middleware = authorize("customer:create");
    await expect(runMiddleware(middleware, req, res)).resolves.toBeUndefined();

    expect(redis.get).toHaveBeenCalledWith("rbac:role:stylist:permissions");
    expect(redis.setex).toHaveBeenCalledWith(
      "rbac:role:stylist:permissions",
      86400,
      JSON.stringify(["customer:view", "customer:create"])
    );
  });

  it("should authorize request from Redis cache on cache hit", async () => {
    await redis.setex(
      "rbac:role:stylist:permissions",
      86400,
      JSON.stringify(["customer:view", "customer:create"])
    );

    RoleRepository.prototype.findOne.mockReset();

    const middleware = authorize("customer:create");
    await expect(runMiddleware(middleware, req, res)).resolves.toBeUndefined();

    expect(RoleRepository.prototype.findOne).not.toHaveBeenCalled();
  });

  it("should block request and throw 403 if role doesn't have the permission", async () => {
    await redis.setex(
      "rbac:role:stylist:permissions",
      86400,
      JSON.stringify(["customer:view"])
    );

    const middleware = authorize("customer:create");

    await expect(runMiddleware(middleware, req, res)).rejects.toThrow(
      new AppError("Access denied. You do not have the required permissions.", 403)
    );
  });

  it("should check and block branch scoping if target branch is unauthorized", async () => {
    await redis.setex(
      "rbac:role:stylist:permissions",
      86400,
      JSON.stringify(["customer:create"])
    );
    
    req.params.branchId = "branch-2";

    const middleware = authorize("customer:create", true);

    await expect(runMiddleware(middleware, req, res)).rejects.toThrow(
      new AppError("Access denied. You do not have access to this branch.", 403)
    );
  });
});
