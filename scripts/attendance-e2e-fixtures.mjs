import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { validateAttendanceE2EConfig, ATTENDANCE_E2E_DATABASE } from '../src/e2e/attendanceE2EConfig.js';
import { verifyAttendanceE2EOwnership } from '../src/e2e/attendanceE2EOwnership.js';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(backendRoot, '.env.test') });
dotenv.config({ path: path.join(backendRoot, '.env.attendance-e2e'), override: true });
const config = validateAttendanceE2EConfig();
dns.setServers(['8.8.8.8', '1.1.1.1']);
const manifestPath = path.join(backendRoot, '.attendance-e2e-fixtures.json');

const stableId = (label) => new mongoose.Types.ObjectId(
  crypto.createHash('sha256').update(`${config.runId}:${label}`).digest('hex').slice(0, 24),
);
const branchAId = stableId('branch-a');
const branchBId = stableId('branch-b');
const organizationId = stableId('organization');
const authorizedUserId = stableId('authorized-user');
const restrictedUserId = stableId('restricted-user');
const alphaStaffId = stableId('staff-alpha');
const betaStaffId = stableId('staff-beta');
const missingStaffId = stableId('staff-missing');
const restrictedStaffId = stableId('staff-restricted');
const attendanceId = stableId('attendance-alpha');
const leaveId = stableId('approved-leave');
const appointmentId = stableId('appointment');
const branchConflictId = stableId('branch-conflict');

const date = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());
const dayStart = new Date(`${date}T00:00:00.000Z`);

const cleanupIds = {
  organizationId,
  userIds: [authorizedUserId, restrictedUserId],
  permissionIds: [],
};

function fixturePhone(id) {
  const digits = BigInt(`0x${id.toString()}`).toString().slice(-10).padStart(10, '0');
  return `+1${digits}`;
}

function writeManifest() {
  fs.writeFileSync(manifestPath, JSON.stringify({
    runId: config.runId,
    organizationId: organizationId.toString(),
    branchIds: [branchAId.toString(), branchBId.toString()],
    userIds: cleanupIds.userIds.map(String),
    permissionIds: cleanupIds.permissionIds.map(String),
    date,
  }, null, 2), { flag: 'w' });
}

async function openIsolatedDatabase() {
  const { auditPlugin } = await import('../src/database/plugins/audit.js');
  mongoose.plugin(auditPlugin);
  await mongoose.connect(config.mongoUri, {
    serverSelectionTimeoutMS: 10000,
    autoIndex: false,
    autoCreate: false,
  });
  if (mongoose.connection.name !== ATTENDANCE_E2E_DATABASE) {
    await mongoose.disconnect();
    throw new Error('Refusing to modify a database outside the Attendance E2E allowlist.');
  }
  try {
    await verifyAttendanceE2EOwnership(mongoose.connection.db, config);
  } catch (error) {
    await mongoose.disconnect();
    throw error;
  }
}

async function loadModels() {
  const [
    { Organization }, { Branch }, { User }, { Role }, { Permission }, { Staff },
    { StaffBranch }, { Attendance }, { AttendancePunch }, { AttendanceBranchConflict },
    { AttendanceLeaveAppointmentConflict }, { Leave }, { Appointment }, { AuditLog },
    { Session }, { AttendanceLeaveException },
  ] = await Promise.all([
    import('../src/models/organizations/organization.model.js'),
    import('../src/models/branches/branch.model.js'),
    import('../src/models/users/user.model.js'),
    import('../src/models/roles/role.model.js'),
    import('../src/models/permissions/permission.model.js'),
    import('../src/models/staff/staff.model.js'),
    import('../src/models/staff/staffBranch.model.js'),
    import('../src/models/attendance/attendance.model.js'),
    import('../src/models/attendance/attendancePunch.model.js'),
    import('../src/models/attendance/AttendanceLeaveAppointmentConflict.model.js'),
    import('../src/models/attendance/AttendanceLeaveAppointmentConflict.model.js'),
    import('../src/models/leaves/leave.model.js'),
    import('../src/models/appointments/appointment.model.js'),
    import('../src/models/audit/auditLog.model.js'),
    import('../src/models/auth/session.model.js'),
    import('../src/models/attendance/AttendanceLeaveException.model.js'),
  ]);
  return {
    Organization, Branch, User, Role, Permission, Staff, StaffBranch, Attendance,
    AttendancePunch, AttendanceBranchConflict, AttendanceLeaveAppointmentConflict,
    Leave, Appointment, AuditLog, Session, AttendanceLeaveException,
  };
}

