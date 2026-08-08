import request from "supertest";
import mongoose from "mongoose";
import crypto from "crypto";
import app from "../../../app.mjs";
import { User } from "../../models/users/user.model.js";
import { Role } from "../../models/roles/role.model.js";
import { Organization } from "../../models/organizations/organization.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Staff } from "../../models/staff/staff.model.js";
import { Session } from "../../models/auth/session.model.js";
import { Permission } from "../../models/permissions/permission.model.js";
import { syncPermissionsLogic } from "../../scripts/syncPermissions.js";
import { UserService } from "../../services/users/user.service.js";

describe("E2E Security Fixture Verification (Phase 5.4.2)", () => {
  let dbConnection;
  let ownerRole, adminRole, managerRole, restrictedRole;
  let orgA, orgB;
  let branchA, branchB;
  let ownerA, managerA, restrictedA, lockedA, firstLoginA;
  let adminB, staffB, userB;
  let staffA;

  let ownerToken, managerToken, restrictedToken;

  beforeAll(async () => {
    let testUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/saloon_erp_test";
    if (testUri.includes("?")) {
      const parts = testUri.split("?");
      testUri = parts[0].replace(/\/([^\/]+)$/, "/saloon_erp_integration_test") + "?" + parts[1];
    } else {
      testUri = testUri.replace(/\/([^\/]+)$/, "/saloon_erp_integration_test");
    }
    // Connect to integration test DB
    dbConnection = await mongoose.connect(testUri);

    // Clean up collections for a deterministic fresh test state
    await User.deleteMany({});
    await Role.deleteMany({});
    await Organization.deleteMany({});
    await Branch.deleteMany({});
    await Staff.deleteMany({});
    await Session.deleteMany({});

    // Sync canonical permissions first
    await syncPermissionsLogic();

    ownerRole = await Role.findOne({ name: "owner" });
    adminRole = await Role.findOne({ name: "admin" });
    if (!adminRole) {
      const allPerms = await Permission.find({});
      adminRole = await Role.create({
        name: "admin",
        description: "Admin Role",
        permissions: allPerms.map(p => p._id),
      });
    }
    
    // Setup Manager Role with users.view, users.create, users.update
    const managerPermNames = ["users.view", "users.create", "users.update", "employees.view", "employees.update"];
    const managerPerms = await Permission.find({ name: { $in: managerPermNames } });
    managerRole = await Role.create({
      name: "manager-e2e",
      description: "E2E Manager",
      permissions: managerPerms.map(p => p._id),
    });

    // Setup Restricted Role without users/staff update/create/view permissions
    restrictedRole = await Role.create({
      name: "restricted-e2e",
      description: "Restricted role",
      permissions: [],
    });

    // Create Organizations
    orgA = await Organization.create({
      name: "E2E Org A",
      isActive: true,
    });

    orgB = await Organization.create({
      name: "E2E Org B",
      isActive: true,
    });

    // Create Branches
    branchA = await Branch.create({
      name: "E2E Branch A",
      organizationId: orgA._id,
      address: "123 Main St",
      phone: "+919999999911",
      isActive: true,
    });

    branchB = await Branch.create({
      name: "E2E Branch B",
      organizationId: orgB._id,
      address: "456 Main St",
      phone: "+919999999912",
      isActive: true,
    });

    // Create Users for Org A
    ownerA = await User.create({
      name: "Org A Owner",
      email: "owner@parlour.com",
      phone: "+919999999901",
      password: "Password@123",
      role: ownerRole._id,
      organizationId: orgA._id,
      isVerified: true,
      hasOrgWideAccess: true,
    });

    managerA = await User.create({
      name: "Org A Manager",
      email: "manager@parlour.com",
      phone: "+919999999902",
      password: "Password@123",
      role: managerRole._id,
      organizationId: orgA._id,
      isVerified: true,
      hasOrgWideAccess: true,
    });

    restrictedA = await User.create({
      name: "Org A Restricted",
      email: "e2e-restricted@parlour.test",
      phone: "+919999999903",
      password: "Password@123",
      role: restrictedRole._id,
      organizationId: orgA._id,
      isVerified: true,
    });

    lockedA = await User.create({
      name: "Org A Locked",
      email: "e2e-locked@parlour.test",
      phone: "+919999999904",
      password: "Password@123",
      role: managerRole._id,
      organizationId: orgA._id,
      isVerified: true,
      status: "locked",
      failedLoginAttempts: 5,
      lockUntil: new Date(Date.now() + 15 * 60 * 1000),
    });

    firstLoginA = await User.create({
      name: "Org A First Login",
      email: "e2e-first-login@parlour.test",
      phone: "+919999999905",
      password: "TempPassword123!",
      role: managerRole._id,
      organizationId: orgA._id,
      isVerified: true,
      isFirstLogin: true,
    });

    // Create Users/Staff for Org B
    adminB = await User.create({
      name: "Org B Admin",
      email: "e2e-tenant-b-admin@parlour.test",
      phone: "+919999999906",
      password: "Password@123",
      role: adminRole._id,
      organizationId: orgB._id,
      isVerified: true,
      hasOrgWideAccess: true,
    });

    userB = await User.create({
      name: "Org B Normal User",
      email: "e2e-tenant-b-user@parlour.test",
      phone: "+919999999907",
      password: "Password@123",
      role: managerRole._id,
      organizationId: orgB._id,
      isVerified: true,
    });

    staffB = await Staff.create({
      name: "Org B Staff",
      phone: "+919999999908",
      email: "staffb@parlour.test",
      organizationId: orgB._id,
      userId: userB._id,
      designation: "Stylist",
      staffCode: "STF-B",
      joiningDate: new Date(),
    });

    staffA = await Staff.create({
      name: "Org A Staff",
      phone: "+919999999909",
      email: "staffa@parlour.test",
      organizationId: orgA._id,
      userId: managerA._id,
      designation: "Stylist",
      staffCode: "STF-A",
      joiningDate: new Date(),
    });

    await Staff.create({
      name: "Org A Restricted Staff",
      phone: "+919999999910",
      email: "staffrestricted@parlour.test",
      organizationId: orgA._id,
      userId: restrictedA._id,
      designation: "Receptionist",
      staffCode: "STF-R",
      joiningDate: new Date(),
    });

    await Staff.create({
      name: "Org A First Login Staff",
      phone: "+919999999913",
      email: "stafffirstlogin@parlour.test",
      organizationId: orgA._id,
      userId: firstLoginA._id,
      designation: "Receptionist",
      staffCode: "STF-FL",
      joiningDate: new Date(),
    });

    // Logins to obtain tokens
    const loginOwner = await request(app).post("/api/v1/auth/login").send({ email: "owner@parlour.com", password: "Password@123" });
    ownerToken = loginOwner.body.data.accessToken;

    const loginManager = await request(app).post("/api/v1/auth/login").send({ email: "manager@parlour.com", password: "Password@123" });
    managerToken = loginManager.body.data.accessToken;

    const loginRestricted = await request(app).post("/api/v1/auth/login").send({ email: "e2e-restricted@parlour.test", password: "Password@123" });
    restrictedToken = loginRestricted.body.data.accessToken;
  });

  afterAll(async () => {
    await User.deleteMany({});
    await Role.deleteMany({});
    await Organization.deleteMany({});
    await Branch.deleteMany({});
    await Staff.deleteMany({});
    await Session.deleteMany({});
    await Permission.deleteMany({});
    await mongoose.connection.close();
  });

  describe("Restricted RBAC User Denials", () => {
    it("should return 403 for users.view", async () => {
      const res = await request(app).get("/api/v1/users").set("Authorization", `Bearer ${restrictedToken}`);
      expect(res.status).toBe(403);
    });

    it("should return 403 for users.create", async () => {
      const res = await request(app).post("/api/v1/users").set("Authorization", `Bearer ${restrictedToken}`).send({
        name: "New User",
        email: "newuser@parlour.test",
        phone: "+919999999990",
        roleId: managerRole._id,
      });
      expect(res.status).toBe(403);
    });

    it("should return 403 for users.update", async () => {
      const res = await request(app).patch(`/api/v1/users/${restrictedA._id}`).set("Authorization", `Bearer ${restrictedToken}`).send({
        name: "Restricted Name Update",
      });
      expect(res.status).toBe(403);
    });

    it("should return 403 for staff.edit / employees.update", async () => {
      const res = await request(app).put(`/api/v1/staff/${staffA._id}`).set("Authorization", `Bearer ${restrictedToken}`).send({
        designation: "Senior Stylist",
      });
      expect(res.status).toBe(403);
    });
  });

  describe("Cross-Tenant Isolation", () => {
    it("should return 404 when Org A manager requests Org B user", async () => {
      const res = await request(app).get(`/api/v1/users/${userB._id}`).set("Authorization", `Bearer ${managerToken}`);
      expect(res.status).toBe(404);
    });

    it("should return 404 when Org A manager attempts to update Org B user status", async () => {
      const res = await request(app).patch(`/api/v1/users/${userB._id}/status`).set("Authorization", `Bearer ${managerToken}`).send({
        status: "inactive",
      });
      expect(res.status).toBe(404);
    });

    it("should return 404 when Org A manager attempts to link Org B staff", async () => {
      const res = await request(app).post(`/api/v1/staff/${staffB._id}/user`).set("Authorization", `Bearer ${managerToken}`).send({
        userId: userB._id.toString(),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("Locked User Recovery", () => {
    it("should transition locked -> active successfully and clear lock info", async () => {
      const res = await request(app).patch(`/api/v1/users/${lockedA._id}/status`).set("Authorization", `Bearer ${managerToken}`).send({
        status: "active",
      });
      expect(res.status).toBe(200);

      const dbUser = await User.findById(lockedA._id);
      expect(dbUser.status).toBe("active");
      expect(dbUser.failedLoginAttempts).toBe(0);
      expect(dbUser.lockUntil).toBeNull();
    });
  });

  describe("Session Invalidation Scenarios", () => {
    it("active -> inactive invalidates active sessions", async () => {
      // Login first to establish session
      const loginRes = await request(app).post("/api/v1/auth/login").send({ email: "manager@parlour.com", password: "Password@123" });
      const tempToken = loginRes.body.data.accessToken;

      // Status change active -> inactive
      const res = await request(app).patch(`/api/v1/users/${managerA._id}/status`).set("Authorization", `Bearer ${ownerToken}`).send({
        status: "inactive",
      });
      expect(res.status).toBe(200);

      // Verify that requesting with tempToken is now rejected (returns 403 because user status is inactive)
      const authCheck = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${tempToken}`);
      expect(authCheck.status).toBe(403);

      // Restore user to active
      await request(app).patch(`/api/v1/users/${managerA._id}/status`).set("Authorization", `Bearer ${ownerToken}`).send({
        status: "active",
      });
    });

    it("active -> suspended invalidates active sessions", async () => {
      const loginRes = await request(app).post("/api/v1/auth/login").send({ email: "manager@parlour.com", password: "Password@123" });
      const tempToken = loginRes.body.data.accessToken;

      // Status change active -> suspended
      const res = await request(app).patch(`/api/v1/users/${managerA._id}/status`).set("Authorization", `Bearer ${ownerToken}`).send({
        status: "suspended",
      });
      expect(res.status).toBe(200);

      // Verify that requesting with tempToken is now rejected (returns 403 because user status is suspended)
      const authCheck = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${tempToken}`);
      expect(authCheck.status).toBe(403);

      // Restore user to active
      await request(app).patch(`/api/v1/users/${managerA._id}/status`).set("Authorization", `Bearer ${ownerToken}`).send({
        status: "active",
      });
    });
  });

  describe("Owner Protection Enforcement", () => {
    it("should prevent setting owner status to inactive", async () => {
      const res = await request(app).patch(`/api/v1/users/${ownerA._id}/status`).set("Authorization", `Bearer ${ownerToken}`).send({
        status: "inactive",
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain("Organization owner cannot be deactivated or suspended.");
    });

    it("should prevent setting owner status to suspended", async () => {
      const res = await request(app).patch(`/api/v1/users/${ownerA._id}/status`).set("Authorization", `Bearer ${ownerToken}`).send({
        status: "suspended",
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain("Organization owner cannot be deactivated or suspended.");
    });
  });

  describe("Staff ↔ User Linkage Safeguards", () => {
    it("should prevent linking user that is already linked to another staff", async () => {
      // Link userA to staffA first
      await request(app).post(`/api/v1/staff/${staffA._id}/user`).set("Authorization", `Bearer ${managerToken}`).send({
        userId: managerA._id.toString(),
      });

      // Create a second staff
      const staffA2 = await Staff.create({
        name: "Org A Staff 2",
        phone: "+919999999988",
        email: "staffa2@parlour.test",
        organizationId: orgA._id,
        designation: "Stylist",
        staffCode: "STF-A2",
        joiningDate: new Date(),
      });

      // Try to link managerA to staffA2 (duplicate link attempt)
      const res = await request(app).post(`/api/v1/staff/${staffA2._id}/user`).set("Authorization", `Bearer ${managerToken}`).send({
        userId: managerA._id.toString(),
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain("User is already linked to another active Staff");

      // Cleanup
      await request(app).delete(`/api/v1/staff/${staffA._id}/user`).set("Authorization", `Bearer ${managerToken}`);
    });
  });

  describe("First-Login Activation Flow", () => {
    it("should enforce complete activation workflow with OTP verification", async () => {
      // 1. Temporary login (first-login user gets activation token)
      const loginRes = await request(app).post("/api/v1/auth/login").send({
        email: "e2e-first-login@parlour.test",
        password: "TempPassword123!",
      });
      expect(loginRes.status).toBe(200);
      expect(loginRes.body.data.requireActivation).toBe(true);
      const activationToken = loginRes.body.data.activationToken;
      expect(activationToken).toBeDefined();

      // Verify activation token cannot access normal authenticated APIs
      const meCheck = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${activationToken}`);
      expect(meCheck.status).toBe(401);

      // 2. OTP Send (Requires activation token in auth header)
      const sendRes = await request(app).post("/api/v1/auth/activate/otp/send").set("Authorization", `Bearer ${activationToken}`);
      expect(sendRes.status).toBe(200);

      // Capture and set known hashed OTP in DB for deterministic test
      const testOtp = "876283";
      const hashedOtp = crypto.createHash("sha256").update(testOtp).digest("hex");
      await User.findByIdAndUpdate(firstLoginA._id, { otp: hashedOtp, otpExpires: new Date(Date.now() + 5 * 60 * 1000) });

      // 3. Invalid OTP Verify (Requires activation token in auth header)
      const invalidVerifyRes = await request(app).post("/api/v1/auth/activate/otp/verify").set("Authorization", `Bearer ${activationToken}`).send({
        otp: "000000",
      });
      expect(invalidVerifyRes.status).toBe(400);

      // 4. Valid OTP Verify (returns password change token) (Requires activation token in auth header)
      const validVerifyRes = await request(app).post("/api/v1/auth/activate/otp/verify").set("Authorization", `Bearer ${activationToken}`).send({
        otp: testOtp,
      });
      expect(validVerifyRes.status).toBe(200);
      const passwordChangeToken = validVerifyRes.body.data.passwordChangeToken;
      expect(passwordChangeToken).toBeDefined();

      // Verify password change token cannot access normal authenticated APIs
      const meCheck2 = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${passwordChangeToken}`);
      expect(meCheck2.status).toBe(401);

      // 5. Change Password & Complete Activation (Requires password change token in auth header)
      const changePasswordRes = await request(app).post("/api/v1/auth/activate/change-password").set("Authorization", `Bearer ${passwordChangeToken}`).send({
        password: "NewSecurePassword123!",
      });
      expect(changePasswordRes.status).toBe(200);

      // 6. Normal login with new password
      const newLoginRes = await request(app).post("/api/v1/auth/login").send({
        email: "e2e-first-login@parlour.test",
        password: "NewSecurePassword123!",
      });
      expect(newLoginRes.status).toBe(200);
      expect(newLoginRes.body.data.accessToken).toBeDefined();
    });
  });

  describe("Mongoose Transaction Standalone Fallback", () => {
    it("should gracefully update user status under standalone MongoDB fallback", async () => {
      // Confirm topology description type is 'Single' for standalone test DB
      const topologyType = mongoose.connection.client?.topology?.description?.type;
      expect(topologyType).toBe("Single");

      // Verify status change triggers fallback logic without throwing MongoServerError
      const res = await request(app).patch(`/api/v1/users/${managerA._id}/status`).set("Authorization", `Bearer ${ownerToken}`).send({
        status: "inactive",
      });
      expect(res.status).toBe(200);
    });
  });
});
