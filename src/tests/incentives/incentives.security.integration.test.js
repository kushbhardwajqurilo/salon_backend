import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import request from "supertest";
import app from "../../../app.mjs";
import { env } from "../../config/env.js";
import { Branch } from "../../models/branches/branch.model.js";
import { AuditLog } from "../../models/audit/auditLog.model.js";
import { IncentiveLedger } from "../../models/incentives/incentiveLedger.model.js";
import { IncentiveScheme } from "../../models/incentives/incentiveScheme.model.js";
import { Organization } from "../../models/organizations/organization.model.js";
import { Permission } from "../../models/permissions/permission.model.js";
import { Role } from "../../models/roles/role.model.js";
import { Staff } from "../../models/staff/staff.model.js";
import { User } from "../../models/users/user.model.js";
import { ConnectionString } from "mongodb-connection-string-url";
import { getIsolatedTestMongoUri } from "../testSetup.js";

describe("Incentives authenticated scope integration", () => {
  jest.setTimeout(30000);
  const syntheticTestPassword = `disposable-${new mongoose.Types.ObjectId()}`;

  let organizationA;
  let organizationB;
  let branchA1;
  let branchA2;
  let branchB;
  let employee;
  let manager;
  let owner;
  let deniedUser;
  let ownStaff;
  let peerA1;
  let peerA2;
  let peerB;
  let schemeA;
  let schemeB;
  let employeeToken;
  let managerToken;
  let ownerToken;
  let deniedToken;

  const tokenFor = (user) => jwt.sign({ id: user._id }, env.JWT_SECRET, { expiresIn: "1h" });

  const createStaff = (organizationId, suffix, userId = null) => {
    const identity = new mongoose.Types.ObjectId().toString();
    return Staff.create({
      name: `Scope ${suffix}`,
      phone: `+91${identity.slice(-10)}`,
      email: `scope_${suffix}_${identity}@test.com`,
      organizationId,
      userId,
      designation: "Stylist",
      status: "active",
      staffCode: `SC-${suffix}-${identity.slice(-6)}`,
      joiningDate: new Date(),
    });
  };

  const createLedgerEntry = (organizationId, branchId, staffId, amount, key) =>
    IncentiveLedger.create({
      organizationId,
      branchId,
      staffId,
      schemeId: String(organizationId) === String(organizationA._id) ? schemeA._id : schemeB._id,
      entryType: "ACCRUAL",
      settlementEventId: new mongoose.Types.ObjectId(),
      invoiceId: new mongoose.Types.ObjectId(),
      lineItemId: new mongoose.Types.ObjectId(),
      sourceRevenueInPaise: amount,
      attributedRevenueInPaise: amount,
      amountInPaise: amount,
      idempotencyKey: key,
    });

  beforeAll(async () => {
    const mongoUri = getIsolatedTestMongoUri("incentives_test");
    if (
      !process.env.TEST_MONGO_RUN_DATABASE ||
      decodeURIComponent(new ConnectionString(mongoUri).pathname.replace(/^\//, "")) !==
        process.env.TEST_MONGO_RUN_DATABASE
    ) {
      throw new Error("The integration test did not receive its exact disposable database authorization.");
    }
    await mongoose.connect(mongoUri);

    organizationA = await Organization.create({ name: "Scope Organization A" });
    organizationB = await Organization.create({ name: "Scope Organization B" });
    [branchA1, branchA2, branchB] = await Branch.create([
      { organizationId: organizationA._id, name: "Scope A1" },
      { organizationId: organizationA._id, name: "Scope A2" },
      { organizationId: organizationB._id, name: "Scope B1" },
    ]);

    const [viewPermission, viewAllPermission, managePermission] = await Promise.all([
      Permission.findOneAndUpdate(
        { name: "incentives.view" },
        { name: "incentives.view", module: "Incentives", action: "View", description: "View incentives" },
        { upsert: true, returnDocument: "after" }
      ),
      Permission.findOneAndUpdate(
        { name: "incentives.view.all" },
        { name: "incentives.view.all", module: "Incentives", action: "View all", description: "View all incentives" },
        { upsert: true, returnDocument: "after" }
      ),
      Permission.findOneAndUpdate(
        { name: "incentives.rules.manage" },
        { name: "incentives.rules.manage", module: "Incentives", action: "Manage rules", description: "Manage incentive rules" },
        { upsert: true, returnDocument: "after" }
      ),
    ]);

    const [employeeRole, managerRole, ownerRole, emptyOwnerRole] = await Role.create([
      { organizationId: organizationA._id, name: "scope_employee", permissions: [viewPermission._id] },
      { organizationId: organizationA._id, name: "scope_manager", permissions: [viewPermission._id, viewAllPermission._id, managePermission._id] },
      { organizationId: organizationA._id, name: "scope_owner", permissions: [viewPermission._id, viewAllPermission._id, managePermission._id] },
      { organizationId: organizationA._id, name: "owner", permissions: [] },
    ]);

    const userSuffix = new mongoose.Types.ObjectId().toString();
    [employee, manager, owner, deniedUser] = await User.create([
      {
        name: "Scope Employee",
        email: `employee_${userSuffix}@test.com`,
        phone: `+918${userSuffix.slice(-10)}`,
        password: syntheticTestPassword,
        organizationId: organizationA._id,
        role: employeeRole._id,
        branchAccess: [{ branchId: branchA1._id, branchName: branchA1.name, isActive: true }],
      },
      {
        name: "Scope Manager",
        email: `manager_${userSuffix}@test.com`,
        phone: `+917${userSuffix.slice(-10)}`,
        password: syntheticTestPassword,
        organizationId: organizationA._id,
        role: managerRole._id,
        branchAccess: [{ branchId: branchA1._id, branchName: branchA1.name, isActive: true }],
      },
      {
        name: "Scope Owner",
        email: `owner_${userSuffix}@test.com`,
        phone: `+916${userSuffix.slice(-10)}`,
        password: syntheticTestPassword,
        organizationId: organizationA._id,
        role: ownerRole._id,
        hasOrgWideAccess: true,
      },
      {
        name: "Empty Permission Owner",
        email: `empty_${userSuffix}@test.com`,
        phone: `+915${userSuffix.slice(-10)}`,
        password: syntheticTestPassword,
        organizationId: organizationA._id,
        role: emptyOwnerRole._id,
      },
    ]);

    [ownStaff, peerA1, peerA2] = await Promise.all([
      createStaff(organizationA._id, "own", employee._id),
      createStaff(organizationA._id, "peer-a1"),
      createStaff(organizationA._id, "peer-a2"),
    ]);
    peerB = await createStaff(organizationB._id, "peer-b");

    schemeA = await IncentiveScheme.create({
      organizationId: organizationA._id,
      name: "Scope Commission",
      code: `SCOPE_${userSuffix.slice(-8)}`,
      schemeType: "COMMISSION",
      calculationBasis: "SERVICE_NET_REVENUE",
      rules: { tiers: [{ minPaise: 0, maxPaise: null, percentage: 10 }] },
      status: "active",
    });
    schemeB = await IncentiveScheme.create({
      organizationId: organizationB._id,
      name: "Other Organization Commission",
      code: `OTHER_${userSuffix.slice(-8)}`,
      schemeType: "COMMISSION",
      calculationBasis: "SERVICE_NET_REVENUE",
      rules: { tiers: [{ minPaise: 0, maxPaise: null, percentage: 10 }] },
      status: "active",
    });

    await Promise.all([
      createLedgerEntry(organizationA._id, branchA1._id, ownStaff._id, 111, "scope-own-a1"),
      createLedgerEntry(organizationA._id, branchA1._id, peerA1._id, 222, "scope-peer-a1"),
      createLedgerEntry(organizationA._id, branchA2._id, ownStaff._id, 444, "scope-own-a2"),
      createLedgerEntry(organizationA._id, branchA2._id, peerA2._id, 333, "scope-peer-a2"),
      createLedgerEntry(organizationB._id, branchB._id, peerB._id, 555, "scope-peer-b"),
    ]);

    employeeToken = tokenFor(employee);
    managerToken = tokenFor(manager);
    ownerToken = tokenFor(owner);
    deniedToken = tokenFor(deniedUser);
  });

  afterAll(async () => {
    if (organizationA?._id && organizationB?._id) {
      await Promise.all([
        AuditLog.deleteMany({ organizationId: { $in: [organizationA._id, organizationB._id] } }),
        IncentiveLedger.deleteMany({ organizationId: { $in: [organizationA._id, organizationB._id] } }),
        IncentiveScheme.deleteMany({ organizationId: { $in: [organizationA._id, organizationB._id] } }),
        Staff.deleteMany({ organizationId: { $in: [organizationA._id, organizationB._id] } }),
        User.deleteMany({ organizationId: { $in: [organizationA._id, organizationB._id] } }),
        Role.deleteMany({ organizationId: { $in: [organizationA._id, organizationB._id] } }),
        Branch.deleteMany({ organizationId: { $in: [organizationA._id, organizationB._id] } }),
        Organization.deleteMany({ _id: { $in: [organizationA._id, organizationB._id] } }),
      ]);
    }
    await mongoose.connection.close();
  });

  it("limits an employee to their own staff record and accessible branch despite manipulated IDs", async () => {
    const response = await request(app)
      .get(`/api/v1/incentives/ledger?staffId=${peerA1._id}&branchId=${branchA1._id}`)
      .set("Authorization", `Bearer ${employeeToken}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(String(response.body.data[0].staffId._id)).toBe(String(ownStaff._id));
    expect(response.body.data[0].amountInPaise).toBe(111);

    const otherBranch = await request(app)
      .get(`/api/v1/incentives/ledger?branchId=${branchA2._id}`)
      .set("Authorization", `Bearer ${employeeToken}`);
    expect(otherBranch.status).toBe(200);
    expect(otherBranch.body.data).toHaveLength(0);
  });

  it("limits a branch manager to their assigned branches, including explicit branch filters", async () => {
    const defaultScope = await request(app)
      .get("/api/v1/incentives/ledger")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(defaultScope.status).toBe(200);
    expect(defaultScope.body.data.map((entry) => entry.amountInPaise).sort((a, b) => a - b)).toEqual([111, 222]);

    const manipulatedBranch = await request(app)
      .get(`/api/v1/incentives/ledger?branchId=${branchA2._id}`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(manipulatedBranch.status).toBe(200);
    expect(manipulatedBranch.body.data).toHaveLength(0);
  });

  it("filters summary metrics by an authorized branch and rejects inaccessible branches", async () => {
    const branchSummary = await request(app)
      .get(`/api/v1/incentives/summary?branchId=${branchA1._id}`)
      .set("Authorization", `Bearer ${managerToken}`);

    expect(branchSummary.status).toBe(200);
    expect(branchSummary.body.data.totalAccruedPaise).toBe(333);

    const inaccessibleBranch = await request(app)
      .get(`/api/v1/incentives/summary?branchId=${branchA2._id}`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(inaccessibleBranch.status).toBe(403);

    const ownerBranchSummary = await request(app)
      .get(`/api/v1/incentives/summary?branchId=${branchA2._id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(ownerBranchSummary.status).toBe(200);
    expect(ownerBranchSummary.body.data.totalAccruedPaise).toBe(777);
  });

  it("allows an explicitly authorized owner organization-wide access without crossing organizations", async () => {
    const allBranches = await request(app)
      .get("/api/v1/incentives/ledger")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(allBranches.status).toBe(200);
    expect(allBranches.body.data.map((entry) => entry.amountInPaise).sort((a, b) => a - b))
      .toEqual([111, 222, 333, 444]);

    const otherOrganizationBranch = await request(app)
      .get(`/api/v1/incentives/ledger?branchId=${branchB._id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(otherOrganizationBranch.status).toBe(200);
    expect(otherOrganizationBranch.body.data).toHaveLength(0);
  });

  it("denies empty permissions even when the role is named owner", async () => {
    const response = await request(app)
      .get("/api/v1/incentives/ledger")
      .set("Authorization", `Bearer ${deniedToken}`);
    expect(response.status).toBe(403);
  });

  it("rejects employee and manager preview scope manipulation", async () => {
    const employeeOtherStaff = await request(app)
      .post("/api/v1/incentives/preview")
      .set("Authorization", `Bearer ${employeeToken}`)
      .send({ staffId: peerA1._id, branchId: branchA1._id, revenueInPaise: 10000 });
    expect(employeeOtherStaff.status).toBe(403);

    const employeeOtherBranch = await request(app)
      .post("/api/v1/incentives/preview")
      .set("Authorization", `Bearer ${employeeToken}`)
      .send({ staffId: ownStaff._id, branchId: branchA2._id, revenueInPaise: 10000 });
    expect(employeeOtherBranch.status).toBe(403);

    const managerOtherBranch = await request(app)
      .post("/api/v1/incentives/preview")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ staffId: peerA2._id, branchId: branchA2._id, revenueInPaise: 10000 });
    expect(managerOtherBranch.status).toBe(403);

    const managerMissingBranch = await request(app)
      .post("/api/v1/incentives/preview")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ staffId: peerA1._id, revenueInPaise: 10000 });
    expect(managerMissingBranch.status).toBe(400);
  });

  it("audits scheme creation under the authenticated manager ID and ignores client tenant/actor fields", async () => {
    const response = await request(app)
      .post("/api/v1/incentives/schemes")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({
        name: "Authenticated Audit Scheme",
        code: `AUDIT_${new mongoose.Types.ObjectId().toString().slice(-8)}`,
        schemeType: "COMMISSION",
        calculationBasis: "SERVICE_NET_REVENUE",
        organizationId: organizationB._id,
        createdBy: deniedUser._id,
      });

    expect(response.status).toBe(201);
    expect(String(response.body.data.organizationId)).toBe(String(organizationA._id));
    expect(String(response.body.data.createdBy)).toBe(String(manager._id));
    const audit = await AuditLog.findOne({
      organizationId: organizationA._id,
      action: "INCENTIVE_SCHEME_CREATED",
      entityId: new mongoose.Types.ObjectId(response.body.data._id),
    }).lean();
    expect(audit).toBeTruthy();
    expect(String(audit.actorId)).toBe(String(manager._id));
  });
});
