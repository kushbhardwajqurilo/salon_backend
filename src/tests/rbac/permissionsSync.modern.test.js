import crypto from "node:crypto";
import mongoose from "mongoose";
import { Permission } from "../../models/permissions/permission.model.js";
import { Role } from "../../models/roles/role.model.js";
import { CANONICAL_PERMISSIONS } from "../../config/permissions.js";
import { User } from "../../models/users/user.model.js";
import { syncPermissionsLogic } from "../../scripts/syncPermissions.js";
import { redis } from "../../utils/redis.js";
import { getIsolatedTestMongoUri } from "../testSetup.js";

describe("Permissions Synchronization Integration Tests (Modern Canonical Suite)", () => {
  let originalPermissions;

  beforeAll(async () => {
    originalPermissions = [...CANONICAL_PERMISSIONS.map((p) => ({ ...p }))];
    const testUri = getIsolatedTestMongoUri("permissions_sync_test");
    await mongoose.connect(testUri);
  }, 30000);

  afterAll(async () => {
    CANONICAL_PERMISSIONS.length = 0;
    originalPermissions.forEach((p) => CANONICAL_PERMISSIONS.push(p));

    await Permission.deleteMany({});
    await Role.deleteMany({});
    await User.deleteMany({});
    await mongoose.connection.close();
  }, 30000);

  beforeEach(async () => {
    await Permission.deleteMany({});
    await Role.deleteMany({});
    await User.deleteMany({});

    CANONICAL_PERMISSIONS.length = 0;
    originalPermissions.forEach((p) => CANONICAL_PERMISSIONS.push(p));
  });

  it("Owner role receives every canonical permission in permissions.js", async () => {
    const totalCanonical = CANONICAL_PERMISSIONS.length;
    expect(totalCanonical).toBeGreaterThan(100);

    const summary = await syncPermissionsLogic();
    expect(summary.canonicalCount).toBe(totalCanonical);
    expect(summary.ownerPermissionCount).toBe(totalCanonical);

    const owner = await Role.findOne({ name: "owner" }).populate("permissions");
    expect(owner).toBeDefined();
    expect(owner.permissions.length).toBe(totalCanonical);

    // Verify all 7 incentives permissions are present on Owner
    const ownerPermNames = owner.permissions.map((p) => p.name);
    const expectedIncentivePerms = [
      "incentives.view",
      "incentives.view.all",
      "incentives.rules.manage",
      "incentives.approve",
      "incentives.payout.sync",
      "incentives.fulfillment.confirm",
      "incentives.fulfillment.correct",
    ];
    for (const perm of expectedIncentivePerms) {
      expect(ownerPermNames).toContain(perm);
    }
  }, 30000);

  it("Adding a new canonical permission and synchronizing dynamically grants it to Owner", async () => {
    await syncPermissionsLogic();

    // Dynamically introduce a new future permission
    const testPermName = "future_module.manage";
    CANONICAL_PERMISSIONS.push({
      name: testPermName,
      module: "Future Module",
      action: "Manage",
      description: "Test future module permission",
    });

    const summary2 = await syncPermissionsLogic();
    expect(summary2.createdCount).toBe(1);
    expect(summary2.ownerPermissionCount).toBe(CANONICAL_PERMISSIONS.length);

    const owner = await Role.findOne({ name: "owner" }).populate("permissions");
    const ownerPermNames = owner.permissions.map((p) => p.name);
    expect(ownerPermNames).toContain(testPermName);
  }, 30000);

  it("Manager receives configured operational defaults including incentives.view and incentives.rules.manage", async () => {
    await syncPermissionsLogic();

    const manager = await Role.findOne({ name: "manager" }).populate("permissions");
    expect(manager).toBeDefined();
    const managerPermNames = manager.permissions.map((p) => p.name);

    // Manager must receive intended incentives permissions
    expect(managerPermNames).toContain("incentives.view");
    expect(managerPermNames).toContain("incentives.view.all");
    expect(managerPermNames).toContain("incentives.rules.manage");
    expect(managerPermNames).toContain("incentives.approve");

    // Manager must NOT receive all system permissions (e.g., settings.backups or superadmin privileges)
    expect(manager.permissions.length).toBeLessThan(CANONICAL_PERMISSIONS.length);
  }, 30000);

  it("Synchronization is strictly idempotent without duplicates or ID mutation", async () => {
    const summary1 = await syncPermissionsLogic();
    const beforePerms = await Permission.find({}).sort({ name: 1 });

    const summary2 = await syncPermissionsLogic();
    expect(summary2.createdCount).toBe(0);
    expect(summary2.updatedCount).toBe(0);
    expect(summary2.unchangedCount).toBe(summary1.canonicalCount);

    const afterPerms = await Permission.find({}).sort({ name: 1 });
    expect(beforePerms.length).toBe(afterPerms.length);

    for (let i = 0; i < beforePerms.length; i++) {
      expect(beforePerms[i]._id.toString()).toBe(afterPerms[i]._id.toString());
      expect(beforePerms[i].name).toBe(afterPerms[i].name);
    }
  }, 30000);

  it("Authenticating as Owner resolves all canonical permissions via /auth/me", async () => {
    await syncPermissionsLogic();

    const ownerRole = await Role.findOne({ name: "owner" });
    const ownerUser = await User.create({
      name: "Owner User",
      email: "owner_test_e2e@example.com",
      phone: "+91 9999900001",
      password: `Test-${crypto.randomUUID()}-A1!`,
      role: ownerRole._id,
      organizationId: new mongoose.Types.ObjectId(),
    });

    const req = { user: { id: ownerUser._id.toString() } };
    const res = {
      statusCode: 0,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        this.body = data;
        return this;
      },
    };

    const { me } = await import("../../controllers/auth/auth.controller.js");
    await me(req, res, () => {});

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.permissions.length).toBe(CANONICAL_PERMISSIONS.length);
    expect(res.body.data.permissions).toContain("incentives.view");
    expect(res.body.data.permissions).toContain("incentives.rules.manage");
  }, 30000);
});
