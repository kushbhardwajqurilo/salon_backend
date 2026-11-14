import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { ConnectionString } from 'mongodb-connection-string-url';
import {
  validateAttendanceE2EConfig,
  ATTENDANCE_E2E_DATABASE,
} from '../src/e2e/attendanceE2EConfig.js';
import {
  attendanceE2EOwnerCollection,
  attendanceE2EOwnerFile,
  verifyAttendanceE2EOwnership,
} from '../src/e2e/attendanceE2EOwnership.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(backendRoot, '.env.test') });
dotenv.config({ path: path.join(backendRoot, '.env.attendance-e2e'), override: true });
const config = validateAttendanceE2EConfig();
dns.setServers(['8.8.8.8', '1.1.1.1']);

async function connect() {
  const parsed = new ConnectionString(config.mongoUri);
  const hosts = parsed.hosts.map((host) => host.replace(/:\d+$/, '').toLowerCase());
  if (
    parsed.pathname.replace(/^\//, '') !== ATTENDANCE_E2E_DATABASE ||
    hosts.length !== config.uriHosts.length ||
    hosts.some((host) => !config.uriHosts.includes(host))
  ) {
    throw new Error('Refusing database operation because connection identity changed.');
  }
  await mongoose.connect(config.mongoUri, {
    serverSelectionTimeoutMS: 15000,
    autoIndex: false,
    autoCreate: false,
  });
  if (mongoose.connection.name !== ATTENDANCE_E2E_DATABASE) {
    await mongoose.disconnect();
    throw new Error('Connected MongoDB database does not match the single approved E2E target.');
  }
}

async function claim() {
  if (fs.existsSync(attendanceE2EOwnerFile)) {
    throw new Error('An Attendance E2E ownership file already exists; verify the prior run before proceeding.');
  }
  await connect();
  let ownedMarker;
  let localMarkerWritten = false;
  try {
    const collections = await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray();
    if (collections.length > 0) {
      throw new Error('The proposed Attendance E2E database already contains collections; refusing to overwrite it.');
    }
    ownedMarker = {
      _id: config.runId,
      database: ATTENDANCE_E2E_DATABASE,
      hosts: [...config.uriHosts].sort(),
      token: crypto.randomBytes(32).toString('hex'),
      createdAt: new Date(),
    };
    await mongoose.connection.db.collection(attendanceE2EOwnerCollection).insertOne(ownedMarker);
    const localMarker = {
      runId: ownedMarker._id,
      database: ownedMarker.database,
      hosts: ownedMarker.hosts,
      token: ownedMarker.token,
      createdAt: ownedMarker.createdAt.toISOString(),
    };
    fs.writeFileSync(attendanceE2EOwnerFile, JSON.stringify(localMarker, null, 2), { flag: 'wx', mode: 0o600 });
    localMarkerWritten = true;
    console.log(`Claimed empty database ${mongoose.connection.name} on ${config.uriHosts.join(',')}.`);
  } catch (error) {
    if (ownedMarker) {
      await mongoose.connection.db.collection(attendanceE2EOwnerCollection).deleteOne({
        _id: ownedMarker._id,
        token: ownedMarker.token,
      });
    }
    if (localMarkerWritten) fs.unlinkSync(attendanceE2EOwnerFile);
    throw error;
  } finally {
    await mongoose.disconnect();
  }
}

async function verify() {
  await connect();
  try {
    await verifyAttendanceE2EOwnership(mongoose.connection.db, config);
    console.log(`Verified ownership of ${mongoose.connection.name} on ${config.uriHosts.join(',')}.`);
  } finally {
    await mongoose.disconnect();
  }
}

async function drop() {
  await connect();
  try {
    await verifyAttendanceE2EOwnership(mongoose.connection.db, config);
    const expectedDatabase = mongoose.connection.db.databaseName;
    if (expectedDatabase !== 'saloon_erp_attendance_e2e') {
      throw new Error('Refusing to drop any database other than saloon_erp_attendance_e2e.');
    }
    const result = await mongoose.connection.db.dropDatabase();
    if (!result?.ok) throw new Error('MongoDB did not confirm the isolated database drop.');
    const remaining = await mongoose.connection.db.admin().command({
      listDatabases: 1,
      nameOnly: true,
      filter: { name: expectedDatabase },
    });
    if ((remaining.databases || []).some(({ name }) => name === expectedDatabase)) {
      throw new Error('The isolated database still exists after the drop request.');
    }
    fs.unlinkSync(attendanceE2EOwnerFile);
    console.log(`Dropped and verified removal of ${expectedDatabase} on ${config.uriHosts.join(',')}.`);
  } finally {
    await mongoose.disconnect();
  }
}

const action = process.argv[2];
try {
  if (action === 'claim') await claim();
  else if (action === 'verify') await verify();
  else if (action === 'drop') await drop();
  else throw new Error('Usage: attendance-e2e-database.mjs claim|verify|drop');
} catch (error) {
  console.error(`Attendance E2E database operation failed: ${error.message}`);
  process.exitCode = 1;
}
