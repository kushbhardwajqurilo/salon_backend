import { describe, expect, it, beforeAll, afterAll, beforeEach, jest } from "@jest/globals";
import mongoose from "mongoose";
import request from "supertest";
import { getIsolatedTestMongoUri } from "../testSetup.js";
import app from "../../../app.mjs";
import { Organization } from "../../models/organizations/organization.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { User } from "../../models/users/user.model.js";
import { Role } from "../../models/roles/role.model.js";
import { Permission } from "../../models/permissions/permission.model.js";
import { Staff } from "../../models/staff/staff.model.js";
import { StaffBranch } from "../../models/staff/staffBranch.model.js";
import { Invoice } from "../../models/billing/invoice.model.js";
import { Attendance } from "../../models/attendance/attendance.model.js";
import { AttendancePunch } from "../../models/attendance/attendancePunch.model.js";
import { ProviderConfiguration } from "../../models/attendance/ProviderConfiguration.model.js";
import { StaffDeviceMapping } from "../../models/attendance/StaffDeviceMapping.model.js";
import { AttendanceLeaveException } from "../../models/attendance/AttendanceLeaveException.model.js";
import { ingestProviderEvents } from "../../services/attendance/attendance.service.js";
import { adjustAttendanceRecord } from "../../services/attendance/attendance.service.js";
import { Leave } from "../../models/leaves/leave.model.js";
import {
  IncentiveScheme,
  IncentiveLedger,
  IncentiveEvaluation,
  IncentiveRecoveryObligation,
  SchemeAssignment,
  InvoiceSettlementEvent,
  ServiceFulfillmentEvent,
} from "../../models/incentives/index.js";
import jwt from "jsonwebtoken";

import { env } from "../../config/env.js";
import { schemeAssignmentService } from "../../services/incentives/schemeAssignment.service.js";

