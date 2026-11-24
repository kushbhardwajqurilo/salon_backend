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
  isDeleted: { type: Boolean, default: false },
  slotMinutes: [String]
}, { strict: false });

async function testRollbackCompatibility() {
  const inOp = '$in';
  const typeOp = '$type';
  const uri = process.env.TEST_MONGO_URI || process.env.MONGO_URI || "mongodb+srv://kushbhardwaj8800:g38VQcYIESBTWQRR@kushcluster.hinejtf.mongodb.net/s_erp_test?retryWrites=true&w=majority";
  const conn = await mongoose.createConnection(uri).asPromise();
  const db = conn.useDb('s_erp_test');
  
  // Use appointments collection with test org to test against actual unique partial index
  const Apt = db.model('appointments', AppointmentSchema, 'appointments');
  const orgId = new mongoose.Types.ObjectId();
  const staffId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();

  console.log('--- TEST 1: Old Backend Writes Without slotMinutes ---');
  // Simulate an older backend version that does not know about slotMinutes
  const oldDocA = await Apt.create({
    organizationId: orgId,
    branchId,
    staffId,
    appointmentCode: 'APT-OLD-1',
    appointmentDate: '2026-11-25',
    startTime: '10:00',
    endTime: '10:30',
    status: 'scheduled',
    isDeleted: false
    // slotMinutes omitted entirely!
  });
  console.log('Old Doc A created with ID:', oldDocA._id, 'slotMinutes:', oldDocA.slotMinutes);

  // Now simulate an older backend creating an overlapping appointment at the same time
  const oldDocB = await Apt.create({
    organizationId: orgId,
    branchId,
    staffId,
    appointmentCode: 'APT-OLD-2',
    appointmentDate: '2026-11-25',
    startTime: '10:00',
    endTime: '10:30',
    status: 'scheduled',
    isDeleted: false
    // slotMinutes omitted entirely!
  });
  console.log('Old Doc B created with ID:', oldDocB._id, 'slotMinutes:', oldDocB.slotMinutes);

  // Check if both documents were allowed to commit
  console.log('CRITICAL FINDING: Did both conflicting appointments commit?');
  const count = await Apt.countDocuments({ organizationId: orgId });
  console.log('Total committed conflicting appointments under old schema:', count);

  // Cleanup test docs
  await Apt.deleteMany({ organizationId: orgId });
  await conn.close();

  if (count === 2) {
    console.log('CONFIRMED: Because the index partialFilterExpression includes slotMinutes: { $type: "string" } or matches slotMinutes, documents WITHOUT slotMinutes BYPASS the unique index filter entirely!');
  }
}

testRollbackCompatibility().catch(err => {
  console.error(err);
  process.exit(1);
});
