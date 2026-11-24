import dns from 'node:dns';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dns.setServers(['8.8.8.8', '1.1.1.1']);
dotenv.config();

const appointmentValidator = {
  $or: [
    // Condition 1: Inactive, soft-deleted, or unassigned appointments are exempted from non-empty slotMinutes
    { isDeleted: true },
    { status: { $in: ['completed', 'cancelled', 'no_show'] } },
    { staffId: null },
    { staffId: { $exists: false } },
    // Condition 2: Active staff-assigned appointments MUST have slotMinutes as an array with at least 1 item
    {
      isDeleted: false,
      status: { $in: ['scheduled', 'in_progress'] },
      staffId: { $type: 'objectId' },
      'slotMinutes.0': { $exists: true, $type: 'string' }
    }
  ]
};

async function testValidator() {
  const uri = process.env.TEST_MONGO_URI || process.env.MONGO_URI;
  const conn = await mongoose.createConnection(uri).asPromise();
  const db = conn.useDb('s_erp_test');

  console.log('Testing collMod with $jsonSchema validator...');
  await db.db.command({
    collMod: 'appointments',
    validator: appointmentValidator,
    validationLevel: 'moderate', // applies to all inserts and updates to modified docs
    validationAction: 'error'
  });
  console.log('SUCCESS: collMod applied successfully.');

  const Apt = db.model('appointments', new mongoose.Schema({}, { strict: false }), 'appointments');
  const orgId = new mongoose.Types.ObjectId();
  const staffId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();

  // Test 1: Insert active staff-assigned appointment WITHOUT slotMinutes (Should FAIL)
  let failedWithoutSlots = false;
  try {
    await Apt.create({
      organizationId: orgId,
      branchId,
      staffId,
      status: 'scheduled',
      isDeleted: false,
      appointmentCode: 'TEST-VAL-1'
    });
  } catch (err) {
    failedWithoutSlots = true;
    console.log('Test 1 Passed: Insert without slotMinutes rejected by MongoDB engine:', err.message);
  }

  // Test 2: Insert active appointment with empty slotMinutes [] (Should FAIL)
  let failedWithEmptySlots = false;
  try {
    await Apt.create({
      organizationId: orgId,
      branchId,
      staffId,
      status: 'scheduled',
      isDeleted: false,
      slotMinutes: [],
      appointmentCode: 'TEST-VAL-2'
    });
  } catch (err) {
    failedWithEmptySlots = true;
    console.log('Test 2 Passed: Insert with slotMinutes: [] rejected by MongoDB engine:', err.message);
  }

  // Test 3: Insert active appointment with valid slotMinutes (Should PASS)
  const validDoc = await Apt.create({
    organizationId: orgId,
    branchId,
    staffId,
    status: 'scheduled',
    isDeleted: false,
    slotMinutes: ['2026-11-25T10:00:00.000Z'],
    appointmentCode: 'TEST-VAL-3'
  });
  console.log('Test 3 Passed: Valid doc created with ID:', validDoc._id);

  // Test 4: Update valid active appointment to empty slotMinutes [] (Should FAIL)
  let failedUpdateEmpty = false;
  try {
    await Apt.updateOne({ _id: validDoc._id }, { $set: { slotMinutes: [] } });
  } catch (err) {
    failedUpdateEmpty = true;
    console.log('Test 4 Passed: Update to slotMinutes: [] rejected by MongoDB engine:', err.message);
  }

  // Test 5: Cancelled appointment WITHOUT slotMinutes (Should PASS because status is cancelled)
  const cancDoc = await Apt.create({
    organizationId: orgId,
    branchId,
    staffId,
    status: 'cancelled',
    isDeleted: false,
    slotMinutes: [],
    appointmentCode: 'TEST-VAL-4'
  });
  console.log('Test 5 Passed: Cancelled doc created without slotMinutes successfully:', cancDoc._id);

  // Test 6: Unassigned staff appointment (staffId: null) WITHOUT slotMinutes (Should PASS)
  const unassignedDoc = await Apt.create({
    organizationId: orgId,
    branchId,
    staffId: null,
    status: 'scheduled',
    isDeleted: false,
    slotMinutes: [],
    appointmentCode: 'TEST-VAL-5'
  });
  console.log('Test 6 Passed: Unassigned doc created without slotMinutes successfully:', unassignedDoc._id);

  // Cleanup
  await Apt.deleteMany({ organizationId: orgId });
  await conn.close();

  if (!failedWithoutSlots || !failedWithEmptySlots || !failedUpdateEmpty) {
    throw new Error('Validation tests failed!');
  }
  console.log('ALL MONGODB COLLECTION VALIDATOR SCENARIOS PASSED WITH FLYING COLORS!');
}

testValidator().catch(err => {
  console.error('Validator test error:', err);
  process.exit(1);
});
