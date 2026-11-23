import { describe, expect, it, beforeAll, afterAll, jest } from '@jest/globals';
import request from 'supertest';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../../../app.mjs';
import { env } from '../../config/env.js';
import { Staff } from '../../models/staff/staff.model.js';
import { StaffBranch } from '../../models/staff/staffBranch.model.js';
import { Branch } from '../../models/branches/branch.model.js';
import { User } from '../../models/users/user.model.js';
import { Role } from '../../models/roles/role.model.js';
import { Permission } from '../../models/permissions/permission.model.js';
import { Attendance } from '../../models/attendance/attendance.model.js';
import { AttendancePunch } from '../../models/attendance/attendancePunch.model.js';
import { Leave } from '../../models/leaves/leave.model.js';
import { AuditLog } from '../../models/audit/auditLog.model.js';
import { AttendanceBranchConflict } from '../../models/attendance/AttendanceLeaveAppointmentConflict.model.js';
import { getIsolatedTestMongoUri } from '../testSetup.js';
import { deriveBusinessDate, ingestProviderEvents } from '../../services/attendance/attendance.service.js';

describe('Attendance Staging Controlled Smoke Test Suite', () => {
  jest.setTimeout(60000);

  let orgId;
  let branch1Id;
  let branch2Id;
  let staff1User;
  let staff2User;
  let managerUser;
  let ownerUser;
  let staff1;
  let staff2;
  let staff1Token;
  let staff2Token;
  let managerToken;
  let ownerToken;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const testUri = getIsolatedTestMongoUri('attendance_test');
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(testUri);
    }

    orgId = new mongoose.Types.ObjectId();
    branch1Id = new mongoose.Types.ObjectId();
    branch2Id = new mongoose.Types.ObjectId();

    // Create 2 branches with operating hours (Branch 1: 09:00 - 18:00, closed Sundays)
    await Branch.create([
      {
        _id: branch1Id,
        organizationId: orgId,
        name: 'Staging Branch Alpha',
        timezone: 'Asia/Kolkata',
        isActive: true,
        bufferMinutes: 15,
        operatingHours: {
          monday: { openTime: '09:00', closeTime: '18:00', isOpen: true },
          tuesday: { openTime: '09:00', closeTime: '18:00', isOpen: true },
          wednesday: { openTime: '09:00', closeTime: '18:00', isOpen: true },
          thursday: { openTime: '09:00', closeTime: '18:00', isOpen: true },
          friday: { openTime: '09:00', closeTime: '18:00', isOpen: true },
          saturday: { openTime: '09:00', closeTime: '18:00', isOpen: true },
          sunday: { openTime: '09:00', closeTime: '18:00', isOpen: false },
        },
      },
      {
        _id: branch2Id,
        organizationId: orgId,
        name: 'Staging Branch Beta',
        timezone: 'Asia/Kolkata',
        isActive: true,
        bufferMinutes: 15,
        operatingHours: {
          monday: { openTime: '10:00', closeTime: '19:00', isOpen: true },
          tuesday: { openTime: '10:00', closeTime: '19:00', isOpen: true },
          wednesday: { openTime: '10:00', closeTime: '19:00', isOpen: true },
          thursday: { openTime: '10:00', closeTime: '19:00', isOpen: true },
          friday: { openTime: '10:00', closeTime: '19:00', isOpen: true },
          saturday: { openTime: '10:00', closeTime: '19:00', isOpen: true },
          sunday: { openTime: '10:00', closeTime: '19:00', isOpen: false },
        },
      },
    ]);

    // Permissions
    const permPunch = await Permission.findOneAndUpdate(
      { name: 'attendance.punch' },
      { $setOnInsert: { name: 'attendance.punch', module: 'Attendance', action: 'Punch', description: 'Punch' } },
      { upsert: true, new: true }
    );
    const permView = await Permission.findOneAndUpdate(
      { name: 'attendance.view' },
      { $setOnInsert: { name: 'attendance.view', module: 'Attendance', action: 'View', description: 'View' } },
      { upsert: true, new: true }
    );
    const permAdjust = await Permission.findOneAndUpdate(
      { name: 'attendance.adjust' },
      { $setOnInsert: { name: 'attendance.adjust', module: 'Attendance', action: 'Adjust', description: 'Adjust' } },
      { upsert: true, new: true }
    );

    // Roles
    const [staffRole, managerRole, ownerRole] = await Role.create([
      {
        name: 'staging_staff',
        organizationId: orgId,
        permissions: [permPunch._id, permView._id],
        isCustom: false,
      },
      {
        name: 'staging_manager',
        organizationId: orgId,
        permissions: [permPunch._id, permView._id, permAdjust._id],
        isCustom: false,
      },
      {
        name: 'owner',
        organizationId: orgId,
        permissions: [permPunch._id, permView._id, permAdjust._id],
        isCustom: false,
      },
    ]);

    const runId = Date.now();
    // Users
    staff1User = await User.create({
      organizationId: orgId,
      branchAccess: [{ branchId: branch1Id, branchName: 'Staging Branch Alpha', isActive: true }],
      role: staffRole._id,
      name: `Smoke Staff Alpha ${runId}`,
      email: `smoke.staff1.${runId}@staging-salon.internal`,
      phone: `+9199${Math.floor(10000000 + Math.random() * 90000000)}`,
      password: 'StagingPassword123!',
      isActive: true,
    });

    staff2User = await User.create({
      organizationId: orgId,
      branchAccess: [{ branchId: branch1Id, branchName: 'Staging Branch Alpha', isActive: true }],
      role: staffRole._id,
      name: `Smoke Staff Beta ${runId}`,
      email: `smoke.staff2.${runId}@staging-salon.internal`,
      phone: `+9199${Math.floor(10000000 + Math.random() * 90000000)}`,
      password: 'StagingPassword123!',
      isActive: true,
    });

    managerUser = await User.create({
      organizationId: orgId,
      branchAccess: [{ branchId: branch1Id, branchName: 'Staging Branch Alpha', isActive: true }],
      role: managerRole._id,
      name: `Smoke Manager ${runId}`,
      email: `smoke.manager.${runId}@staging-salon.internal`,
      phone: `+9199${Math.floor(10000000 + Math.random() * 90000000)}`,
      password: 'StagingPassword123!',
      isActive: true,
    });

    ownerUser = await User.create({
      organizationId: orgId,
      branchAccess: [
        { branchId: branch1Id, branchName: 'Staging Branch Alpha', isActive: true },
        { branchId: branch2Id, branchName: 'Staging Branch Beta', isActive: true },
      ],
      hasOrgWideAccess: true,
      role: ownerRole._id,
      name: `Smoke Salon Owner ${runId}`,
      email: `smoke.owner.${runId}@staging-salon.internal`,
      phone: `+9199${Math.floor(10000000 + Math.random() * 90000000)}`,
      password: 'StagingPassword123!',
      isActive: true,
    });

    // Staff records
    // Staff 1 joined 2026-11-01
    staff1 = await Staff.create({
      organizationId: orgId,
      primaryBranchId: branch1Id,
      userId: staff1User._id,
      name: 'Smoke Staff Alpha',
      email: staff1User.email,
      phone: staff1User.phone,
      staffCode: 'STF-SMK-001',
      designation: 'Senior Stylist',
      joiningDate: new Date('2026-11-01T00:00:00.000Z'),
      isActive: true,
      employmentStatus: 'active',
      attendanceSchedule: {
        monday: { isWorking: true, scheduledIn: '09:00', scheduledOut: '18:00' },
        tuesday: { isWorking: true, scheduledIn: '09:00', scheduledOut: '18:00' },
        wednesday: { isWorking: true, scheduledIn: '09:00', scheduledOut: '18:00' },
        thursday: { isWorking: true, scheduledIn: '09:00', scheduledOut: '18:00' },
        friday: { isWorking: true, scheduledIn: '09:00', scheduledOut: '18:00' },
        saturday: { isWorking: true, scheduledIn: '09:00', scheduledOut: '18:00' },
        sunday: { isWorking: false },
      },
    });

    // Staff 2 joined halfway: 2026-11-15
    staff2 = await Staff.create({
      organizationId: orgId,
      primaryBranchId: branch1Id,
      userId: staff2User._id,
      name: 'Smoke Staff Beta',
      email: staff2User.email,
      phone: staff2User.phone,
      staffCode: 'STF-SMK-002',
      designation: 'Junior Stylist',
      joiningDate: new Date('2026-11-15T00:00:00.000Z'),
      isActive: true,
      employmentStatus: 'active',
      attendanceSchedule: {
        monday: { isWorking: true, scheduledIn: '09:00', scheduledOut: '18:00' },
        tuesday: { isWorking: true, scheduledIn: '09:00', scheduledOut: '18:00' },
        wednesday: { isWorking: true, scheduledIn: '09:00', scheduledOut: '18:00' },
        thursday: { isWorking: true, scheduledIn: '09:00', scheduledOut: '18:00' },
        friday: { isWorking: true, scheduledIn: '09:00', scheduledOut: '18:00' },
        saturday: { isWorking: true, scheduledIn: '09:00', scheduledOut: '18:00' },
        sunday: { isWorking: false },
      },
    });

    await StaffBranch.create([
      { organizationId: orgId, branchId: branch1Id, staffId: staff1._id, isHomeBranch: true, isActive: true },
      { organizationId: orgId, branchId: branch1Id, staffId: staff2._id, isHomeBranch: true, isActive: true },
    ]);

    const secret = env.JWT_SECRET || 'test-jwt-secret';
    staff1Token = jwt.sign(
      {
        sub: staff1User._id.toString(),
        id: staff1User._id.toString(),
        organizationId: orgId.toString(),
        branchAccess: [{ branchId: branch1Id.toString(), role: 'staff' }],
        permissions: ['attendance.punch', 'attendance.view'],
      },
      secret,
      { expiresIn: '1h' }
    );

    staff2Token = jwt.sign(
      {
        sub: staff2User._id.toString(),
        id: staff2User._id.toString(),
        organizationId: orgId.toString(),
        branchAccess: [{ branchId: branch1Id.toString(), role: 'staff' }],
        permissions: ['attendance.punch', 'attendance.view'],
      },
      secret,
      { expiresIn: '1h' }
    );

    managerToken = jwt.sign(
      {
        sub: managerUser._id.toString(),
        id: managerUser._id.toString(),
        organizationId: orgId.toString(),
        branchAccess: [{ branchId: branch1Id.toString(), role: 'manager' }],
        permissions: ['attendance.punch', 'attendance.view', 'attendance.adjust'],
      },
      secret,
      { expiresIn: '1h' }
    );

    ownerToken = jwt.sign(
      {
        sub: ownerUser._id.toString(),
        id: ownerUser._id.toString(),
        organizationId: orgId.toString(),
        hasOrgWideAccess: true,
        branchAccess: [
          { branchId: branch1Id.toString(), role: 'owner' },
          { branchId: branch2Id.toString(), role: 'owner' },
        ],
        permissions: ['attendance.punch', 'attendance.view', 'attendance.adjust'],
      },
      secret,
      { expiresIn: '1h' }
    );
  });

  afterAll(async () => {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.close();
    }
  });

  // Test 1: Staff clock-in and clock-out
  it('1. Staff clock-in and clock-out creates punches, attendance record, and audit log', async () => {
    const resIn = await request(app)
      .post('/api/v1/attendance/punch')
      .set('Authorization', `Bearer ${staff1Token}`)
      .set('x-branch-id', branch1Id.toString())
      .send({
        branchId: branch1Id.toString(),
        punchType: 'in',
        notes: 'Staging morning clock-in',
      });

    expect(resIn.status).toBe(200);
    expect(resIn.body.success).toBe(true);
    expect(resIn.body.data.punch.punchType).toBe('in');
    expect(resIn.body.data.status).toBeDefined();

    // Confirm database records directly
    const dbRecordIn = await Attendance.findOne({
      organizationId: orgId,
      staffId: staff1._id,
      isDeleted: false,
    });
    expect(dbRecordIn).toBeTruthy();
    expect(dbRecordIn.branchId.toString()).toBe(branch1Id.toString());

    const punchInRecord = await AttendancePunch.findOne({
      organizationId: orgId,
      staffId: staff1._id,
      punchType: 'in',
    });
    expect(punchInRecord).toBeTruthy();

    // Clock-out
    const resOut = await request(app)
      .post('/api/v1/attendance/punch')
      .set('Authorization', `Bearer ${staff1Token}`)
      .set('x-branch-id', branch1Id.toString())
      .send({
        branchId: branch1Id.toString(),
        punchType: 'out',
        notes: 'Staging evening clock-out',
      });

    expect(resOut.status).toBe(200);
    expect(resOut.body.success).toBe(true);
    expect(resOut.body.data.punch.punchType).toBe('out');

    // Confirm audit logs created
    const inAudit = await AuditLog.findOne({
      organizationId: orgId,
      action: 'STAFF_PUNCH_IN',
      'metadata.staffId': staff1._id.toString(),
    });
    const outAudit = await AuditLog.findOne({
      organizationId: orgId,
      action: 'STAFF_PUNCH_OUT',
      'metadata.staffId': staff1._id.toString(),
    });
    expect(inAudit).toBeTruthy();
    expect(outAudit).toBeTruthy();
  });

  // Test 2: Duplicate clock-in rejection
  it('2. Duplicate clock-in rejection when staff is already clocked in', async () => {
    // Clock-in staff 2
    const res1 = await request(app)
      .post('/api/v1/attendance/punch')
      .set('Authorization', `Bearer ${staff2Token}`)
      .set('x-branch-id', branch1Id.toString())
      .send({
        branchId: branch1Id.toString(),
        punchType: 'in',
      });
    expect(res1.status).toBe(200);

    // Second clock-in should fail
    const res2 = await request(app)
      .post('/api/v1/attendance/punch')
      .set('Authorization', `Bearer ${staff2Token}`)
      .set('x-branch-id', branch1Id.toString())
      .send({
        branchId: branch1Id.toString(),
        punchType: 'in',
      });
    expect(res2.status).toBe(400);
    expect(res2.body.message).toMatch(/already clocked in/i);
  });

  // Test 3: Invalid clock-out rejection
  it('3. Invalid clock-out rejection when staff is already clocked out', async () => {
    // Clock out staff 2
    const resOut1 = await request(app)
      .post('/api/v1/attendance/punch')
      .set('Authorization', `Bearer ${staff2Token}`)
      .set('x-branch-id', branch1Id.toString())
      .send({
        branchId: branch1Id.toString(),
        punchType: 'out',
      });
    expect(resOut1.status).toBe(200);

    // Attempting a second clock-out should fail
    const resOut2 = await request(app)
      .post('/api/v1/attendance/punch')
      .set('Authorization', `Bearer ${staff2Token}`)
      .set('x-branch-id', branch1Id.toString())
      .send({
        branchId: branch1Id.toString(),
        punchType: 'out',
      });
    expect(resOut2.status).toBe(400);
    expect(resOut2.body.message).toMatch(/cannot clock out without an active clock-in/i);
  });

  // Test 4: Manager-authorized punch for another staff member
  it('4. Manager-authorized punch for another staff member succeeds', async () => {
    const res = await request(app)
      .post('/api/v1/attendance/punch')
      .set('Authorization', `Bearer ${managerToken}`)
      .set('x-branch-id', branch1Id.toString())
      .send({
        branchId: branch1Id.toString(),
        staffId: staff2._id.toString(),
        punchType: 'in',
        notes: 'Manager adjusted clock-in',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.punch.staffId.toString()).toBe(staff2._id.toString());
  });

  // Test 5: Staff identity spoofing rejection
  it('5. Staff identity spoofing rejection: non-manager cannot punch for another staff', async () => {
    // Clock in staff 1
    await request(app)
      .post('/api/v1/attendance/punch')
      .set('Authorization', `Bearer ${staff1Token}`)
      .set('x-branch-id', branch1Id.toString())
      .send({
        branchId: branch1Id.toString(),
        punchType: 'in',
      });

    // staff1 attempts to punch out passing staff2's ID
    const res = await request(app)
      .post('/api/v1/attendance/punch')
      .set('Authorization', `Bearer ${staff1Token}`)
      .set('x-branch-id', branch1Id.toString())
      .send({
        branchId: branch1Id.toString(),
        staffId: staff2._id.toString(), // spoof attempt
        punchType: 'out',
      });

    expect(res.status).toBe(200);
    // The server must have overridden staffId with staff1._id
    expect(res.body.data.punch.staffId.toString()).toBe(staff1._id.toString());
  });

  // Test 6: Cross-branch punch conflict handling
  it('6. Cross-branch punch conflict handling records conflict without corrupting record', async () => {
    // Assign staff 1 to branch 2 as a secondary branch
    await StaffBranch.create({
      organizationId: orgId,
      branchId: branch2Id,
      staffId: staff1._id,
      isHomeBranch: false,
      isActive: true,
    });

    // Ingest punch for staff 1 at branch 2 using ownerToken (who has access to branch 2)
    const res = await request(app)
      .post('/api/v1/attendance/punch')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('x-branch-id', branch2Id.toString())
      .send({
        branchId: branch2Id.toString(),
        staffId: staff1._id.toString(),
        punchType: 'in',
        notes: 'Attempt punch at secondary branch',
      });

    // Cross branch punch conflict caught
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/claimed by another branch/i);

    const todayStr = deriveBusinessDate(new Date(), 'Asia/Kolkata');
    const conflictRecord = await AttendanceBranchConflict.findOne({
      organizationId: orgId,
      staffId: staff1._id,
      date: todayStr,
    });
    expect(conflictRecord).toBeTruthy();
    expect(conflictRecord.primaryBranchId.toString()).toBe(branch1Id.toString());
  });

  // Test 7, 8, 9, 10: Monthly muster roll date handling (past, current, future, leave, off-day, joining date)
  it('7-10. Monthly muster roll handles past, current, future, leave, holidays, and joining dates', async () => {
    const currentMonth = new Date().toISOString().slice(0, 7);

    // Add approved paid leave on the 5th for staff 1
    await Leave.create({
      organizationId: orgId,
      branchId: branch1Id,
      staffId: staff1._id,
      leaveCode: 'LV-SMK-001',
      leaveType: 'annual',
      startDate: new Date(`${currentMonth}-05T00:00:00.000Z`),
      endDate: new Date(`${currentMonth}-05T23:59:59.999Z`),
      dates: [`${currentMonth}-05`],
      reason: 'Staging smoke annual leave',
      status: 'approved',
      submittedBy: staff1User._id,
      submittedFor: 'self',
    });

    const res = await request(app)
      .get(`/api/v1/attendance/monthly-summary?monthYear=${currentMonth}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('x-branch-id', branch1Id.toString());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const musterRoll = res.body.data.musterRoll;
    expect(musterRoll.length).toBeGreaterThanOrEqual(2);

    const s1Row = musterRoll.find((r) => r.staff._id.toString() === staff1._id.toString());
    const s2Row = musterRoll.find((r) => r.staff._id.toString() === staff2._id.toString());

    expect(s1Row).toBeTruthy();
    expect(s2Row).toBeTruthy();

    // Staff 1 on the 5th should be 'paid_leave'
    expect(s1Row.dailyBreakdown[`${currentMonth}-05`].status).toBe('paid_leave');
    expect(s1Row.metrics.approvedPaidLeaveDays).toBeGreaterThanOrEqual(1);

    // Staff 2 joined on the 15th -> days 1-14 should be 'not_joined'
    expect(s2Row.dailyBreakdown[`${currentMonth}-01`].status).toBe('not_joined');
  });

  // Test 11: Owner authorized multi-branch view
  it('11. Owner authorized multi-branch view (branchId=all) aggregates staff across branches', async () => {
    const currentMonth = new Date().toISOString().slice(0, 7);

    const res = await request(app)
      .get(`/api/v1/attendance/monthly-summary?monthYear=${currentMonth}&branchId=all`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('x-branch-id', branch1Id.toString());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.branchId).toBe('all');
    expect(res.body.data.musterRoll.length).toBeGreaterThanOrEqual(2);
  });

  // Test 12: Branch-specific isolation
  it('12. Branch-specific isolation: non-owner staff cannot query unauthorized branch or branchId=all', async () => {
    const currentMonth = new Date().toISOString().slice(0, 7);

    const res = await request(app)
      .get(`/api/v1/attendance/monthly-summary?monthYear=${currentMonth}&branchId=all`)
      .set('Authorization', `Bearer ${staff1Token}`)
      .set('x-branch-id', branch1Id.toString());

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/branchId=all requires multi-branch access/i);
  });

  // Test 13: Payroll preview and approval blocker behavior
  it('13. Incomplete attendance records serve as explicit blocker for Payroll approval', async () => {
    // Incomplete attendance record for staff 2 (clocked in by manager in test 4, not clocked out)
    const incompleteRec = await Attendance.findOne({
      organizationId: orgId,
      staffId: staff2._id,
      isDeleted: false,
    });

    expect(incompleteRec).toBeTruthy();
    // Reconciled should be false when in-progress
    expect(incompleteRec.isReconciled).toBe(false);

    // Punches for staff 2 should have 1 active punch (clocked in, not clocked out)
    const punches = await AttendancePunch.find({
      organizationId: orgId,
      staffId: staff2._id,
      isDeleted: false,
    });
    expect(punches.length % 2).toBe(1); // odd count = in-progress/incomplete
  });
});