async function removeFixture(models) {
  const { organizationId: orgId, userIds, permissionIds } = cleanupIds;
  await models.Session.deleteMany({ user: { $in: userIds } });
  for (const model of [
    models.Attendance, models.AttendancePunch, models.AttendanceBranchConflict,
    models.AttendanceLeaveAppointmentConflict, models.AttendanceLeaveException,
    models.Leave, models.Appointment, models.AuditLog, models.StaffBranch, models.Staff,
  ]) {
    await model.deleteMany({ organizationId: orgId });
  }
  await models.User.deleteMany({ _id: { $in: userIds }, organizationId: orgId });
  await models.Role.deleteMany({ organizationId: orgId });
  if (permissionIds.length) {
    const referencedPermissionIds = await models.Role.distinct('permissions', { permissions: { $in: permissionIds } });
    await models.Permission.deleteMany({
      _id: { $in: permissionIds.filter((id) => !referencedPermissionIds.some((usedId) => usedId.equals(id))) },
    });
  }
  await models.Branch.deleteMany({ organizationId: orgId });
  await models.Organization.deleteOne({ _id: orgId });
}

async function prepareIndexes(models) {
  const indexed = [
    models.Organization, models.Branch, models.User, models.Role, models.Permission,
    models.Staff, models.StaffBranch, models.Attendance, models.AttendancePunch,
    models.AttendanceBranchConflict, models.AttendanceLeaveAppointmentConflict,
    models.AttendanceLeaveException, models.Leave, models.Appointment, models.AuditLog, models.Session,
  ];
  await Promise.all(indexed.map((model) => model.createIndexes()));
}

