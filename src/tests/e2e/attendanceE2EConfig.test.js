import assert from 'node:assert/strict';
import test from 'node:test';
import { ATTENDANCE_E2E_DATABASE, validateAttendanceE2EConfig } from '../../e2e/attendanceE2EConfig.js';

const validConfig = {
  ATTENDANCE_E2E_MONGO_URI: `mongodb+srv://test-user:test-password@attendance-test.mongodb.net/${ATTENDANCE_E2E_DATABASE}?retryWrites=true`,
  ATTENDANCE_E2E_ALLOWED_MONGO_HOSTS: 'attendance-test.mongodb.net',
  ATTENDANCE_E2E_BACKEND_URL: 'http://127.0.0.1:5015/api/v1',
  ATTENDANCE_E2E_FRONTEND_URL: 'http://localhost:3000',
  ATTENDANCE_E2E_RUN_ID: 'config_safety_test',
  ATTENDANCE_E2E_AUTHORIZED_EMAIL: 'attendance-authorized@example.invalid',
  ATTENDANCE_E2E_AUTHORIZED_PASSWORD: 'authorized-test-password',
  ATTENDANCE_E2E_RESTRICTED_EMAIL: 'attendance-restricted@example.invalid',
  ATTENDANCE_E2E_RESTRICTED_PASSWORD: 'restricted-test-password',
};

test('accepts a fully explicit isolated Attendance E2E configuration', () => {
  const result = validateAttendanceE2EConfig(validConfig);
  assert.equal(result.database, ATTENDANCE_E2E_DATABASE);
  assert.equal(result.backendPort, 5015);
  assert.equal(result.frontendPort, 3000);
});

test('rejects a database other than the dedicated Attendance E2E database', () => {
  assert.throws(
    () => validateAttendanceE2EConfig({
      ...validConfig,
      ATTENDANCE_E2E_MONGO_URI: 'mongodb+srv://test-user:test-password@attendance-test.mongodb.net/saloon_erp_test',
    }),
    /must target saloon_erp_attendance_e2e/,
  );
});

test('rejects a MongoDB host not explicitly allowlisted', () => {
  assert.throws(
    () => validateAttendanceE2EConfig({
      ...validConfig,
      ATTENDANCE_E2E_ALLOWED_MONGO_HOSTS: 'another-test.mongodb.net',
    }),
    /not exactly allowlisted/,
  );
});

test('allows an explicitly allowlisted local MongoDB only with the dedicated database name', () => {
  const result = validateAttendanceE2EConfig({
    ...validConfig,
    ATTENDANCE_E2E_MONGO_URI: `mongodb://127.0.0.1:27017/${ATTENDANCE_E2E_DATABASE}`,
    ATTENDANCE_E2E_ALLOWED_MONGO_HOSTS: '127.0.0.1',
  });
  assert.deepEqual(result.uriHosts, ['127.0.0.1']);
});

test('rejects production mode, remote URLs, shared ports, and missing accounts', () => {
  assert.throws(() => validateAttendanceE2EConfig({ ...validConfig, NODE_ENV: 'production' }), /NODE_ENV=production/);
  assert.throws(() => validateAttendanceE2EConfig({ ...validConfig, ATTENDANCE_E2E_FRONTEND_URL: 'https://app.example.com' }), /local HTTP URL/);
  assert.throws(() => validateAttendanceE2EConfig({
    ...validConfig,
    ATTENDANCE_E2E_FRONTEND_URL: 'http://localhost:5015',
  }), /different ports/);
  assert.throws(() => validateAttendanceE2EConfig({
    ...validConfig,
    ATTENDANCE_E2E_RESTRICTED_PASSWORD: '',
  }), /must be configured/);
});
