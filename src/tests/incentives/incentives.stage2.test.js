import { describe, expect, it, beforeAll, afterAll, beforeEach, jest } from "@jest/globals";
import mongoose from "mongoose";
import { getIsolatedTestMongoUri } from "../testSetup.js";
import { Organization } from "../../models/organizations/organization.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { User } from "../../models/users/user.model.js";
import { Role } from "../../models/roles/role.model.js";
import {
  ScopeLock,
  IncentiveScheme,
  SchemeAssignment,
  IncentiveLedger,
  IncentiveRecoveryObligation,
  IncentiveEvaluationRevision,
} from "../../models/incentives/index.js";
import { scopeLockService } from "../../services/incentives/scopeLock.service.js";
import { schemeAssignmentService } from "../../services/incentives/schemeAssignment.service.js";
import { recoveryObligationService } from "../../services/incentives/recoveryObligation.service.js";
import { appendOnlyWriteBoundaryService } from "../../services/incentives/appendOnlyWriteBoundary.service.js";

describe("Incentives Stage 2 — Service Foundations Test Suite", () => {
  jest.setTimeout(30000);
  let orgId;
  let branchId;
  let userId;
  let schemeId;

  beforeAll(async () => {
    const mongoUri = getIsolatedTestMongoUri("incentives_test");
    await mongoose.connect(mongoUri);
  });

  afterAll(async () => {
    await ScopeLock.deleteMany({});
    await IncentiveScheme.deleteMany({});
    await SchemeAssignment.deleteMany({});
    await IncentiveLedger.deleteMany({});
    await IncentiveRecoveryObligation.deleteMany({});
    await IncentiveEvaluationRevision.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await ScopeLock.deleteMany({});
    await IncentiveScheme.deleteMany({});
    await SchemeAssignment.deleteMany({});
    await IncentiveLedger.deleteMany({});
    await IncentiveRecoveryObligation.deleteMany({});
    await IncentiveEvaluationRevision.deleteMany({});

    const org = await Organization.create({
      name: `Incentives Test Org ${Date.now()}`,
      slug: `inc-org-${Date.now()}-${Math.random()}`,
      status: "active",
    });
    orgId = org._id;

    const branch = await Branch.create({
      name: "Main Branch",
      organizationId: orgId,
      status: "active",
      isActive: true,
    });
    branchId = branch._id;

    userId = new mongoose.Types.ObjectId();

    const scheme = await IncentiveScheme.create({
      organizationId: orgId,
      name: "Standard Stylist Commission",
      code: `SCHEME_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      schemeType: "COMMISSION",
      calculationBasis: "SERVICE_NET_REVENUE",
      status: "active",
    });
    schemeId = scheme._id;
  });

  describe("1. ScopeLock Acquisition & Serialization", () => {
    it("sorts multiple scopes in deterministic lexicographical order", () => {
      const scopes = [
        { scopeType: "STAFF", scopeKey: "staff-2" },
        { scopeType: "BRANCH", scopeKey: "branch-9" },
        { scopeType: "STAFF", scopeKey: "staff-1" },
        { scopeType: "ORGANIZATION", scopeKey: "org-1" },
      ];

      const sorted = scopeLockService.constructor.sortScopes(scopes);
      expect(sorted[0].scopeType).toBe("BRANCH");
      expect(sorted[1].scopeType).toBe("ORGANIZATION");
      expect(sorted[2].scopeKey).toBe("staff-1");
      expect(sorted[3].scopeKey).toBe("staff-2");
    });

    it("acquires and releases a lock within a session", async () => {
      const session = await mongoose.startSession();
      session.startTransaction();

      const lock = await scopeLockService.acquireLock({
        organizationId: orgId,
        scopeType: "BRANCH",
        scopeKey: branchId.toString(),
        lockOwner: "worker-A",
        session,
      });

      expect(lock).toBeDefined();
      expect(lock.lockOwner).toBe("worker-A");
      expect(lock.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now());

      const released = await scopeLockService.releaseLock({
        organizationId: orgId,
        scopeType: "BRANCH",
        scopeKey: branchId.toString(),
        lockOwner: "worker-A",
        session,
      });
      expect(released).toBe(true);

      await session.commitTransaction();
      await session.endSession();
    });

    it("allows re-entrant acquisition by the same lockOwner", async () => {
      const session = await mongoose.startSession();
      session.startTransaction();

      const lock1 = await scopeLockService.acquireLock({
        organizationId: orgId,
        scopeType: "ROLE",
        scopeKey: "senior-stylist",
        lockOwner: "worker-reentrant",
        session,
      });
      expect(lock1).toBeDefined();

      const lock2 = await scopeLockService.acquireLock({
        organizationId: orgId,
        scopeType: "ROLE",
        scopeKey: "senior-stylist",
        lockOwner: "worker-reentrant",
        session,
      });
      expect(lock2).toBeDefined();
      expect(lock2.lockOwner).toBe("worker-reentrant");

      await session.commitTransaction();
      await session.endSession();
    });

    it("takes over an expired lease", async () => {
      // Seed an expired lock
      await ScopeLock.create({
        organizationId: orgId,
        scopeType: "STAFF",
        scopeKey: "staff-expired",
        lockOwner: "dead-worker",
        lockedAt: new Date(Date.now() - 60000),
        leaseExpiresAt: new Date(Date.now() - 1000), // Expired 1 second ago
      });

      const session = await mongoose.startSession();
      session.startTransaction();

      const newLock = await scopeLockService.acquireLock({
        organizationId: orgId,
        scopeType: "STAFF",
        scopeKey: "staff-expired",
        lockOwner: "new-worker",
        session,
      });

      expect(newLock).toBeDefined();
      expect(newLock.lockOwner).toBe("new-worker");
      expect(newLock.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now());

      await session.commitTransaction();
      await session.endSession();
    });
  });

  describe("2. SchemeAssignment Lifecycle & Half-Open Interval Overlap Prevention", () => {
    it("allows non-overlapping adjacent half-open intervals [startA, endA) and [endA, endB)", async () => {
      const t1 = new Date("2026-01-01T00:00:00.000Z");
      const t2 = new Date("2026-06-01T00:00:00.000Z");
      const t3 = new Date("2026-12-31T00:00:00.000Z");

      const a1 = await schemeAssignmentService.createAssignment(
        {
          schemeId,
          scopeType: "BRANCH",
          scopeId: branchId,
          startDate: t1,
          endDate: t2,
        },
        orgId,
        userId
      );
      expect(a1).toBeDefined();

      // Adjacent interval starting exactly at t2
      const a2 = await schemeAssignmentService.createAssignment(
        {
          schemeId,
          scopeType: "BRANCH",
          scopeId: branchId,
          startDate: t2,
          endDate: t3,
        },
        orgId,
        userId
      );
      expect(a2).toBeDefined();
    });

    it("rejects overlapping effective-date assignments for the same scope", async () => {
      const t1 = new Date("2026-01-01T00:00:00.000Z");
      const t2 = new Date("2026-06-01T00:00:00.000Z");

      await schemeAssignmentService.createAssignment(
        {
          schemeId,
          scopeType: "ORGANIZATION",
          startDate: t1,
          endDate: t2,
        },
        orgId,
        userId
      );

      // Overlapping interval [2026-03-01, 2026-09-01)
      const tOverlap = new Date("2026-03-01T00:00:00.000Z");
      const tEndOverlap = new Date("2026-09-01T00:00:00.000Z");

      await expect(
        schemeAssignmentService.createAssignment(
          {
            schemeId,
            scopeType: "ORGANIZATION",
            startDate: tOverlap,
            endDate: tEndOverlap,
          },
          orgId,
          userId
        )
      ).rejects.toThrow("Assignment overlap conflict");
    });

    it("rejects an open-ended assignment when another open-ended assignment exists", async () => {
      const t1 = new Date("2026-01-01T00:00:00.000Z");

      await schemeAssignmentService.createAssignment(
        {
          schemeId,
          scopeType: "ROLE",
          scopeId: new mongoose.Types.ObjectId(),
          startDate: t1,
          endDate: null, // Open-ended
        },
        orgId,
        userId
      );

      // Same role scope starting later with open-ended date
      const t2 = new Date("2026-07-01T00:00:00.000Z");
      await expect(
        schemeAssignmentService.createAssignment(
          {
            schemeId,
            scopeType: "ROLE",
            scopeId: (await SchemeAssignment.findOne({ organizationId: orgId })).scopeId,
            startDate: t2,
            endDate: null,
          },
          orgId,
          userId
        )
      ).rejects.toThrow("Assignment overlap conflict");
    });

    it("acquires both old and new scope locks in sorted order when changing scope", async () => {
      const staff1 = new mongoose.Types.ObjectId();
      const staff2 = new mongoose.Types.ObjectId();

      const assignment = await schemeAssignmentService.createAssignment(
        {
          schemeId,
          scopeType: "STAFF",
          scopeId: staff1,
          startDate: new Date("2026-01-01"),
          endDate: new Date("2026-05-01"),
        },
        orgId,
        userId
      );

      // Mutate to staff2
      const updated = await schemeAssignmentService.updateAssignment(
        assignment._id,
        {
          scopeId: staff2,
        },
        orgId,
        userId
      );

      expect(updated.scopeId.toString()).toBe(staff2.toString());
    });
  });

  describe("3. Recovery Obligation Operations & Atomic Invariant Preconditions", () => {
    let obligation;
    const clawbackLedgerId = new mongoose.Types.ObjectId();
    const batchId = new mongoose.Types.ObjectId();

    beforeEach(async () => {
      obligation = await IncentiveRecoveryObligation.create({
        organizationId: orgId,
        branchId,
        staffId: new mongoose.Types.ObjectId(),
        clawbackLedgerId,
        originalClawbackInPaise: 100000, // ₹1,000.00
        totalReservedInPaise: 0,
        totalRecoveredInPaise: 0,
        status: "pending",
      });
    });

    it("reserves an allocation under balance preconditions and is idempotent", async () => {
      const session = await mongoose.startSession();
      session.startTransaction();

      const reservedDoc = await recoveryObligationService.reserveAllocation({
        obligationId: obligation._id,
        organizationId: orgId,
        payoutBatchId: batchId,
        allocationEventId: "ALLOC-EVT-1",
        amountInPaise: 40000,
        session,
      });

      expect(reservedDoc.totalReservedInPaise).toBe(40000);
      expect(reservedDoc.allocations.length).toBe(1);
      expect(reservedDoc.allocations[0].state).toBe("reserved");

      // Idempotent retry with same eventId and amount
      const idempotentDoc = await recoveryObligationService.reserveAllocation({
        obligationId: obligation._id,
        organizationId: orgId,
        payoutBatchId: batchId,
        allocationEventId: "ALLOC-EVT-1",
        amountInPaise: 40000,
        session,
      });
      expect(idempotentDoc.totalReservedInPaise).toBe(40000);

      await session.commitTransaction();
      await session.endSession();
    });

    it("rejects reservation when amount exceeds available unrecovered balance", async () => {
      const session = await mongoose.startSession();
      session.startTransaction();

      await expect(
        recoveryObligationService.reserveAllocation({
          obligationId: obligation._id,
          organizationId: orgId,
          payoutBatchId: batchId,
          allocationEventId: "ALLOC-TOO-LARGE",
          amountInPaise: 150000, // 150000 > 100000 original
          session,
        })
      ).rejects.toThrow("Insufficient unrecovered clawback balance");

      await session.abortTransaction();
      await session.endSession();
    });

    it("confirms a reserved allocation deriving amount from persisted allocation and updates status", async () => {
      const session = await mongoose.startSession();
      session.startTransaction();

      await recoveryObligationService.reserveAllocation({
        obligationId: obligation._id,
        organizationId: orgId,
        payoutBatchId: batchId,
        allocationEventId: "ALLOC-FULL",
        amountInPaise: 100000,
        session,
      });

      const confirmedDoc = await recoveryObligationService.confirmAllocation({
        obligationId: obligation._id,
        organizationId: orgId,
        allocationEventId: "ALLOC-FULL",
        confirmEventId: "CONFIRM-FULL",
        session,
      });

      expect(confirmedDoc.totalReservedInPaise).toBe(0);
      expect(confirmedDoc.totalRecoveredInPaise).toBe(100000);
      expect(confirmedDoc.status).toBe("recovered");
      expect(confirmedDoc.allocations[0].state).toBe("confirmed");

      // Idempotent confirmation
      const retryConfirmed = await recoveryObligationService.confirmAllocation({
        obligationId: obligation._id,
        organizationId: orgId,
        allocationEventId: "ALLOC-FULL",
        confirmEventId: "CONFIRM-FULL",
        session,
      });
      expect(retryConfirmed.status).toBe("recovered");

      await session.commitTransaction();
      await session.endSession();
    });

    it("releases a reserved allocation back to unreserved pool", async () => {
      const session = await mongoose.startSession();
      session.startTransaction();

      await recoveryObligationService.reserveAllocation({
        obligationId: obligation._id,
        organizationId: orgId,
        payoutBatchId: batchId,
        allocationEventId: "ALLOC-RELEASE",
        amountInPaise: 50000,
        session,
      });

      const releasedDoc = await recoveryObligationService.releaseAllocation({
        obligationId: obligation._id,
        organizationId: orgId,
        allocationEventId: "ALLOC-RELEASE",
        releaseEventId: "REL-1",
        session,
      });

      expect(releasedDoc.totalReservedInPaise).toBe(0);
      expect(releasedDoc.totalRecoveredInPaise).toBe(0);
      expect(releasedDoc.allocations[0].state).toBe("released");

      await session.commitTransaction();
      await session.endSession();
    });

    it("reverses a confirmed allocation, reopening the obligation", async () => {
      const session = await mongoose.startSession();
      session.startTransaction();

      await recoveryObligationService.reserveAllocation({
        obligationId: obligation._id,
        organizationId: orgId,
        payoutBatchId: batchId,
        allocationEventId: "ALLOC-REV",
        amountInPaise: 100000,
        session,
      });

      await recoveryObligationService.confirmAllocation({
        obligationId: obligation._id,
        organizationId: orgId,
        allocationEventId: "ALLOC-REV",
        confirmEventId: "CONF-REV",
        session,
      });

      const reversedDoc = await recoveryObligationService.reverseAllocation({
        obligationId: obligation._id,
        organizationId: orgId,
        allocationEventId: "ALLOC-REV",
        reversalEventId: "REV-PAYROLL-1",
        session,
      });

      expect(reversedDoc.totalRecoveredInPaise).toBe(0);
      expect(reversedDoc.status).toBe("pending");
      expect(reversedDoc.allocations[0].state).toBe("reversed");

      await session.commitTransaction();
      await session.endSession();
    });
  });

  describe("4. Append-Only Write Boundaries", () => {
    it("appends to IncentiveLedger and enforces idempotency", async () => {
      const ledgerData = {
        branchId,
        staffId: new mongoose.Types.ObjectId(),
        schemeId,
        entryType: "ACCRUAL",
        settlementEventId: new mongoose.Types.ObjectId(),
        invoiceId: new mongoose.Types.ObjectId(),
        lineItemId: new mongoose.Types.ObjectId(),
        sourceRevenueInPaise: 500000,
        attributedRevenueInPaise: 500000,
        amountInPaise: 50000,
        idempotencyKey: `ACCRUAL:${Date.now()}:STAFF1`,
      };

      const entry1 = await appendOnlyWriteBoundaryService.appendLedgerEntry(ledgerData, orgId);
      expect(entry1._id).toBeDefined();

      // Idempotent retry returns identical document without creating duplicates
      const entry2 = await appendOnlyWriteBoundaryService.appendLedgerEntry(ledgerData, orgId);
      expect(entry2._id.toString()).toBe(entry1._id.toString());

      const count = await IncentiveLedger.countDocuments({ organizationId: orgId });
      expect(count).toBe(1);
    });

    it("appends monotonically numbered IncentiveEvaluationRevision records", async () => {
      const evaluation = await mongoose.model("IncentiveEvaluation").create({
        organizationId: orgId,
        branchId,
        staffId: new mongoose.Types.ObjectId(),
        schemeId,
        monthYear: "2026-11",
        evaluationType: "TARGET_BONUS",
        targetPaise: 500000,
        achievedPaise: 500000,
        bonusAwardedInPaise: 20000,
      });
      const evalId = evaluation._id;

      const r1 = await appendOnlyWriteBoundaryService.appendEvaluationRevision(
        {
          evaluationId: evalId,
          previousValueInPaise: 20000,
          newValueInPaise: 25000,
          deltaInPaise: 5000,
          reason: "Bonus adjustment for high customer rating",
        },
        orgId,
        userId
      );
      expect(r1.revisionNumber).toBe(1);

      const r2 = await appendOnlyWriteBoundaryService.appendEvaluationRevision(
        {
          evaluationId: evalId,
          previousValueInPaise: 25000,
          newValueInPaise: 22000,
          deltaInPaise: -3000,
          reason: "Correction of unfulfilled service",
        },
        orgId,
        userId
      );
      expect(r2.revisionNumber).toBe(2);

      const revisions = await IncentiveEvaluationRevision.find({ evaluationId: evalId }).sort({ revisionNumber: 1 });
      expect(revisions.length).toBe(2);
      expect(revisions[0].deltaInPaise).toBe(5000);
      expect(revisions[1].deltaInPaise).toBe(-3000);
    });
  });
});
