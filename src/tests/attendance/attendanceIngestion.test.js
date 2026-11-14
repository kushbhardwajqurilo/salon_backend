import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import mongoose from 'mongoose';
import { Attendance } from '../../models/attendance/attendance.model.js';
import { AttendancePunch } from '../../models/attendance/attendancePunch.model.js';
import { RawProviderEvent } from '../../models/attendance/RawProviderEvent.model.js';
import { StaffDeviceMapping } from '../../models/attendance/StaffDeviceMapping.model.js';
import { ProviderConfiguration } from '../../models/attendance/ProviderConfiguration.model.js';
import { ProviderDeliveryLog } from '../../models/attendance/ProviderDeliveryLog.model.js';
import { ProviderSyncState } from '../../models/attendance/ProviderSyncState.model.js';
import { AttendanceBranchConflict } from '../../models/attendance/AttendanceLeaveAppointmentConflict.model.js';
import { Branch } from '../../models/branches/branch.model.js';
import { deriveBusinessDate, ingestProviderEvents } from '../../services/attendance/attendance.service.js';
import SimulatorAdapter from '../../providers/attendance/simulator.adapter.js';
import eTimeOfficeAdapter from '../../providers/attendance/etimeoffice.adapter.js';
import providerRegistry from '../../providers/attendance/provider.registry.js';

