import mongoose from 'mongoose';
import './src/database/db.js';
import { LeaveService } from './src/services/leaves/leave.service.js';
import { LeaveRepository } from './src/repositories/leaves/leave.repository.js';
import { Leave } from './src/models/leaves/leave.model.js';
import { Staff } from './src/models/staff/staff.model.js';
import { Branch } from './src/models/branches/branch.model.js';
import { StaffBranch } from './src/models/staff/staffBranch.model.js';
import { User } from './src/models/users/user.model.js';
import { Role } from './src/models/roles/role.model.js';
import { Permission } from './src/models/permissions/permission.model.js';
import { AuditLog } from './src/models/audit/auditLog.model.js';

const MONGODB_URI = 'mongodb://127.0.0.1:27018/saloon_erp_test?replicaSet=rs0&retryWrites=false';

const leaveService = new LeaveService();
const leaveRepo = new LeaveRepository();

async function runVerification() {
  console.log('=== PHASE 7C VERIFICATION RUNNER ===');
  
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;

  const results = {};

  try {
    // 1. TOPOLOGY
    const admin = db.admin();
    const hello = await admin.command({ hello: 1 });
    results.topology = {
      isWritablePrimary: hello.isWritablePrimary,
      primary: hello.primary,
      setName: hello.setName,
      dbName: mongoose.connection.name
    };

    // Ensure Leave collection / indexes exist
    await Leave.syncIndexes();

    // 2. INDEX VERIFICATION
    const indexes = await db.collection('leaves').indexes();
    results.indexes = indexes;

    // Clean up collection before testing
    await Leave.deleteMany({});
    await AuditLog.deleteMany({});
    await Staff.deleteMany({});
    await Branch.deleteMany({});
    await StaffBranch.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Permission.deleteMany({});

    const orgId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    const userId1 = new mongoose.Types.ObjectId();
    const userId2 = new mongoose.Types.ObjectId();
    const roleId = new mongoose.Types.ObjectId();

    const permDoc = await Permission.create({
      name: 'employees.leaves.manage',
      module: 'employees',
      action: 'manage',
      description: 'Manage leave records'
    });

    await Role.create({
      _id: roleId,
      name: 'admin',
      description: 'Admin role',
      permissions: [permDoc._id]
    });

    await User.create({
      _id: userId1,
      name: 'Test Admin',
      username: 'testadmin',
      email: 'admin@test.com',
      phone: '1234567890',
      password: 'hashedpassword',
      role: roleId,
      organizationId: orgId,
      status: 'active'
    });

    await User.create({
      _id: userId2,
      name: 'Test Reviewer',
      username: 'revieweradmin',
      email: 'reviewer@test.com',
      phone: '0987654321',
      password: 'hashedpassword',
      role: roleId,
      organizationId: orgId,
      status: 'active'
    });

    await Branch.create({
      _id: branchId,
      organizationId: orgId,
      name: 'Main Branch',
      isActive: true
    });

    const staff1Doc = await Staff.create({
      name: 'Staff One',
      phone: '1111111111',
      email: 'staff1@test.com',
      organizationId: orgId,
      userId: userId1,
      staffCode: 'ST-001',
      designation: 'Stylist',
      joiningDate: new Date('2026-01-01'),
      status: 'active'
    });

    const staff2Doc = await Staff.create({
      name: 'Staff Two',
      phone: '2222222222',
      email: 'staff2@test.com',
      organizationId: orgId,
      userId: userId2,
      staffCode: 'ST-002',
      designation: 'Stylist',
      joiningDate: new Date('2026-01-01'),
      status: 'active'
    });

    await StaffBranch.create({
      staffId: staff1Doc._id,
      branchId: branchId,
      organizationId: orgId,
      isPrimary: true,
      isActive: true
    });

    await StaffBranch.create({
      staffId: staff2Doc._id,
      branchId: branchId,
      organizationId: orgId,
      isPrimary: true,
      isActive: true
    });

    const staff1 = staff1Doc._id.toString();
    const staff2 = staff2Doc._id.toString();
    const user1Str = userId1.toString();
    const user2Str = userId2.toString();
    const orgIdStr = orgId.toString();
    const branchIdStr = branchId.toString();

    // B. REAL OVERLAP ENFORCEMENT
    // Create baseline leave: staff1 on 2026-09-10 to 2026-09-12
    const baseLeave = await leaveService.createLeave(
      { staffId: staff1, leaveType: 'Casual', startDate: '2026-09-10', endDate: '2026-09-12', reason: 'Base Leave' },
      orgIdStr, branchIdStr, user1Str
    );

    results.overlap = {};

    // First date overlap (2026-09-09 to 2026-09-10)
    try {
      await leaveService.createLeave(
        { staffId: staff1, leaveType: 'Casual', startDate: '2026-09-09', endDate: '2026-09-10', reason: 'Overlap first date' },
        orgIdStr, branchIdStr, user1Str
      );
      results.overlap.firstDate = 'FAILED (allowed unexpectedly)';
    } catch (err) {
      results.overlap.firstDate = { code: err.code, statusCode: err.statusCode, status: err.status, message: err.message, name: err.name, errorCode: err.errorCode };
    }

    // Middle date overlap (2026-09-11 to 2026-09-11)
    try {
      await leaveService.createLeave(
        { staffId: staff1, leaveType: 'Casual', startDate: '2026-09-11', endDate: '2026-09-11', reason: 'Overlap middle date' },
        orgIdStr, branchIdStr, user1Str
      );
      results.overlap.middleDate = 'FAILED (allowed unexpectedly)';
    } catch (err) {
      results.overlap.middleDate = { code: err.code, statusCode: err.statusCode, status: err.status, message: err.message, name: err.name, errorCode: err.errorCode };
    }

    // Last date overlap (2026-09-12 to 2026-09-13)
    try {
      await leaveService.createLeave(
        { staffId: staff1, leaveType: 'Casual', startDate: '2026-09-12', endDate: '2026-09-13', reason: 'Overlap last date' },
        orgIdStr, branchIdStr, user1Str
      );
      results.overlap.lastDate = 'FAILED (allowed unexpectedly)';
    } catch (err) {
      results.overlap.lastDate = { code: err.code, statusCode: err.statusCode, status: err.status, message: err.message, name: err.name, errorCode: err.errorCode };
    }

    // Adjacent dates (2026-09-13 to 2026-09-14) -> allowed
    try {
      const adj = await leaveService.createLeave(
        { staffId: staff1, leaveType: 'Casual', startDate: '2026-09-13', endDate: '2026-09-14', reason: 'Adjacent leave' },
        orgIdStr, branchIdStr, user1Str
      );
      results.overlap.adjacent = 'SUCCESS (id: ' + adj.id + ')';
    } catch (err) {
      results.overlap.adjacent = 'FAILED: ' + err.message;
    }

    // Different staff (staff2 on 2026-09-10 to 2026-09-12) -> allowed
    try {
      const diffStaff = await leaveService.createLeave(
        { staffId: staff2, leaveType: 'Casual', startDate: '2026-09-10', endDate: '2026-09-12', reason: 'Different staff' },
        orgIdStr, branchIdStr, user2Str
      );
      results.overlap.differentStaff = 'SUCCESS (id: ' + diffStaff.id + ')';
    } catch (err) {
      results.overlap.differentStaff = 'FAILED: ' + err.message;
    }

    // Rejected leave frees dates
    const leaveToReject = await leaveService.createLeave(
      { staffId: staff1, leaveType: 'Casual', startDate: '2026-09-20', endDate: '2026-09-22', reason: 'To be rejected' },
      orgIdStr, branchIdStr, user1Str
    );
    await leaveService.rejectLeave(leaveToReject.id, 'Rejecting test', orgIdStr, user2Str);
    try {
      const freedByReject = await leaveService.createLeave(
        { staffId: staff1, leaveType: 'Casual', startDate: '2026-09-20', endDate: '2026-09-22', reason: 'After rejection' },
        orgIdStr, branchIdStr, user1Str
      );
      results.overlap.rejectedFreesDates = 'SUCCESS (id: ' + freedByReject.id + ')';
    } catch (err) {
      results.overlap.rejectedFreesDates = 'FAILED: ' + err.message;
    }

    // Cancelled leave frees dates
    const leaveToCancel = await leaveService.createLeave(
      { staffId: staff1, leaveType: 'Casual', startDate: '2026-09-25', endDate: '2026-09-27', reason: 'To be cancelled' },
      orgIdStr, branchIdStr, user1Str
    );
    await leaveService.cancelLeave(leaveToCancel.id, 'Cancelling test', orgIdStr, user1Str);
    try {
      const freedByCancel = await leaveService.createLeave(
        { staffId: staff1, leaveType: 'Casual', startDate: '2026-09-25', endDate: '2026-09-27', reason: 'After cancellation' },
        orgIdStr, branchIdStr, user1Str
      );
      results.overlap.cancelledFreesDates = 'SUCCESS (id: ' + freedByCancel.id + ')';
    } catch (err) {
      results.overlap.cancelledFreesDates = 'FAILED: ' + err.message;
    }

    // Soft-deleted blocking leave frees dates
    const leaveToDelete = await leaveService.createLeave(
      { staffId: staff1, leaveType: 'Casual', startDate: '2026-10-01', endDate: '2026-10-03', reason: 'To be soft-deleted' },
      orgIdStr, branchIdStr, user1Str
    );
    await leaveRepo.deleteById(leaveToDelete.id, orgIdStr, user1Str);
    try {
      const freedByDelete = await leaveService.createLeave(
        { staffId: staff1, leaveType: 'Casual', startDate: '2026-10-01', endDate: '2026-10-03', reason: 'After soft deletion' },
        orgIdStr, branchIdStr, user1Str
      );
      results.overlap.softDeleteFreesDates = 'SUCCESS (id: ' + freedByDelete.id + ')';
    } catch (err) {
      results.overlap.softDeleteFreesDates = 'FAILED: ' + err.message;
    }

    // C. REAL CONCURRENCY
    const concPromises = Array.from({ length: 5 }).map((_, i) =>
      leaveService.createLeave(
        { staffId: staff1, leaveType: 'Casual', startDate: '2026-11-01', endDate: '2026-11-05', reason: `Concurrent attempt ${i}` },
        orgIdStr, branchIdStr, user1Str
      ).then(res => ({ status: 'fulfilled', value: res }))
        .catch(err => ({ status: 'rejected', error: err }))
    );
    const concResults = await Promise.all(concPromises);
    const fulfilled = concResults.filter(r => r.status === 'fulfilled');
    const rejected = concResults.filter(r => r.status === 'rejected');
    results.concurrency = {
      total: concResults.length,
      fulfilledCount: fulfilled.length,
      rejectedCount: rejected.length,
      rejectedErrors: rejected.map(r => ({
        code: r.error.code,
        statusCode: r.error.statusCode,
        status: r.error.status,
        message: r.error.message,
        name: r.error.name,
        errorCode: r.error.errorCode
      }))
    };

    // D. REAL TRANSACTION
    // Commit test
    const txCreated = await leaveService.createLeave(
      { staffId: staff1, leaveType: 'Casual', startDate: '2026-12-01', endDate: '2026-12-02', reason: 'Tx Commit Test' },
      orgIdStr, branchIdStr, user1Str
    );
    const txLeaveDoc = await Leave.findById(txCreated.id);
    const txAuditDoc = await AuditLog.findOne({ entityId: new mongoose.Types.ObjectId(txCreated.id) });
    results.transactionCommit = {
      leaveExists: !!txLeaveDoc,
      auditExists: !!txAuditDoc
    };

    // Rollback test: simulate error inside transaction
    const session = await mongoose.startSession();
    session.startTransaction();
    let rbLeaveId;
    try {
      const leaveDoc = new Leave({
        organizationId: orgId,
        branchId: branchId,
        staffId: staff1Doc._id,
        leaveCode: 'LV-TEST-RB',
        leaveType: 'Casual',
        startDate: new Date('2026-12-10'),
        endDate: new Date('2026-12-11'),
        dates: [new Date('2026-12-10'), new Date('2026-12-11')],
        reason: 'Rollback Test',
        status: 'pending',
        submittedBy: userId1,
        submittedFor: 'self',
        createdBy: userId1,
        updatedBy: userId1
      });
      rbLeaveId = leaveDoc._id;
      await leaveDoc.save({ session });

      const auditDoc = new AuditLog({
        organizationId: orgId,
        branchId: branchId,
        entityId: leaveDoc._id,
        entityType: 'Leave',
        action: 'CREATE',
        performedBy: userId1
      });
      await auditDoc.save({ session });

      // Force failure
      throw new Error('Forced transaction failure');
    } catch (err) {
      await session.abortTransaction();
      session.endSession();
    }
    const rbLeaveCheck = await Leave.findById(rbLeaveId);
    const rbAuditCheck = await AuditLog.findOne({ entityId: rbLeaveId });
    results.transactionRollback = {
      leaveExists: !!rbLeaveCheck,
      auditExists: !!rbAuditCheck,
      rolledBackCleanly: !rbLeaveCheck && !rbAuditCheck
    };

    // E. SESSION PROPAGATION
    const sessProp = await mongoose.startSession();
    sessProp.startTransaction();
    const sessLeave = new Leave({
      organizationId: orgId,
      branchId: branchId,
      staffId: staff1Doc._id,
      leaveCode: 'LV-TEST-SESS',
      leaveType: 'Casual',
      startDate: new Date('2026-12-20'),
      endDate: new Date('2026-12-21'),
      dates: [new Date('2026-12-20'), new Date('2026-12-21')],
      reason: 'Session Propagation Test',
      status: 'pending',
      submittedBy: userId1,
      submittedFor: 'self',
      createdBy: userId1,
      updatedBy: userId1
    });
    await sessLeave.save({ session: sessProp });
    const outsideTx = await Leave.findById(sessLeave._id);
    const insideTx = await Leave.findById(sessLeave._id).session(sessProp);
    await sessProp.abortTransaction();
    sessProp.endSession();
    results.sessionPropagation = {
      visibleOutsideTxBeforeCommit: !!outsideTx,
      visibleInsideTxBeforeCommit: !!insideTx
    };

    // F. OPTIMISTIC CONCURRENCY
    const optLeave = await leaveService.createLeave(
      { staffId: staff1, leaveType: 'Casual', startDate: '2027-01-01', endDate: '2027-01-02', reason: 'Optimistic Concurrency' },
      orgIdStr, branchIdStr, user1Str
    );
    const docA = await Leave.findById(optLeave.id);
    const docB = await Leave.findById(optLeave.id);
    
    // Save A first (increments __v from 0 to 1)
    docA.reason = 'Updated by A';
    await docA.save();

    // Now attempt saving B (still has __v: 0)
    docB.reason = 'Updated by B';
    try {
      await docB.save();
      results.optimisticConcurrency = 'FAILED (competing update succeeded)';
    } catch (err) {
      results.optimisticConcurrency = {
        name: err.name,
        message: err.message
      };
    }

    // G. DATE / DATA SAFETY
    results.dataSafety = {};
    
    // Check DTO mapping
    const dtoLeave = await leaveService.createLeave(
      { staffId: staff1, leaveType: 'Casual', startDate: '2027-02-01', endDate: '2027-02-05', reason: 'DTO Safety Test' },
      orgIdStr, branchIdStr, user1Str
    );
    results.dataSafety.dtoHasDates = 'dates' in dtoLeave;

    // Check 365-day range vs 366-day range
    try {
      const pass365 = await leaveService.createLeave(
        { staffId: staff1, leaveType: 'Casual', startDate: '2028-01-01', endDate: '2028-12-30', reason: '365 days' },
        orgIdStr, branchIdStr, user1Str
      );
      results.dataSafety.range365 = 'SUCCESS (id: ' + pass365.id + ')';
    } catch (err) {
      results.dataSafety.range365 = 'FAILED: ' + err.message;
    }

    try {
      await leaveService.createLeave(
        { staffId: staff1, leaveType: 'Casual', startDate: '2029-01-01', endDate: '2030-01-02', reason: '366+ days' },
        orgIdStr, branchIdStr, user1Str
      );
      results.dataSafety.range366 = 'FAILED (allowed unexpectedly)';
    } catch (err) {
      results.dataSafety.range366 = { code: err.code, statusCode: err.statusCode, status: err.status, message: err.message, name: err.name, errorCode: err.errorCode };
    }

    console.log('=== RESULTS SUMMARY ===');
    console.log(JSON.stringify(results, null, 2));

  } finally {
    await mongoose.disconnect();
  }
}

runVerification();