describe("Stage 5 — Incentives Configuration & API Foundation Suite", () => {
  jest.setTimeout(30000);
  const syntheticTestPassword = `disposable-${new mongoose.Types.ObjectId()}`;

  let orgId, branchId, staffId;
  let managerUser, managerToken;
  let unauthorizedUser, unauthorizedToken;

  const createAuthToken = (user) => {
    return jwt.sign(
      {
        id: user._id,
        userId: user._id,
        organizationId: user.organizationId,
        branchId: user.branchId,
        role: user.role,
      },
      env.JWT_SECRET,
      { expiresIn: "1h" }
    );
  };

  beforeAll(async () => {
    const mongoUri = getIsolatedTestMongoUri("incentives_test");
    await mongoose.connect(mongoUri);
    await Promise.all([
      Invoice.init(),
      InvoiceSettlementEvent.init(),
      ServiceFulfillmentEvent.init(),
      IncentiveLedger.init(),
    ]);

    orgId = new mongoose.Types.ObjectId();
    branchId = new mongoose.Types.ObjectId();
    await Branch.create({
      _id: branchId,
      organizationId: orgId,
      name: "Stage 5 Branch",
      isActive: true,
    });

    // 1. Setup Permissions & Roles
    const ruleManagePerm = await Permission.create({
      name: "incentives.rules.manage",
      module: "Incentives",
      action: "Manage Rules",
      description: "Manage rules description",
    });
    const viewAllPerm = await Permission.create({
      name: "incentives.view.all",
      module: "Incentives",
      action: "View All",
      description: "View all description",
    });
    const viewPerm = await Permission.create({
      name: "incentives.view",
      module: "Incentives",
      action: "View Own",
      description: "View own description",
    });
    const fulfillmentConfirmPerm = await Permission.create({
      name: "incentives.fulfillment.confirm",
      module: "Incentives",
      action: "Confirm Service Fulfillment",
      description: "Confirm walk-in service fulfillment",
    });
    const incentiveApprovePerm = await Permission.create({
      name: "incentives.approve",
      module: "Incentives",
      action: "Approve Incentive Payouts",
      description: "Approve attendance incentive evaluations",
    });

    const managerRole = await Role.create({
      name: "manager_stage5",
      organizationId: orgId,
      permissions: [
        ruleManagePerm._id,
        viewAllPerm._id,
        viewPerm._id,
        fulfillmentConfirmPerm._id,
        incentiveApprovePerm._id,
      ],
    });

    const unauthorizedRole = await Role.create({
      name: "basic_stage5",
      organizationId: orgId,
      permissions: [],
    });

    // 2. Setup Users
    managerUser = await User.create({
      name: "Manager User",
      email: `manager_${Date.now()}@test.com`,
      phone: "+919876543210",
      password: syntheticTestPassword,
      organizationId: orgId,
      branchId,
      branchAccess: [{ branchId, branchName: "Stage 5 Branch", isActive: true }],
      role: managerRole._id,
      status: "active",
    });
    managerToken = createAuthToken(managerUser);

    unauthorizedUser = await User.create({
      name: "Unauthorized User",
      email: `unauth_${Date.now()}@test.com`,
      phone: "+919876543211",
      password: syntheticTestPassword,
      organizationId: orgId,
      branchId,
      role: unauthorizedRole._id,
      status: "active",
    });
    unauthorizedToken = createAuthToken(unauthorizedUser);

    // 3. Setup Staff
    const staff = await Staff.create({
      name: "Senior Stylist 5",
      phone: `+919${Math.floor(100000000 + Math.random() * 900000000)}`,
      email: `stylist5_${Date.now()}@test.com`,
      designation: "Stylist",
      joiningDate: new Date(),
      organizationId: orgId,
      status: "active",
      staffCode: `STF5-${Date.now()}`,
    });
    staffId = staff._id;
  });

  afterAll(async () => {
    await Invoice.deleteMany({ organizationId: orgId });
    await InvoiceSettlementEvent.deleteMany({ organizationId: orgId });
    await ServiceFulfillmentEvent.deleteMany({ organizationId: orgId });
    await IncentiveEvaluation.deleteMany({ organizationId: orgId });
    await IncentiveLedger.deleteMany({});
    await Attendance.deleteMany({ organizationId: orgId });
    await AttendancePunch.deleteMany({ organizationId: orgId });
    await ProviderConfiguration.deleteMany({ organizationId: orgId });
    await StaffDeviceMapping.deleteMany({ organizationId: orgId });
    await AttendanceLeaveException.deleteMany({ organizationId: orgId });
    await Leave.deleteMany({ organizationId: orgId });
    await StaffBranch.deleteMany({ organizationId: orgId });
    await IncentiveRecoveryObligation.deleteMany({});
    await IncentiveScheme.deleteMany({});
    await SchemeAssignment.deleteMany({});
    await Branch.deleteMany({ _id: branchId });
    await Staff.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Permission.deleteMany({});
    await mongoose.connection.close();
  });

  describe("1. Route Authorization & Tenant Boundary", () => {
    it("rejects unauthenticated requests with 401", async () => {
      const res = await request(app).get("/api/v1/incentives/schemes");
      expect(res.status).toBe(401);
    });

    it("rejects unauthorized user lacking incentives permissions with 403", async () => {
      const res = await request(app)
        .post("/api/v1/incentives/schemes")
        .set("Authorization", `Bearer ${unauthorizedToken}`)
        .send({
          name: "Test Scheme",
          code: "TEST_SCHEME",
          schemeType: "COMMISSION",
          calculationBasis: "SERVICE_NET_REVENUE",
        });
      expect(res.status).toBe(403);
    });
  });

  describe("2. Scheme Lifecycle CRUD Endpoints", () => {
    let createdSchemeId;

    it("creates a new incentive scheme in draft status", async () => {
      const res = await request(app)
        .post("/api/v1/incentives/schemes")
        .set("Authorization", `Bearer ${managerToken}`)
        .send({
          name: "Festive Stylist Plan",
          code: `FESTIVE_${Date.now()}`,
          schemeType: "COMMISSION",
          calculationBasis: "SERVICE_NET_REVENUE",
          rules: {
            tiers: [
              { minPaise: 0, maxPaise: 100000, percentage: 5, fixedPaise: 0 },
              { minPaise: 100001, maxPaise: null, percentage: 10, fixedPaise: 1000 },
            ],
            fixedAmountPaise: 0,
          },
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe("draft");
      expect(res.body.data.name).toBe("Festive Stylist Plan");
      expect(res.body.data.rules.tiers[1].maxPaise).toBeNull();
      createdSchemeId = res.body.data._id;
    });

    it("rejects unsupported target rule updates to a service commission", async () => {
      const response = await request(app)
        .patch(`/api/v1/incentives/schemes/${createdSchemeId}`)
        .set("Authorization", `Bearer ${managerToken}`)
        .send({ rules: { targetThresholdPaise: 5000000 } });

      expect(response.status).toBe(400);
      const scheme = await IncentiveScheme.findById(createdSchemeId).lean();
      expect(scheme.rules.targetThresholdPaise).toBe(0);
    });

    it("creates an attendance bonus scheme with verified attendance rules", async () => {
      const code = `ATTENDANCE_${Date.now()}`;
      const response = await request(app)
        .post("/api/v1/incentives/schemes")
        .set("Authorization", `Bearer ${managerToken}`)
        .send({
          name: "Verified Attendance Bonus",
          code,
          schemeType: "ATTENDANCE_BONUS",
          calculationBasis: "ATTENDANCE_DAYS",
          rules: { minimumAttendanceDays: 20, fixedAmountPaise: 100000 },
        });

      expect(response.status).toBe(201);
      expect(response.body.data.schemeType).toBe("ATTENDANCE_BONUS");
      expect(response.body.data.calculationBasis).toBe("ATTENDANCE_DAYS");
      expect(response.body.data.rules.minimumAttendanceDays).toBe(20);
    });

    it.each([
      ["product commission", "COMMISSION", "PRODUCT_NET_REVENUE"],
      ["hybrid scheme", "HYBRID", "ATTENDANCE_DAYS"],
    ])("rejects unsupported %s schemes at creation", async (category, schemeType, calculationBasis) => {
      const code = `UNSUPPORTED_${category.toUpperCase()}_${Date.now()}`;
      const response = await request(app)
        .post("/api/v1/incentives/schemes")
        .set("Authorization", `Bearer ${managerToken}`)
        .send({
          name: "Unsupported Scheme",
          code,
          schemeType,
          calculationBasis,
        });

      expect(response.status).toBe(400);
      expect(await IncentiveScheme.countDocuments({ organizationId: orgId, code })).toBe(0);
    });

    it("rejects unsupported target and attendance rules on a service commission", async () => {
      const code = `UNSUPPORTED_RULES_${Date.now()}`;
      const response = await request(app)
        .post("/api/v1/incentives/schemes")
        .set("Authorization", `Bearer ${managerToken}`)
        .send({
          name: "Service Commission With Unsupported Rules",
          code,
          schemeType: "COMMISSION",
          calculationBasis: "SERVICE_NET_REVENUE",
          rules: {
            fixedAmountPaise: 0,
            tiers: [],
            targetThresholdPaise: 0,
            minimumAttendanceDays: 0,
          },
        });

      expect(response.status).toBe(400);
      expect(await IncentiveScheme.countDocuments({ organizationId: orgId, code })).toBe(0);
    });

    it("rejects a finite tier maximum below its minimum before persistence", async () => {
      const code = `INVALID_MAX_${Date.now()}`;
      const response = await request(app)
        .post("/api/v1/incentives/schemes")
        .set("Authorization", `Bearer ${managerToken}`)
        .send({
          name: "Invalid Tier Bound",
          code,
          schemeType: "COMMISSION",
          calculationBasis: "SERVICE_NET_REVENUE",
          rules: {
            tiers: [{ minPaise: 1000000, maxPaise: 0, percentage: 5 }],
          },
        });

      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/maxPaise must be greater than or equal to minPaise/i);
      expect(await IncentiveScheme.countDocuments({ organizationId: orgId, code })).toBe(0);
    });

    it("retrieves the created scheme by ID and lists schemes with pagination", async () => {
      const getRes = await request(app)
        .get(`/api/v1/incentives/schemes/${createdSchemeId}`)
        .set("Authorization", `Bearer ${managerToken}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.data._id).toBe(createdSchemeId);

      const listRes = await request(app)
        .get("/api/v1/incentives/schemes?page=1&limit=10")
        .set("Authorization", `Bearer ${managerToken}`);
      expect(listRes.status).toBe(200);
      expect(listRes.body.data.length).toBeGreaterThanOrEqual(1);
      expect(listRes.body.meta.total).toBeGreaterThanOrEqual(1);
    });

    it("activates, pauses, and archives a scheme following valid lifecycle transitions", async () => {
      // Activate
      const actRes = await request(app)
        .post(`/api/v1/incentives/schemes/${createdSchemeId}/activate`)
        .set("Authorization", `Bearer ${managerToken}`);
      expect(actRes.status).toBe(200);
      expect(actRes.body.data.status).toBe("active");

      // Pause
      const pauseRes = await request(app)
        .post(`/api/v1/incentives/schemes/${createdSchemeId}/pause`)
        .set("Authorization", `Bearer ${managerToken}`);
      expect(pauseRes.status).toBe(200);
      expect(pauseRes.body.data.status).toBe("paused");

      // Archive
      const archRes = await request(app)
        .post(`/api/v1/incentives/schemes/${createdSchemeId}/archive`)
        .set("Authorization", `Bearer ${managerToken}`);
      expect(archRes.status).toBe(200);
      expect(archRes.body.data.status).toBe("archived");

      // Modifications on archived scheme must fail
      const updateRes = await request(app)
        .patch(`/api/v1/incentives/schemes/${createdSchemeId}`)
        .set("Authorization", `Bearer ${managerToken}`)
        .send({ name: "Cannot Rename Archived" });
      expect(updateRes.status).toBe(400);
    });

    it("activates a valid attendance bonus scheme", async () => {
      const scheme = await IncentiveScheme.create({
        organizationId: orgId,
        name: "Unintegrated Attendance Bonus",
        code: `ATTENDANCE_${Date.now()}`,
        schemeType: "ATTENDANCE_BONUS",
        calculationBasis: "ATTENDANCE_DAYS",
        rules: { minimumAttendanceDays: 24, fixedAmountPaise: 100000 },
        status: "draft",
      });

      const response = await request(app)
        .post(`/api/v1/incentives/schemes/${scheme._id}/activate`)
        .set("Authorization", `Bearer ${managerToken}`);

      expect(response.status).toBe(200);
      expect((await IncentiveScheme.findById(scheme._id)).status).toBe("active");
    });
  });

  describe("3. Scheme Assignment Endpoints & Precedence Serialization", () => {
    let activeSchemeId;

    beforeAll(async () => {
      const scheme = await IncentiveScheme.create({
        organizationId: orgId,
        name: "Standard Commission 10%",
        code: `COMM10_${Date.now()}`,
        schemeType: "COMMISSION",
        calculationBasis: "SERVICE_NET_REVENUE",
        rules: {
          tiers: [{ minPaise: 0, maxPaise: null, percentage: 10, fixedPaise: 0 }],
        },
        status: "active",
      });
      activeSchemeId = scheme._id;
    });

    it("creates a scheme assignment under ScopeLock serialization", async () => {
      const res = await request(app)
        .post("/api/v1/incentives/assignments")
        .set("Authorization", `Bearer ${managerToken}`)
        .send({
          schemeId: activeSchemeId.toString(),
          scopeType: "STAFF",
          scopeId: staffId.toString(),
          startDate: "2026-01-01T00:00:00.000Z",
          priority: 5,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.scopeType).toBe("STAFF");
      expect(res.body.data.status).toBe("active");
    });

    it("rejects overlapping interval assignment for the same staff scope (HTTP 409)", async () => {
      const duplicateRes = await request(app)
        .post("/api/v1/incentives/assignments")
        .set("Authorization", `Bearer ${managerToken}`)
        .send({
          schemeId: activeSchemeId.toString(),
          scopeType: "STAFF",
          scopeId: staffId.toString(),
          startDate: "2026-06-01T00:00:00.000Z",
          priority: 5,
        });

      expect(duplicateRes.status).toBe(409);
      expect(duplicateRes.body.message).toMatch(/conflict|overlap/i);
    });

    it("rejects role assignments because the active scheme resolver does not support role scope", async () => {
      const response = await request(app)
        .post("/api/v1/incentives/assignments")
        .set("Authorization", `Bearer ${managerToken}`)
        .send({
          schemeId: activeSchemeId.toString(),
          scopeType: "ROLE",
          scopeId: staffId.toString(),
          startDate: "2026-01-01T00:00:00.000Z",
        });

      expect(response.status).toBe(400);
      expect(await SchemeAssignment.countDocuments({
        organizationId: orgId,
        scopeType: "ROLE",
      })).toBe(0);
    });

    it("assigns an active attendance bonus scheme", async () => {
      const unsupportedScheme = await IncentiveScheme.create({
        organizationId: orgId,
        name: "Unintegrated Attendance Bonus",
        code: `ATTENDANCE_ASSIGN_${Date.now()}`,
        schemeType: "ATTENDANCE_BONUS",
        calculationBasis: "ATTENDANCE_DAYS",
        rules: { minimumAttendanceDays: 24, fixedAmountPaise: 100000 },
        status: "active",
      });

      const response = await request(app)
        .post("/api/v1/incentives/assignments")
        .set("Authorization", `Bearer ${managerToken}`)
        .send({
          schemeId: unsupportedScheme._id.toString(),
          scopeType: "BRANCH",
          scopeId: branchId.toString(),
          startDate: "2026-01-01T00:00:00.000Z",
        });

      expect(response.status).toBe(201);
      expect(await SchemeAssignment.countDocuments({ schemeId: unsupportedScheme._id })).toBe(1);
    });

    it("allows independent service, subscription-sale, and membership-sale assignments for one staff scope", async () => {
      const categoryStaff = await Staff.create({
        name: "Multi-category Seller",
        phone: `+919${Math.floor(100000000 + Math.random() * 900000000)}`,
        email: `multi_category_${Date.now()}@test.com`,
        designation: "Consultant",
        joiningDate: new Date(),
        organizationId: orgId,
        status: "active",
        staffCode: `MULTI-${Date.now()}`,
      });
      const categories = [
        "SERVICE_NET_REVENUE",
        "SUBSCRIPTION_NET_REVENUE",
        "MEMBERSHIP_NET_REVENUE",
      ];
      const startDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const schemes = [];

      for (const calculationBasis of categories) {
        const scheme = await IncentiveScheme.create({
          organizationId: orgId,
          name: `${calculationBasis} scheme`,
          code: `${calculationBasis}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          schemeType: "COMMISSION",
          calculationBasis,
          rules: {
            tiers: [{ minPaise: 0, maxPaise: null, percentage: 5, fixedPaise: 0 }],
          },
          status: "active",
        });
        schemes.push(scheme);

        const response = await request(app)
          .post("/api/v1/incentives/assignments")
          .set("Authorization", `Bearer ${managerToken}`)
          .send({
            schemeId: scheme._id.toString(),
            scopeType: "STAFF",
            scopeId: categoryStaff._id.toString(),
            startDate: startDate.toISOString(),
          });
        expect(response.status).toBe(201);
      }

      for (let index = 0; index < categories.length; index += 1) {
        const assignment = await schemeAssignmentService.resolveActiveAssignment({
          organizationId: orgId,
          staffId: categoryStaff._id,
          branchId,
          calculationBasis: categories[index],
          effectiveDate: new Date(),
        });
        expect(assignment.schemeId.toString()).toBe(schemes[index]._id.toString());
      }

      const duplicateResponse = await request(app)
        .post("/api/v1/incentives/assignments")
        .set("Authorization", `Bearer ${managerToken}`)
        .send({
          schemeId: schemes[1]._id.toString(),
          scopeType: "STAFF",
          scopeId: categoryStaff._id.toString(),
          startDate: startDate.toISOString(),
        });
      expect(duplicateResponse.status).toBe(409);
    });

    it("lists active assignments with populated scheme details", async () => {
      const listRes = await request(app)
        .get(`/api/v1/incentives/assignments?scopeType=STAFF&scopeId=${staffId}`)
        .set("Authorization", `Bearer ${managerToken}`);

      expect(listRes.status).toBe(200);
      expect(listRes.body.data.length).toBe(1);
      expect(listRes.body.data[0].schemeId.code).toMatch(/^COMM10_/);
    });
  });

  describe("4. Live Incentive Calculation Preview Endpoint", () => {
    it("previews commission accurately given revenue and staffId using resolved scheme", async () => {
      const res = await request(app)
        .post("/api/v1/incentives/preview")
        .set("Authorization", `Bearer ${managerToken}`)
        .send({
          staffId: staffId.toString(),
          branchId: branchId.toString(),
          revenueInPaise: 500000, // ₹5,000 at 10% = 50,000 paise (₹500)
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.inputRevenueInPaise).toBe(500000);
      expect(res.body.data.earnedCommissionInPaise).toBe(50000);
      expect(res.body.data.snapshot.appliedRate).toBe(10);
    });
  });

  describe("5. Recovery Reporting Contract", () => {
    it("returns persisted recovery fields and distinguishes reserved from recovered paise", async () => {
      const invoiceId = new mongoose.Types.ObjectId();
      const settlementEventId = new mongoose.Types.ObjectId();
      const ledgerEntry = await IncentiveLedger.create({
        organizationId: orgId,
        branchId,
        staffId,
        schemeId: new mongoose.Types.ObjectId(),
        entryType: "CLAWBACK",
        settlementEventId,
        invoiceId,
        lineItemId: new mongoose.Types.ObjectId(),
        fulfillmentStatus: "confirmed",
        sourceRevenueInPaise: 10000,
        attributedRevenueInPaise: 10000,
        amountInPaise: 10000,
        idempotencyKey: `RECOVERY-REPORT-${Date.now()}`,
      });

      await IncentiveRecoveryObligation.create({
        organizationId: orgId,
        branchId,
        staffId,
        clawbackLedgerId: ledgerEntry._id,
        originalClawbackInPaise: 10000,
        totalReservedInPaise: 3000,
        totalRecoveredInPaise: 0,
        status: "pending",
      });

      const listRes = await request(app)
        .get("/api/v1/incentives/recovery-obligations?status=pending")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchId.toString());

      expect(listRes.status).toBe(200);
      expect(listRes.body.data).toHaveLength(1);
      expect(listRes.body.data[0].originalClawbackInPaise).toBe(10000);
      expect(listRes.body.data[0].totalReservedInPaise).toBe(3000);
      expect(listRes.body.data[0].totalRecoveredInPaise).toBe(0);
      expect(listRes.body.data[0].remainingAvailableInPaise).toBe(7000);
      expect(listRes.body.data[0].clawbackLedgerId.invoiceId).toBe(invoiceId.toString());

      const summaryRes = await request(app)
        .get("/api/v1/incentives/summary")
        .set("Authorization", `Bearer ${managerToken}`);

      expect(summaryRes.status).toBe(200);
      expect(summaryRes.body.data.outstandingRecoveryPaise).toBe(10000);
    });
  });

  describe("6. Walk-in Fulfillment Gates and Pending Summary", () => {
    it("reports paid unfulfilled service lines without earnings and accepts idempotent confirmation", async () => {
      const invoiceId = new mongoose.Types.ObjectId();
      const lineItemId = new mongoose.Types.ObjectId();
      const invoice = await Invoice.create({
        _id: invoiceId,
        organizationId: orgId,
        branchId,
        invoiceNumber: `INV-PENDING-${Date.now()}`,
        invoiceType: "retail",
        customerId: new mongoose.Types.ObjectId(),
        customerSnapshot: { name: "Test Customer", phone: "+919000000000" },
        lines: [{
          _id: lineItemId,
          lineType: "service",
          serviceType: "registered",
          serviceId: new mongoose.Types.ObjectId(),
          staffId,
          name: "Unfulfilled walk-in service",
          duration: 30,
          quantity: 1,
          unitPrice: 1000,
          lineTotal: 1000,
          isCoveredBySubscription: false,
          subscriptionCoveredAmount: 0,
          discountAmount: 0,
          customerPayable: 1000,
        }],
        subtotal: 1000,
        discountTotal: 0,
        grossPayable: 1000,
        subscriptionCoveredAmount: 0,
        payableAmount: 1000,
        amountPaid: 1000,
        amountDue: 0,
        status: "finalized",
        paymentStatus: "paid",
        createdBy: managerUser._id,
      });
      await InvoiceSettlementEvent.create({
        organizationId: orgId,
        branchId,
        invoiceId: invoice._id,
        paymentId: new mongoose.Types.ObjectId(),
        eventType: "SETTLED",
        settlementCycle: 1,
        grossAmountInPaise: 100000,
        discountAmountInPaise: 0,
        taxAmountInPaise: 0,
        netSettledInPaise: 100000,
        lineItems: [{
          itemId: lineItemId,
          itemType: "service",
          name: "Unfulfilled walk-in service",
          priceInPaise: 100000,
          discountInPaise: 0,
          netRevenueInPaise: 100000,
          staffAttributions: [{
            staffId,
            splitPercentage: 100,
            attributedPaise: 100000,
          }],
        }],
        idempotencyKey: `SETTLE:PENDING:${invoice._id}`,
        eventTimestamp: new Date(),
      });

      expect(await IncentiveLedger.countDocuments({
        organizationId: orgId,
        invoiceId: invoice._id,
        entryType: "ACCRUAL",
      })).toBe(0);
      const pendingSummary = await request(app)
        .get("/api/v1/incentives/summary")
        .set("Authorization", `Bearer ${managerToken}`);
      expect(pendingSummary.status).toBe(200);
      expect(pendingSummary.body.data.pendingFulfillmentCount).toBe(1);

      const confirm = () => request(app)
        .post("/api/v1/incentives/fulfillment/confirm")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          invoiceId: invoice._id.toString(),
          lineIds: [lineItemId.toString()],
          reason: "Walk-in service performed",
        });
      const firstConfirmation = await confirm();
      expect(firstConfirmation.status).toBe(200);
      const retryConfirmation = await confirm();
      expect(retryConfirmation.status).toBe(200);
      expect(await ServiceFulfillmentEvent.countDocuments({
        organizationId: orgId,
        invoiceId: invoice._id,
        lineItemId,
      })).toBe(1);

      const clearedSummary = await request(app)
        .get("/api/v1/incentives/summary")
        .set("Authorization", `Bearer ${managerToken}`);
      expect(clearedSummary.status).toBe(200);
      expect(clearedSummary.body.data.pendingFulfillmentCount).toBe(0);
    });

    describe("7. Biometric attendance incentive accrual", () => {
      it("blocks incomplete punches, then accrues once from verified attendance and audited leave handling", async () => {
        const attendanceStaff = await Staff.create({
          name: "Attendance Bonus Staff",
          phone: `+919${Math.floor(100000000 + Math.random() * 900000000)}`,
          email: `attendance_${Date.now()}@test.com`,
          designation: "Stylist",
          joiningDate: new Date("2025-01-01T00:00:00.000Z"),
          organizationId: orgId,
          status: "active",
          staffCode: `ATT-${Date.now()}`,
        });
        await StaffBranch.create({
          organizationId: orgId,
          branchId,
          staffId: attendanceStaff._id,
          isActive: true,
          isPrimary: true,
        });
        const schemeResponse = await request(app)
          .post("/api/v1/incentives/schemes")
          .set("Authorization", `Bearer ${managerToken}`)
          .send({
            name: "Attendance Accrual",
            code: `ATT_ACCRUAL_${Date.now()}`,
            schemeType: "ATTENDANCE_BONUS",
            calculationBasis: "ATTENDANCE_DAYS",
            rules: { minimumAttendanceDays: 2, fixedAmountPaise: 100000 },
          });
        expect(schemeResponse.status).toBe(201);
        const schemeId = schemeResponse.body.data._id;

        const activation = await request(app)
          .post(`/api/v1/incentives/schemes/${schemeId}/activate`)
          .set("Authorization", `Bearer ${managerToken}`);
        expect(activation.status).toBe(200);
        const assignment = await request(app)
          .post("/api/v1/incentives/assignments")
          .set("Authorization", `Bearer ${managerToken}`)
          .send({
            schemeId,
            scopeType: "STAFF",
            scopeId: attendanceStaff._id.toString(),
            startDate: "2026-01-01T00:00:00.000Z",
          });
        expect(assignment.status).toBe(201);

        await ProviderConfiguration.create({
          organizationId: orgId,
          branchId,
          providerName: "simulator",
          isActive: true,
        });
        await StaffDeviceMapping.create({
          organizationId: orgId,
          branchId,
          provider: "simulator",
          deviceId: "attendance-device",
          externalEmployeeCode: attendanceStaff.staffCode,
          staffId: attendanceStaff._id,
          mappingStatus: "mapped",
          isActive: true,
          effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        });
        let checkpoint = 0;
        const ingest = (events) => ingestProviderEvents({
          providerName: "simulator",
          organizationId: orgId,
          branchId,
          actorId: managerUser._id,
          events,
          checkpoint: `attendance-incentive-${++checkpoint}`,
          streamIdentifier: "realtime",
          request: {},
        });
        const event = (date, punchType, id) => ({
          employeeCode: attendanceStaff.staffCode,
          deviceId: "attendance-device",
          punchType,
          punchAt: `${date}T${punchType === "in" ? "04:00:00" : "12:00:00"}.000Z`,
          externalEventId: id,
        });
        await ingest([
          event("2026-10-05", "in", "day-5-in"),
          event("2026-10-05", "out", "day-5-out"),
          event("2026-10-06", "in", "day-6-in"),
          event("2026-10-06", "out", "day-6-out"),
          event("2026-10-07", "in", "day-7-in"),
        ]);

        const compute = () => request(app)
          .post("/api/v1/incentives/attendance-evaluations/compute")
          .set("Authorization", `Bearer ${managerToken}`)
          .set("X-Branch-Id", branchId.toString())
          .send({
            staffId: attendanceStaff._id.toString(),
            schemeId,
            monthYear: "2026-10",
          });
        const incompleteEvaluation = await compute();
        expect(incompleteEvaluation.status).toBe(200);
        expect(incompleteEvaluation.body.data.blockReasons).toContain(
          "Attendance for 2026-10-07 is incomplete and requires reconciliation",
        );
        expect(await IncentiveLedger.countDocuments({
          organizationId: orgId,
          sourceType: "attendance_bonus",
        })).toBe(0);

        await ingest([
          event("2026-10-07", "in", "day-7-in"),
          event("2026-10-07", "out", "day-7-out"),
        ]);
        expect(await AttendancePunch.countDocuments({
          organizationId: orgId,
          staffId: attendanceStaff._id,
          punchAt: {
            $gte: new Date("2026-10-07T00:00:00.000Z"),
            $lt: new Date("2026-10-08T00:00:00.000Z"),
          },
        })).toBe(2);

        const partialLeaveId = new mongoose.Types.ObjectId();
        await Leave.create({
          _id: partialLeaveId,
          organizationId: orgId,
          branchId,
          staffId: attendanceStaff._id,
          leaveCode: `ATT-PARTIAL-${Date.now()}`,
          leaveType: "Personal Leave",
          startDate: new Date("2026-10-05T00:00:00.000Z"),
          endDate: new Date("2026-10-05T23:59:59.999Z"),
          dates: ["2026-10-05"],
          reason: "Half day leave",
          status: "approved",
          submittedBy: managerUser._id,
          submittedFor: "staff",
          isPartialDay: true,
        });
        await AttendanceLeaveException.create({
          organizationId: orgId,
          leaveId: partialLeaveId,
          resolvedDate: "2026-10-05",
          decision: "half-day",
          reason: "Half day confirmed",
          isActive: true,
          resolvedBy: managerUser._id,
          resolvedAt: new Date(),
        });
        await Leave.create({
          organizationId: orgId,
          branchId,
          staffId: attendanceStaff._id,
          leaveCode: `ATT-FULL-${Date.now()}`,
          leaveType: "Personal Leave",
          startDate: new Date("2026-10-06T00:00:00.000Z"),
          endDate: new Date("2026-10-06T23:59:59.999Z"),
          dates: ["2026-10-06"],
          reason: "Approved leave",
          status: "approved",
          submittedBy: managerUser._id,
          submittedFor: "staff",
          isPartialDay: false,
        });

        await Attendance.create({
          organizationId: orgId,
          branchId,
          staffId: attendanceStaff._id,
          attendanceDate: new Date("2026-10-08T00:00:00.000Z"),
          status: "incomplete",
        });
        await adjustAttendanceRecord({
          organizationId: orgId,
          branchId,
          actorId: managerUser._id,
          staffId: attendanceStaff._id,
          date: "2026-10-08",
          status: "present",
          reason: "Verified manual attendance correction",
        });

        const verifiedEvaluation = await compute();
        expect(verifiedEvaluation.status).toBe(200);
        expect(verifiedEvaluation.body.data.blockReasons).toEqual([]);
        expect(verifiedEvaluation.body.data.achievedDays).toBe(2.5);
        expect(verifiedEvaluation.body.data.isTargetMet).toBe(true);
        expect(verifiedEvaluation.body.data.attendanceSnapshot.days).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ date: "2026-10-05", creditedDays: 0.5 }),
            expect.objectContaining({ date: "2026-10-06", creditedDays: 0 }),
            expect.objectContaining({ date: "2026-10-08", creditedDays: 1 }),
          ]),
        );

        const finalize = () => request(app)
          .post(`/api/v1/incentives/attendance-evaluations/${verifiedEvaluation.body.data._id}/finalize`)
          .set("Authorization", `Bearer ${managerToken}`)
          .set("X-Branch-Id", branchId.toString());
        const finalized = await finalize();
        expect(finalized.status).toBe(200);
        expect(finalized.body.data.ledgerEntry.amountInPaise).toBe(100000);
        expect(finalized.body.data.ledgerEntry.sourceType).toBe("attendance_bonus");
        const retry = await finalize();
        expect(retry.status).toBe(200);
        expect(await IncentiveLedger.countDocuments({
          organizationId: orgId,
          sourceType: "attendance_bonus",
          evaluationId: verifiedEvaluation.body.data._id,
        })).toBe(1);
      });
    });
  });
});
