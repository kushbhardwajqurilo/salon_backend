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
  status: String,
  isDeleted: Boolean,
  slotMinutes: [String]
}, { strict: false });

async function preflightCheck(dbName) {
  const inOp = '$in';
  const typeOp = '$type';
  const existsOp = '$exists';
  const sizeOp = '$size';
  const notOp = '$not';
  const orOp = '$or';
  const neOp = '$ne';

  const baseUri = process.env.TEST_MONGO_URI || process.env.MONGO_URI;
  const uri = baseUri.replace(/\/[^/?]+(\?|$)/, '/' + dbName + '$1');
  const conn = await mongoose.createConnection(uri).asPromise();
  const Apt = conn.model('appointments', AppointmentSchema, 'appointments');

  console.log(`=== PREFLIGHT AUDIT FOR DATABASE: ${dbName} ===`);
  const total = await Apt.countDocuments({});
  console.log('Total Appointments:', total);

  const activeQuery = {
    isDeleted: false,
    status: { [inOp]: ['scheduled', 'in_progress'] },
    staffId: { [typeOp]: 'objectId' }
  };
  const activeCount = await Apt.countDocuments(activeQuery);
  console.log('Active Appointments (scheduled/in_progress with staffId):', activeCount);

  const missingSlotMinutes = await Apt.countDocuments({
    ...activeQuery,
    slotMinutes: { [existsOp]: false }
  });
  console.log('Active appointments missing slotMinutes field:', missingSlotMinutes);

  const emptySlotMinutes = await Apt.countDocuments({
    ...activeQuery,
    slotMinutes: { [sizeOp]: 0 }
  });
  console.log('Active appointments with empty slotMinutes array ([]):', emptySlotMinutes);

  const nonArraySlotMinutes = await Apt.countDocuments({
    ...activeQuery,
    slotMinutes: { [notOp]: { [typeOp]: 'array' } }
  });
  console.log('Active appointments with non-array slotMinutes:', nonArraySlotMinutes);

  const terminalLingering = await Apt.countDocuments({
    [orOp]: [
      { isDeleted: true },
      { status: { [inOp]: ['completed', 'cancelled', 'no_show'] } }
    ],
    slotMinutes: { [existsOp]: true, [neOp]: [] }
  });
  console.log('Terminal/Deleted appointments with lingering slotMinutes:', terminalLingering);

  // Active Overlap Check in Memory
  const actives = await Apt.find(activeQuery).select('organizationId staffId appointmentCode appointmentDate startTime endTime slotMinutes');
  const registry = new Map();
  const collisions = [];
  for (const doc of actives) {
    const keyPrefix = `${doc.organizationId}:${doc.staffId}`;
    const slots = doc.slotMinutes || [];
    for (const slot of slots) {
      const slotKey = `${keyPrefix}:${slot}`;
      if (registry.has(slotKey)) {
        collisions.push({
          minute: slot,
          first: registry.get(slotKey),
          second: doc.appointmentCode
        });
      } else {
        registry.set(slotKey, doc.appointmentCode);
      }
    }
  }
  console.log('Active Overlapping Appointment Conflicts detected:', collisions.length);
  if (collisions.length > 0) {
    console.log('Sample collisions:', collisions.slice(0, 5));
  }

  // Indexes
  const indexes = await Apt.collection.indexes();
  console.log('Current Indexes Count:', indexes.length);
  const targetIndex = indexes.find(i => i.key && i.key.slotMinutes);
  console.log('Target slotMinutes Index Definition:', JSON.stringify(targetIndex, null, 2));

  await conn.close();
}

preflightCheck('saloon_erp_test').catch(err => {
  console.error(err);
  process.exit(1);
});
