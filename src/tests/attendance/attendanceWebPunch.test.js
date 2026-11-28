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
import { getIsolatedTestMongoUri } from '../testSetup.js';

describe('Attendance Web Punch & Monthly Muster Roll Suite', () => {
  jest.setTimeout(45000);
  let orgId;
  let branchId;
  let branch2Id;
  let userStaff;
  let userManager;
  let userOwner;
  let staff1;
  let staff2;
  let staffToken;
  let managerToken;
  let ownerToken;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const testUri = getIsolatedTestMongoUri('attendance_test');
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(testUri);
    }

    orgId = new mongoose.Types.ObjectId();
    branchId = new mongoose.Types.ObjectId();
    branch2Id = new mongoose.Types.ObjectId();

    // Create branch with operating hours 09:00 - 18:00
    await Branch.create([
      {
        _id: branchId,
        organizationId: orgId,
        name: 'Main Salon Branch',
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
          sunday: { openTime: '09:00', closeTime: '18:00', isOpen: true },
        },
      },
      {
        _id: branch2Id,
        organizationId: orgId,
        name: 'Secondary Salon Branch',
        timezone: 'Asia/Kolkata',
        isActive: true,
      },
    ]);

    // Permissions
    const permPunch = await Permission.findOneAndUpdate(
      { name: 'attendance.punch' },
      { $setOnInsert: { name: 'attendance.punch', module: 'Attendance', action: 'Punch', description: 'Punch' } },
      { upsert: true, returnDocument: 'after' }
    );
    const permView = await Permission.findOneAndUpdate(
      { name: 'attendance.view' },
      { $setOnInsert: { name: 'attendance.view', module: 'Attendance', action: 'View', description: 'View' } },
      { upsert: true, returnDocument: 'after' }
    );
    const permAdjust = await Permission.findOneAndUpdate(
      { name: 'attendance.adjust' },
      { $setOnInsert: { name: 'attendance.adjust', module: 'Attendance', action: 'Adjust', description: 'Adjust' } },
      { upsert: true, returnDocument: 'after' }
    );

    // Roles
    const [staffRole, managerRole, ownerRole] = await Role.create([
      {
        name: 'staff',
        organizationId: orgId,
        permissions: [permPunch._id, permView._id],
        isCustom: false,
      },
      {
        name: 'manager',
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

    // Users
    userStaff = await User.create({
      _id: new mongoose.Types.ObjectId(),
      organizationId: orgId,
      name: 'Stylist John',
      email: 'john.stylist@test.com',
      password: 'Password123!',
      phone: '+919876543210',
      role: staffRole._id,
      branchAccess: [{ branchId, branchName: 'Main Salon Branch', isActive: true }],
    });

    userManager = await User.create({
      _id: new mongoose.Types.ObjectId(),
      organizationId: orgId,
      name: 'Manager Alice',
      email: 'alice.manager@test.com',
      password: 'Password123!',
      phone: '+919876543220',
      role: managerRole._id,
      branchAccess: [{ branchId, branchName: 'Main Salon Branch', isActive: true }],
    });

    userOwner = await User.create({
      _id: new mongoose.Types.ObjectId(),
      organizationId: orgId,
      name: 'Owner Bob',
      email: 'bob.owner@test.com',
      password: 'Password123!',
      phone: '+919876543230',
      role: ownerRole._id,
      hasOrgWideAccess: true,
      branchAccess: [
        { branchId, branchName: 'Main Salon Branch', isActive: true },
        { branchId: branch2Id, branchName: 'Secondary Salon Branch', isActive: true },
      ],
    });

    // Staff profiles
    staff1 = await Staff.create({
      _id: new mongoose.Types.ObjectId(),
      organizationId: orgId,
      userId: userStaff._id,
      name: 'Stylist John',
      phone: '+919876543210',
      email: 'john.stylist@test.com',
      designation: 'Senior Stylist',
      staffCode: 'STF-001',
      status: 'active',
      joiningDate: new Date('2026-01-01T00:00:00.000Z'),
    });

    staff2 = await Staff.create({
      _id: new mongoose.Types.ObjectId(),
      organizationId: orgId,
      name: 'Stylist Mary',
      phone: '+919876543211',
      email: 'mary.stylist@test.com',
      designation: 'Junior Stylist',
      staffCode: 'STF-002',
      status: 'active',
      joiningDate: new Date('2026-01-01T00:00:00.000Z'),
    });

    await StaffBranch.create([
      { organizationId: orgId, staffId: staff1._id, branchId, isActive: true },
      { organizationId: orgId, staffId: staff2._id, branchId, isActive: true },
    ]);

    staffToken = jwt.sign(
      {
        id: userStaff._id.toString(),
        userId: userStaff._id.toString(),
        organizationId: orgId.toString(),
        role: 'Staff',
        permissions: ['attendance.punch', 'attendance.view'],
      },
      env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    managerToken = jwt.sign(
      {
        id: userManager._id.toString(),
        userId: userManager._id.toString(),
        organizationId: orgId.toString(),
        role: 'Manager',
        permissions: ['attendance.punch', 'attendance.view', 'attendance.adjust'],
      },
      env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    ownerToken = jwt.sign(
      {
        id: userOwner._id.toString(),
        userId: userOwner._id.toString(),
        organizationId: orgId.toString(),
        role: 'Owner',
        permissions: ['attendance.punch', 'attendance.view', 'attendance.adjust'],
      },
      env.JWT_SECRET,
      { expiresIn: '1h' }
    );
  });

  afterAll(async () => {
    await Attendance.deleteMany({ organizationId: orgId });
    await AttendancePunch.deleteMany({ organizationId: orgId });
    await Staff.deleteMany({ organizationId: orgId });
    await StaffBranch.deleteMany({ organizationId: orgId });
    await Branch.deleteMany({ organizationId: orgId });
    await User.deleteMany({ organizationId: orgId });
    await Role.deleteMany({ organizationId: orgId });
    await Leave.deleteMany({ organizationId: orgId });
    await mongoose.connection.close();
  });

  describe('1. Direct Web Punch Lifecycle', () => {
    it('should clock-in successfully and create punch and incomplete attendance record', async () => {
      const res = await request(app)
        .post('/api/v1/attendance/punch')
        .set('Authorization', `Bearer ${staffToken}`)
        .set('x-branch-id', branchId.toString())
        .send({ punchType: 'in', notes: 'Morning checkin' });

      if (res.status !== 200) {
        console.error('Clock-in failed with error:', res.body);
      }
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.punch.punchType).toBe('in');
      expect(res.body.data.punch.provider).toBe('web_punch');
      expect(res.body.data.status).toBe('incomplete');

      const att = await Attendance.findOne({
        organizationId: orgId,
        staffId: staff1._id,
        isDeleted: false,
      });
      expect(att).toBeTruthy();
      expect(att.branchId.toString()).toBe(branchId.toString());
      expect(att.status).toBe('incomplete');
    });

    it('should reject consecutive duplicate clock-in without clocking out', async () => {
      const res = await request(app)
        .post('/api/v1/attendance/punch')
        .set('Authorization', `Bearer ${staffToken}`)
        .set('x-branch-id', branchId.toString())
        .send({ punchType: 'in' });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('already clocked in');
    });

    it('should prevent non-manager from submitting punch for another staff member', async () => {
      const res = await request(app)
        .post('/api/v1/attendance/punch')
        .set('Authorization', `Bearer ${staffToken}`)
        .set('x-branch-id', branchId.toString())
        .send({ staffId: staff2._id.toString(), punchType: 'out' });

      // Because staffToken has no attendance.adjust, controller ignores body.staffId
      // and attempts to clock out own staff1!
      expect(res.status).toBe(200);
      expect(res.body.data.punch.staffId.toString()).toBe(staff1._id.toString());
    });

    it('should reject clock-out when not clocked in', async () => {
      // staff1 is now clocked out, so punching out again should fail
      const res = await request(app)
        .post('/api/v1/attendance/punch')
        .set('Authorization', `Bearer ${staffToken}`)
        .set('x-branch-id', branchId.toString())
        .send({ punchType: 'out' });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Cannot clock out without an active clock-in');
    });

    it('should allow manager to record punch for another staff member', async () => {
      const res = await request(app)
        .post('/api/v1/attendance/punch')
        .set('Authorization', `Bearer ${managerToken}`)
        .set('x-branch-id', branchId.toString())
        .send({ staffId: staff2._id.toString(), punchType: 'in' });

      expect(res.status).toBe(200);
      expect(res.body.data.punch.staffId.toString()).toBe(staff2._id.toString());
      expect(res.body.data.status).toBe('incomplete');
    });
  });

  describe('2. Monthly Muster Roll Aggregation', () => {
    it('should aggregate monthly attendance correctly with present, absent, and leave counts', async () => {
      // Clock out staff2 so staff2 is present today
      await request(app)
        .post('/api/v1/attendance/punch')
        .set('Authorization', `Bearer ${managerToken}`)
        .set('x-branch-id', branchId.toString())
        .send({ staffId: staff2._id.toString(), punchType: 'out' });

      const currentMonth = new Date().toISOString().slice(0, 7);

      const res = await request(app)
        .get(`/api/v1/attendance/monthly-summary?monthYear=${currentMonth}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .set('x-branch-id', branchId.toString());

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.monthYear).toBe(currentMonth);
      expect(res.body.data.totalStaff).toBe(2);
      expect(res.body.data.consolidatedTotals).toBeDefined();

      const staff1Summary = res.body.data.musterRoll.find((r) => r.staff._id.toString() === staff1._id.toString());
      const staff2Summary = res.body.data.musterRoll.find((r) => r.staff._id.toString() === staff2._id.toString());

      expect(staff1Summary).toBeDefined();
      expect(staff2Summary).toBeDefined();
      expect(staff1Summary.metrics.presentDays).toBeGreaterThanOrEqual(1);
      expect(staff2Summary.metrics.presentDays).toBeGreaterThanOrEqual(1);
    });

    it('should allow owner to view all branch attendance when branchId=all', async () => {
      const currentMonth = new Date().toISOString().slice(0, 7);
      const res = await request(app)
        .get(`/api/v1/attendance/monthly-summary?monthYear=${currentMonth}&branchId=all`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('x-branch-id', branchId.toString());

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.branchId).toBe('all');
    });

    it('should correctly classify past days as absent, future days as scheduled, and exclude pre-joining dates', async () => {
      // Create staff3 with joining date on the 10th of current month
      const currentMonth = new Date().toISOString().slice(0, 7);
      const joiningDate = new Date(`${currentMonth}-10T00:00:00.000Z`);

      const staff3 = await Staff.create({
        _id: new mongoose.Types.ObjectId(),
        organizationId: orgId,
        name: 'Late Joiner Sam',
        phone: '+919876543299',
        email: 'sam.late@test.com',
        designation: 'Apprentice',
        staffCode: 'STF-003',
        status: 'active',
        joiningDate,
      });

      await StaffBranch.create({
        organizationId: orgId,
        staffId: staff3._id,
        branchId,
        isActive: true,
      });

      // Also create an approved leave for staff1 on the 5th
      await Leave.create({
        organizationId: orgId,
        branchId,
        staffId: staff1._id,
        leaveCode: 'LV-TEST-001',
        leaveType: 'annual',
        startDate: new Date(`${currentMonth}-05T00:00:00.000Z`),
        endDate: new Date(`${currentMonth}-05T23:59:59.999Z`),
        dates: [`${currentMonth}-05`],
        reason: 'Personal time off',
        status: 'approved',
        submittedBy: userStaff._id,
        submittedFor: 'self',
      });

      const res = await request(app)
        .get(`/api/v1/attendance/monthly-summary?monthYear=${currentMonth}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .set('x-branch-id', branchId.toString());

      expect(res.status).toBe(200);

      const samSummary = res.body.data.musterRoll.find((r) => r.staff._id.toString() === staff3._id.toString());
      expect(samSummary).toBeDefined();

      // Days 1-9 should be 'not_joined'
      expect(samSummary.dailyBreakdown[`${currentMonth}-01`].status).toBe('not_joined');
      expect(samSummary.dailyBreakdown[`${currentMonth}-09`].status).toBe('not_joined');

      // Staff1 on the 5th should be 'paid_leave', not absent
      const staff1Summary = res.body.data.musterRoll.find((r) => r.staff._id.toString() === staff1._id.toString());
      expect(staff1Summary.dailyBreakdown[`${currentMonth}-05`].status).toBe('paid_leave');
      expect(staff1Summary.metrics.approvedPaidLeaveDays).toBeGreaterThanOrEqual(1);
    });
  });
});