async function setup(models) {
  const { CANONICAL_PERMISSIONS } = await import('../src/config/permissions.js');
  let priorManifest;
  if (fs.existsSync(manifestPath)) {
    priorManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (priorManifest.runId !== config.runId || priorManifest.organizationId !== organizationId.toString()) {
      throw new Error('Existing fixture manifest belongs to a different Attendance E2E run.');
    }
    cleanupIds.permissionIds = (priorManifest.permissionIds || []).map((id) => new mongoose.Types.ObjectId(id));
  } else if (await models.Organization.exists({ _id: organizationId })) {
    throw new Error('A deterministic E2E organization exists without its fixture manifest; refusing to remove it.');
  }

  const existingUsers = await models.User.find({
    email: { $in: [config.authorizedEmail.toLowerCase(), config.restrictedEmail.toLowerCase()] },
  }).select('_id organizationId').lean();
  const allowedUserIds = new Set(cleanupIds.userIds.map(String));
  if (existingUsers.some((user) =>
    !allowedUserIds.has(user._id.toString()) || user.organizationId.toString() !== organizationId.toString()
  )) {
    throw new Error('Configured E2E account email is already used by a different isolated-database record.');
  }
  if (priorManifest) await removeFixture(models);
  cleanupIds.permissionIds = [];
  writeManifest();

  const requiredNames = ['branches.view', 'attendance.view', 'attendance.punch', 'attendance.adjust'];
  const permissionDefinitions = requiredNames.map((name) => {
    const definition = CANONICAL_PERMISSIONS.find((permission) => permission.name === name);
    if (!definition) throw new Error(`Required permission is not defined by the application: ${name}`);
    return definition;
  });
  const createdPermissionIds = [];
  const permissionDocuments = [];
  for (const definition of permissionDefinitions) {
    let permission = await models.Permission.findOne({ name: definition.name });
    if (!permission) {
      permission = await models.Permission.create(definition);
      createdPermissionIds.push(permission._id);
      cleanupIds.permissionIds = [...createdPermissionIds];
      writeManifest();
    }
    permissionDocuments.push(permission);
  }
  cleanupIds.permissionIds = createdPermissionIds;
  writeManifest();

  await models.Organization.create({
    _id: organizationId,
    name: `Attendance E2E ${config.runId}`,
    isActive: true,
  });
  const [branchA, branchB] = await models.Branch.create([
    { _id: branchAId, organizationId, name: `Attendance E2E ${config.runId} Branch A`, timezone: 'Asia/Kolkata', isActive: true },
    { _id: branchBId, organizationId, name: `Attendance E2E ${config.runId} Branch B`, timezone: 'Asia/Kolkata', isActive: true },
  ]);

  const adminRolePermissions = permissionDocuments.map(({ _id }) => _id);
  const readOnlyPermission = permissionDocuments.find(({ name }) => name === 'branches.view')._id;
  const authorizedRole = await models.Role.create({
    _id: stableId('authorized-role'),
    name: `attendance-e2e-${config.runId}-authorized`,
    description: 'Disposable Attendance E2E role',
    organizationId,
    isSystem: false,
    permissions: adminRolePermissions,
  });
  const restrictedRole = await models.Role.create({
    _id: stableId('restricted-role'),
    name: `attendance-e2e-${config.runId}-restricted`,
    description: 'Disposable restricted Attendance E2E role',
    organizationId,
    isSystem: false,
    permissions: [readOnlyPermission],
  });

  const makeUser = async ({ _id, name, email, password, role, branches }) => {
    const user = new models.User({
      _id,
      name,
      email,
      phone: fixturePhone(_id),
      password,
      role: role._id,
      organizationId,
      hasOrgWideAccess: false,
      branchAccess: branches.map((branch) => ({ branchId: branch._id, branchName: branch.name, isActive: true })),
      isVerified: true,
      isFirstLogin: false,
      status: 'active',
    });
    await user.save();
    return user;
  };
  const authorizedUser = await makeUser({
    _id: authorizedUserId, name: `Attendance E2E Authorized ${config.runId}`,
    email: config.authorizedEmail, password: config.authorizedPassword,
    role: authorizedRole, branches: [branchA, branchB],
  });
  const restrictedUser = await makeUser({
    _id: restrictedUserId, name: `Attendance E2E Restricted ${config.runId}`,
    email: config.restrictedEmail, password: config.restrictedPassword,
    role: restrictedRole, branches: [branchA],
  });

  const createStaff = async ({ _id, name, branch, userId = null, code }) => {
    const staff = await models.Staff.create({
      _id, name, phone: fixturePhone(_id),
      email: `${code.toLowerCase()}-${config.runId}@attendance-e2e.invalid`,
      organizationId, userId, designation: 'E2E Test Staff', status: 'active',
      staffCode: `E2E-${config.runId}-${code}`, joiningDate: new Date('2020-01-01T00:00:00.000Z'),
    });
    await models.StaffBranch.create({ staffId: staff._id, branchId: branch._id, organizationId, isPrimary: true, isActive: true });
    return staff;
  };

  const alpha = await createStaff({ _id: alphaStaffId, name: `E2E Alpha ${config.runId}`, branch: branchA, userId: authorizedUser._id, code: 'ALPHA' });
  await createStaff({ _id: betaStaffId, name: `E2E Beta ${config.runId}`, branch: branchB, code: 'BETA' });
  await createStaff({ _id: missingStaffId, name: `E2E Missing ${config.runId}`, branch: branchA, code: 'MISSING' });
  await createStaff({ _id: restrictedStaffId, name: `E2E Restricted ${config.runId}`, branch: branchA, userId: restrictedUser._id, code: 'RESTRICTED' });

  await models.Attendance.create({
    _id: attendanceId, organizationId, branchId: branchA._id, staffId: alpha._id,
    attendanceDate: dayStart, status: 'incomplete', isReconciled: false,
  });
  await models.AttendancePunch.create({
    organizationId, branchId: branchA._id, staffId: alpha._id, punchType: 'in',
    punchAt: new Date(`${date}T03:30:00.000Z`), provider: 'simulator',
    deviceId: `attendance-e2e-${config.runId}`, externalEventId: `alpha-${config.runId}`,
    mappingStatus: 'mapped', rawEvent: { testFixture: config.runId },
  });
  await models.Attendance.create({
    organizationId, branchId: branchB._id, staffId: betaStaffId,
    attendanceDate: dayStart, status: 'present', isReconciled: false,
  });

  const leave = await models.Leave.create({
    _id: leaveId, organizationId, branchId: branchA._id, staffId: alpha._id,
    leaveCode: `E2E-LEAVE-${config.runId}`, leaveType: 'E2E controlled leave',
    startDate: dayStart, endDate: dayStart, dates: [date], reason: 'Disposable Attendance E2E fixture',
    status: 'approved', submittedBy: authorizedUser._id, submittedFor: 'staff',
    reviewedBy: authorizedUser._id, reviewedAt: new Date(), isPartialDay: false,
  });
  const appointmentStart = new Date(`${date}T05:00:00.000Z`);
  await models.Appointment.create({
    _id: appointmentId, organizationId, branchId: branchA._id,
    appointmentCode: `E2E-APT-${config.runId}`, customerId: stableId('customer'),
    staffId: alpha._id,
    services: [{ serviceType: 'custom', name: 'E2E fixture service', duration: 30, price: 0 }],
    startAt: appointmentStart, endAt: new Date(appointmentStart.getTime() + 30 * 60 * 1000),
    appointmentDate: date, startTime: '10:30', endTime: '11:00', totalDuration: 30,
    bookingType: 'advance', pricing: { subtotal: 0, discount: 0, total: 0 },
    notes: 'Disposable Attendance E2E fixture', status: 'scheduled', isDeleted: false,
  });
  await models.AttendanceLeaveAppointmentConflict.create({
    organizationId, leave: leave._id, leaveId: leave._id, conflictAppointmentId: appointmentId,
    status: 'pending', isActive: true,
  });
  await models.AttendanceBranchConflict.create({
    _id: branchConflictId, organizationId, staffId: alpha._id, date: dayStart,
    branchesInvolved: [
      { branchId: branchA._id, punchCount: 1 },
      { branchId: branchB._id, punchCount: 1 },
    ],
    primaryBranchId: branchA._id, conflictStatus: 'pending', isActive: true,
    evidence: { testFixture: config.runId },
  });

  writeManifest();
  console.log(`Attendance E2E fixtures prepared for run ${config.runId} in ${ATTENDANCE_E2E_DATABASE}.`);
  console.log('Authorized permissions: branches.view, attendance.view, attendance.punch, attendance.adjust. Restricted permissions: branches.view.');
}

