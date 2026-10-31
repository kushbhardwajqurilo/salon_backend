import { describe, expect, it, beforeEach, afterEach, jest, beforeAll, afterAll } from "@jest/globals";
import mongoose from "mongoose";
import { Organization } from "../../models/organizations/organization.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Customer } from "../../models/customers/customer.model.js";
import { Service } from "../../models/services/service.model.js";
import { ServiceCategory } from "../../models/services/serviceCategory.model.js";
import { Role } from "../../models/roles/role.model.js";
import { Permission } from "../../models/permissions/permission.model.js";
import { User } from "../../models/users/user.model.js";
import { Subscription } from "../../models/subscriptions/subscription.model.js";
import { SubscriptionUsage } from "../../models/subscriptions/subscriptionUsage.model.js";
import { Appointment } from "../../models/appointments/appointment.model.js";
import { SubscriptionConsumptionChallenge } from "../../models/subscriptions/subscriptionConsumptionChallenge.model.js";
import { AuditLog } from "../../models/audit/auditLog.model.js";
import { subscriptionService } from "../../services/subscriptions/subscription.service.js";
import { AppointmentService } from "../../services/appointments/appointment.service.js";
import { isTransactionSupported } from "../../utils/transaction.js";
import { redis } from "../../utils/redis.js";

const appointmentService = new AppointmentService();

jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");

