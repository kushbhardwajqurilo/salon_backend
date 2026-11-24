import dns from 'node:dns';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dns.setServers(['8.8.8.8', '1.1.1.1']);
dotenv.config();

const strictValidator = {
  $or: [
    { isDeleted: true },
    { status: { $in: ['completed', 'cancelled', 'no_show'] } },
    { staffId: null },
    { staffId: { $exists: false } },
    {
      isDeleted: false,
      status: { $in: ['scheduled', 'in_progress'] },
      staffId: { $type: 'objectId' },
      $expr: {
        $and: [
          { $isArray: '$slotMinutes' },
          { $gt: [{ $size: '$slotMinutes' }, 0] },
          {
            $allElementsTrue: {
              $map: {
                input: '$slotMinutes',
                as: 'slot',
                in: {
                  $and: [
                    { $eq: [{ $type: '$$slot' }, 'string'] },
                    { $gt: [{ $strLenCP: '$$slot' }, 0] }
                  ]
                }
              }
            }
          }
        ]
      }
    }
  ]
};

async function testStrictValidator() {
  const uri = process.env.TEST_MONGO_URI || process.env.MONGO_URI;
  const conn = await mongoose.createConnection(uri).asPromise();
  const db = conn.useDb('s_erp_test');

  console.log('Applying strict $expr collection validator to appointments...');
  await db.db.command({
    collMod: 'appointments',
    validator: strictValidator,
    validationLevel: 'strict',
    validationAction: 'error'
  });
  console.log('SUCCESS: Strict validator applied with validationLevel: strict, validationAction: error.');

  const Apt = db.model('appointments', new mongoose.Schema({}, { strict: false }), 'appointments');
  const orgId = new mongoose.Types.ObjectId();
  const staffId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();

  // Test Case A: slotMinutes contains non-string element: ['valid-slot', 123] -> MUST FAIL
  let failedNonString = false;
  try {
    await Apt.create({
      organizationId: orgId,
      branchId,
      staffId,
      status: 'scheduled',
      isDeleted: false,
      slotMinutes: ['2026-11-25T10:00:00.000Z', 123],
      appointmentCode: 'TEST-STRICT-1'
    });
  } catch (err) {
    failedNonString = true;
    console.log('Case A (non-string element in array) correctly REJECTED:', err.message);
  }

  // Test Case B: slotMinutes contains empty string: ['valid-slot', ''] -> MUST FAIL
  let failedEmptyString = false;
  try {
    await Apt.create({
      organizationId: orgId,
      branchId,
      staffId,
      status: 'scheduled',
      isDeleted: false,
      slotMinutes: ['2026-11-25T10:00:00.000Z', ''],
      appointmentCode: 'TEST-STRICT-2'
    });
  } catch (err) {
    failedEmptyString = true;
    console.log('Case B (empty string element in array) correctly REJECTED:', err.message);
  }

  // Test Case C: slotMinutes is non-array (e.g. string or object) -> MUST FAIL
  let failedNonArray = false;
  try {
    await Apt.create({
      organizationId: orgId,
      branchId,
      staffId,
      status: 'scheduled',
      isDeleted: false,
      slotMinutes: 'not-an-array',
      appointmentCode: 'TEST-STRICT-3'
    });
  } catch (err) {
    failedNonArray = true;
    console.log('Case C (non-array value) correctly REJECTED:', err.message);
  }

  // Test Case D: Completely valid slotMinutes array of strings -> MUST PASS
  const validDoc = await Apt.create({
    organizationId: orgId,
    branchId,
    staffId,
    status: 'scheduled',
    isDeleted: false,
    slotMinutes: ['2026-11-25T10:00:00.000Z', '2026-11-25T10:01:00.000Z'],
    appointmentCode: 'TEST-STRICT-4'
  });
  console.log('Case D (clean valid array) correctly ACCEPTED with ID:', validDoc._id);

  await Apt.deleteMany({ organizationId: orgId });
  await conn.close();

  if (!failedNonString || !failedEmptyString || !failedNonArray) {
    throw new Error('Strict validator did not catch all malformed cases!');
  }
  console.log('ALL STRICT MONGODB ENGINE CASES PASSED PERFECTLY!');
}

testStrictValidator().catch(err => {
  console.error('Strict validator test error:', err);
  process.exit(1);
});
