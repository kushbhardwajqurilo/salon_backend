import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import request from 'supertest';
import { env } from '../../config/env.js';

jest.unstable_mockModule('../../repositories/users/user.repository.js', () => ({
  UserRepository: class {
    async findById() {
      return globalThis.__attendanceTestUser;
    }
  },
}));

jest.unstable_mockModule('../../repositories/roles/role.repository.js', () => ({
  RoleRepository: class {
    async findByNameInOrg() {
      return {
        isSystem: false,
        permissions: (globalThis.__attendanceTestPermissions || []).map((name) => ({ name })),
      };
    }
    async findByName() {
      return null;
    }
  },
}));

jest.unstable_mockModule('../../utils/redis.js', () => ({
  redis: {
    get: jest.fn().mockResolvedValue(null),
    setex: jest.fn().mockResolvedValue('OK'),
  },
}));

jest.unstable_mockModule('../../models/branches/branch.model.js', () => ({
  Branch: {
    findOne: jest.fn(async ({ _id, organizationId, isActive }) => {
      const branch = globalThis.__attendanceTestBranch;
      if (!branch || !isActive || !branch.isActive) return null;
      if (String(_id) !== String(branch._id) || String(organizationId) !== String(branch.organizationId)) return null;
      return branch;
    }),
    find: jest.fn().mockResolvedValue([]),
  },
}));

jest.unstable_mockModule('../../services/attendance/attendance.service.js', () => ({
  listAttendanceRecords: jest.fn(async (input) => {
    globalThis.__attendanceCapturedInput = input;
    return { data: [], total: 0 };
  }),
  getStaffAttendanceDetail: jest.fn(async (input) => input),
  adjustAttendanceRecord: jest.fn(async (input) => input),
  listBranchAttendanceConflicts: jest.fn(async () => []),
  listLeaveAppointmentConflicts: jest.fn(async () => ({ data: [], total: 0 })),
  recordLeaveException: jest.fn(async (input) => input),
  resolveBranchAttendanceConflict: jest.fn(async (input) => input),
  resolveLeaveAppointmentConflict: jest.fn(async (input) => input),
  getProviderStatus: jest.fn(async () => ({ configurations: [], syncStates: [] })),
  ingestProviderEvents: jest.fn(async (input) => {
    globalThis.__attendanceCapturedInput = input;
    return { provider: input.providerName, checkpoint: input.checkpoint, results: [] };
  }),
  listStaffDeviceMappings: jest.fn(async () => ({ mappings: [], pagination: { total: 0, page: 1, limit: 20, totalPages: 1 } })),
  getStaffDeviceMappingById: jest.fn(async (input) => input),
  createStaffDeviceMapping: jest.fn(async (input) => input),
  updateStaffDeviceMapping: jest.fn(async (input) => input),
  deactivateStaffDeviceMapping: jest.fn(async (input) => input),
  recordStaffPunch: jest.fn(async (input) => input),
  getMonthlyMusterRoll: jest.fn(async () => ({ totalStaff: 0, consolidatedTotals: {}, musterRoll: [] })),
}));

const { default: attendanceRouter } = await import('../../routers/attendance/attendance.router.js');
const { ingestProviderEvents, listAttendanceRecords, adjustAttendanceRecord } =
  await import('../../services/attendance/attendance.service.js');
const { globalErrorHandler } = await import('../../utils/errors.js');

const app = express();
app.use(express.json());
app.use('/api/v1/attendance', attendanceRouter);
app.use(globalErrorHandler);

