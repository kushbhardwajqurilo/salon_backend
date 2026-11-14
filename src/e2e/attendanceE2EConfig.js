import { ConnectionString } from 'mongodb-connection-string-url';

export const ATTENDANCE_E2E_DATABASE = 'saloon_erp_attendance_e2e';

function requiredValue(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} must be configured for Attendance E2E.`);
  }
  return value.trim();
}

function localHttpUrl(value, name, requiredPath = '/') {
  let url;
  try {
    url = new URL(requiredValue(value, name));
  } catch {
    throw new Error(`${name} must be an absolute local HTTP URL.`);
  }
  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.pathname !== requiredPath ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must use an allowed local HTTP URL with path ${requiredPath}.`);
  }
  return url;
}

export function validateAttendanceE2EConfig(source = process.env) {
  if (source.NODE_ENV?.trim().toLowerCase() === 'production') {
    throw new Error('Attendance E2E cannot run with NODE_ENV=production.');
  }
  const mongoUri = requiredValue(source.ATTENDANCE_E2E_MONGO_URI, 'ATTENDANCE_E2E_MONGO_URI');
  let parsed;
  try {
    parsed = new ConnectionString(mongoUri);
  } catch {
    throw new Error('ATTENDANCE_E2E_MONGO_URI is invalid.');
  }
  const database = (parsed.pathname || '').replace(/^\//, '');
  if (!['mongodb:', 'mongodb+srv:'].includes(parsed.protocol) || database !== ATTENDANCE_E2E_DATABASE) {
    throw new Error(`ATTENDANCE_E2E_MONGO_URI must target ${ATTENDANCE_E2E_DATABASE} using MongoDB.`);
  }

  const uriHosts = parsed.hosts.map((host) =>
    host.startsWith('[')
      ? host.slice(1, host.indexOf(']')).toLowerCase()
      : host.replace(/:\d+$/, '').trim().toLowerCase(),
  );
  if (!uriHosts.length || uriHosts.some((host) =>
    !['localhost', '127.0.0.1'].includes(host) && !host.endsWith('.mongodb.net')
  )) {
    throw new Error('ATTENDANCE_E2E_MONGO_URI must target localhost or a MongoDB Atlas host.');
  }
  if (parsed.protocol === 'mongodb+srv:' && uriHosts.some((host) => ['localhost', '127.0.0.1'].includes(host))) {
    throw new Error('Local MongoDB must use mongodb:// rather than mongodb+srv://.');
  }
  const allowedHosts = requiredValue(
    source.ATTENDANCE_E2E_ALLOWED_MONGO_HOSTS,
    'ATTENDANCE_E2E_ALLOWED_MONGO_HOSTS',
  )
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (uriHosts.some((host) => !allowedHosts.includes(host))) {
    throw new Error('The Attendance E2E MongoDB host is not exactly allowlisted.');
  }

  const backendUrl = localHttpUrl(source.ATTENDANCE_E2E_BACKEND_URL, 'ATTENDANCE_E2E_BACKEND_URL', '/api/v1');
  const frontendUrl = localHttpUrl(source.ATTENDANCE_E2E_FRONTEND_URL, 'ATTENDANCE_E2E_FRONTEND_URL');
  if (!backendUrl.port || !frontendUrl.port) {
    throw new Error('Attendance E2E frontend and backend URLs must specify dedicated ports.');
  }
  if (backendUrl.port === frontendUrl.port) {
    throw new Error('Attendance E2E frontend and backend must use different ports.');
  }
  if (frontendUrl.origin !== 'http://localhost:3000') {
    throw new Error('ATTENDANCE_E2E_FRONTEND_URL must use http://localhost:3000, the application test CORS origin.');
  }
  const runId = requiredValue(source.ATTENDANCE_E2E_RUN_ID, 'ATTENDANCE_E2E_RUN_ID');
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(runId)) {
    throw new Error('ATTENDANCE_E2E_RUN_ID may contain only letters, numbers, underscores, and hyphens.');
  }

  const authorizedEmail = requiredValue(source.ATTENDANCE_E2E_AUTHORIZED_EMAIL, 'ATTENDANCE_E2E_AUTHORIZED_EMAIL');
  const authorizedPassword = requiredValue(source.ATTENDANCE_E2E_AUTHORIZED_PASSWORD, 'ATTENDANCE_E2E_AUTHORIZED_PASSWORD');
  const restrictedEmail = requiredValue(source.ATTENDANCE_E2E_RESTRICTED_EMAIL, 'ATTENDANCE_E2E_RESTRICTED_EMAIL');
  const restrictedPassword = requiredValue(source.ATTENDANCE_E2E_RESTRICTED_PASSWORD, 'ATTENDANCE_E2E_RESTRICTED_PASSWORD');
  if (authorizedPassword.length < 6 || restrictedPassword.length < 6) {
    throw new Error('Attendance E2E passwords must contain at least six characters.');
  }
  if (authorizedEmail.toLowerCase() === restrictedEmail.toLowerCase()) {
    throw new Error('Authorized and restricted Attendance E2E accounts must be different.');
  }

  return {
    mongoUri,
    database,
    uriHosts,
    backendUrl: backendUrl.toString().replace(/\/$/, ''),
    backendOrigin: backendUrl.origin,
    backendPort: Number(backendUrl.port),
    frontendUrl: frontendUrl.toString().replace(/\/$/, ''),
    frontendOrigin: frontendUrl.origin,
    frontendPort: Number(frontendUrl.port),
    runId,
    authorizedEmail,
    authorizedPassword,
    restrictedEmail,
    restrictedPassword,
  };
}
