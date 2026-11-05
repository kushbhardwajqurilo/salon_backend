import { describe, expect, it, beforeEach, afterEach, jest, beforeAll, afterAll } from "@jest/globals";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app.mjs";
import { Organization } from "../../models/organizations/organization.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Customer } from "../../models/customers/customer.model.js";
import { Service } from "../../models/services/service.model.js";
import { ServiceCategory } from "../../models/services/serviceCategory.model.js";
import { Role } from "../../models/roles/role.model.js";
import { Permission } from "../../models/permissions/permission.model.js";
import { User } from "../../models/users/user.model.js";
import { Subscription } from "../../models/subscriptions/subscription.model.js";
import { SubscriptionPlan } from "../../models/subscriptions/subscriptionPlan.model.js";
import { SubscriptionUsage } from "../../models/subscriptions/subscriptionUsage.model.js";
import { AuditLog } from "../../models/audit/auditLog.model.js";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";
import { redis } from "../../utils/redis.js";

jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");

describe("Subscription Listing - Customer, Payer, and Beneficiary Filters Regression Tests", () => {
  jest.setTimeout(45000);

  let orgA, orgB;
  let branchA1, branchA2, branchB1;
  let ownerTokenA, ownerTokenB;
  let customerPayer, customerBeneficiary1, customerBeneficiary2, customerUnrelated;
  let serviceHairCut;
  let category;

  beforeAll(async () => {
    process.env.ALLOW_STANDALONE_TRANSACTION_FALLBACK = "true";
    const testUri = process.env.TEST_MONGO_URI || "mongodb://127.0.0.1:27017/saloon_erp_sub_listing_test";
    await mongoose.connect(testUri);
  });

  afterAll(async () => {
    await SubscriptionUsage.deleteMany({});
    await Subscription.deleteMany({});
    await SubscriptionPlan.deleteMany({});
    await AuditLog.deleteMany({});
    await Service.deleteMany({});
    await ServiceCategory.deleteMany({});
    await Customer.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Permission.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await SubscriptionUsage.deleteMany({});
    await Subscription.deleteMany({});
    await SubscriptionPlan.deleteMany({});
    await AuditLog.deleteMany({});
    await Service.deleteMany({});
    await ServiceCategory.deleteMany({});
    await Customer.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Permission.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});

    // 1. Setup Organizations
    orgA = await Organization.create({
      name: "Listing Test Org A",
      status: "active",
      currency: "INR",
      timezone: "Asia/Kolkata",
    });

    orgB = await Organization.create({
      name: "Listing Test Org B",
      status: "active",
      currency: "INR",
      timezone: "Asia/Kolkata",
    });

    // 2. Branches
    branchA1 = await Branch.create({
      organizationId: orgA._id,
      name: "Org A Downtown",
      address: "101 Downtown Ave, Mumbai, MH, 400001, India",
      phone: "+919800000011",
      isActive: true,
    });

    branchA2 = await Branch.create({
      organizationId: orgA._id,
      name: "Org A Uptown",
      address: "202 Uptown Ave, Mumbai, MH, 400002, India",
      phone: "+919800000012",
      isActive: true,
    });

    branchB1 = await Branch.create({
      organizationId: orgB._id,
      name: "Org B Branch 1",
      address: "303 Other Ave, Mumbai, MH, 400003, India",
      phone: "+919800000013",
      isActive: true,
    });

    // 3. Permissions & Roles
    const permissionNames = [
      "subscriptions.sell",
      "subscriptions.view",
      "subscriptions.configure",
      "subscriptions.redeem",
    ];

    const permissions = await Permission.insertMany(
      permissionNames.map((name) => ({
        name,
        displayName: name,
        module: name.split(".")[0],
        action: name.split(".")[1],
        description: `Permission for ${name}`,
      }))
    );

    const roleA = await Role.create({
      organizationId: orgA._id,
      name: "Owner A",
      isCustom: false,
      permissions: permissions.map((p) => p._id),
    });

    const roleB = await Role.create({
      organizationId: orgB._id,
      name: "Owner B",
      isCustom: false,
      permissions: permissions.map((p) => p._id),
    });

    // 4. Users & Tokens
    const ownerA = await User.create({
      organizationId: orgA._id,
      name: "Owner A User",
      email: `ownera_${Date.now()}@test.com`,
      phone: "+919820000001",
      password: "HashedPassword123!",
      role: roleA._id,
      hasOrgWideAccess: true,
      status: "active",
    });

    ownerTokenA = jwt.sign(
      {
        id: ownerA._id.toString(),
        userId: ownerA._id.toString(),
        organizationId: orgA._id.toString(),
        role: "owner",
        hasOrgWideAccess: true,
      },
      env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    const ownerB = await User.create({
      organizationId: orgB._id,
      name: "Owner B User",
      email: `ownerb_${Date.now()}@test.com`,
      phone: "+919820000002",
      password: "HashedPassword123!",
      role: roleB._id,
      hasOrgWideAccess: true,
      status: "active",
    });

    ownerTokenB = jwt.sign(
      {
        id: ownerB._id.toString(),
        userId: ownerB._id.toString(),
        organizationId: orgB._id.toString(),
        role: "owner",
        hasOrgWideAccess: true,
      },
      env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    // 5. Customers
    customerPayer = await Customer.create({
      organizationId: orgA._id,
      homeBranchId: branchA1._id,
      name: "Payer Customer",
      phone: "+919811111111",
      email: "payer@customer.com",
    });

    customerBeneficiary1 = await Customer.create({
      organizationId: orgA._id,
      homeBranchId: branchA1._id,
      name: "Beneficiary 1",
      phone: "+919822222222",
      email: "ben1@customer.com",
    });

    customerBeneficiary2 = await Customer.create({
      organizationId: orgA._id,
      homeBranchId: branchA1._id,
      name: "Beneficiary 2",
      phone: "+919833333333",
      email: "ben2@customer.com",
    });

    customerUnrelated = await Customer.create({
      organizationId: orgA._id,
      homeBranchId: branchA1._id,
      name: "Unrelated Customer",
      phone: "+919844444444",
      email: "unrelated@customer.com",
    });

    // 6. Service & Category
    category = await ServiceCategory.create({
      organizationId: orgA._id,
      name: "Hair Care",
    });

    serviceHairCut = await Service.create({
      organizationId: orgA._id,
      categoryId: category._id,
      name: "Hair Cut",
      price: 500,
      pricing: { basePrice: 500 },
      duration: 30,
      status: "active",
      isActive: true,
    });
  });

  it("1. Payer receives their subscriptions when querying customerId", async () => {
    // Create shared subscription where customerPayer is payerCustomerId and customerBeneficiary1 is member
    const sub = await Subscription.create({
      organizationId: orgA._id,
      payerCustomerId: customerPayer._id,
      customerId: customerPayer._id,
      subscriptionCode: "SUB-PAYER-01",
      price: 2000,
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-12-31"),
      status: "active",
      permittedBranchIds: [branchA1._id],
      members: [
        {
          customerId: customerBeneficiary1._id,
          status: "active",
          permittedBranchIds: [branchA1._id],
          entitlements: [
            {
              serviceId: serviceHairCut._id,
              serviceName: "Hair Cut",
              totalQuantity: 5,
              usedQuantity: 0,
              remainingQuantity: 5,
            },
          ],
        },
      ],
    });

    const res = await request(app)
      .get(`/api/v1/subscriptions?customerId=${customerPayer._id}`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("x-branch-id", branchA1._id.toString());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]._id.toString()).toBe(sub._id.toString());
  });

  it("2. Beneficiary receives subscriptions purchased by another customer", async () => {
    const sub = await Subscription.create({
      organizationId: orgA._id,
      payerCustomerId: customerPayer._id,
      customerId: customerPayer._id,
      subscriptionCode: "SUB-BEN-01",
      price: 2000,
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-12-31"),
      status: "active",
      permittedBranchIds: [branchA1._id],
      members: [
        {
          customerId: customerBeneficiary1._id,
          status: "active",
          permittedBranchIds: [branchA1._id],
          entitlements: [
            {
              serviceId: serviceHairCut._id,
              serviceName: "Hair Cut",
              totalQuantity: 5,
              usedQuantity: 0,
              remainingQuantity: 5,
            },
          ],
        },
      ],
    });

    const res = await request(app)
      .get(`/api/v1/subscriptions?customerId=${customerBeneficiary1._id}`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("x-branch-id", branchA1._id.toString());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]._id.toString()).toBe(sub._id.toString());
  });

  it("3. Different beneficiaries receive the same shared subscription", async () => {
    const sharedSub = await Subscription.create({
      organizationId: orgA._id,
      payerCustomerId: customerPayer._id,
      customerId: customerPayer._id,
      subscriptionCode: "SUB-SHARED-01",
      price: 4000,
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-12-31"),
      status: "active",
      permittedBranchIds: [branchA1._id],
      members: [
        {
          customerId: customerBeneficiary1._id,
          status: "active",
          permittedBranchIds: [branchA1._id],
          entitlements: [
            {
              serviceId: serviceHairCut._id,
              serviceName: "Hair Cut",
              totalQuantity: 5,
              usedQuantity: 0,
              remainingQuantity: 5,
            },
          ],
        },
        {
          customerId: customerBeneficiary2._id,
          status: "active",
          permittedBranchIds: [branchA1._id],
          entitlements: [
            {
              serviceId: serviceHairCut._id,
              serviceName: "Hair Cut",
              totalQuantity: 5,
              usedQuantity: 0,
              remainingQuantity: 5,
            },
          ],
        },
      ],
    });

    const res1 = await request(app)
      .get(`/api/v1/subscriptions?customerId=${customerBeneficiary1._id}`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("x-branch-id", branchA1._id.toString());

    expect(res1.status).toBe(200);
    expect(res1.body.data).toHaveLength(1);
    expect(res1.body.data[0]._id.toString()).toBe(sharedSub._id.toString());

    const res2 = await request(app)
      .get(`/api/v1/subscriptions?customerId=${customerBeneficiary2._id}`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("x-branch-id", branchA1._id.toString());

    expect(res2.status).toBe(200);
    expect(res2.body.data).toHaveLength(1);
    expect(res2.body.data[0]._id.toString()).toBe(sharedSub._id.toString());
  });

  it("4. A customer who is both payer and member does not receive duplicate records", async () => {
    await Subscription.create({
      organizationId: orgA._id,
      payerCustomerId: customerPayer._id,
      customerId: customerPayer._id,
      subscriptionCode: "SUB-DUAL-01",
      price: 2000,
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-12-31"),
      status: "active",
      permittedBranchIds: [branchA1._id],
      members: [
        {
          customerId: customerPayer._id,
          status: "active",
          permittedBranchIds: [branchA1._id],
          entitlements: [
            {
              serviceId: serviceHairCut._id,
              serviceName: "Hair Cut",
              totalQuantity: 5,
              usedQuantity: 0,
              remainingQuantity: 5,
            },
          ],
        },
        {
          customerId: customerBeneficiary1._id,
          status: "active",
          permittedBranchIds: [branchA1._id],
          entitlements: [
            {
              serviceId: serviceHairCut._id,
              serviceName: "Hair Cut",
              totalQuantity: 5,
              usedQuantity: 0,
              remainingQuantity: 5,
            },
          ],
        },
      ],
    });

    const res = await request(app)
      .get(`/api/v1/subscriptions?customerId=${customerPayer._id}`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("x-branch-id", branchA1._id.toString());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta.total).toBe(1);
  });

  it("5. A customer with no association receives no subscriptions", async () => {
    await Subscription.create({
      organizationId: orgA._id,
      payerCustomerId: customerPayer._id,
      customerId: customerPayer._id,
      subscriptionCode: "SUB-UNRELATED-01",
      price: 2000,
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-12-31"),
      status: "active",
      permittedBranchIds: [branchA1._id],
      members: [
        {
          customerId: customerBeneficiary1._id,
          status: "active",
          permittedBranchIds: [branchA1._id],
          entitlements: [
            {
              serviceId: serviceHairCut._id,
              serviceName: "Hair Cut",
              totalQuantity: 5,
              usedQuantity: 0,
              remainingQuantity: 5,
            },
          ],
        },
      ],
    });

    const res = await request(app)
      .get(`/api/v1/subscriptions?customerId=${customerUnrelated._id}`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("x-branch-id", branchA1._id.toString());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.meta.total).toBe(0);
  });

  it("6. Multiple subscriptions are returned correctly with pagination", async () => {
    // Create 3 subscriptions for beneficiary1
    for (let i = 1; i <= 3; i++) {
      await Subscription.create({
        organizationId: orgA._id,
        payerCustomerId: customerPayer._id,
        customerId: customerPayer._id,
        subscriptionCode: `SUB-PAGE-0${i}`,
        price: 1000 * i,
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        status: "active",
        permittedBranchIds: [branchA1._id],
        members: [
          {
            customerId: customerBeneficiary1._id,
            status: "active",
            permittedBranchIds: [branchA1._id],
            entitlements: [
              {
                serviceId: serviceHairCut._id,
                serviceName: "Hair Cut",
                totalQuantity: 2,
                usedQuantity: 0,
                remainingQuantity: 2,
              },
            ],
          },
        ],
      });
    }

    const page1Res = await request(app)
      .get(`/api/v1/subscriptions?customerId=${customerBeneficiary1._id}&page=1&limit=2`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("x-branch-id", branchA1._id.toString());

    expect(page1Res.status).toBe(200);
    expect(page1Res.body.data).toHaveLength(2);
    expect(page1Res.body.meta.page).toBe(1);
    expect(page1Res.body.meta.limit).toBe(2);
    expect(page1Res.body.meta.total).toBe(3);
    expect(page1Res.body.meta.totalPages).toBe(2);

    const page2Res = await request(app)
      .get(`/api/v1/subscriptions?customerId=${customerBeneficiary1._id}&page=2&limit=2`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("x-branch-id", branchA1._id.toString());

    expect(page2Res.status).toBe(200);
    expect(page2Res.body.data).toHaveLength(1);
    expect(page2Res.body.meta.page).toBe(2);
    expect(page2Res.body.meta.total).toBe(3);
  });

  it("7. Total count is accurate with filters", async () => {
    await Subscription.create({
      organizationId: orgA._id,
      payerCustomerId: customerPayer._id,
      customerId: customerPayer._id,
      subscriptionCode: "SUB-COUNT-01",
      price: 1000,
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-12-31"),
      status: "active",
      permittedBranchIds: [],
      members: [
        {
          customerId: customerBeneficiary1._id,
          status: "active",
          permittedBranchIds: [],
          entitlements: [
            {
              serviceId: serviceHairCut._id,
              serviceName: "Hair Cut",
              totalQuantity: 2,
              usedQuantity: 0,
              remainingQuantity: 2,
            },
          ],
        },
      ],
    });

    await Subscription.create({
      organizationId: orgA._id,
      payerCustomerId: customerBeneficiary1._id,
      customerId: customerBeneficiary1._id,
      subscriptionCode: "SUB-COUNT-02",
      price: 1500,
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-12-31"),
      status: "active",
      permittedBranchIds: [],
      members: [
        {
          customerId: customerBeneficiary1._id,
          status: "active",
          permittedBranchIds: [],
          entitlements: [
            {
              serviceId: serviceHairCut._id,
              serviceName: "Hair Cut",
              totalQuantity: 3,
              usedQuantity: 0,
              remainingQuantity: 3,
            },
          ],
        },
      ],
    });

    const res = await request(app)
      .get(`/api/v1/subscriptions?customerId=${customerBeneficiary1._id}`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("x-branch-id", branchA1._id.toString());

    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(2);
    expect(res.body.data).toHaveLength(2);
  });

  it("8. Status filtering works with beneficiary filtering", async () => {
    await Subscription.create({
      organizationId: orgA._id,
      payerCustomerId: customerPayer._id,
      customerId: customerPayer._id,
      subscriptionCode: "SUB-STATUS-ACT",
      price: 1000,
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-12-31"),
      status: "active",
      permittedBranchIds: [],
      members: [
        {
          customerId: customerBeneficiary1._id,
          status: "active",
          permittedBranchIds: [],
          entitlements: [
            {
              serviceId: serviceHairCut._id,
              serviceName: "Hair Cut",
              totalQuantity: 2,
              usedQuantity: 0,
              remainingQuantity: 2,
            },
          ],
        },
      ],
    });

    await Subscription.create({
      organizationId: orgA._id,
      payerCustomerId: customerPayer._id,
      customerId: customerPayer._id,
      subscriptionCode: "SUB-STATUS-EXP",
      price: 1000,
      startDate: new Date("2025-01-01"),
      endDate: new Date("2025-12-31"),
      status: "expired",
      permittedBranchIds: [],
      members: [
        {
          customerId: customerBeneficiary1._id,
          status: "exhausted",
          permittedBranchIds: [],
          entitlements: [
            {
              serviceId: serviceHairCut._id,
              serviceName: "Hair Cut",
              totalQuantity: 2,
              usedQuantity: 2,
              remainingQuantity: 0,
            },
          ],
        },
      ],
    });

    const activeRes = await request(app)
      .get(`/api/v1/subscriptions?customerId=${customerBeneficiary1._id}&status=active`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("x-branch-id", branchA1._id.toString());

    expect(activeRes.status).toBe(200);
    expect(activeRes.body.data).toHaveLength(1);
    expect(activeRes.body.data[0].subscriptionCode).toBe("SUB-STATUS-ACT");

    const expiredRes = await request(app)
      .get(`/api/v1/subscriptions?customerId=${customerBeneficiary1._id}&status=expired`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("x-branch-id", branchA1._id.toString());

    expect(expiredRes.status).toBe(200);
    expect(expiredRes.body.data).toHaveLength(1);
    expect(expiredRes.body.data[0].subscriptionCode).toBe("SUB-STATUS-EXP");
  });

  it("9. Branch filtering works with beneficiary filtering", async () => {
    // sub1 is only for branchA1
    await Subscription.create({
      organizationId: orgA._id,
      payerCustomerId: customerPayer._id,
      customerId: customerPayer._id,
      subscriptionCode: "SUB-BRANCH-A1",
      price: 1000,
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-12-31"),
      status: "active",
      permittedBranchIds: [branchA1._id],
      members: [
        {
          customerId: customerBeneficiary1._id,
          status: "active",
          permittedBranchIds: [branchA1._id],
          entitlements: [
            {
              serviceId: serviceHairCut._id,
              serviceName: "Hair Cut",
              totalQuantity: 2,
              usedQuantity: 0,
              remainingQuantity: 2,
            },
          ],
        },
      ],
    });

    // sub2 is only for branchA2
    await Subscription.create({
      organizationId: orgA._id,
      payerCustomerId: customerPayer._id,
      customerId: customerPayer._id,
      subscriptionCode: "SUB-BRANCH-A2",
      price: 1000,
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-12-31"),
      status: "active",
      permittedBranchIds: [branchA2._id],
      members: [
        {
          customerId: customerBeneficiary1._id,
          status: "active",
          permittedBranchIds: [branchA2._id],
          entitlements: [
            {
              serviceId: serviceHairCut._id,
              serviceName: "Hair Cut",
              totalQuantity: 2,
              usedQuantity: 0,
              remainingQuantity: 2,
            },
          ],
        },
      ],
    });

    // sub3 is all branches
    await Subscription.create({
      organizationId: orgA._id,
      payerCustomerId: customerPayer._id,
      customerId: customerPayer._id,
      subscriptionCode: "SUB-BRANCH-ALL",
      price: 1000,
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-12-31"),
      status: "active",
      permittedBranchIds: [],
      members: [
        {
          customerId: customerBeneficiary1._id,
          status: "active",
          permittedBranchIds: [],
          entitlements: [
            {
              serviceId: serviceHairCut._id,
              serviceName: "Hair Cut",
              totalQuantity: 2,
              usedQuantity: 0,
              remainingQuantity: 2,
            },
          ],
        },
      ],
    });

    // Filter by branchA1: should return SUB-BRANCH-A1 and SUB-BRANCH-ALL (2 total)
    const branch1Res = await request(app)
      .get(`/api/v1/subscriptions?customerId=${customerBeneficiary1._id}&branchId=${branchA1._id}`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("x-branch-id", branchA1._id.toString());

    expect(branch1Res.status).toBe(200);
    expect(branch1Res.body.data).toHaveLength(2);
    const codes1 = branch1Res.body.data.map((s) => s.subscriptionCode);
    expect(codes1).toContain("SUB-BRANCH-A1");
    expect(codes1).toContain("SUB-BRANCH-ALL");
    expect(codes1).not.toContain("SUB-BRANCH-A2");

    // Filter by branchA2: should return SUB-BRANCH-A2 and SUB-BRANCH-ALL (2 total)
    const branch2Res = await request(app)
      .get(`/api/v1/subscriptions?customerId=${customerBeneficiary1._id}&branchId=${branchA2._id}`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("x-branch-id", branchA2._id.toString());

    expect(branch2Res.status).toBe(200);
    expect(branch2Res.body.data).toHaveLength(2);
    const codes2 = branch2Res.body.data.map((s) => s.subscriptionCode);
    expect(codes2).toContain("SUB-BRANCH-A2");
    expect(codes2).toContain("SUB-BRANCH-ALL");
    expect(codes2).not.toContain("SUB-BRANCH-A1");
  });

  it("10. Organization isolation prevents cross-tenant subscription access", async () => {
    // Create subscription in orgB
    const customerOrgB = await Customer.create({
      organizationId: orgB._id,
      homeBranchId: branchB1._id,
      name: "Customer in Org B",
      phone: "+919999999999",
      email: "orgb@customer.com",
    });

    await Subscription.create({
      organizationId: orgB._id,
      payerCustomerId: customerOrgB._id,
      customerId: customerOrgB._id,
      subscriptionCode: "SUB-ORGB-01",
      price: 2500,
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-12-31"),
      status: "active",
      permittedBranchIds: [branchB1._id],
      members: [
        {
          customerId: customerOrgB._id,
          status: "active",
          permittedBranchIds: [branchB1._id],
          entitlements: [
            {
              serviceId: serviceHairCut._id,
              serviceName: "Hair Cut",
              totalQuantity: 2,
              usedQuantity: 0,
              remainingQuantity: 2,
            },
          ],
        },
      ],
    });

    // Query from orgA owner using customerOrgB id
    const resA = await request(app)
      .get(`/api/v1/subscriptions?customerId=${customerOrgB._id}`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("x-branch-id", branchA1._id.toString());

    expect(resA.status).toBe(200);
    expect(resA.body.data).toHaveLength(0);
    expect(resA.body.meta.total).toBe(0);

    // Query from orgB owner using customerOrgB id
    const resB = await request(app)
      .get(`/api/v1/subscriptions?customerId=${customerOrgB._id}`)
      .set("Authorization", `Bearer ${ownerTokenB}`)
      .set("x-branch-id", branchB1._id.toString());

    expect(resB.status).toBe(200);
    expect(resB.body.data).toHaveLength(1);
    expect(resB.body.data[0].subscriptionCode).toBe("SUB-ORGB-01");
  });

  it("11. Soft-deleted subscriptions are excluded", async () => {
    const activeSub = await Subscription.create({
      organizationId: orgA._id,
      payerCustomerId: customerPayer._id,
      customerId: customerPayer._id,
      subscriptionCode: "SUB-DELETED-NO",
      price: 1000,
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-12-31"),
      status: "active",
      isDeleted: false,
      permittedBranchIds: [],
      members: [
        {
          customerId: customerBeneficiary1._id,
          status: "active",
          permittedBranchIds: [],
          entitlements: [
            {
              serviceId: serviceHairCut._id,
              serviceName: "Hair Cut",
              totalQuantity: 2,
              usedQuantity: 0,
              remainingQuantity: 2,
            },
          ],
        },
      ],
    });

    await Subscription.create({
      organizationId: orgA._id,
      payerCustomerId: customerPayer._id,
      customerId: customerPayer._id,
      subscriptionCode: "SUB-DELETED-YES",
      price: 1000,
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-12-31"),
      status: "active",
      isDeleted: true,
      deletedAt: new Date(),
      permittedBranchIds: [],
      members: [
        {
          customerId: customerBeneficiary1._id,
          status: "active",
          permittedBranchIds: [],
          entitlements: [
            {
              serviceId: serviceHairCut._id,
              serviceName: "Hair Cut",
              totalQuantity: 2,
              usedQuantity: 0,
              remainingQuantity: 2,
            },
          ],
        },
      ],
    });

    const res = await request(app)
      .get(`/api/v1/subscriptions?customerId=${customerBeneficiary1._id}`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("x-branch-id", branchA1._id.toString());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].subscriptionCode).toBe("SUB-DELETED-NO");
    expect(res.body.meta.total).toBe(1);
  });

  it("12. Verify existing legacy single-customer subscriptions remain compatible", async () => {
    const legacySub = await Subscription.create({
      organizationId: orgA._id,
      customerId: customerPayer._id,
      subscriptionCode: "SUB-LEGACY-01",
      price: 1500,
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-12-31"),
      status: "active",
      permittedBranchIds: [],
      entitlements: [
        {
          serviceId: serviceHairCut._id,
          serviceName: "Hair Cut",
          totalQuantity: 3,
          usedQuantity: 0,
          remainingQuantity: 3,
        },
      ],
    });

    const res = await request(app)
      .get(`/api/v1/subscriptions?customerId=${customerPayer._id}`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("x-branch-id", branchA1._id.toString());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].subscriptionCode).toBe("SUB-LEGACY-01");
    expect(res.body.data[0].entitlements).toBeDefined();
    expect(res.body.data[0].entitlements[0].remainingQuantity).toBe(3);
  });

  it("13. Dedicated payerId and memberId filters work as specified", async () => {
    // Sub 1: Payer is customerPayer, Beneficiary is customerBeneficiary1
    await Subscription.create({
      organizationId: orgA._id,
      payerCustomerId: customerPayer._id,
      customerId: customerPayer._id,
      subscriptionCode: "SUB-FILTER-01",
      price: 1500,
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-12-31"),
      status: "active",
      permittedBranchIds: [],
      members: [
        {
          customerId: customerBeneficiary1._id,
          status: "active",
          permittedBranchIds: [],
          entitlements: [
            {
              serviceId: serviceHairCut._id,
              serviceName: "Hair Cut",
              totalQuantity: 3,
              usedQuantity: 0,
              remainingQuantity: 3,
            },
          ],
        },
      ],
    });

    // Sub 2: Payer is customerBeneficiary1, Beneficiary is customerBeneficiary2
    await Subscription.create({
      organizationId: orgA._id,
      payerCustomerId: customerBeneficiary1._id,
      customerId: customerBeneficiary1._id,
      subscriptionCode: "SUB-FILTER-02",
      price: 2000,
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-12-31"),
      status: "active",
      permittedBranchIds: [],
      members: [
        {
          customerId: customerBeneficiary2._id,
          status: "active",
          permittedBranchIds: [],
          entitlements: [
            {
              serviceId: serviceHairCut._id,
              serviceName: "Hair Cut",
              totalQuantity: 2,
              usedQuantity: 0,
              remainingQuantity: 2,
            },
          ],
        },
      ],
    });

    // payerId=customerBeneficiary1 -> Should only return SUB-FILTER-02 (purchased by customerBeneficiary1)
    const payerRes = await request(app)
      .get(`/api/v1/subscriptions?payerId=${customerBeneficiary1._id}`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("x-branch-id", branchA1._id.toString());

    expect(payerRes.status).toBe(200);
    expect(payerRes.body.data).toHaveLength(1);
    expect(payerRes.body.data[0].subscriptionCode).toBe("SUB-FILTER-02");

    // memberId=customerBeneficiary1 -> Should only return SUB-FILTER-01 (customerBeneficiary1 is enrolled member)
    const memberRes = await request(app)
      .get(`/api/v1/subscriptions?memberId=${customerBeneficiary1._id}`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("x-branch-id", branchA1._id.toString());

    expect(memberRes.status).toBe(200);
    expect(memberRes.body.data).toHaveLength(1);
    expect(memberRes.body.data[0].subscriptionCode).toBe("SUB-FILTER-01");

    // customerId=customerBeneficiary1 -> Should return BOTH SUB-FILTER-01 and SUB-FILTER-02
    const customerRes = await request(app)
      .get(`/api/v1/subscriptions?customerId=${customerBeneficiary1._id}`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("x-branch-id", branchA1._id.toString());

    expect(customerRes.status).toBe(200);
    expect(customerRes.body.data).toHaveLength(2);
    const codes = customerRes.body.data.map((s) => s.subscriptionCode);
    expect(codes).toContain("SUB-FILTER-01");
    expect(codes).toContain("SUB-FILTER-02");
  });
});
