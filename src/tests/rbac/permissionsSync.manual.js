import mongoose from "mongoose";
import { connectDB } from "../../database/db.js";
import { Permission } from "../../models/permissions/permission.model.js";
import { Role } from "../../models/roles/role.model.js";
import { CANONICAL_PERMISSIONS } from "../../config/permissions.js";
import { User } from "../../models/users/user.model.js";
import { syncPermissionsLogic } from "../../scripts/syncPermissions.js";
import { redis } from "../../utils/redis.js";
import { jest } from "@jest/globals";

describe("Permissions Synchronization Integration Tests", () => {
  let originalPermissions;

  beforeAll(async () => {
    // Connect to separate integration test database to protect dev database data
    let testUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/saloon_erp_test";
    if (testUri.includes("?")) {
      const parts = testUri.split("?");
      testUri = parts[0].replace(/\/([^\/]+)$/, "/saloon_erp_integration_test") + "?" + parts[1];
    } else {
      testUri = testUri.replace(/\/([^\/]+)$/, "/saloon_erp_integration_test");
    }
    await mongoose.connect(testUri);
    
    // Save original canonical permissions array content to restore later
    originalPermissions = [...CANONICAL_PERMISSIONS.map(p => ({ ...p }))];
  });

  afterAll(async () => {
    // Restore original canonical permissions array
    CANONICAL_PERMISSIONS.length = 0;
    originalPermissions.forEach(p => CANONICAL_PERMISSIONS.push(p));
    
    // Cleanup test collections
    await Permission.deleteMany({});
    await Role.deleteMany({});
    await User.deleteMany({});
    
    // Disconnect
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    // Clear collections for fresh test state
    await Permission.deleteMany({});
    await Role.deleteMany({});
    await User.deleteMany({});
    
    // Restore registry to canonical 88 permissions
    CANONICAL_PERMISSIONS.length = 0;
    originalPermissions.forEach(p => CANONICAL_PERMISSIONS.push(p));
    
    // Reset mock spies
    jest.clearAllMocks();
  });

  it("should create all 88 canonical permissions on first sync", async () => {
    expect(CANONICAL_PERMISSIONS.length).toBe(88);

    const summary = await syncPermissionsLogic();
    expect(summary.canonicalCount).toBe(88);
    expect(summary.createdCount).toBe(88);
    expect(summary.updatedCount).toBe(0);
    expect(summary.unchangedCount).toBe(0);

    const count = await Permission.countDocuments({});
    expect(count).toBe(88);

    const owner = await Role.findOne({ name: "owner" }).populate("permissions");
    expect(owner).toBeDefined();
    expect(owner.permissions.length).toBe(88);
  });

  it("should create no duplicates and have unchanged count on repeated sync", async () => {
    // First sync
    await syncPermissionsLogic();
    
    // Second sync
    const summary = await syncPermissionsLogic();
    expect(summary.canonicalCount).toBe(88);
    expect(summary.createdCount).toBe(0);
    expect(summary.updatedCount).toBe(0);
    expect(summary.unchangedCount).toBe(88);

    const count = await Permission.countDocuments({});
    expect(count).toBe(88);
  });

  it("should preserve existing permission _id values after re-sync", async () => {
    await syncPermissionsLogic();
    const beforeList = await Permission.find({}).sort({ name: 1 });

    await syncPermissionsLogic();
    const afterList = await Permission.find({}).sort({ name: 1 });

    expect(beforeList.length).toBe(88);
    expect(afterList.length).toBe(88);

    for (let i = 0; i < 88; i++) {
      expect(beforeList[i]._id.toString()).toBe(afterList[i]._id.toString());
      expect(beforeList[i].name).toBe(afterList[i].name);
    }
  });

  it("should update permission metadata when the registry changes", async () => {
    await syncPermissionsLogic();

    // Mutate description of the first permission in registry
    const targetPermName = CANONICAL_PERMISSIONS[0].name;
    const oldDesc = CANONICAL_PERMISSIONS[0].description;
    CANONICAL_PERMISSIONS[0].description = "Updated description for test";

    const summary = await syncPermissionsLogic();
    expect(summary.updatedCount).toBe(1);
    expect(summary.unchangedCount).toBe(87);

    const dbPerm = await Permission.findOne({ name: targetPermName });
    expect(dbPerm.description).toBe("Updated description for test");
    
    // Restore
    CANONICAL_PERMISSIONS[0].description = oldDesc;
  });

  it("should create a new permission on sync when added to the registry later", async () => {
    await syncPermissionsLogic();

    // Add new permission to the registry array
    CANONICAL_PERMISSIONS.push({
      name: "test_new_module.do_something",
      module: "TestNewModule",
      action: "Do Something",
      description: "Test description for new permission"
    });

    const summary = await syncPermissionsLogic();
    expect(summary.canonicalCount).toBe(89);
    expect(summary.createdCount).toBe(1);
    expect(summary.unchangedCount).toBe(88);

    const dbPerm = await Permission.findOne({ name: "test_new_module.do_something" });
    expect(dbPerm).not.toBeNull();
    expect(dbPerm.module).toBe("TestNewModule");

    // Owner should now have 89 permissions
    const owner = await Role.findOne({ name: "owner" });
    expect(owner.permissions.length).toBe(89);
  });

  it("should not delete document from MongoDB when a permission is removed from the registry", async () => {
    await syncPermissionsLogic();

    // Remove first permission from the registry
    const removedPerm = CANONICAL_PERMISSIONS.shift();

    const summary = await syncPermissionsLogic();
    expect(summary.canonicalCount).toBe(87);
    expect(summary.unchangedCount).toBe(87);

    // Document must still exist in MongoDB (not automatically deleted)
    const dbPerm = await Permission.findOne({ name: removedPerm.name });
    expect(dbPerm).not.toBeNull();
    expect(dbPerm.name).toBe(removedPerm.name);
  });

  it("should exclude removed registry permissions from Owner's permission list", async () => {
    await syncPermissionsLogic();

    // Remove first permission from the registry
    const removedPerm = CANONICAL_PERMISSIONS.shift();

    await syncPermissionsLogic();

    const owner = await Role.findOne({ name: "owner" }).populate("permissions");
    expect(owner.permissions.length).toBe(87);

    // Verify owner does not have the removed permission
    const ownerPermNames = owner.permissions.map(p => p.name);
    expect(ownerPermNames.includes(removedPerm.name)).toBe(false);
  });

  it("should not modify non-owner roles when new permissions are added", async () => {
    // Pre-create a non-owner role (manager) with specific permissions
    await syncPermissionsLogic();
    const allPerms = await Permission.find({});
    
    const managerRole = await Role.create({
      name: "manager",
      description: "Manager Role",
      permissions: [allPerms[0]._id, allPerms[1]._id]
    });

    // Add new permission to canonical registry
    CANONICAL_PERMISSIONS.push({
      name: "another_module.action",
      module: "AnotherModule",
      action: "Action",
      description: "Another description"
    });

    await syncPermissionsLogic();

    // Manager role permissions must remain unchanged
    const dbManager = await Role.findOne({ name: "manager" });
    expect(dbManager.permissions.length).toBe(2);
    expect(dbManager.permissions.map(id => id.toString())).toContain(allPerms[0]._id.toString());
    expect(dbManager.permissions.map(id => id.toString())).toContain(allPerms[1]._id.toString());
  });

  it("should invalidate owner's permissions cache after synchronization", async () => {
    const redisDelSpy = jest.spyOn(redis, "del");
    
    await syncPermissionsLogic();
    
    expect(redisDelSpy).toHaveBeenCalledWith("rbac:role:owner:permissions");
  });

  it("should invalidate cache when role permissions are changed via controller", async () => {
    await syncPermissionsLogic();
    
    const ownerRole = await Role.findOne({ name: "owner" });
    const redisDelSpy = jest.spyOn(redis, "del");
    
    // We mock req and res for assignPermissionsToRole
    const req = {
      params: { roleId: ownerRole._id.toString() },
      body: { permissions: ["dashboard.view"] },
      user: { id: "some-user-id" }
    };
    
    const res = {
      status: function(code) {
        this.statusCode = code;
        return this;
      },
      json: function(data) {
        this.body = data;
        return this;
      }
    };
    
    // Import controller dynamically or directly
    const { assignPermissionsToRole } = await import("../../controllers/rbac/rbac.controller.js");
    
    await new Promise((resolve, reject) => {
      const next = (err) => {
        if (err) reject(err);
        else resolve();
      };
      const originalJson = res.json;
      res.json = (data) => {
        originalJson.call(res, data);
        resolve();
      };
      assignPermissionsToRole(req, res, next);
    });
    
    expect(redisDelSpy).toHaveBeenCalledWith(`rbac:role:owner:permissions`);
  });

  it("should return resolved permission names in /api/v1/auth/me response", async () => {
    await syncPermissionsLogic();
    
    // Create a specific user linked to a role
    const matchedPerms = await Permission.find({ name: { $in: ["dashboard.view", "customers.view"] } });
    const testRole = await Role.create({
      name: "custom_stylist",
      description: "Custom Stylist",
      permissions: matchedPerms.map(p => p._id)
    });
    
    const testUser = await User.create({
      name: "Test Stylist",
      email: "stylist@example.com",
      phone: "+91 7777777777",
      password: "Password@123",
      role: testRole._id,
      organizationId: new mongoose.Types.ObjectId()
    });

    const req = {
      user: { id: testUser._id.toString() }
    };
    
    const res = {
      status: function(code) {
        this.statusCode = code;
        return this;
      },
      json: function(data) {
        this.body = data;
        return this;
      }
    };

    const { me } = await import("../../controllers/auth/auth.controller.js");
    
    await new Promise((resolve, reject) => {
      const next = (err) => {
        if (err) reject(err);
        else resolve();
      };
      const originalJson = res.json;
      res.json = (data) => {
        originalJson.call(res, data);
        resolve();
      };
      me(req, res, next);
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.permissions).toContain("dashboard.view");
    expect(res.body.data.permissions).toContain("customers.view");
    expect(res.body.data.permissions.length).toBe(2);
  });

  it("should return all 88 canonical permission names in Owner's /auth/me response after synchronization", async () => {
    await syncPermissionsLogic();
    
    const ownerRole = await Role.findOne({ name: "owner" });
    const testOwner = await User.create({
      name: "Owner User",
      email: "owner_test@example.com",
      phone: "+91 6666666666",
      password: "Password@123",
      role: ownerRole._id,
      organizationId: new mongoose.Types.ObjectId()
    });

    const req = {
      user: { id: testOwner._id.toString() }
    };
    
    const res = {
      status: function(code) {
        this.statusCode = code;
        return this;
      },
      json: function(data) {
        this.body = data;
        return this;
      }
    };

    const { me } = await import("../../controllers/auth/auth.controller.js");
    
    await new Promise((resolve, reject) => {
      const next = (err) => {
        if (err) reject(err);
        else resolve();
      };
      const originalJson = res.json;
      res.json = (data) => {
        originalJson.call(res, data);
        resolve();
      };
      me(req, res, next);
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.permissions.length).toBe(88);
    expect(res.body.data.permissions).toContain("dashboard.view");
    expect(res.body.data.permissions).toContain("settings.backups");
  });
});