describe('Attendance route authorization and trusted tenant scope', () => {
  let organizationId;
  let branchId;
  let otherBranchId;
  let userId;
  let token;

  beforeEach(() => {
    organizationId = new mongoose.Types.ObjectId();
    branchId = new mongoose.Types.ObjectId();
    otherBranchId = new mongoose.Types.ObjectId();
    userId = new mongoose.Types.ObjectId();
    globalThis.__attendanceTestPermissions = ['attendance.punch'];
    globalThis.__attendanceTestBranch = { _id: branchId, organizationId, isActive: true, timezone: 'Asia/Kolkata' };
    globalThis.__attendanceTestUser = {
      _id: userId,
      organizationId,
      role: 'staff',
      status: 'active',
      hasOrgWideAccess: false,
      branchAccess: [{ branchId, isActive: true }],
    };
    token = jwt.sign({ id: userId.toString() }, env.JWT_SECRET);
    globalThis.__attendanceCapturedInput = undefined;
    ingestProviderEvents.mockClear();
    listAttendanceRecords.mockClear();
    adjustAttendanceRecord.mockClear();
  });

  afterEach(() => {
    delete globalThis.__attendanceTestUser;
    delete globalThis.__attendanceTestBranch;
    delete globalThis.__attendanceTestPermissions;
    delete globalThis.__attendanceCapturedInput;
  });

  const authorized = (method, path, targetBranch = branchId) =>
    request(app)[method](path).auth(token, { type: 'bearer' }).set('X-Branch-Id', targetBranch.toString());

  it('rejects unauthenticated provider requests', async () => {
    const response = await request(app)
      .post('/api/v1/attendance/providers/simulator/events')
      .set('X-Branch-Id', branchId.toString())
      .send({ checkpoint: 'checkpoint-1', streamIdentifier: 'realtime', events: [{}] });
    expect(response.status).toBe(401);
    expect(ingestProviderEvents).not.toHaveBeenCalled();
  });

  it('rejects authenticated users without the provider permission', async () => {
    globalThis.__attendanceTestPermissions = ['attendance.view'];
    const response = await authorized('post', '/api/v1/attendance/providers/simulator/events')
      .send({ checkpoint: 'checkpoint-1', streamIdentifier: 'realtime', events: [{}] });
    expect(response.status).toBe(403);
    expect(ingestProviderEvents).not.toHaveBeenCalled();
  });

  it('rejects inactive and unauthorized branches before ingestion', async () => {
    globalThis.__attendanceTestBranch.isActive = false;
    expect((await authorized('post', '/api/v1/attendance/providers/simulator/events')).status).toBe(404);
    globalThis.__attendanceTestBranch.isActive = true;
    expect((await authorized('post', '/api/v1/attendance/providers/simulator/events', otherBranchId)).status).toBe(404);
    globalThis.__attendanceTestBranch._id = otherBranchId;
    expect((await authorized('post', '/api/v1/attendance/providers/simulator/events', otherBranchId)).status).toBe(403);
    expect(ingestProviderEvents).not.toHaveBeenCalled();
  });

  it('uses authenticated organization and active branch, not provider payload identities', async () => {
    const spoofed = {
      organizationId: new mongoose.Types.ObjectId().toString(),
      branchId: new mongoose.Types.ObjectId().toString(),
      staffId: new mongoose.Types.ObjectId().toString(),
      punchType: 'in',
    };
    const response = await authorized('post', '/api/v1/attendance/providers/simulator/events')
      .send({ checkpoint: 'checkpoint-1', streamIdentifier: 'realtime', events: [spoofed] });
    expect(response.status).toBe(200);
    expect(globalThis.__attendanceCapturedInput).toEqual(expect.objectContaining({
      organizationId,
      branchId,
      actorId: userId,
      events: [spoofed],
    }));
    expect(globalThis.__attendanceCapturedInput.organizationId).not.toBe(spoofed.organizationId);
    expect(globalThis.__attendanceCapturedInput.branchId).not.toBe(spoofed.branchId);
  });

  it('requires attendance.view and ignores tenant identity supplied in query parameters', async () => {
    globalThis.__attendanceTestPermissions = ['attendance.punch'];
    const denied = await authorized('get', '/api/v1/attendance/records?date=2026-11-14');
    expect(denied.status).toBe(403);
    globalThis.__attendanceTestPermissions = ['attendance.view'];
    const allowed = await authorized('get', '/api/v1/attendance/records?date=2026-11-14&organizationId=spoofed');
    expect(allowed.status).toBe(200);
    expect(globalThis.__attendanceCapturedInput).toEqual(expect.objectContaining({ organizationId, branchId, date: '2026-11-14' }));
    expect(globalThis.__attendanceCapturedInput.organizationId).not.toBe('spoofed');
  });

  it('requires attendance.adjust for manual attendance changes', async () => {
    globalThis.__attendanceTestPermissions = ['attendance.view'];
    const response = await authorized('post', '/api/v1/attendance/records/adjust')
      .send({ staffId: new mongoose.Types.ObjectId().toString(), date: '2026-11-14', status: 'present', reason: 'Reviewed records' });
    expect(response.status).toBe(403);
    expect(adjustAttendanceRecord).not.toHaveBeenCalled();
  });
});