describe("Subscription Recovery Gaps — Failure Injection & Durable Crash Recovery Tests", () => {
  jest.setTimeout(45000);

  let org;
  let branch;
  let customer;
  let service;
  let category;
  let user;

  beforeAll(async () => {
    process.env.ALLOW_STANDALONE_TRANSACTION_FALLBACK = "true";
    const testUri = process.env.TEST_MONGO_URI || "mongodb://127.0.0.1:27017/saloon_erp_recovery_gaps_test";
    await mongoose.connect(testUri);
  });

  afterAll(async () => {
    await Appointment.deleteMany({});
    await SubscriptionUsage.deleteMany({});
    await SubscriptionConsumptionChallenge.deleteMany({});
    await Subscription.deleteMany({});
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
    await Appointment.deleteMany({});
    await SubscriptionUsage.deleteMany({});
    await SubscriptionConsumptionChallenge.deleteMany({});
    await Subscription.deleteMany({});
    await AuditLog.deleteMany({});
    await Service.deleteMany({});
    await ServiceCategory.deleteMany({});
    await Customer.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Permission.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});

    org = await Organization.create({
      name: "Recovery Test Org",
      status: "active",
      currency: "INR",
      timezone: "Asia/Kolkata",
    });

    branch = await Branch.create({
      organizationId: org._id,
      name: "Main Branch",
      address: "123 Recovery Lane, Mumbai, MH, 400001, India",
      phone: "+919800001111",
      isActive: true,
    });

    const role = await Role.create({
      organizationId: org._id,
      name: "Manager",
      slug: "manager",
      permissions: [],
    });

    user = await User.create({
      organizationId: org._id,
      branchIds: [branch._id],
      role: role._id,
      name: "Recovery Tester",
      email: `tester_${Date.now()}@example.com`,
      phone: "+919800002222",
      password: "Password123!",
      status: "active",
    });

    customer = await Customer.create({
      organizationId: org._id,
      homeBranchId: branch._id,
      name: "Alice Johnson",
      phone: "+919800003333",
      email: "alice@example.com",
      gender: "female",
    });

    category = await ServiceCategory.create({
      organizationId: org._id,
      name: "Hair Care",
      gender: "unisex",
    });

    service = await Service.create({
      organizationId: org._id,
      name: "Deluxe Haircut",
      categoryId: category._id,
      gender: "unisex",
      pricing: { basePrice: 1000 },
      duration: 45,
    });
  });

  // Helper to create a multi-member subscription
  const createTestSubscription = async (remainingQty = 2, usedQty = 0) => {
    return await Subscription.create({
      organizationId: org._id,
      payerCustomerId: customer._id,
      customerId: customer._id,
      subscriptionCode: `SUB-GAP-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      price: 2000,
      startDate: new Date(Date.now() - 86400000),
      endDate: new Date(Date.now() + 30 * 86400000),
      status: "active",
      permittedBranchIds: [branch._id],
      appliedOperations: [],
      members: [
        {
          customerId: customer._id,
          status: "active",
          permittedBranchIds: [branch._id],
          entitlements: [
            {
              serviceId: service._id,
              serviceName: service.name,
              totalQuantity: remainingQty + usedQty,
              usedQuantity: usedQty,
              remainingQuantity: remainingQty,
            },
          ],
        },
      ],
      entitlements: [
        {
          serviceId: service._id,
          serviceName: service.name,
          totalQuantity: remainingQty + usedQty,
          usedQuantity: usedQty,
          remainingQuantity: remainingQty,
        },
      ],
    });
  };

  // Helper to create appointment
  const createTestAppointment = async () => {
    const aptServiceId = new mongoose.Types.ObjectId();
    return await Appointment.create({
      organizationId: org._id,
      branchId: branch._id,
      customerId: customer._id,
      appointmentCode: `APT-GAP-${Date.now()}`,
      appointmentDate: "2026-11-01",
      startTime: "10:00",
      endTime: "10:45",
      status: "in_progress",
      bookingType: "advance",
      startAt: new Date(),
      endAt: new Date(Date.now() + 2700000),
      totalDuration: 45,
      pricing: { subtotal: 1000, discount: 0, total: 1000 },
      services: [
        {
          _id: aptServiceId,
          serviceId: service._id,
          name: service.name,
          price: 1000,
          duration: 45,
          isRedeemedViaSubscription: false,
        },
      ],
    });
  };

  describe("1. Crash Window A: Decrement Acknowledgment Ambiguity", () => {
    it("Scenario A1: Failure BEFORE decrement commit — does not falsely restore balance and resolves cleanly", async () => {
      const sub = await createTestSubscription(3, 0);
      const apt = await createTestAppointment();
      const aptServiceId = apt.services[0]._id;
      const decOpId = `${apt._id}:${aptServiceId}:dec`;

      // Intent registered in challenge ledger with isDecremented: false, but crash occurred before decrement
      const challenge = await SubscriptionConsumptionChallenge.create({
        organizationId: org._id,
        branchId: branch._id,
        appointmentId: apt._id,
        subscriptionIds: [sub._id],
        customerId: customer._id,
        serviceIds: [service._id],
        otpHash: "hash-a1",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
        status: "in_redemption",
        redemptionState: "in_redemption",
        decrements: [
          {
            operationId: decOpId,
            subscriptionId: sub._id,
            memberCustomerId: customer._id,
            serviceId: service._id,
            quantity: 1,
            appointmentServiceId: aptServiceId,
            decrementedAt: null,
            isDecremented: false, // Never decremented
            isRestored: false,
            restorationState: "none",
          },
        ],
      });

      // Verify initial subscription balance is 3
      let subCheck = await Subscription.findById(sub._id);
      expect(subCheck.members[0].entitlements[0].remainingQuantity).toBe(3);
      expect(subCheck.appliedOperations).toEqual([]);

      // Run reconciliation sweeper
      const report = await subscriptionService.reconcileIncompleteRedemptions(org._id, { maxAgeMinutes: 0 });
      expect(report.reconciledRestored).toBe(1);

      // Verify balance did NOT falsely increment to 4
      subCheck = await Subscription.findById(sub._id);
      expect(subCheck.members[0].entitlements[0].remainingQuantity).toBe(3);
      expect(subCheck.members[0].entitlements[0].usedQuantity).toBe(0);

      // Verify challenge state is cleanly finalized as exhausted/reconciled
      const challengeCheck = await SubscriptionConsumptionChallenge.findById(challenge._id);
      expect(challengeCheck.status).toBe("exhausted");
      expect(challengeCheck.redemptionState).toBe("reconciled");
      expect(challengeCheck.decrements[0].isDecremented).toBe(false);

      // Repeat reconciliation pass (idempotency check)
      const repeatReport = await subscriptionService.reconcileIncompleteRedemptions(org._id, { maxAgeMinutes: 0 });
      expect(repeatReport.inspected).toBe(0);
      expect(repeatReport.reconciledRestored).toBe(0);
    });

    it("Scenario A2: Failure AFTER decrement commit but before acknowledgment/ledger update — deterministically recovers decrement via durable operation identity", async () => {
      const sub = await createTestSubscription(2, 0);
      const apt = await createTestAppointment();
      const aptServiceId = apt.services[0]._id;
      const decOpId = `${apt._id}:${aptServiceId}:dec`;

      // Decrement committed on Subscription with decOpId pushed to appliedOperations
      await subscriptionService.subscriptionRepo.atomicDecrementMemberEntitlement(
        sub._id,
        org._id,
        customer._id,
        service._id,
        1,
        null,
        decOpId
      );

      // Verify decrement committed on Subscription: balance is now 1
      let subPreCrash = await Subscription.findById(sub._id);
      expect(subPreCrash.members[0].entitlements[0].remainingQuantity).toBe(1);
      expect(subPreCrash.members[0].entitlements[0].usedQuantity).toBe(1);
      expect(subPreCrash.appliedOperations).toContain(decOpId);

      // But process crashed before challenge document could be updated to isDecremented: true!
      const challengeAmbiguous = await SubscriptionConsumptionChallenge.create({
        organizationId: org._id,
        branchId: branch._id,
        appointmentId: apt._id,
        subscriptionIds: [sub._id],
        customerId: customer._id,
        serviceIds: [service._id],
        otpHash: "hash-a2",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
        status: "in_redemption",
        redemptionState: "in_redemption",
        decrements: [
          {
            operationId: decOpId,
            subscriptionId: sub._id,
            memberCustomerId: customer._id,
            serviceId: service._id,
            quantity: 1,
            appointmentServiceId: aptServiceId,
            decrementedAt: null,
            isDecremented: false, // Challenge says false due to crash!
            isRestored: false,
            restorationState: "none",
          },
        ],
      });

      // Run reconciliation: system must inspect Subscription.appliedOperations to resolve acknowledgment ambiguity
      const report = await subscriptionService.reconcileIncompleteRedemptions(org._id, { maxAgeMinutes: 0 });
      expect(report.inspected).toBe(1);
      expect(report.reconciledRestored).toBe(1);

      // Verify balance was properly restored to original 2
      const subPostRecon = await Subscription.findById(sub._id);
      expect(subPostRecon.members[0].entitlements[0].remainingQuantity).toBe(2);
      expect(subPostRecon.members[0].entitlements[0].usedQuantity).toBe(0);

      const restoreOpId = `${decOpId}:restore`;
      expect(subPostRecon.appliedOperations).toContain(restoreOpId);

      // Verify challenge reflects restored status
      const challengePostRecon = await SubscriptionConsumptionChallenge.findById(challengeAmbiguous._id);
      expect(challengePostRecon.status).toBe("exhausted");
      expect(challengePostRecon.redemptionState).toBe("reconciled");
      expect(challengePostRecon.decrements[0].isDecremented).toBe(true);
      expect(challengePostRecon.decrements[0].isRestored).toBe(true);
      expect(challengePostRecon.decrements[0].restorationState).toBe("restored");

      // Repeated reconciliation pass must NOT double-restore
      await subscriptionService.reconcileIncompleteRedemptions(org._id, { maxAgeMinutes: 0 });
      const subRepeat = await Subscription.findById(sub._id);
      expect(subRepeat.members[0].entitlements[0].remainingQuantity).toBe(2);
      expect(subRepeat.members[0].entitlements[0].usedQuantity).toBe(0);
    });

    it("Scenario A3: Ambiguous operation with missing subscription record is marked failed, never silently exhausted", async () => {
      const apt = await createTestAppointment();
      const nonExistentSubId = new mongoose.Types.ObjectId();
      const aptServiceId = apt.services[0]._id;

      const challengeBroken = await SubscriptionConsumptionChallenge.create({
        organizationId: org._id,
        branchId: branch._id,
        appointmentId: apt._id,
        subscriptionIds: [nonExistentSubId],
        customerId: customer._id,
        serviceIds: [service._id],
        otpHash: "hash-a3",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
        status: "in_redemption",
        redemptionState: "in_redemption",
        decrements: [
          {
            operationId: "broken-op-id",
            subscriptionId: nonExistentSubId,
            memberCustomerId: customer._id,
            serviceId: service._id,
            quantity: 1,
            appointmentServiceId: aptServiceId,
            isDecremented: true,
            isRestored: false,
          },
        ],
      });

      const report = await subscriptionService.reconcileIncompleteRedemptions(org._id, { maxAgeMinutes: 0 });
      expect(report.errors).toBe(1);

      // Verify it was NOT marked 'reconciled' or 'exhausted' as resolved
      const challengeReloaded = await SubscriptionConsumptionChallenge.findById(challengeBroken._id);
      expect(challengeReloaded.redemptionState).toBe("failed");
      expect(challengeReloaded.status).not.toBe("exhausted");
    });
  });

  describe("2. Crash Window B: Restoration Acknowledgment Ambiguity", () => {
    it("Scenario B1: Interruption after restoration claim but before balance restoration — safely executes restoration on restart", async () => {
      const sub = await createTestSubscription(1, 1); // 1 remaining, 1 used
      const apt = await createTestAppointment();
      const aptServiceId = apt.services[0]._id;
      const decOpId = `${apt._id}:${aptServiceId}:dec`;

      // Simulate a crashed worker: set restorationState: "restoring" on challenge, but crash occurred before balance restoration
      const challengeCrashedMidRestore = await SubscriptionConsumptionChallenge.create({
        organizationId: org._id,
        branchId: branch._id,
        appointmentId: apt._id,
        subscriptionIds: [sub._id],
        customerId: customer._id,
        serviceIds: [service._id],
        otpHash: "hash-b1",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
        status: "in_redemption",
        redemptionState: "restoring",
        reconciliationClaimedAt: new Date(Date.now() - 150000), // Stale claim (> 120s old)
        decrements: [
          {
            operationId: decOpId,
            subscriptionId: sub._id,
            memberCustomerId: customer._id,
            serviceId: service._id,
            quantity: 1,
            appointmentServiceId: aptServiceId,
            isDecremented: true,
            isRestored: false, // Balance was NOT restored yet
            restorationState: "restoring",
          },
        ],
      });

      // Verify balance is currently 1
      let subCheck = await Subscription.findById(sub._id);
      expect(subCheck.members[0].entitlements[0].remainingQuantity).toBe(1);

      // Run reconciliation with stale lock timeout
      const report = await subscriptionService.reconcileIncompleteRedemptions(org._id, {
        maxAgeMinutes: 0,
        staleLockTimeoutMs: 60000,
      });
      expect(report.inspected).toBe(1);
      expect(report.reconciledRestored).toBe(1);

      // Verify balance restored to 2
      subCheck = await Subscription.findById(sub._id);
      expect(subCheck.members[0].entitlements[0].remainingQuantity).toBe(2);
      expect(subCheck.members[0].entitlements[0].usedQuantity).toBe(0);

      // Verify challenge finalized
      const challengeFinal = await SubscriptionConsumptionChallenge.findById(challengeCrashedMidRestore._id);
      expect(challengeFinal.status).toBe("exhausted");
      expect(challengeFinal.redemptionState).toBe("reconciled");
      expect(challengeFinal.decrements[0].isRestored).toBe(true);
      expect(challengeFinal.decrements[0].restorationState).toBe("restored");
    });

    it("Scenario B2: Interruption after balance restoration but before restoration confirmation — idempotent guard prevents double-restoration", async () => {
      const sub = await createTestSubscription(1, 1);
      const apt = await createTestAppointment();
      const aptServiceId = apt.services[0]._id;
      const decOpId = `${apt._id}:${aptServiceId}:dec`;

      const challengePreCrash = await SubscriptionConsumptionChallenge.create({
        organizationId: org._id,
        branchId: branch._id,
        appointmentId: apt._id,
        subscriptionIds: [sub._id],
        customerId: customer._id,
        serviceIds: [service._id],
        otpHash: "hash-b2",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
        status: "in_redemption",
        redemptionState: "restoring",
        reconciliationClaimedAt: new Date(Date.now() - 150000),
        decrements: [
          {
            operationId: decOpId,
            subscriptionId: sub._id,
            memberCustomerId: customer._id,
            serviceId: service._id,
            quantity: 1,
            appointmentServiceId: aptServiceId,
            isDecremented: true,
            isRestored: false, // Challenge crashed before setting this to true!
            restorationState: "restoring",
          },
        ],
      });

      const restoreOpId = `${challengePreCrash._id}:${aptServiceId}:restore`;

      // Balance was already restored in Subscription!
      await subscriptionService.subscriptionRepo.atomicRestoreMemberEntitlement(
        sub._id,
        org._id,
        customer._id,
        service._id,
        1,
        null,
        restoreOpId
      );

      // Verify balance is now 2 and restoreOpId is durably registered
      let subCheck = await Subscription.findById(sub._id);
      expect(subCheck.members[0].entitlements[0].remainingQuantity).toBe(2);
      expect(subCheck.appliedOperations).toContain(restoreOpId);

      // Run reconciliation pass
      const report = await subscriptionService.reconcileIncompleteRedemptions(org._id, {
        maxAgeMinutes: 0,
        staleLockTimeoutMs: 60000,
      });
      expect(report.inspected).toBe(1);
      expect(report.reconciledRestored).toBe(1);

      // Verify balance is STILL 2 (MUST NOT have double-restored to 3!)
      subCheck = await Subscription.findById(sub._id);
      expect(subCheck.members[0].entitlements[0].remainingQuantity).toBe(2);
      expect(subCheck.members[0].entitlements[0].usedQuantity).toBe(0);

      // Challenge is finalized
      const challengeFinal = await SubscriptionConsumptionChallenge.findById(challengePreCrash._id);
      expect(challengeFinal.status).toBe("exhausted");
      expect(challengeFinal.redemptionState).toBe("reconciled");
      expect(challengeFinal.decrements[0].isRestored).toBe(true);
      expect(challengeFinal.decrements[0].restorationState).toBe("restored");
    });
  });

  describe("3. Worker & Process Interruption Guarantees", () => {
    it("Scenario C1: Interruption during usage creation and appointment completion — restores balance and cleans up orphan usage records", async () => {
      const sub = await createTestSubscription(2, 0);
      const apt = await createTestAppointment();
      const aptServiceId = apt.services[0]._id;
      const decOpId = `${apt._id}:${aptServiceId}:dec`;

      // Decrement occurred
      await subscriptionService.subscriptionRepo.atomicDecrementMemberEntitlement(
        sub._id,
        org._id,
        customer._id,
        service._id,
        1,
        null,
        decOpId
      );

      // Orphan usage record was created before process crash
      const usage = await SubscriptionUsage.create({
        organizationId: org._id,
        subscriptionId: sub._id,
        customerId: customer._id,
        serviceId: service._id,
        serviceName: service.name,
        quantity: 1,
        branchId: branch._id,
        verifiedBy: user._id,
        verificationMethod: "otp",
        appointmentId: apt._id,
        appointmentServiceId: aptServiceId,
        appointmentCode: apt.appointmentCode,
      });

      // Challenge in decremented state; appointment still in_progress
      const challenge = await SubscriptionConsumptionChallenge.create({
        organizationId: org._id,
        branchId: branch._id,
        appointmentId: apt._id,
        subscriptionIds: [sub._id],
        customerId: customer._id,
        serviceIds: [service._id],
        otpHash: "hash-c1",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
        status: "in_redemption",
        redemptionState: "decremented",
        decrements: [
          {
            operationId: decOpId,
            subscriptionId: sub._id,
            memberCustomerId: customer._id,
            serviceId: service._id,
            quantity: 1,
            appointmentServiceId: aptServiceId,
            isDecremented: true,
            isRestored: false,
          },
        ],
      });

      // Verify usage exists
      expect(await SubscriptionUsage.countDocuments({ appointmentId: apt._id })).toBe(1);

      // Run reconciliation
      await subscriptionService.reconcileIncompleteRedemptions(org._id, { maxAgeMinutes: 0 });

      // Verify balance restored
      const subRestored = await Subscription.findById(sub._id);
      expect(subRestored.members[0].entitlements[0].remainingQuantity).toBe(2);

      // Verify orphan usage record was cleaned up
      expect(await SubscriptionUsage.countDocuments({ appointmentId: apt._id })).toBe(0);

      // Verify appointment status was NOT touched (remains in_progress)
      const aptCheck = await Appointment.findById(apt._id);
      expect(aptCheck.status).toBe("in_progress");
    });

    it("Scenario C2: Concurrent worker execution — prevents overlapping reconciliation passes and duplicate restorations", async () => {
      const sub = await createTestSubscription(2, 0);
      const apt = await createTestAppointment();
      const aptServiceId = apt.services[0]._id;
      const decOpId = `${apt._id}:${aptServiceId}:dec`;

      await subscriptionService.subscriptionRepo.atomicDecrementMemberEntitlement(
        sub._id,
        org._id,
        customer._id,
        service._id,
        1,
        null,
        decOpId
      );

      const challenge = await SubscriptionConsumptionChallenge.create({
        organizationId: org._id,
        branchId: branch._id,
        appointmentId: apt._id,
        subscriptionIds: [sub._id],
        customerId: customer._id,
        serviceIds: [service._id],
        otpHash: "hash-c2",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
        status: "in_redemption",
        redemptionState: "decremented",
        decrements: [
          {
            operationId: decOpId,
            subscriptionId: sub._id,
            memberCustomerId: customer._id,
            serviceId: service._id,
            quantity: 1,
            appointmentServiceId: aptServiceId,
            isDecremented: true,
            isRestored: false,
          },
        ],
      });

      // Simulate 2 parallel workers executing reconciliation concurrently
      const [workerResult1, workerResult2] = await Promise.all([
        subscriptionService.reconcileIncompleteRedemptions(org._id, { maxAgeMinutes: 0 }),
        subscriptionService.reconcileIncompleteRedemptions(org._id, { maxAgeMinutes: 0 }),
      ]);

      // Exactly one worker claims and restores; the other skips or sees no work
      const totalRestored = workerResult1.reconciledRestored + workerResult2.reconciledRestored;
      expect(totalRestored).toBe(1);

      // Balance must be exactly 2 (never double-restored to 3)
      const subFinal = await Subscription.findById(sub._id);
      expect(subFinal.members[0].entitlements[0].remainingQuantity).toBe(2);
      expect(subFinal.members[0].entitlements[0].usedQuantity).toBe(0);
    });

    it("Scenario C3: Environment topology awareness — documents standalone vs replica-set guarantees", () => {
      const supportsTx = isTransactionSupported();
      const topology = mongoose.connection.client?.topology?.description?.type;

      // Assert truth of the current test environment without false claims
      if (!supportsTx) {
        expect(["Single", "Unknown"]).toContain(topology);
        // Explicitly assert that standalone does NOT support multi-document ACID transactions
        expect(supportsTx).toBe(false);
      } else {
        expect(["ReplicaSetWithPrimary", "ReplicaSetNoPrimary", "Sharded"]).toContain(topology);
        expect(supportsTx).toBe(true);
      }
    });
  });

  describe("4. Advanced Edge Cases: Repeated Services, Stale Worker Fencing & Lifecycle Archival", () => {
    it("Scenario D1: Repeated identical services on single appointment — unique service-line identity prevents operation collisions", async () => {
      const sub = await createTestSubscription(2, 0); // Total 2 entitlements
      const aptServiceId1 = new mongoose.Types.ObjectId();
      const aptServiceId2 = new mongoose.Types.ObjectId();

      // Appointment with two identical services
      const apt = await Appointment.create({
        organizationId: org._id,
        branchId: branch._id,
        customerId: customer._id,
        appointmentCode: `APT-REPEATED-${Date.now()}`,
        appointmentDate: "2026-11-01",
        startTime: "10:00",
        endTime: "11:30",
        status: "in_progress",
        bookingType: "advance",
        startAt: new Date(),
        endAt: new Date(Date.now() + 5400000),
        totalDuration: 90,
        pricing: { subtotal: 2000, discount: 0, total: 2000 },
        services: [
          {
            _id: aptServiceId1,
            serviceId: service._id,
            name: service.name,
            price: 1000,
            duration: 45,
            isRedeemedViaSubscription: false,
          },
          {
            _id: aptServiceId2,
            serviceId: service._id,
            name: service.name,
            price: 1000,
            duration: 45,
            isRedeemedViaSubscription: false,
          },
        ],
      });

      const decOpId1 = `${apt._id}:${aptServiceId1}:dec`;
      const decOpId2 = `${apt._id}:${aptServiceId2}:dec`;

      // Both operations decremented on subscription
      await subscriptionService.subscriptionRepo.atomicDecrementMemberEntitlement(
        sub._id,
        org._id,
        customer._id,
        service._id,
        1,
        null,
        decOpId1
      );
      await subscriptionService.subscriptionRepo.atomicDecrementMemberEntitlement(
        sub._id,
        org._id,
        customer._id,
        service._id,
        1,
        null,
        decOpId2
      );

      // Verify both operations recorded distinctly on subscription
      let subCheck = await Subscription.findById(sub._id);
      expect(subCheck.members[0].entitlements[0].remainingQuantity).toBe(0);
      expect(subCheck.members[0].entitlements[0].usedQuantity).toBe(2);
      expect(subCheck.appliedOperations).toContain(decOpId1);
      expect(subCheck.appliedOperations).toContain(decOpId2);

      // Challenge crashed: line 1 was recorded isDecremented: true, but line 2 crashed before isDecremented was set
      const challenge = await SubscriptionConsumptionChallenge.create({
        organizationId: org._id,
        branchId: branch._id,
        appointmentId: apt._id,
        subscriptionIds: [sub._id],
        customerId: customer._id,
        serviceIds: [service._id],
        otpHash: "hash-d1",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
        status: "in_redemption",
        redemptionState: "in_redemption",
        decrements: [
          {
            operationId: decOpId1,
            subscriptionId: sub._id,
            memberCustomerId: customer._id,
            serviceId: service._id,
            quantity: 1,
            appointmentServiceId: aptServiceId1,
            isDecremented: true,
            isRestored: false,
            restorationState: "none",
          },
          {
            operationId: decOpId2,
            subscriptionId: sub._id,
            memberCustomerId: customer._id,
            serviceId: service._id,
            quantity: 1,
            appointmentServiceId: aptServiceId2,
            isDecremented: false, // Lost acknowledgment state
            isRestored: false,
            restorationState: "none",
          },
        ],
      });

      // Run reconciliation
      const report = await subscriptionService.reconcileIncompleteRedemptions(org._id, { maxAgeMinutes: 0 });
      expect(report.inspected).toBe(1);
      expect(report.reconciledRestored).toBe(1);

      // Both lines must be restored cleanly back to 2
      subCheck = await Subscription.findById(sub._id);
      expect(subCheck.members[0].entitlements[0].remainingQuantity).toBe(2);
      expect(subCheck.members[0].entitlements[0].usedQuantity).toBe(0);

      const restoreOpId1 = `${decOpId1}:restore`;
      const restoreOpId2 = `${decOpId2}:restore`;
      expect(subCheck.appliedOperations).toContain(restoreOpId1);
      expect(subCheck.appliedOperations).toContain(restoreOpId2);

      // Repeat reconciliation pass (idempotency check)
      await subscriptionService.reconcileIncompleteRedemptions(org._id, { maxAgeMinutes: 0 });
      subCheck = await Subscription.findById(sub._id);
      expect(subCheck.members[0].entitlements[0].remainingQuantity).toBe(2);
    });

    it("Scenario D2: Stale worker fencing — proves an old/delayed worker cannot commit a decrement after recovery classified it as unapplied", async () => {
      const sub = await createTestSubscription(2, 0);
      const apt = await createTestAppointment();
      const aptServiceId = apt.services[0]._id;
      const decOpId = `${apt._id}:${aptServiceId}:dec`;

      // Challenge created with isDecremented: false, but decrement was delayed in worker
      const challenge = await SubscriptionConsumptionChallenge.create({
        organizationId: org._id,
        branchId: branch._id,
        appointmentId: apt._id,
        subscriptionIds: [sub._id],
        customerId: customer._id,
        serviceIds: [service._id],
        otpHash: "hash-d2",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
        status: "in_redemption",
        redemptionState: "in_redemption",
        decrements: [
          {
            operationId: decOpId,
            subscriptionId: sub._id,
            memberCustomerId: customer._id,
            serviceId: service._id,
            quantity: 1,
            appointmentServiceId: aptServiceId,
            isDecremented: false,
            isRestored: false,
            restorationState: "none",
          },
        ],
      });

      // Recovery runs while old worker is paused.
      // Recovery classifies operation as unapplied and permanently fences decOpId on Subscription
      await subscriptionService.reconcileIncompleteRedemptions(org._id, { maxAgeMinutes: 0 });

      // Verify fence token is recorded in appliedOperations on Subscription
      let subCheck = await Subscription.findById(sub._id);
      expect(subCheck.appliedOperations).toContain(`fence:${decOpId}`);
      expect(subCheck.members[0].entitlements[0].remainingQuantity).toBe(2);

      // Now the old worker wakes up and attempts to commit the decrement
      const decrementResult = await subscriptionService.subscriptionRepo.atomicDecrementMemberEntitlement(
        sub._id,
        org._id,
        customer._id,
        service._id,
        1,
        null,
        decOpId
      );

      // The decrement MUST be rejected by the atomic fence filter ($nin: [decOpId, fence:decOpId])
      expect(decrementResult).toBeNull();

      // Verify balance is completely unchanged
      subCheck = await Subscription.findById(sub._id);
      expect(subCheck.members[0].entitlements[0].remainingQuantity).toBe(2);
      expect(subCheck.members[0].entitlements[0].usedQuantity).toBe(0);
    });

    it("Scenario D3: appliedOperations lifecycle archival — prunes eligible terminal operation IDs without breaking idempotency", async () => {
      const sub = await createTestSubscription(2, 0);
      const op1 = `op-old-1-${Date.now()}`;
      const op2 = `op-old-2-${Date.now()}`;
      const opActive = `op-active-${Date.now()}`;

      // Seed operations in appliedOperations
      await Subscription.updateOne(
        { _id: sub._id },
        { $push: { appliedOperations: { $each: [op1, op2, opActive] } } }
      );

      let subCheck = await Subscription.findById(sub._id);
      expect(subCheck.appliedOperations).toHaveLength(3);
      expect(subCheck.archivedOperationsCount).toBe(0);

      // Prune only terminal, non-retryable operations [op1, op2]
      const pruned = await subscriptionService.subscriptionRepo.pruneArchivedOperations(sub._id, [op1, op2]);
      expect(pruned.appliedOperations).toEqual([opActive]);
      expect(pruned.archivedOperationsCount).toBe(2);

      // Subsequent decrement with a new operation still functions atomically
      const newOp = `op-new-${Date.now()}`;
      const decremented = await subscriptionService.subscriptionRepo.atomicDecrementMemberEntitlement(
        sub._id,
        org._id,
        customer._id,
        service._id,
        1,
        null,
        newOp
      );
      expect(decremented.members[0].entitlements[0].remainingQuantity).toBe(1);
      expect(decremented.appliedOperations).toContain(newOp);
      expect(decremented.archivedOperationsCount).toBe(2);
    });

    it("Scenario D4: Redis distributed lock ownership token & fallback safety", async () => {
      const { runSubscriptionReconciliationPass } = await import("../../workers/subscriptionReconciliation.worker.js");

      // 1. Worker pass succeeds with mocked Redis
      const report = await runSubscriptionReconciliationPass();
      expect(report).not.toBeNull();

      // 2. Worker pass succeeds even if Redis throws a connection failure (falls back to DB CAS)
      const originalSet = redis.set;
      redis.set = jest.fn().mockRejectedValue(new Error("ECONNREFUSED: Redis offline"));

      const fallbackReport = await runSubscriptionReconciliationPass();
      expect(fallbackReport).not.toBeNull();

      redis.set = originalSet;
    });

    it("Scenario D5: Legacy appointments and missing line IDs — safe fallback and idempotency across retries", async () => {
      const sub = await createTestSubscription(2, 0);
      const apt = await createTestAppointment();

      // Simulate legacy challenge decrement created before appointmentServiceId schema field existed:
      // decrements entry has its own subdocument _id, but appointmentServiceId is undefined
      const challengeLegacy = await SubscriptionConsumptionChallenge.create({
        organizationId: org._id,
        branchId: branch._id,
        appointmentId: apt._id,
        subscriptionIds: [sub._id],
        customerId: customer._id,
        serviceIds: [service._id],
        otpHash: "hash-d5",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
        status: "in_redemption",
        redemptionState: "in_redemption",
        decrements: [
          {
            subscriptionId: sub._id,
            memberCustomerId: customer._id,
            serviceId: service._id,
            quantity: 1,
            isDecremented: true,
            isRestored: false,
          },
        ],
      });

      const decSubdoc = challengeLegacy.decrements[0];
      const legacyLineId = decSubdoc._id;
      const expectedDecOpId = `${challengeLegacy._id}:${legacyLineId}:dec`;

      await subscriptionService.subscriptionRepo.atomicDecrementMemberEntitlement(
        sub._id,
        org._id,
        customer._id,
        service._id,
        1,
        null,
        expectedDecOpId
      );

      let subCheck = await Subscription.findById(sub._id);
      expect(subCheck.members[0].entitlements[0].remainingQuantity).toBe(1);
      expect(subCheck.appliedOperations).toContain(expectedDecOpId);

      // Run reconciliation: should use dec._id when appointmentServiceId is absent
      const report = await subscriptionService.reconcileIncompleteRedemptions(org._id, { maxAgeMinutes: 0 });
      expect(report.inspected).toBe(1);
      expect(report.reconciledRestored).toBe(1);

      // Verify balance restored cleanly back to 2
      subCheck = await Subscription.findById(sub._id);
      expect(subCheck.members[0].entitlements[0].remainingQuantity).toBe(2);
      expect(subCheck.appliedOperations).toContain(`${expectedDecOpId}:restore`);

      // Verify repeat reconciliation pass is completely idempotent
      await subscriptionService.reconcileIncompleteRedemptions(org._id, { maxAgeMinutes: 0 });
      subCheck = await Subscription.findById(sub._id);
      expect(subCheck.members[0].entitlements[0].remainingQuantity).toBe(2);
    });
  });

});
