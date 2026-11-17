import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { auditPlugin } from '../../database/plugins/audit.js';
import { getIsolatedTestMongoUri } from '../testSetup.js';
import { verifyAttendanceE2EOwnership } from '../../e2e/attendanceE2EOwnership.js';

mongoose.plugin(auditPlugin);

const { Attendance } = await import('../../models/attendance/attendance.model.js');
const { AttendancePunch } = await import('../../models/attendance/attendancePunch.model.js');
const { RawProviderEvent } = await import('../../models/attendance/RawProviderEvent.model.js');
const { StaffDeviceMapping } = await import('../../models/attendance/StaffDeviceMapping.model.js');
const { ProviderConfiguration } = await import('../../models/attendance/ProviderConfiguration.model.js');
const { ProviderDeliveryLog } = await import('../../models/attendance/ProviderDeliveryLog.model.js');
const { ProviderSyncState } = await import('../../models/attendance/ProviderSyncState.model.js');
const { AttendanceBranchConflict } = await import('../../models/attendance/AttendanceLeaveAppointmentConflict.model.js');
const { Branch } = await import('../../models/branches/branch.model.js');
const { ingestProviderEvents } = await import('../../services/attendance/attendance.service.js');

const indexedModels = [
  Attendance,
  AttendancePunch,
  RawProviderEvent,
  StaffDeviceMapping,
  ProviderConfiguration,
  ProviderDeliveryLog,
  ProviderSyncState,
  AttendanceBranchConflict,
];

