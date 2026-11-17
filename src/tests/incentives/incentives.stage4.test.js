import { describe, expect, it, beforeAll, afterAll, beforeEach, jest } from "@jest/globals";
import mongoose from "mongoose";
import { getIsolatedTestMongoUri } from "../testSetup.js";
import { IncentiveCalculationEngine } from "../../services/incentives/incentiveCalculation.engine.js";
import { schemeAssignmentService } from "../../services/incentives/schemeAssignment.service.js";
import { IncentiveScheme } from "../../models/incentives/incentiveScheme.model.js";
import { SchemeAssignment } from "../../models/incentives/schemeAssignment.model.js";
import { IncentiveLedger } from "../../models/incentives/incentiveLedger.model.js";
import { Staff } from "../../models/staff/staff.model.js";
import { AppError } from "../../utils/errors.js";

describe("Stage 4 — Incentive Calculation & Evaluation Engine Suite", () => {
  jest.setTimeout(30000);
  let orgId;
  let branchId;
  let staffId1;
  let staffId2;
  let staffId3;

  beforeAll(async () => {
    const mongoUri = getIsolatedTestMongoUri("incentives_test");
    await mongoose.connect(mongoUri);

    orgId = new mongoose.Types.ObjectId();
    branchId = new mongoose.Types.ObjectId();

    const staff1 = await Staff.create({
      name: "Stylist One",
      phone: `+919${Math.floor(100000000 + Math.random() * 900000000)}`,
      email: `stylist1_${Date.now()}@test.com`,
      designation: "Stylist",
      joiningDate: new Date(),
      organizationId: orgId,
      status: "active",
      staffCode: `STF4-1-${Date.now()}`,
    });
    staffId1 = staff1._id;

    const staff2 = await Staff.create({
      name: "Stylist Two",
      phone: `+919${Math.floor(100000000 + Math.random() * 900000000)}`,
      email: `stylist2_${Date.now()}@test.com`,
      designation: "Colorist",
      joiningDate: new Date(),
      organizationId: orgId,
      status: "active",
      staffCode: `STF4-2-${Date.now()}`,
    });
    staffId2 = staff2._id;

    const staff3 = await Staff.create({
      name: "Stylist Three",
      phone: `+919${Math.floor(100000000 + Math.random() * 900000000)}`,
      email: `stylist3_${Date.now()}@test.com`,
      designation: "Therapist",
      joiningDate: new Date(),
      organizationId: orgId,
      status: "active",
      staffCode: `STF4-3-${Date.now()}`,
    });
    staffId3 = staff3._id;
  });

  describe("1. Fixed, Percentage, and Tiered Commission Calculations", () => {
    it("rejects unsupported bonus categories and calculation bases as commissions", () => {
      expect(() =>
        IncentiveCalculationEngine.calculateCommission(
          {
            schemeType: "ATTENDANCE_BONUS",
            calculationBasis: "ATTENDANCE_DAYS",
            rules: { fixedAmountPaise: 100000 },
          },
          100000
        )
      ).toThrow(
        /Commission calculation supports only service, subscription-sale, membership-sale, or retail-sale net revenue schemes/
      );
    });

    it("evaluates fixed commission accurately regardless of revenue", () => {
      const scheme = {
        code: "FIXED_PLAN",
        calculationBasis: "SERVICE_NET_REVENUE",
        rules: {
          fixedAmountPaise: 50000, // ₹500 fixed
        },
      };

      const result = IncentiveCalculationEngine.calculateCommission(scheme, 250000);
      expect(result.earnedCommissionInPaise).toBe(50000);
      expect(result.snapshot.appliedRate).toBe(0);
      expect(result.snapshot.fixedAmountPaise).toBe(50000);
      expect(result.snapshot.schemeCode).toBe("FIXED_PLAN");
    });

    it("evaluates graduated tiers with half-up rounding in integer paise", () => {
      const scheme = {
        code: "GRADUATED_TIERS",
        calculationBasis: "SERVICE_NET_REVENUE",
        rules: {
          tiers: [
            { minPaise: 0, maxPaise: 100000, percentage: 5, fixedPaise: 0 }, // 0 to ₹1000: 5%
            { minPaise: 100001, maxPaise: 500000, percentage: 10, fixedPaise: 1000 }, // ₹1000.01 to ₹5000: 10% + ₹10
            { minPaise: 500001, maxPaise: null, percentage: 15, fixedPaise: 2500 }, // > ₹5000: 15% + ₹25
          ],
        },
      };

      // Case A: Within Tier 1 (₹500 revenue = 50,000 paise) -> 5% = 2,500 paise
      const res1 = IncentiveCalculationEngine.calculateCommission(scheme, 50000);
      expect(res1.earnedCommissionInPaise).toBe(2500);
      expect(res1.snapshot.appliedRate).toBe(5);
      expect(res1.snapshot.tierMinPaise).toBe(0);
      expect(res1.snapshot.tierMaxPaise).toBe(100000);

      // Case B: Boundary of Tier 1 (₹1000 = 100,000 paise) -> 5% = 5,000 paise
      const res2 = IncentiveCalculationEngine.calculateCommission(scheme, 100000);
      expect(res2.earnedCommissionInPaise).toBe(5000);

      // Case C: Transition into Tier 2 (₹2000 = 200,000 paise) -> 10% of 200,000 = 20,000 + 1,000 fixed = 21,000 paise
      const res3 = IncentiveCalculationEngine.calculateCommission(scheme, 200000);
      expect(res3.earnedCommissionInPaise).toBe(21000);
      expect(res3.snapshot.appliedRate).toBe(10);
      expect(res3.snapshot.tierMinPaise).toBe(100001);
      expect(res3.snapshot.tierMaxPaise).toBe(500000);

      // Case D: Top Tier open-ended (₹10,000 = 1,000,000 paise) -> 15% of 1,000,000 = 150,000 + 2,500 fixed = 152,500 paise
      const res4 = IncentiveCalculationEngine.calculateCommission(scheme, 1000000);
      expect(res4.earnedCommissionInPaise).toBe(152500);
      expect(res4.snapshot.appliedRate).toBe(15);
      expect(res4.snapshot.tierMaxPaise).toBeNull();
    });

    it("handles zero revenue, small fractional paise rounding, and upper bounds correctly", () => {
      const scheme = {
        code: "RATE_PLAN",
        rules: {
          tiers: [{ minPaise: 0, maxPaise: null, percentage: 12.5, fixedPaise: 0 }],
        },
      };

      // 0 revenue
      const resZero = IncentiveCalculationEngine.calculateCommission(scheme, 0);
      expect(resZero.earnedCommissionInPaise).toBe(0);

      // Revenue = 33 paise at 12.5% -> 33 * 0.125 = 4.125 paise -> rounds down to 4 paise
      const resSmallDown = IncentiveCalculationEngine.calculateCommission(scheme, 33);
      expect(resSmallDown.earnedCommissionInPaise).toBe(4);

      // Revenue = 36 paise at 12.5% -> 36 * 0.125 = 4.5 paise -> half-up rounds to 5 paise
      const resSmallUp = IncentiveCalculationEngine.calculateCommission(scheme, 36);
      expect(resSmallUp.earnedCommissionInPaise).toBe(5);

      // Rejects negative or non-integer revenue
      expect(() => IncentiveCalculationEngine.calculateCommission(scheme, -100)).toThrow(AppError);
      expect(() => IncentiveCalculationEngine.calculateCommission(scheme, 10.5)).toThrow(AppError);

      // Enforces maximum safe financial limit (₹100 Crore = 10^13 paise)
      expect(() => IncentiveCalculationEngine.calculateCommission(scheme, 10_000_000_000_001)).toThrow(AppError);
    });
  });

  describe("2. Multi-Staff Hamilton-Hare Largest Remainder Allocation", () => {
    it("allocates indivisible odd-paise pool with zero leakage and exact sum invariant", () => {
      // Scenario: ₹100 (10,000 paise) pool split equally 3 ways: 33.33%, 33.33%, 33.34%
      // Exact math:
      // Staff 1 (33.33%): 3,333 paise, remainder 0.33
      // Staff 2 (33.33%): 3,333 paise, remainder 0.33
      // Staff 3 (33.34%): 3,334 paise, remainder 0.34
      // Total floor = 3333 + 3333 + 3334 = 10,000 paise. Undistributed = 0 paise.
      const staffList = [
        { staffId: staffId1, splitPercentage: 33.33 },
        { staffId: staffId2, splitPercentage: 33.33 },
        { staffId: staffId3, splitPercentage: 33.34 },
      ];

      const allocations = IncentiveCalculationEngine.allocateLargestRemainder(10000, staffList);
      expect(allocations.length).toBe(3);

      const sumPaise = allocations.reduce((acc, cur) => acc + cur.allocatedPaise, 0);
      expect(sumPaise).toBe(10000); // 0 paise leak

      expect(allocations.find((a) => a.staffId === staffId3.toString()).allocatedPaise).toBe(3334);
    });

    it("distributes fractional remainders using deterministic staffId tie-breaking", () => {
      // Scenario: ₹10 (1000 paise) split 50% - 50% on an odd pool: 1001 paise
      // Pool = 1001 paise.
      // Staff 1 (50%): floor 500 paise, remainder 5000/10000 (0.5)
      // Staff 2 (50%): floor 500 paise, remainder 5000/10000 (0.5)
      // Undistributed = 1001 - 1000 = 1 paise.
      // Both have identical fractionalRemainder (5000). Tie-breaking by staffId ASC string:
      const idA = "507f191e810c19729de860ea";
      const idB = "507f191e810c19729de860eb";

      const staffList = [
        { staffId: idB, splitPercentage: 50 },
        { staffId: idA, splitPercentage: 50 },
      ];

      const allocations = IncentiveCalculationEngine.allocateLargestRemainder(1001, staffList);
      const sumPaise = allocations.reduce((acc, cur) => acc + cur.allocatedPaise, 0);
      expect(sumPaise).toBe(1001);

      // idA is lexicographically smaller than idB -> idA gets the extra +1 paise
      const allocA = allocations.find((a) => a.staffId === idA);
      const allocB = allocations.find((a) => a.staffId === idB);
      expect(allocA.allocatedPaise).toBe(501);
      expect(allocB.allocatedPaise).toBe(500);
    });

    it("safely handles 0 pool and rejects non-100% split totals", () => {
      const staffList = [
        { staffId: staffId1, splitPercentage: 50 },
        { staffId: staffId2, splitPercentage: 50 },
      ];

      const zeroAlloc = IncentiveCalculationEngine.allocateLargestRemainder(0, staffList);
      expect(zeroAlloc[0].allocatedPaise).toBe(0);
      expect(zeroAlloc[1].allocatedPaise).toBe(0);

      // Invalid sum of splits (e.g. 70%)
      const invalidSplits = [
        { staffId: staffId1, splitPercentage: 40 },
        { staffId: staffId2, splitPercentage: 30 },
      ];
      expect(() => IncentiveCalculationEngine.allocateLargestRemainder(1000, invalidSplits)).toThrow(AppError);

      // Duplicate staffId rejection
      const duplicateStaff = [
        { staffId: staffId1, splitPercentage: 50 },
        { staffId: staffId1, splitPercentage: 50 },
      ];
      expect(() => IncentiveCalculationEngine.allocateLargestRemainder(1000, duplicateStaff)).toThrow(
        /Duplicate staffId/
      );

      // Zero split share validation: valid when total still sums to 100%
      const zeroShareStaff = [
        { staffId: staffId1, splitPercentage: 100 },
        { staffId: staffId2, splitPercentage: 0 },
      ];
      const zeroShareAlloc = IncentiveCalculationEngine.allocateLargestRemainder(1000, zeroShareStaff);
      expect(zeroShareAlloc.find((a) => a.staffId === staffId1.toString()).allocatedPaise).toBe(1000);
      expect(zeroShareAlloc.find((a) => a.staffId === staffId2.toString()).allocatedPaise).toBe(0);

      // Negative split percentage rejection
      const negativeSplit = [
        { staffId: staffId1, splitPercentage: 110 },
        { staffId: staffId2, splitPercentage: -10 },
      ];
      expect(() => IncentiveCalculationEngine.allocateLargestRemainder(1000, negativeSplit)).toThrow(
        /Invalid split percentage/
      );
    });
  });

  describe("3. Scope Precedence Resolution (Staff -> Branch -> Organization)", () => {
    let orgScheme;
    let branchScheme;
    let staffScheme;

    beforeAll(async () => {
      orgScheme = await IncentiveScheme.create({
        organizationId: orgId,
        name: "Org Default Scheme",
        code: `ORG_DEF_${Date.now()}`,
        schemeType: "COMMISSION",
        calculationBasis: "SERVICE_NET_REVENUE",
        rules: { fixedAmountPaise: 1000 },
        status: "active",
      });

      branchScheme = await IncentiveScheme.create({
        organizationId: orgId,
        name: "Branch Special Scheme",
        code: `BRANCH_SPEC_${Date.now()}`,
        schemeType: "COMMISSION",
        calculationBasis: "SERVICE_NET_REVENUE",
        rules: { fixedAmountPaise: 2000 },
        status: "active",
      });

      staffScheme = await IncentiveScheme.create({
        organizationId: orgId,
        name: "Staff Star Scheme",
        code: `STAFF_STAR_${Date.now()}`,
        schemeType: "COMMISSION",
        calculationBasis: "SERVICE_NET_REVENUE",
        rules: { fixedAmountPaise: 5000 },
        status: "active",
      });

      // 1. Assign Org-wide default
      await SchemeAssignment.create({
        organizationId: orgId,
        schemeId: orgScheme._id,
        scopeType: "ORGANIZATION",
        startDate: new Date("2026-01-01T00:00:00.000Z"),
        endDate: null,
        status: "active",
      });

      // 2. Assign Branch-wide
      await SchemeAssignment.create({
        organizationId: orgId,
        schemeId: branchScheme._id,
        scopeType: "BRANCH",
        scopeId: branchId,
        startDate: new Date("2026-01-01T00:00:00.000Z"),
        endDate: null,
        status: "active",
      });

      // 3. Assign Staff-specific for staffId1
      await SchemeAssignment.create({
        organizationId: orgId,
        schemeId: staffScheme._id,
        scopeType: "STAFF",
        scopeId: staffId1,
        startDate: new Date("2026-01-01T00:00:00.000Z"),
        endDate: null,
        status: "active",
      });
    });

    it("prefers Staff scope over Branch and Org scopes", async () => {
      const resolved = await schemeAssignmentService.resolveActiveAssignment({
        organizationId: orgId,
        staffId: staffId1,
        branchId,
        effectiveDate: new Date("2026-06-01T00:00:00.000Z"),
      });

      expect(resolved).toBeDefined();
      expect(resolved.scopeType).toBe("STAFF");
      expect(resolved.schemeId.toString()).toBe(staffScheme._id.toString());
    });

    it("falls back to Branch scope when Staff scope is absent", async () => {
      const resolved = await schemeAssignmentService.resolveActiveAssignment({
        organizationId: orgId,
        staffId: staffId2, // No staff-level assignment
        branchId,
        effectiveDate: new Date("2026-06-01T00:00:00.000Z"),
      });

      expect(resolved).toBeDefined();
      expect(resolved.scopeType).toBe("BRANCH");
      expect(resolved.schemeId.toString()).toBe(branchScheme._id.toString());
    });

    it("falls back to Organization default when both Staff and Branch scopes are absent", async () => {
      const otherBranchId = new mongoose.Types.ObjectId();
      const resolved = await schemeAssignmentService.resolveActiveAssignment({
        organizationId: orgId,
        staffId: staffId3,
        branchId: otherBranchId, // Branch has no assignment
        effectiveDate: new Date("2026-06-01T00:00:00.000Z"),
      });

      expect(resolved).toBeDefined();
      expect(resolved.scopeType).toBe("ORGANIZATION");
      expect(resolved.schemeId.toString()).toBe(orgScheme._id.toString());
    });

    it("detects and rejects ambiguous overlapping assignments at the same scope tier", async () => {
      const testStaffId = new mongoose.Types.ObjectId();
      const duplicateScheme = await IncentiveScheme.create({
        organizationId: orgId,
        name: "Second Staff Scheme",
        code: `SECOND_STAFF_${Date.now()}`,
        schemeType: "COMMISSION",
        calculationBasis: "SERVICE_NET_REVENUE",
        rules: { fixedAmountPaise: 2500 },
        status: "active",
      });

      // Seed two overlapping active assignments directly at STAFF scope
      await SchemeAssignment.create([
        {
          organizationId: orgId,
          schemeId: staffScheme._id,
          scopeType: "STAFF",
          scopeId: testStaffId,
          startDate: new Date("2026-01-01T00:00:00.000Z"),
          priority: 10,
          status: "active",
        },
        {
          organizationId: orgId,
          schemeId: duplicateScheme._id,
          scopeType: "STAFF",
          scopeId: testStaffId,
          startDate: new Date("2026-01-01T00:00:00.000Z"),
          priority: 10,
          status: "active",
        },
      ]);

      await expect(
        schemeAssignmentService.resolveActiveAssignment({
          organizationId: orgId,
          staffId: testStaffId,
          effectiveDate: new Date("2026-06-01T00:00:00.000Z"),
        })
      ).rejects.toThrow(/Ambiguous scheme assignment detected at STAFF scope/);
    });
  });

  describe("4. Monthly Target and Attendance Bonus Evaluation Engine", () => {
    it("evaluates revenue target bonus successfully when threshold is met or exceeded", () => {
      const scheme = {
        schemeType: "TARGET_BONUS",
        rules: {
          targetThresholdPaise: 5000000, // ₹50,000 target
          fixedAmountPaise: 250000, // ₹2,500 bonus
        },
      };

      // Below threshold (₹49,999) -> 0 bonus
      const resBelow = IncentiveCalculationEngine.evaluateMonthlyBonus({
        scheme,
        achievedRevenueInPaise: 4999900,
        attendedDaysCount: 26,
      });
      expect(resBelow.isTargetMet).toBe(false);
      expect(resBelow.bonusAwardedInPaise).toBe(0);

      // Met threshold (₹50,000) -> ₹2,500 bonus
      const resMet = IncentiveCalculationEngine.evaluateMonthlyBonus({
        scheme,
        achievedRevenueInPaise: 5000000,
        attendedDaysCount: 26,
      });
      expect(resMet.isTargetMet).toBe(true);
      expect(resMet.bonusAwardedInPaise).toBe(250000);
    });

    it("fails closed for attendance bonuses instead of trusting a precomputed day count", () => {
      const scheme = {
        schemeType: "ATTENDANCE_BONUS",
        rules: {
          minimumAttendanceDays: 24,
          fixedAmountPaise: 100000, // ₹1,000 bonus
        },
      };

      expect(() =>
        IncentiveCalculationEngine.evaluateMonthlyBonus({
          scheme,
          achievedRevenueInPaise: 10000000,
          attendedDaysCount: 25,
        })
      ).toThrow(/Attendance bonus evaluation must use verified Attendance records/);
    });

    it("fails closed for hybrid schemes rather than awarding an unverified attendance component", () => {
      expect(() =>
        IncentiveCalculationEngine.evaluateMonthlyBonus({
          scheme: {
            schemeType: "HYBRID",
            rules: {
              targetThresholdPaise: 5000000,
              minimumAttendanceDays: 24,
              fixedAmountPaise: 100000,
            },
          },
          achievedRevenueInPaise: 6000000,
          attendedDaysCount: 25,
        })
      ).toThrow(/Attendance bonus evaluation must use verified Attendance records/);
    });
  });

  afterAll(async () => {
    await SchemeAssignment.deleteMany({});
    await IncentiveScheme.deleteMany({});
    await IncentiveLedger.deleteMany({});
    await Staff.deleteMany({});
    await mongoose.connection.close();
  });
});