async function main() {
  const action = process.argv[2];
  if (!['prepare-indexes', 'setup', 'cleanup'].includes(action)) {
    throw new Error('Usage: attendance-e2e-fixtures.mjs prepare-indexes|setup|cleanup');
  }
  if (action === 'cleanup') {
    if (!fs.existsSync(manifestPath)) {
      console.log('No Attendance E2E fixture manifest exists; nothing to clean.');
      return;
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.runId !== config.runId || manifest.organizationId !== organizationId.toString()) {
      throw new Error('Fixture manifest does not match the configured Attendance E2E run.');
    }
  }

  await openIsolatedDatabase();
  let models;
  try {
    models = await loadModels();
    if (action === 'prepare-indexes') {
      await prepareIndexes(models);
      console.log(`Attendance E2E indexes prepared in ${ATTENDANCE_E2E_DATABASE}.`);
    } else if (action === 'setup') {
      try {
        await setup(models);
      } catch (error) {
        try {
          if (fs.existsSync(manifestPath)) {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            if (manifest.runId === config.runId && manifest.organizationId === organizationId.toString()) {
              cleanupIds.permissionIds = (manifest.permissionIds || []).map((id) => new mongoose.Types.ObjectId(id));
              await removeFixture(models);
              fs.unlinkSync(manifestPath);
            }
          }
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Attendance E2E fixture setup failed and partial cleanup also failed.');
        }
        throw error;
      }
    } else {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      cleanupIds.permissionIds = manifest.permissionIds.map((id) => new mongoose.Types.ObjectId(id));
      await removeFixture(models);
      fs.unlinkSync(manifestPath);
      console.log(`Attendance E2E fixtures removed for run ${config.runId}.`);
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(`Attendance E2E fixture operation failed: ${error.message}`);
  process.exitCode = 1;
});
