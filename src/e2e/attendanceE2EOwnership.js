import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATTENDANCE_E2E_DATABASE } from './attendanceE2EConfig.js';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const attendanceE2EOwnerFile = path.join(backendRoot, '.attendance-e2e-owner.json');
export const attendanceE2EOwnerCollection = '_attendance_e2e_ownership';

export async function verifyAttendanceE2EOwnership(database, config) {
  if (database.databaseName !== ATTENDANCE_E2E_DATABASE) {
    throw new Error('Connected database is not the approved Attendance E2E database.');
  }
  if (!fs.existsSync(attendanceE2EOwnerFile)) {
    throw new Error('Attendance E2E database ownership marker file is missing.');
  }
  const marker = JSON.parse(fs.readFileSync(attendanceE2EOwnerFile, 'utf8'));
  const expectedHosts = [...config.uriHosts].sort();
  if (
    marker.database !== ATTENDANCE_E2E_DATABASE ||
    marker.runId !== config.runId ||
    JSON.stringify([...marker.hosts].sort()) !== JSON.stringify(expectedHosts) ||
    typeof marker.token !== 'string' ||
    marker.token.length < 32
  ) {
    throw new Error('Attendance E2E ownership marker does not match the configured run and cluster.');
  }
  const persisted = await database.collection(attendanceE2EOwnerCollection).findOne({ _id: marker.runId });
  if (
    !persisted ||
    persisted.database !== marker.database ||
    persisted.token !== marker.token ||
    JSON.stringify([...persisted.hosts].sort()) !== JSON.stringify(expectedHosts)
  ) {
    throw new Error('The isolated MongoDB database does not contain this run’s ownership marker.');
  }
  return marker;
}