describe('Attendance MongoDB persistence integration', () => {
  jest.setTimeout(30000);
  const dedicatedE2E = process.env.ATTENDANCE_E2E_PERSISTENCE === '1';
  const ownershipMarkerPath = path.resolve(process.cwd(), '.attendance-e2e-owner.json');
  let organizationId;
  let branchA;
  let branchB;
  let branchC;
  let staffId;

  beforeAll(async () => {
    const mongoUri = dedicatedE2E
      ? process.env.ATTENDANCE_E2E_MONGO_URI
      : getIsolatedTestMongoUri('attendance_test');
    if (dedicatedE2E && (!mongoUri || !fs.existsSync(ownershipMarkerPath))) {
      throw new Error('Dedicated Attendance E2E persistence requires a database ownership marker.');
    }
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 10000,
      autoIndex: false,
      autoCreate: false,
    });
    if (dedicatedE2E) {
      const { validateAttendanceE2EConfig } = await import('../../e2e/attendanceE2EConfig.js');
      const config = validateAttendanceE2EConfig();
      await verifyAttendanceE2EOwnership(mongoose.connection.db, config);
    }
    await Promise.all(indexedModels.map((model) => model.createIndexes()));
  });

  afterEach(async () => {
    if (mongoose.connection.readyState === 1 && organizationId) {
      await Promise.all(indexedModels.map((model) => model.deleteMany({ organizationId })));
      await Branch.deleteMany({ organizationId });
    }
  });

  afterAll(async () => {
    if (mongoose.connection.readyState === 1) await mongoose.disconnect();
  });

  beforeEach(async () => {
    organizationId = new mongoose.Types.ObjectId();
    staffId = new mongoose.Types.ObjectId();
    [branchA, branchB, branchC] = await Branch.create([
      { organizationId, name: `Attendance A ${organizationId}`, timezone: 'Asia/Kolkata' },
      { organizationId, name: `Attendance B ${organizationId}`, timezone: 'America/New_York' },
      { organizationId, name: `Attendance C ${organizationId}`, timezone: 'America/New_York' },
    ]);

    await Promise.all([branchA, branchB, branchC].map(async (branch, index) => {
      await ProviderConfiguration.create({
        organizationId,
        branchId: branch._id,
        providerName: 'simulator',
        isActive: true,
      });
      await StaffDeviceMapping.create({
        organizationId,
        branchId: branch._id,
        provider: 'simulator',
        deviceId: `device-${index}`,
        externalEmployeeCode: 'employee-1',
        staffId,
        isActive: true,
      });
    }));
  });

  const ingest = (branch, deviceId, events, checkpoint = 'checkpoint-1') =>
    ingestProviderEvents({
      providerName: 'simulator',
      organizationId,
      branchId: branch._id,
      actorId: new mongoose.Types.ObjectId(),
      events: events.map((event) => ({ employeeCode: 'employee-1', deviceId, ...event })),
      checkpoint,
      streamIdentifier: 'realtime',
      request: {},
    });

  it('enforces raw-event ID uniqueness while retaining multiple events without stable IDs', async () => {
    const rawEventIndexes = await RawProviderEvent.collection.indexes();
    expect(rawEventIndexes).toContainEqual(expect.objectContaining({
      key: { organizationId: 1, provider: 1, deviceId: 1, externalEventId: 1 },
      unique: true,
      partialFilterExpression: { isDeleted: false, externalEventId: { $type: 'string' } },
    }));
    const raw = {
      organizationId,
      provider: 'simulator',
      deviceId: 'device-raw',
      externalEventId: ' stable-1 ',
      rawPayload: { event: 1 },
    };
    await RawProviderEvent.create(raw);
    await expect(RawProviderEvent.create(raw)).rejects.toMatchObject({ code: 11000 });

    await RawProviderEvent.create({ ...raw, externalEventId: '   ', rawPayload: { event: 2 } });
    await RawProviderEvent.create({ ...raw, externalEventId: undefined, rawPayload: { event: 3 } });
    await RawProviderEvent.create({ ...raw, isDeleted: true, rawPayload: { event: 4 } });
    expect(await RawProviderEvent.collection.countDocuments({ organizationId, deviceId: 'device-raw' })).toBe(4);
  });

  it('enforces attendance identity uniqueness across concurrent branch claims', async () => {
    const attendanceIndexes = await Attendance.collection.indexes();
    expect(attendanceIndexes).toContainEqual(expect.objectContaining({
      key: { organizationId: 1, staffId: 1, attendanceDate: 1 },
      unique: true,
      partialFilterExpression: { isDeleted: false },
    }));
    const attendanceDate = new Date('2024-06-01T00:00:00.000Z');
    const claims = await Promise.allSettled([
      Attendance.create({ organizationId, branchId: branchA._id, staffId, attendanceDate }),
      Attendance.create({ organizationId, branchId: branchB._id, staffId, attendanceDate }),
    ]);
    expect(claims.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(claims.find(({ status }) => status === 'rejected')?.reason).toMatchObject({ code: 11000 });
    expect(await Attendance.countDocuments({ organizationId, staffId, attendanceDate })).toBe(1);
  });

  it('persists raw, punch, delivery, attendance and checkpoint; duplicate stable delivery is idempotent', async () => {
    const punchIndexes = await AttendancePunch.collection.indexes();
    expect(punchIndexes).toContainEqual(expect.objectContaining({
      key: { organizationId: 1, provider: 1, deviceId: 1, externalEventId: 1 },
      unique: true,
      partialFilterExpression: { isDeleted: false, externalEventId: { $type: 'string' } },
    }));
    const event = {
      externalEventId: 'attendance-event-1',
      punchAt: '2024-06-01T08:30:00.000Z',
      punchType: 'in',
    };

    const initial = await ingest(branchA, 'device-0', [event]);
    const duplicate = await ingest(branchA, 'device-0', [event], 'checkpoint-2');

    expect(initial.results[0].isDuplicate).toBe(false);
    expect(duplicate.results[0].isDuplicate).toBe(true);
    expect(await RawProviderEvent.countDocuments({ organizationId, externalEventId: event.externalEventId })).toBe(1);
    expect(await AttendancePunch.countDocuments({ organizationId, externalEventId: event.externalEventId })).toBe(1);
    expect(await ProviderDeliveryLog.countDocuments({ organizationId, externalEventId: event.externalEventId })).toBe(2);
    expect((await ProviderSyncState.findOne({ organizationId, deviceId: 'device-0' })).lastSuccessfulCheckpoint)
      .toBe('checkpoint-2');

    await expect(AttendancePunch.create({
      organizationId,
      branchId: branchA._id,
      staffId,
      punchType: 'in',
      punchAt: event.punchAt,
      provider: 'simulator',
      deviceId: 'device-0',
      externalEventId: event.externalEventId,
    })).rejects.toMatchObject({ code: 11000 });
    await AttendancePunch.create({
      organizationId,
      branchId: branchA._id,
      staffId,
      punchType: 'in',
      punchAt: event.punchAt,
      provider: 'simulator',
      deviceId: 'device-0',
      externalEventId: event.externalEventId,
      isDeleted: true,
    });
  });

  it('credits a day only after a chronological in/out pair and recovers status on idempotent retries', async () => {
    const checkIn = {
      externalEventId: 'eligibility-check-in',
      punchAt: '2024-06-05T05:00:00.000Z',
      punchType: 'in',
    };
    const checkOut = {
      externalEventId: 'eligibility-check-out',
      punchAt: '2024-06-05T12:00:00.000Z',
      punchType: 'out',
    };

    await ingest(branchA, 'device-0', [checkIn]);
    let attendance = await Attendance.findOne({ organizationId, staffId });
    expect(attendance.status).toBe('incomplete');

    await ingest(branchA, 'device-0', [checkIn], 'check-in-retry');
    expect(await AttendancePunch.countDocuments({ organizationId, staffId })).toBe(1);
    expect((await Attendance.findOne({ organizationId, staffId })).status).toBe('incomplete');

    await ingest(branchA, 'device-0', [checkOut], 'check-out');
    attendance = await Attendance.findOne({ organizationId, staffId });
    expect(attendance.status).toBe('present');
    expect(await Attendance.countDocuments({ organizationId, staffId })).toBe(1);
    expect(await AttendancePunch.countDocuments({ organizationId, staffId })).toBe(2);

    await ingest(branchA, 'device-0', [checkOut], 'check-out-retry');
    expect((await Attendance.findOne({ organizationId, staffId })).status).toBe('present');
    expect(await AttendancePunch.countDocuments({ organizationId, staffId })).toBe(2);
  });

  it('does not count repeated same-direction or out-of-order punches as attendance and preserves corrections', async () => {
    await ingest(branchA, 'device-0', [
      { externalEventId: 'duplicate-in-1', punchAt: '2024-06-06T05:00:00.000Z', punchType: 'in' },
      { externalEventId: 'duplicate-in-2', punchAt: '2024-06-06T05:00:00.000Z', punchType: 'in' },
      { externalEventId: 'early-out', punchAt: '2024-06-06T04:00:00.000Z', punchType: 'out' },
    ]);
    let attendance = await Attendance.findOne({ organizationId, staffId });
    expect(attendance.status).toBe('incomplete');

    await ingest(branchA, 'device-0', [{
      externalEventId: 'valid-out',
      punchAt: '2024-06-06T12:00:00.000Z',
      punchType: 'out',
    }]);
    attendance = await Attendance.findOne({ organizationId, staffId });
    expect(attendance.status).toBe('present');

    attendance.status = 'late';
    attendance.isReconciled = true;
    attendance.reconciliationReason = 'Manager verified late arrival';
    await attendance.save();
    await ingest(branchA, 'device-0', [{
      externalEventId: 'later-duplicate-out',
      punchAt: '2024-06-06T13:00:00.000Z',
      punchType: 'out',
    }]);

    attendance = await Attendance.findOne({ organizationId, staffId });
    expect(attendance.status).toBe('late');
    expect(attendance.isReconciled).toBe(true);
  });

  it('repairs a failed attendance status write when the stable provider event is retried', async () => {
    await ingest(branchA, 'device-0', [{
      externalEventId: 'repair-check-in',
      punchAt: '2024-06-07T05:00:00.000Z',
      punchType: 'in',
    }]);

    const originalUpdate = Attendance.findOneAndUpdate.bind(Attendance);
    let failDerivedStatusWrite = true;
    const updateSpy = jest.spyOn(Attendance, 'findOneAndUpdate').mockImplementation(async (filter, ...args) => {
      if (failDerivedStatusWrite && filter?._id && filter.isReconciled) {
        failDerivedStatusWrite = false;
        return null;
      }
      return originalUpdate(filter, ...args);
    });

    try {
      await expect(ingest(branchA, 'device-0', [{
        externalEventId: 'repair-check-out',
        punchAt: '2024-06-07T12:00:00.000Z',
        punchType: 'out',
      }])).rejects.toThrow('Attendance status could not be durably reconciled');
    } finally {
      updateSpy.mockRestore();
    }

    expect(await AttendancePunch.countDocuments({ organizationId, staffId })).toBe(2);
    expect((await Attendance.findOne({ organizationId, staffId })).status).toBe('incomplete');

    await ingest(branchA, 'device-0', [{
      externalEventId: 'repair-check-out',
      punchAt: '2024-06-07T12:00:00.000Z',
      punchType: 'out',
    }], 'repair-checkpoint');
    expect((await Attendance.findOne({ organizationId, staffId })).status).toBe('present');
    expect(await AttendancePunch.countDocuments({ organizationId, staffId })).toBe(2);
  });

  it('upserts cross-branch conflicts idempotently and captures distinct branches', async () => {
    const conflictIndexes = await AttendanceBranchConflict.collection.indexes();
    expect(conflictIndexes).toContainEqual(expect.objectContaining({
      key: { organizationId: 1, staffId: 1, date: 1 },
      unique: true,
      partialFilterExpression: { conflictStatus: 'pending' },
    }));
    const event = { externalEventId: 'cross-branch-1', punchAt: '2024-06-01T08:30:00.000Z' };
    await ingest(branchA, 'device-0', [{ ...event, externalEventId: 'branch-a-claim' }]);

    await Promise.all([
      ingest(branchB, 'device-1', [event]),
      ingest(branchC, 'device-2', [{ ...event, externalEventId: 'cross-branch-2' }]),
    ]);
    await ingest(branchB, 'device-1', [event], 'checkpoint-retry');

    const conflicts = await AttendanceBranchConflict.find({ organizationId, staffId, conflictStatus: 'pending' });
    expect(conflicts).toHaveLength(1);
    const involved = conflicts[0].branchesInvolved.map(({ branchId }) => branchId.toString());
    expect(new Set(involved).size).toBe(3);
    expect(involved).toEqual(expect.arrayContaining([
      branchA._id.toString(),
      branchB._id.toString(),
      branchC._id.toString(),
    ]));
  });

  it('retains unmapped events and does not advance checkpoint after transient punch or sync-state failure', async () => {
    const mapping = await StaffDeviceMapping.findOne({
      organizationId,
      branchId: branchA._id,
      externalEmployeeCode: 'employee-1',
    });
    await StaffDeviceMapping.deleteOne({ _id: mapping._id });

    const unmapped = await ingest(branchA, 'device-0', [{
      externalEmployeeCode: 'not-mapped',
      externalEventId: 'unmapped-1',
      punchAt: '2024-06-01T08:30:00.000Z',
    }]);
    expect(unmapped.results[0].mappingStatus).toBe('unmapped');
    expect(await RawProviderEvent.countDocuments({ organizationId, externalEventId: 'unmapped-1' })).toBe(1);
    expect(await ProviderDeliveryLog.findOne({ organizationId, externalEventId: 'unmapped-1' })).toMatchObject({
      status: 'unmapped',
    });

    await StaffDeviceMapping.create({
      organizationId,
      branchId: branchA._id,
      provider: 'simulator',
      deviceId: 'device-0',
      externalEmployeeCode: 'employee-1',
      staffId,
      isActive: true,
    });

    const originalPunchSave = AttendancePunch.prototype.save;
    let failedOnce = false;
    jest.spyOn(AttendancePunch.prototype, 'save').mockImplementation(async function (...args) {
      if (!failedOnce) {
        failedOnce = true;
        throw new Error('injected transient punch write failure');
      }
      return originalPunchSave.apply(this, args);
    });

    const retryEvent = { externalEventId: 'retry-after-write-failure', punchAt: '2024-06-02T08:30:00.000Z' };
    await expect(ingest(branchA, 'device-0', [retryEvent], 'failed-checkpoint'))
      .rejects.toThrow('injected transient punch write failure');
    expect(await AttendancePunch.countDocuments({ organizationId, externalEventId: retryEvent.externalEventId })).toBe(0);
    const failedState = await ProviderSyncState.findOne({ organizationId, deviceId: 'device-0' });
    expect(failedState.lastSuccessfulCheckpoint)
      .not.toBe('failed-checkpoint');
    expect(failedState).toMatchObject({ outcome: 'failed', syncStatus: 'error', retryCount: 1 });
    expect(await ProviderDeliveryLog.findOne({
      organizationId,
      externalEventId: retryEvent.externalEventId,
      status: 'failed',
    })).not.toBeNull();

    jest.restoreAllMocks();
    await ingest(branchA, 'device-0', [retryEvent], 'retry-checkpoint');
    expect(await AttendancePunch.countDocuments({ organizationId, externalEventId: retryEvent.externalEventId })).toBe(1);
    expect((await ProviderSyncState.findOne({ organizationId, deviceId: 'device-0' })).lastSuccessfulCheckpoint)
      .toBe('retry-checkpoint');
  });
});
