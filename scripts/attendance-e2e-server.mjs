import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { validateAttendanceE2EConfig, ATTENDANCE_E2E_DATABASE } from '../src/e2e/attendanceE2EConfig.js';
import { verifyAttendanceE2EOwnership } from '../src/e2e/attendanceE2EOwnership.js';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(backendRoot, '.env.test') });
dotenv.config({ path: path.join(backendRoot, '.env.attendance-e2e'), override: true });

const config = validateAttendanceE2EConfig();
dns.setServers(['8.8.8.8', '1.1.1.1']);
process.env.NODE_ENV = 'test';
process.env.MONGO_URI = config.mongoUri;
process.env.PORT = String(config.backendPort);

const { auditPlugin } = await import('../src/database/plugins/audit.js');
mongoose.plugin(auditPlugin);
await mongoose.connect(config.mongoUri, {
  serverSelectionTimeoutMS: 10000,
  autoIndex: false,
  autoCreate: false,
});
if (mongoose.connection.name !== ATTENDANCE_E2E_DATABASE) {
  await mongoose.disconnect();
  throw new Error('Connected database does not match the Attendance E2E allowlist.');
}
await verifyAttendanceE2EOwnership(mongoose.connection.db, config);

const { default: app } = await import('../app.mjs');
app.get('/attendance-e2e-health', (req, res) => {
  if (mongoose.connection.readyState !== 1 || mongoose.connection.name !== ATTENDANCE_E2E_DATABASE) {
    return res.status(503).json({ success: false });
  }
  return res.json({
    success: true,
    mode: 'attendance-e2e',
    database: mongoose.connection.name,
    clusterHosts: config.uriHosts,
  });
});

const server = app.listen(config.backendPort, '127.0.0.1');
const stop = async () => {
  server.close(async () => {
    await mongoose.disconnect();
    process.exit(0);
  });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('listening', () => {
  console.log(`Attendance E2E backend ready on 127.0.0.1:${config.backendPort} (${ATTENDANCE_E2E_DATABASE}).`);
});
