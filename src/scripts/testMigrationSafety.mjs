import dns from 'node:dns';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dns.setServers(['8.8.8.8', '1.1.1.1']);
dotenv.config();

const AppointmentSchema = new mongoose.Schema({
  organizationId: mongoose.Schema.Types.ObjectId,
  branchId: mongoose.Schema.Types.ObjectId,
  staffId: mongoose.Schema.Types.ObjectId,
  appointmentCode: String,
  appointmentDate: String,
  startTime: String,
  endTime: String,
  startAt: Date,
  endAt: Date,
  status: String,
  isDeleted: { type: Boolean, default: false },
  slotMinutes: [String]
});

async function runScenarioTests() {
  const uri = process.env.TEST_MONGO_URI || process.env.MONGO_URI || "mongodb+srv://kushbhardwaj8800:g38VQcYIESBTWQRR@kushcluster.hinejtf.mongodb.net/s_erp_test?retryWrites=true&w=majority";
  const conn = await mongoose.createConnection(uri).asPromise();
  // Reuse existing 'appointments' collection with a unique test-scoped organizationId to avoid creating a 510th collection on Atlas M0
  const Apt = conn.model('appointments', AppointmentSchema, 'appointments');

  console.log('--- 1. Clean DB Setup for test organization ---');
  const orgId = new mongoose.Types.ObjectId();
  const staffId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();
  await Apt.deleteMany({ organizationId: orgId });
  
  console.log('--- 2. Insert Test Data Matrix ---');

  // Active appointment 1
  await Apt.create({
    organizationId: orgId,
    branchId,
    staffId,
    appointmentCode: 'APT-MIG-1',
    appointmentDate: '2026-11-25',
    startTime: '10:00',
    endTime: '10:30',
    startAt: new Date('2026-11-25T10:00:00.000Z'),
    endAt: new Date('2026-11-25T10:30:00.000Z'),
    status: 'scheduled',
    isDeleted: false,
    slotMinutes: [] // missing slotMinutes
  });

  // Cancelled appointment overlapping with Active 1
  await Apt.create({
    organizationId: orgId,
    branchId,
    staffId,
    appointmentCode: 'APT-MIG-CANC',
    appointmentDate: '2026-11-25',
    startTime: '10:15',
    endTime: '10:45',
    status: 'cancelled',
    isDeleted: false,
    slotMinutes: ['2026-11-25T10:15:00.000Z']
  });

  // Completed appointment overlapping with Active 1
  await Apt.create({
    organizationId: orgId,
    branchId,
    staffId,
    appointmentCode: 'APT-MIG-COMP',
    appointmentDate: '2026-11-25',
    startTime: '10:00',
    endTime: '10:30',
    status: 'completed',
    isDeleted: false,
    slotMinutes: ['2026-11-25T10:00:00.000Z']
  });

  // Soft-deleted appointment overlapping
  await Apt.create({
    organizationId: orgId,
    branchId,
    staffId,
    appointmentCode: 'APT-MIG-DEL',
    appointmentDate: '2026-11-25',
    startTime: '10:00',
    endTime: '10:30',
    status: 'scheduled',
    isDeleted: true,
    slotMinutes: ['2026-11-25T10:00:00.000Z']
  });

  console.log('Matrix records inserted successfully.');

  // Pre-flight collision test: Insert overlapping active record
  const conflictDoc = await Apt.create({
    organizationId: orgId,
    branchId,
    staffId,
    appointmentCode: 'APT-MIG-CONFLICT',
    appointmentDate: '2026-11-25',
    startTime: '10:15',
    endTime: '10:45',
    status: 'scheduled',
    isDeleted: false,
    slotMinutes: []
  });

  console.log('--- 3. Testing Pre-Flight Collision Detection (Should Abort) ---');
  const inOp = '$in';
  const typeOp = '$type';
  const setOp = '$set';
  const orOp = '$or';

  const actives = await Apt.find({
    organizationId: orgId,
    isDeleted: false,
    status: { [inOp]: ['scheduled', 'in_progress'] },
    staffId: { [typeOp]: 'objectId' }
  });

  const generateSlotMinutes = (dateStr, start, end) => {
    const slots = [];
    let cur = new Date(dateStr + 'T' + start + ':00.000Z').getTime();
    const endMs = new Date(dateStr + 'T' + end + ':00.000Z').getTime();
    while (cur < endMs) {
      slots.push(new Date(cur).toISOString());
      cur += 60000;
    }
    return slots;
  };

  const occupied = new Set();
  let collisionDetected = false;
  for (const doc of actives) {
    const slots = generateSlotMinutes(doc.appointmentDate, doc.startTime, doc.endTime);
    for (const slot of slots) {
      const key = `${doc.organizationId}:${doc.staffId}:${slot}`;
      if (occupied.has(key)) {
        collisionDetected = true;
        console.log('SUCCESS: Pre-flight accurately detected collision on key:', key);
        break;
      }
      occupied.add(key);
    }
  }

  if (!collisionDetected) {
    throw new Error('Collision detection failed to catch active overlap!');
  }

  // Remove the conflicting active record
  await Apt.deleteOne({ _id: conflictDoc._id });
  console.log('Conflicting record removed for clean backfill test.');

  // Execute Backfill
  console.log('--- 4. Testing Backfill & Terminal State Cleansing ---');
  const activeToBackfill = await Apt.find({
    organizationId: orgId,
    isDeleted: false,
    status: { [inOp]: ['scheduled', 'in_progress'] }
  });
  for (const doc of activeToBackfill) {
    const slots = generateSlotMinutes(doc.appointmentDate, doc.startTime, doc.endTime);
    await Apt.updateOne({ _id: doc._id }, { [setOp]: { slotMinutes: slots } });
  }

  // Clean terminal states
  await Apt.updateMany(
    { organizationId: orgId, [orOp]: [{ isDeleted: true }, { status: { [inOp]: ['cancelled', 'completed'] } }] },
    { [setOp]: { slotMinutes: [] } }
  );

  const activeDoc = await Apt.findOne({ appointmentCode: 'APT-MIG-1' });
  const cancDoc = await Apt.findOne({ appointmentCode: 'APT-MIG-CANC' });
  console.log('Active Doc slotMinutes count:', activeDoc.slotMinutes.length);
  console.log('Cancelled Doc slotMinutes count:', cancDoc.slotMinutes.length);

  // Apply Index: match existing index name or drop & recreate
  console.log('--- 5. Testing Unique Index Application on Database ---');
  await Apt.collection.createIndex(
    { organizationId: 1, staffId: 1, slotMinutes: 1 },
    {
      unique: true,
      partialFilterExpression: {
        isDeleted: false,
        status: { [inOp]: ['scheduled', 'in_progress'] },
        staffId: { [typeOp]: 'objectId' },
        slotMinutes: { [typeOp]: 'string' }
      },
      name: 'organizationId_1_staffId_1_slotMinutes_1'
    }
  );
  console.log('SUCCESS: Unique partial index matched and verified without error.');

  // Idempotency: Run createIndex again
  await Apt.collection.createIndex(
    { organizationId: 1, staffId: 1, slotMinutes: 1 },
    {
      unique: true,
      partialFilterExpression: {
        isDeleted: false,
        status: { [inOp]: ['scheduled', 'in_progress'] },
        staffId: { [typeOp]: 'objectId' },
        slotMinutes: { [typeOp]: 'string' }
      },
      name: 'organizationId_1_staffId_1_slotMinutes_1'
    }
  );
  console.log('SUCCESS: Re-running createIndex is completely idempotent.');

  // Attempt duplicate insert to verify engine enforcement
  let duplicateRejected = false;
  try {
    await Apt.create({
      organizationId: orgId,
      branchId,
      staffId,
      appointmentCode: 'APT-MIG-DUP',
      appointmentDate: '2026-11-25',
      startTime: '10:00',
      endTime: '10:30',
      status: 'scheduled',
      isDeleted: false,
      slotMinutes: activeDoc.slotMinutes
    });
  } catch (err) {
    if (err.code === 11000) {
      duplicateRejected = true;
      console.log('SUCCESS: Database rejected overlapping insert with E11000 duplicate key error.');
    }
  }

  if (!duplicateRejected) {
    throw new Error('Unique index failed to reject duplicate insert!');
  }

  await conn.close();
  console.log('All disposable migration safety scenarios verified successfully.');
}

runScenarioTests().catch(err => {
  console.error('Migration safety test failed:', err);
  process.exit(1);
});
