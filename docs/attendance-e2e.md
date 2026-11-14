# Isolated Attendance browser E2E

The normal backend entry point is `index.mjs`. It loads the application database connection path, which synchronizes model indexes, and starts Redis/background workers. Do not use it for authenticated Attendance browser tests.

The dedicated `scripts/attendance-e2e-server.mjs` entry point requires an explicit `ATTENDANCE_E2E_MONGO_URI`, validates the exact `saloon_erp_attendance_e2e` database and an exact host allowlist before connecting, verifies the connected database and run-specific ownership marker, and listens only on loopback. It does not import the normal startup entry point, initialize workers, run migrations, or call `syncIndexes()`. Mongoose `autoIndex` and `autoCreate` are disabled for the server.

## Provisioning

1. Use only the temporary database named exactly `saloon_erp_attendance_e2e` on the explicitly authorized test cluster.
2. Create a test-only MongoDB account scoped to that database. A database-scoped `readWrite` role is sufficient for fixture CRUD and explicit index preparation; do not grant cluster-wide or administrator roles.
3. Copy `.env.attendance-e2e.example` to `.env.attendance-e2e`. Set the exact test URI and hostname allowlist, local URLs, a unique run ID, and two dedicated test-account emails/passwords. Do not copy production credentials or reuse an application administrator.
4. The authorized fixture role receives the application's canonical `branches.view`, `attendance.view`, `attendance.punch`, and `attendance.adjust` permissions. The restricted role receives only canonical `branches.view`. Fixture passwords are hashed by the existing User model save hook.

No values are inferred from `MONGO_URI`, `TEST_MONGO_URI`, the normal frontend API URL, or production URLs. Configuration errors stop startup before a database connection is attempted.

## Explicit E2E commands

From `backend`, claim the empty database for this run, explicitly prepare only its model indexes, then create the fixtures:

```powershell
node scripts/attendance-e2e-database.mjs claim
node scripts/attendance-e2e-fixtures.mjs prepare-indexes
node scripts/attendance-e2e-fixtures.mjs setup
```

From `frontend`, run the authenticated browser journeys:

```powershell
.\node_modules\.bin\playwright.cmd test --config playwright.attendance.config.mjs
```

The dedicated Playwright config starts the isolated backend and frontend on local test URLs with existing-server reuse disabled. Before each browser journey, the test calls the backend E2E health endpoint and requires proof of the connected database identity. Browser API calls target the real backend; only the loading/error/retry case temporarily delays or aborts a single register request.

The persistence suite uses the same exact isolated database only when `ATTENDANCE_E2E_PERSISTENCE=1` is explicit. It creates model indexes for the test assertions, deletes only its generated organization-scoped records, and disconnects without dropping the database or ownership marker. Keep it separate from normal test runs.

Fixtures use deterministic IDs derived from the run ID. Keep the same run ID when cleaning up an interrupted run. Setup writes a scoped manifest and refuses to remove a deterministic organization unless the matching manifest exists. Teardown deletes documents only for that fixture organization, its two fixture users, and permissions created by that run that are no longer referenced by any role. It never drops a database or index. Run teardown explicitly from `backend` if a test process is interrupted:

```powershell
node scripts/attendance-e2e-fixtures.mjs cleanup
```

## Verification limits

Configuration safety tests run without connecting to MongoDB. Fixture, authentication, and browser tests require the dedicated URI/host allowlist and test accounts to be configured. Index preparation intentionally fails if the database account lacks the required database-scoped index privilege; do not bypass that failure.