describe('Attendance provider ingestion', () => {
  let savedRawEvents;
  let savedPunches;
  let savedDeliveryLogs;
  let organizationId;
  let branchId;
  let staffId;
  let branch;

  beforeEach(() => {
    savedRawEvents = [];
    savedPunches = [];
    savedDeliveryLogs = [];
    organizationId = new mongoose.Types.ObjectId();
    branchId = new mongoose.Types.ObjectId();
    staffId = new mongoose.Types.ObjectId();
    branch = { _id: branchId, organizationId, isActive: true, timezone: 'Asia/Kolkata' };

    jest.spyOn(ProviderConfiguration, 'findOne').mockResolvedValue({
      organizationId,
      branchId,
      providerName: 'simulator',
      isActive: true,
    });
    jest.spyOn(Branch, 'findOne').mockResolvedValue(branch);
    jest.spyOn(StaffDeviceMapping, 'findOne').mockResolvedValue({ staffId });
    jest.spyOn(RawProviderEvent, 'findOne').mockResolvedValue(null);
    jest.spyOn(AttendancePunch, 'findOne').mockResolvedValue(null);
    jest.spyOn(Attendance, 'claimAttendanceRecord').mockResolvedValue({
      success: true,
      conflict: null,
    });
    jest.spyOn(AttendanceBranchConflict, 'findOneAndUpdate').mockResolvedValue({
      _id: new mongoose.Types.ObjectId(),
    });
    jest.spyOn(ProviderSyncState, 'findOneAndUpdate').mockResolvedValue({});
    jest.spyOn(RawProviderEvent.prototype, 'save').mockImplementation(async function () {
      savedRawEvents.push(this);
      return this;
    });
    jest.spyOn(AttendancePunch.prototype, 'save').mockImplementation(async function () {
      savedPunches.push(this);
      return this;
    });
    jest.spyOn(ProviderDeliveryLog.prototype, 'save').mockImplementation(async function () {
      savedDeliveryLogs.push(this);
      return this;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const ingest = (events) => ingestProviderEvents({
    providerName: 'simulator',
    organizationId,
    branchId,
    actorId: new mongoose.Types.ObjectId(),
    events,
    checkpoint: 'checkpoint-1',
    streamIdentifier: 'realtime',
    request: {},
  });

  const event = (overrides = {}) => ({
    employeeCode: 'EMP-01',
    deviceId: 'SIM-DEV-01',
    punchType: 'in',
    punchAt: '2024-06-01T08:30:00.000Z',
    externalEventId: 'event-1',
    organizationId: new mongoose.Types.ObjectId(),
    branchId: new mongoose.Types.ObjectId(),
    staffId: new mongoose.Types.ObjectId(),
    provider: 'untrusted-provider',
    ...overrides,
  });

  it('normalizes stable, missing, empty, and whitespace-only IDs in raw and punch models', () => {
    for (const Model of [RawProviderEvent, AttendancePunch]) {
      expect(new Model({ externalEventId: '  event-1  ' }).externalEventId).toBe('event-1');
      for (const externalEventId of [undefined, null, '', ' \t ']) {
        expect(new Model({ externalEventId }).externalEventId).toBeUndefined();
      }
    }

    const adapter = new SimulatorAdapter();
    expect(adapter.normalizePayload(event()).externalEventId).toBe('event-1');
    expect(adapter.normalizePayload(event({ externalEventId: '   ' })).externalEventId).toBe('   ');
  });

  it('keeps eTimeOffice explicitly blocked pending official provider documentation', () => {
    expect(() => new eTimeOfficeAdapter().validateRequestSource({})).toThrow(
      /Official API documentation not yet available/,
    );
    expect(() => new eTimeOfficeAdapter().normalizePayload({})).toThrow(
      /Official API documentation not yet available/,
    );
  });

  it('deduplicates stable delivery and recovers the original punch without remapping', async () => {
    await ingest([event({ externalEventId: '  event-1  ' })]);
    const persistedPunch = savedPunches[0];
    expect(persistedPunch.organizationId).toEqual(organizationId);
    expect(persistedPunch.branchId).toEqual(branchId);
    expect(persistedPunch.staffId).toEqual(staffId);
    expect(persistedPunch.provider).toBe('simulator');
    AttendancePunch.findOne.mockResolvedValueOnce(persistedPunch);

    const result = await ingest([event()]);

    expect(savedPunches).toHaveLength(1);
    expect(StaffDeviceMapping.findOne).toHaveBeenCalledTimes(1);
    expect(Attendance.claimAttendanceRecord).toHaveBeenCalledTimes(2);
    expect(result.results[0].isDuplicate).toBe(true);
    expect(savedDeliveryLogs.map((log) => log.status)).toEqual(['success', 'duplicate']);
    expect(ProviderSyncState.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(ProviderConfiguration.findOne).toHaveBeenCalledWith({
      organizationId,
      branchId,
      providerName: 'simulator',
      isActive: true,
    });
    expect(AttendancePunch.findOne.mock.calls[0][0]).toEqual({
      organizationId,
      provider: 'simulator',
      deviceId: 'SIM-DEV-01',
      externalEventId: 'event-1',
      isDeleted: false,
    });
  });

  it('processes repeated events without stable IDs without matching by timestamp or payload', async () => {
    await ingest([event({ externalEventId: undefined })]);
    await ingest([event({ externalEventId: '   ' })]);

    expect(AttendancePunch.findOne).not.toHaveBeenCalled();
    expect(RawProviderEvent.findOne).not.toHaveBeenCalled();
    expect(savedRawEvents).toHaveLength(2);
    expect(savedPunches).toHaveLength(2);
    expect(savedDeliveryLogs.map((log) => log.status)).toEqual(['success', 'success']);
    expect(ProviderSyncState.findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it('uses the trusted branch timezone when claiming attendance during ingestion', async () => {
    branch.timezone = 'America/New_York';
    await ingest([event({ punchAt: '2024-03-10T04:59:00.000Z' })]);

    expect(Attendance.claimAttendanceRecord.mock.calls[0][0].attendanceDate).toBe('2024-03-09');
  });

  it('retains unmapped events without stable IDs and advances only after durable raw and delivery writes', async () => {
    StaffDeviceMapping.findOne.mockResolvedValue(null);
    const payload = event({
      employeeCode: undefined,
      externalEventId: ' \t ',
      organizationId: new mongoose.Types.ObjectId(),
      branchId: new mongoose.Types.ObjectId(),
      staffId: new mongoose.Types.ObjectId(),
    });

    const result = await ingest([payload]);

    expect(result.results[0].mappingStatus).toBe('unmapped');
    expect(savedRawEvents).toHaveLength(1);
    expect(savedRawEvents[0].externalEventId).toBeUndefined();
    expect(savedRawEvents[0].organizationId).toEqual(organizationId);
    expect(savedRawEvents[0].rawPayload.organizationId).toEqual(payload.organizationId);
    expect(savedPunches).toHaveLength(0);
    expect(StaffDeviceMapping.findOne).not.toHaveBeenCalled();
    expect(savedDeliveryLogs[0].status).toBe('unmapped');
    expect(ProviderSyncState.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId, provider: 'simulator', deviceId: 'SIM-DEV-01' }),
      expect.objectContaining({ $set: expect.objectContaining({ lastSuccessfulCheckpoint: 'checkpoint-1' }) }),
      expect.any(Object),
    );
  });

  it('rejects unsupported, disabled, and cross-tenant provider configurations', async () => {
    ProviderConfiguration.findOne.mockResolvedValueOnce({
      organizationId,
      branchId,
      providerName: 'unsupported-provider',
      isActive: true,
    });
    await expect(ingestProviderEvents({
      providerName: 'unsupported-provider',
      organizationId,
      branchId,
      actorId: new mongoose.Types.ObjectId(),
      events: [event()],
      checkpoint: 'checkpoint-1',
      streamIdentifier: 'realtime',
      request: {},
    })).rejects.toThrow(/Unknown provider adapter/);

    ProviderConfiguration.findOne.mockResolvedValueOnce(null);
    await expect(ingest([event()])).rejects.toThrow(/Active provider configuration/);

    ProviderConfiguration.findOne.mockResolvedValueOnce({
      organizationId,
      branchId: new mongoose.Types.ObjectId(),
      providerName: 'simulator',
      isActive: true,
    });
    await expect(ingest([event()])).rejects.toThrow(/Active provider configuration/);

    ProviderConfiguration.findOne.mockResolvedValueOnce({
      organizationId: new mongoose.Types.ObjectId(),
      branchId,
      providerName: 'simulator',
      isActive: true,
    });
    await expect(ingest([event()])).rejects.toThrow(/Active provider configuration/);

    expect(savedPunches).toHaveLength(0);
    expect(ProviderSyncState.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('does not report success or advance the checkpoint when delivery logging fails', async () => {
    ProviderDeliveryLog.prototype.save.mockRejectedValueOnce(new Error('delivery log unavailable'));
    await expect(ingest([event()])).rejects.toThrow('delivery log unavailable');
    expect(savedDeliveryLogs).toHaveLength(1);
    expect(savedDeliveryLogs[0].status).toBe('failed');
    expect(ProviderSyncState.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(ProviderSyncState.findOneAndUpdate.mock.calls[0][1].$set.lastSuccessfulCheckpoint).toBeUndefined();
  });

  it('durably records every raw event as failed when adapter normalization fails', async () => {
    jest.spyOn(providerRegistry, 'createAdapter').mockReturnValue({
      validateRequestSource: async () => null,
      normalizePayload: async (rawPayload) => {
        if (rawPayload.externalEventId === 'invalid-event') {
          throw new Error('invalid provider event');
        }
        return new SimulatorAdapter().normalizePayload(rawPayload);
      },
    });

    await expect(ingest([
      event({ externalEventId: 'valid-event' }),
      event({ externalEventId: 'invalid-event' }),
    ])).rejects.toThrow('invalid provider event');

    expect(savedDeliveryLogs).toHaveLength(2);
    expect(savedDeliveryLogs.map((log) => log.status)).toEqual(['failed', 'failed']);
    expect(savedDeliveryLogs.map((log) => log.rawPayload.externalEventId))
      .toEqual(['valid-event', 'invalid-event']);
    expect(savedPunches).toHaveLength(0);
    expect(ProviderSyncState.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('fails the batch when completion-state persistence returns no document', async () => {
    ProviderSyncState.findOneAndUpdate.mockResolvedValueOnce(null);
    await expect(ingest([event()])).rejects.toThrow(/completion was not durably recorded/);
    expect(savedDeliveryLogs[0].status).toBe('success');
  });

  it('fails a partially processed batch and safely retries it without duplicate punches', async () => {
    let failSecondPunch = true;
    AttendancePunch.findOne.mockImplementation(async (filter) =>
      savedPunches.find((punch) =>
        punch.organizationId.equals(filter.organizationId) &&
        punch.provider === filter.provider &&
        punch.deviceId === filter.deviceId &&
        punch.externalEventId === filter.externalEventId
      ) || null
    );
    RawProviderEvent.findOne.mockImplementation(async (filter) =>
      savedRawEvents.find((rawEvent) =>
        rawEvent.organizationId.equals(filter.organizationId) &&
        rawEvent.provider === filter.provider &&
        rawEvent.deviceId === filter.deviceId &&
        rawEvent.externalEventId === filter.externalEventId
      ) || null
    );
    AttendancePunch.prototype.save.mockImplementation(async function () {
      if (this.externalEventId === 'event-2' && failSecondPunch) {
        failSecondPunch = false;
        throw new Error('temporary punch write failure');
      }
      savedPunches.push(this);
      return this;
    });

    await expect(ingest([event({ externalEventId: 'event-1' }), event({ externalEventId: 'event-2' })]))
      .rejects.toThrow('temporary punch write failure');
    expect(savedPunches.map((punch) => punch.externalEventId)).toEqual(['event-1']);
    expect(ProviderSyncState.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(ProviderSyncState.findOneAndUpdate.mock.calls[0][1].$set.lastSuccessfulCheckpoint).toBeUndefined();

    await ingest([event({ externalEventId: 'event-1' }), event({ externalEventId: 'event-2' })]);
    expect(savedPunches.map((punch) => punch.externalEventId)).toEqual(['event-1', 'event-2']);
    expect(savedDeliveryLogs.map((log) => log.status)).toEqual(['success', 'failed', 'duplicate', 'success']);
    expect(ProviderSyncState.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(ProviderSyncState.findOneAndUpdate.mock.calls[1][1].$set.lastSuccessfulCheckpoint).toBe('checkpoint-1');
  });

  it('persists cross-branch conflict and retries a duplicate-key upsert race', async () => {
    Attendance.claimAttendanceRecord.mockResolvedValue({
      success: false,
      conflict: {
        type: 'cross_branch',
        existingBranch: new mongoose.Types.ObjectId(),
        attemptedBranch: branchId,
        evidence: { punchType: 'in' },
      },
    });
    const duplicateKey = Object.assign(new Error('duplicate conflict'), { code: 11000 });
    AttendanceBranchConflict.findOneAndUpdate
      .mockRejectedValueOnce(duplicateKey)
      .mockResolvedValueOnce({ _id: new mongoose.Types.ObjectId() });

    const result = await ingest([event()]);

    expect(result.results[0].attendanceClaim).toBe('cross_branch');
    expect(AttendanceBranchConflict.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(savedDeliveryLogs[0].status).toBe('success');
    expect(ProviderSyncState.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('records failed sync state without advancing the checkpoint when conflict persistence fails', async () => {
    Attendance.claimAttendanceRecord.mockResolvedValue({
      success: false,
      conflict: {
        type: 'cross_branch',
        existingBranch: new mongoose.Types.ObjectId(),
        attemptedBranch: branchId,
        evidence: {},
      },
    });
    AttendanceBranchConflict.findOneAndUpdate.mockRejectedValue(new Error('conflict store unavailable'));

    await expect(ingest([event()])).rejects.toThrow('conflict store unavailable');

    expect(savedDeliveryLogs.at(-1).status).toBe('failed');
    expect(ProviderSyncState.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const failedSyncUpdate = ProviderSyncState.findOneAndUpdate.mock.calls[0][1].$set;
    expect(failedSyncUpdate.outcome).toBe('failed');
    expect(failedSyncUpdate.syncStatus).toBe('error');
    expect(failedSyncUpdate.lastSuccessfulCheckpoint).toBeUndefined();
  });
});

describe('Branch-local attendance date', () => {
  it('uses the branch date before and after local midnight when UTC date differs', () => {
    expect(deriveBusinessDate('2024-03-10T04:59:00Z', 'America/New_York')).toBe('2024-03-09');
    expect(deriveBusinessDate('2024-03-10T05:01:00Z', 'America/New_York')).toBe('2024-03-10');
  });

  it('rejects missing or invalid timezone configuration', () => {
    expect(() => deriveBusinessDate('2024-01-01T20:00:00Z')).toThrow(/timezone/i);
    expect(() => deriveBusinessDate('2024-01-01T20:00:00Z', '  ')).toThrow(/timezone/i);
    expect(() => deriveBusinessDate('2024-01-01T20:00:00Z', 'Not/A_Timezone')).toThrow(/timezone/i);
    expect(() => deriveBusinessDate('not-a-date', 'Asia/Kolkata')).toThrow(/timestamp/i);
  });

  it('keeps the correct local date across daylight-saving transitions', () => {
    expect(deriveBusinessDate('2024-03-10T06:59:00Z', 'America/New_York')).toBe('2024-03-10');
    expect(deriveBusinessDate('2024-03-10T07:01:00Z', 'America/New_York')).toBe('2024-03-10');
    expect(deriveBusinessDate('2024-11-03T05:59:00Z', 'America/New_York')).toBe('2024-11-03');
    expect(deriveBusinessDate('2024-11-03T06:01:00Z', 'America/New_York')).toBe('2024-11-03');
  });
});
