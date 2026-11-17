import { describe, expect, it } from "@jest/globals";
import mongoose from "mongoose";
import {
  ScopeLock,
  IncentiveScheme,
  SchemeAssignment,
  InvoiceSettlementEvent,
  IncentiveLedger,
  IncentiveRecoveryObligation,
  IncentivePayoutBatch,
  IncentiveEvaluation,
  IncentiveEvaluationRevision,
  PayrollSettlementOutbox,
} from "../../models/incentives/index.js";
import { CANONICAL_PERMISSIONS } from "../../config/permissions.js";
import { AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";

describe("Stage 1 — Incentives Models & Schema Constraints Test Suite", () => {
  const dummyOrgId = new mongoose.Types.ObjectId();
  const dummyBranchId = new mongoose.Types.ObjectId();
  const dummyStaffId = new mongoose.Types.ObjectId();
  const dummyUserId = new mongoose.Types.ObjectId();
  const dummySchemeId = new mongoose.Types.ObjectId();
  const dummyInvoiceId = new mongoose.Types.ObjectId();
  const dummyPaymentId = new mongoose.Types.ObjectId();
  const dummyBatchId = new mongoose.Types.ObjectId();

  describe("1. ScopeLock Model", () => {
    it("validates required fields and default values", () => {
      const lock = new ScopeLock({
        organizationId: dummyOrgId,
        scopeType: "BRANCH",
        scopeKey: dummyBranchId.toString(),
        lockOwner: "worker-1",
      });

      const err = lock.validateSync();
      expect(err).toBeUndefined();
      expect(lock.scopeType).toBe("BRANCH");
      expect(lock.lockedAt).toBeInstanceOf(Date);
      expect(lock.leaseExpiresAt).toBeNull();
    });

    it("rejects invalid scopeType enum", () => {
      const lock = new ScopeLock({
        organizationId: dummyOrgId,
        scopeType: "INVALID_SCOPE",
        scopeKey: "abc",
        lockOwner: "worker-1",
      });

      const err = lock.validateSync();
      expect(err).toBeDefined();
      expect(err.errors.scopeType).toBeDefined();
    });

    it("has the compound unique index on organizationId, scopeType, and scopeKey", () => {
      const indexes = ScopeLock.schema.indexes();
      const hasCompoundUnique = indexes.some(
        ([idx, opts]) =>
          idx.organizationId === 1 &&
          idx.scopeType === 1 &&
          idx.scopeKey === 1 &&
          opts?.unique === true
      );
      expect(hasCompoundUnique).toBe(true);
    });
  });

  describe("2. IncentiveScheme Model", () => {
    it("validates pure integer paise and valid tiers", () => {
      const scheme = new IncentiveScheme({
        organizationId: dummyOrgId,
        name: "Hair Stylist Commission",
        code: "HSC_2026",
        schemeType: "COMMISSION",
        calculationBasis: "SERVICE_NET_REVENUE",
        rules: {
          tiers: [
            {
              minPaise: 0,
              maxPaise: 500000,
              percentage: 10,
              fixedPaise: 0,
            },
            {
              minPaise: 500001,
              maxPaise: null,
              percentage: 15,
              fixedPaise: 5000,
            },
          ],
          fixedAmountPaise: 0,
        },
      });

      const err = scheme.validateSync();
      expect(err).toBeUndefined();
      expect(scheme.status).toBe("draft");
    });

    it("rejects fractional (float) paise values", () => {
      const scheme = new IncentiveScheme({
        organizationId: dummyOrgId,
        name: "Invalid Tier Scheme",
        code: "ITS_2026",
        schemeType: "COMMISSION",
        rules: {
          tiers: [
            {
              minPaise: 100.5, // Invalid float paise
              percentage: 10,
            },
          ],
        },
      });

      const err = scheme.validateSync();
      expect(err).toBeDefined();
      expect(err.errors["rules.tiers.0.minPaise"]).toBeDefined();
    });

    it("rejects negative paise values", () => {
      const scheme = new IncentiveScheme({
        organizationId: dummyOrgId,
        name: "Negative Tier Scheme",
        code: "NTS_2026",
        schemeType: "COMMISSION",
        rules: {
          tiers: [
            {
              minPaise: -500,
              percentage: 10,
            },
          ],
        },
      });

      const err = scheme.validateSync();
      expect(err).toBeDefined();
      expect(err.errors["rules.tiers.0.minPaise"]).toBeDefined();
    });

    it("has unique compound index on organizationId and code", () => {
      const indexes = IncentiveScheme.schema.indexes();
      const hasUnique = indexes.some(
        ([idx, opts]) =>
          idx.organizationId === 1 && idx.code === 1 && opts?.unique === true
      );
      expect(hasUnique).toBe(true);
    });
  });

  describe("3. SchemeAssignment Model", () => {
    it("validates assignment date interval and scope", () => {
      const now = new Date();
      const nextMonth = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      const assignment = new SchemeAssignment({
        organizationId: dummyOrgId,
        schemeId: dummySchemeId,
        scopeType: "STAFF",
        scopeId: dummyStaffId,
        startDate: now,
        endDate: nextMonth,
      });

      const err = assignment.validateSync();
      expect(err).toBeUndefined();
      expect(assignment.priority).toBe(0);
      expect(assignment.status).toBe("active");
    });

    it("rejects endDate earlier than startDate", () => {
      const now = new Date();
      const past = new Date(now.getTime() - 1000);
      const assignment = new SchemeAssignment({
        organizationId: dummyOrgId,
        schemeId: dummySchemeId,
        scopeType: "BRANCH",
        scopeId: dummyBranchId,
        startDate: now,
        endDate: past,
      });

      const err = assignment.validateSync();
      expect(err).toBeDefined();
      expect(err.errors.endDate).toBeDefined();
    });
  });

  describe("4. InvoiceSettlementEvent Model", () => {
    it("validates line item snapshots, integer paise, and settlement cycle", () => {
      const lineItemId = new mongoose.Types.ObjectId();
      const event = new InvoiceSettlementEvent({
        organizationId: dummyOrgId,
        branchId: dummyBranchId,
        invoiceId: dummyInvoiceId,
        paymentId: dummyPaymentId,
        eventType: "SETTLED",
        settlementCycle: 1,
        grossAmountInPaise: 100000,
        discountAmountInPaise: 10000,
        taxAmountInPaise: 5000,
        netSettledInPaise: 95000,
        idempotencyKey: `SETTLE:INV:${dummyInvoiceId}:PAY:${dummyPaymentId}:CYCLE:1`,
        lineItems: [
          {
            itemId: lineItemId,
            itemType: "service",
            name: "Hair Spa",
            priceInPaise: 100000,
            discountInPaise: 10000,
            netRevenueInPaise: 90000,
            staffAttributions: [
              {
                staffId: dummyStaffId,
                splitPercentage: 100,
                attributedPaise: 90000,
              },
            ],
          },
        ],
      });

      const err = event.validateSync();
      expect(err).toBeUndefined();
    });

    it("has compound unique index on organizationId and idempotencyKey", () => {
      const indexes = InvoiceSettlementEvent.schema.indexes();
      const hasUnique = indexes.some(
        ([idx, opts]) =>
          idx.organizationId === 1 &&
          idx.idempotencyKey === 1 &&
          opts?.unique === true
      );
      expect(hasUnique).toBe(true);
    });
  });

  describe("5. IncentiveLedger Model", () => {
    it("validates append-only ledger schema with fulfillmentStatus defaults", () => {
      const ledger = new IncentiveLedger({
        organizationId: dummyOrgId,
        branchId: dummyBranchId,
        staffId: dummyStaffId,
        schemeId: dummySchemeId,
        entryType: "ACCRUAL",
        settlementEventId: new mongoose.Types.ObjectId(),
        invoiceId: dummyInvoiceId,
        lineItemId: new mongoose.Types.ObjectId(),
        sourceRevenueInPaise: 100000,
        attributedRevenueInPaise: 100000,
        amountInPaise: 10000,
        idempotencyKey: `ACCRUAL:${dummyInvoiceId}:${dummyStaffId}`,
      });

      const err = ledger.validateSync();
      expect(err).toBeUndefined();
      expect(ledger.fulfillmentStatus).toBe("confirmed");
      expect(ledger.payoutBatchId).toBeNull();
    });

    it("rejects negative amountInPaise", () => {
      const ledger = new IncentiveLedger({
        organizationId: dummyOrgId,
        branchId: dummyBranchId,
        staffId: dummyStaffId,
        schemeId: dummySchemeId,
        entryType: "CLAWBACK",
        settlementEventId: new mongoose.Types.ObjectId(),
        invoiceId: dummyInvoiceId,
        lineItemId: new mongoose.Types.ObjectId(),
        sourceRevenueInPaise: 100000,
        attributedRevenueInPaise: 100000,
        amountInPaise: -5000, // Invalid negative paise
        idempotencyKey: "abc",
      });

      const err = ledger.validateSync();
      expect(err).toBeDefined();
      expect(err.errors.amountInPaise).toBeDefined();
    });
  });

  describe("6. IncentiveRecoveryObligation Model", () => {
    it("validates recovery obligation and enforces totalRecovered + totalReserved <= originalClawback", () => {
      const obligation = new IncentiveRecoveryObligation({
        organizationId: dummyOrgId,
        branchId: dummyBranchId,
        staffId: dummyStaffId,
        clawbackLedgerId: new mongoose.Types.ObjectId(),
        originalClawbackInPaise: 50000,
        totalReservedInPaise: 20000,
        totalRecoveredInPaise: 30000,
        allocations: [
          {
            allocationEventId: "ALLOC-001",
            payoutBatchId: dummyBatchId,
            allocatedPaise: 20000,
            state: "reserved",
          },
        ],
      });

      const err = obligation.validateSync();
      expect(err).toBeUndefined();
    });

    it("triggers validation error when totalRecovered + totalReserved exceeds originalClawback", () => {
      const obligation = new IncentiveRecoveryObligation({
        organizationId: dummyOrgId,
        branchId: dummyBranchId,
        staffId: dummyStaffId,
        clawbackLedgerId: new mongoose.Types.ObjectId(),
        originalClawbackInPaise: 50000,
        totalReservedInPaise: 30000,
        totalRecoveredInPaise: 25000, // Sum = 55000 > 50000!
      });

      const err = obligation.validateSync();
      expect(err).toBeDefined();
      expect(err.message).toContain("Invariant violation");
    });
  });

  describe("7. IncentivePayoutBatch Model", () => {
    it("validates monthYear format YYYY-MM and non-negative summary paise", () => {
      const batch = new IncentivePayoutBatch({
        organizationId: dummyOrgId,
        branchId: dummyBranchId,
        monthYear: "2026-11",
        totalGrossInPaise: 100000,
        totalRecoveredInPaise: 20000,
        totalNetInPaise: 80000,
        staffSummaries: [
          {
            staffId: dummyStaffId,
            grossEarningsInPaise: 100000,
            bonusInPaise: 0,
            allocatedRecoveryInPaise: 20000,
            netPayoutInPaise: 80000,
          },
        ],
      });

      const err = batch.validateSync();
      expect(err).toBeUndefined();
      expect(batch.status).toBe("draft");
    });

    it("rejects invalid monthYear pattern", () => {
      const batch = new IncentivePayoutBatch({
        organizationId: dummyOrgId,
        branchId: dummyBranchId,
        monthYear: "2026/11", // Invalid delimiter
      });

      const err = batch.validateSync();
      expect(err).toBeDefined();
      expect(err.errors.monthYear).toBeDefined();
    });
  });

  describe("8. IncentiveEvaluation & Revision Models", () => {
    it("validates IncentiveEvaluation schema", () => {
      const evalDoc = new IncentiveEvaluation({
        organizationId: dummyOrgId,
        branchId: dummyBranchId,
        staffId: dummyStaffId,
        schemeId: dummySchemeId,
        monthYear: "2026-11",
        evaluationType: "TARGET_BONUS",
        targetPaise: 500000,
        achievedPaise: 550000,
        isTargetMet: true,
        bonusAwardedInPaise: 25000,
      });

      const err = evalDoc.validateSync();
      expect(err).toBeUndefined();
      expect(evalDoc.status).toBe("computed");
    });

    it("validates IncentiveEvaluationRevision schema with positive or negative delta", () => {
      const rev = new IncentiveEvaluationRevision({
        organizationId: dummyOrgId,
        evaluationId: new mongoose.Types.ObjectId(),
        revisionNumber: 1,
        previousValueInPaise: 25000,
        newValueInPaise: 30000,
        deltaInPaise: 5000,
        reason: "Manager discretionary adjustment",
        adjustedBy: dummyUserId,
      });

      const err = rev.validateSync();
      expect(err).toBeUndefined();

      // Negative delta
      const revNeg = new IncentiveEvaluationRevision({
        organizationId: dummyOrgId,
        evaluationId: new mongoose.Types.ObjectId(),
        revisionNumber: 2,
        previousValueInPaise: 30000,
        newValueInPaise: 20000,
        deltaInPaise: -10000,
        reason: "Correction of unfulfilled appointment",
        adjustedBy: dummyUserId,
      });

      const errNeg = revNeg.validateSync();
      expect(errNeg).toBeUndefined();
    });
  });

  describe("9. PayrollSettlementOutbox Model", () => {
    it("validates outbox event schema and lease fields", () => {
      const outbox = new PayrollSettlementOutbox({
        organizationId: dummyOrgId,
        eventType: "payroll_paid",
        idempotencyKey: `OUTBOX:PAYROLL:${dummyOrgId}:2026-11`,
        payload: {
          payrollRecordId: new mongoose.Types.ObjectId(),
          monthYear: "2026-11",
          payoutBatchId: dummyBatchId,
          staffId: dummyStaffId,
          amountInPaise: 80000,
          reason: "Monthly payroll payout",
        },
      });

      const err = outbox.validateSync();
      expect(err).toBeUndefined();
      expect(outbox.status).toBe("pending");
      expect(outbox.retryCount).toBe(0);
      expect(outbox.maxRetries).toBe(5);
    });

    it("has unique compound index on organizationId and idempotencyKey", () => {
      const indexes = PayrollSettlementOutbox.schema.indexes();
      const hasUnique = indexes.some(
        ([idx, opts]) =>
          idx.organizationId === 1 &&
          idx.idempotencyKey === 1 &&
          opts?.unique === true
      );
      expect(hasUnique).toBe(true);
    });
  });

  describe("10. Canonical Permissions and Audit Actions", () => {
    it("registers all seven canonical incentives permissions", () => {
      const expectedPermissions = [
        "incentives.view",
        "incentives.view.all",
        "incentives.rules.manage",
        "incentives.approve",
        "incentives.payout.sync",
        "incentives.fulfillment.confirm",
        "incentives.fulfillment.correct",
      ];

      const canonicalNames = CANONICAL_PERMISSIONS.map((p) => p.name);
      for (const expected of expectedPermissions) {
        expect(canonicalNames).toContain(expected);
        const perm = CANONICAL_PERMISSIONS.find((p) => p.name === expected);
        expect(perm.module).toBe("Incentives");
      }
    });

    it("registers new incentive audit actions in AUDIT_ACTIONS", () => {
      const expectedActions = [
        "INCENTIVE_SCHEME_CREATED",
        "INCENTIVE_SCHEME_UPDATED",
        "INCENTIVE_ASSIGNMENT_CREATED",
        "INCENTIVE_ASSIGNMENT_UPDATED",
        "INCENTIVE_BATCH_CREATED",
        "INCENTIVE_BATCH_APPROVED",
        "INCENTIVE_BATCH_SYNCED",
        "INCENTIVE_EVALUATION_OVERRIDDEN",
        "INCENTIVE_FULFILLMENT_CONFIRMED",
        "INCENTIVE_FULFILLMENT_CORRECTED",
      ];

      for (const act of expectedActions) {
        expect(AUDIT_ACTIONS[act]).toBe(act);
      }
    });
  });
});
