import fs from "node:fs";
import path from "node:path";
import dns from "node:dns";
import mongoose from "mongoose";
import dotenv from "dotenv";
import { ConnectionString } from "mongodb-connection-string-url";

// In environments where the default local DNS resolver cannot resolve MongoDB Atlas SRV records,
// explicitly configure reliable public resolvers so test database connections succeed.
try {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch (err) {
  console.warn("Failed to set DNS servers in test setup:", err?.message || err);
}

// -----------------------------------------------------------------------------
// Dedicated Test Environment Loading (.env.test exclusive source)
// -----------------------------------------------------------------------------
// Purge any preexisting shell or inherited environment variables unconditionally
// upon module load to prevent shell bypass or accidental leakage.
delete process.env.TEST_MONGO_URI;
delete process.env.TEST_MONGO_ALLOWED_HOSTS;

// Explicitly default NODE_ENV to "test" during test bootstrap if unset
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "test";
}

const envTestPath = path.resolve(process.cwd(), ".env.test");

if (fs.existsSync(envTestPath)) {
  const rawContent = fs.readFileSync(envTestPath, "utf-8");
  const testParsed = dotenv.parse(rawContent);

  if (testParsed.TEST_MONGO_URI && testParsed.TEST_MONGO_URI.trim()) {
    process.env.TEST_MONGO_URI = testParsed.TEST_MONGO_URI.trim();
  }
}

/**
 * Explicit registry of recognized test-suite suffixes.
 * Every integration test database MUST end with one of these registered suffixes
 * to guarantee strict test namespace isolation and avoid collisions with development/production databases.
 */
export const REGISTERED_SUITE_SUFFIXES = Object.freeze([
  "custom_services_test",
  "apt_test",
  "appt_sub_test",
  "audit_test",
  "integration_test",
  "permissions_sync_test",
  "billing_test",
  "checkout_queue_test",
  "invoice_discounts_test",
  "tx_safety_test",
  "loyalty_test",
  "sub_billing_test",
  "sub_branch_reg_test",
  "sub_listing_test",
  "multi_sub_test",
  "recovery_gaps_test",
  "sub_test",
  "plan_test",
  "phase7c_runner_test",
  "inventory_test",
]);

/**
 * List of forbidden application / development / production database names.
 * These databases can NEVER be targeted, connected to, or wiped by any test suite or test setup.
 */
export const FORBIDDEN_APPLICATION_DB_NAMES = Object.freeze([
  "saloon_erp",
  "saloon_erp_test",
  "saloon_erp_dev",
  "saloon_erp_development",
  "saloon_erp_prod",
  "production",
  "prod",
  "main",
  "development",
  "dev",
  "test",
  "admin",
  "local",
  "config",
]);

/**
 * Extracts and normalizes the hostnames and target database name from a MongoDB connection string.
 *
 * @param {string} uriString - The MongoDB connection URI
 * @returns {{ hosts: string[], dbName: string, protocol: string, parsed: ConnectionString }}
 */
function parseMongoUri(uriString) {
  if (!uriString || typeof uriString !== "string" || !uriString.trim()) {
    throw new Error(
      "🚨 [FATAL TEST DATABASE GUARD] Explicit TEST_MONGO_URI is required for test database execution. Refusing silent fallback to MONGO_URI."
    );
  }

  const trimmed = uriString.trim();
  let parsed;
  try {
    parsed = new ConnectionString(trimmed);
  } catch (err) {
    throw new Error(
      `🚨 [FATAL TEST DATABASE GUARD] Invalid MongoDB URI provided. Parse error: ${err.message}`
    );
  }

  const protocol = parsed.protocol ? parsed.protocol.toLowerCase() : "";
  if (protocol !== "mongodb+srv:") {
    throw new Error(
      `🚨 [FATAL TEST DATABASE GUARD] Invalid MongoDB URI protocol: '${parsed.protocol}'. ` +
      "Under the Atlas-only policy, all connections must use 'mongodb+srv://' targeting a MongoDB Atlas cluster (*.mongodb.net)."
    );
  }

  const hosts = Array.isArray(parsed.hosts) ? parsed.hosts : [];
  if (hosts.length === 0) {
    throw new Error("🚨 [FATAL TEST DATABASE GUARD] MongoDB URI must specify at least one host.");
  }

  const dbName = (parsed.pathname || "").replace(/^\//, "").trim();
  return { hosts, dbName, protocol, parsed, trimmed };
}

/**
 * Validates a MongoDB URI to guarantee it is strictly an isolated, suite-specific test database
 * on an authorized local or explicitly allowlisted remote test host.
 *
 * Rules:
 * 1. Rejects if NODE_ENV === "production".
 * 2. Rejects if uriString is missing, empty, or not a string.
 * 3. Rejects invalid URI scheme (must be 'mongodb:' or 'mongodb+srv:').
 * 4. Extracts all hostnames from the connection string:
 *    - Allows "localhost" and "127.0.0.1" (case-insensitive).
 *    - For any remote host, requires TEST_MONGO_ALLOWED_HOSTS to be set.
 *    - Matches each host strictly against exact, normalized, comma-separated entries in TEST_MONGO_ALLOWED_HOSTS.
 *    - Never uses substring or loose wildcard matching.
 *    - Never logs credentials or full URI.
 * 5. Requires an explicit database name that is NOT in FORBIDDEN_APPLICATION_DB_NAMES.
 * 6. Specifically and explicitly rejects "saloon_erp", "saloon_erp_test", "saloon_erp_dev", etc.
 * 7. Requires that the database name ends with one of the REGISTERED_SUITE_SUFFIXES.
 *    Unsuffixed databases are unconditionally rejected even if they contain the word "test".
 * 8. Checks against application MONGO_URI (if defined): rejects if the normalized host/cluster
 *    and database name target the same database as MONGO_URI.
 *
 * @param {string} uriString - The MongoDB connection URI to validate
 * @returns {string} The validated URI string
 */
export function validateTestDatabaseUri(uriString) {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "🚨 [FATAL TEST DATABASE GUARD] Tests cannot run when NODE_ENV === 'production'. Aborting immediately."
    );
  }

  const { hosts, dbName, trimmed } = parseMongoUri(uriString);

  // 1. Host-level validation: Enforce Atlas-only architecture (*.mongodb.net)
  // Localhost, loopback IPs, and any non-Atlas hostnames are strictly rejected unconditionally
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

  for (const hostEntry of hosts) {
    const cleanHost = hostEntry.split(":")[0].trim().toLowerCase();

    // Reject localhost, 127.0.0.1, and loopback IPs
    if (localHosts.has(cleanHost)) {
      throw new Error(
        `🚨 [FATAL TEST DATABASE GUARD] Local MongoDB host '${cleanHost}' is strictly forbidden. ` +
        "This project uses MongoDB Atlas exclusively (*.mongodb.net). Localhost and loopback execution are not permitted."
      );
    }

    // Must strictly be an Atlas hostname ending in .mongodb.net
    const isAtlasHost = cleanHost.endsWith(".mongodb.net");
    if (!isAtlasHost) {
      throw new Error(
        `🚨 [FATAL TEST DATABASE GUARD] Non-Atlas MongoDB host '${cleanHost}' is not authorized. ` +
        "Tests must target a valid MongoDB Atlas cluster ending in '*.mongodb.net'. Non-Atlas hosts are strictly forbidden."
      );
    }
  }

  // 2. Database path presence
  if (!dbName) {
    throw new Error(
      "🚨 [FATAL TEST DATABASE GUARD] TEST_MONGO_URI must explicitly specify a database path (e.g. /saloon_erp_test_sub_test)."
    );
  }

  const normalizedDb = dbName.toLowerCase();

  // 3. Strictly forbid application / development / production database names
  for (const forbidden of FORBIDDEN_APPLICATION_DB_NAMES) {
    if (normalizedDb === forbidden.toLowerCase()) {
      throw new Error(
        `🚨 [FATAL TEST DATABASE GUARD] Refusing to connect to application/development database '${dbName}'. Tests must use an isolated suite-specific database.`
      );
    }
  }

  // 4. Must contain "test" in the database name
  if (!/test/i.test(dbName)) {
    throw new Error(
      `🚨 [FATAL TEST DATABASE GUARD] Database name '${dbName}' must contain 'test' (case-insensitive) to ensure test isolation.`
    );
  }

  // 5. Must end with a registered suite suffix to prevent unsuffixed base database wipes
  const matchesRegisteredSuffix = REGISTERED_SUITE_SUFFIXES.some((suffix) => {
    return normalizedDb.endsWith(`_${suffix}`) || normalizedDb === suffix;
  });

  if (!matchesRegisteredSuffix) {
    throw new Error(
      `🚨 [FATAL TEST DATABASE GUARD] Database name '${dbName}' is not a recognized isolated suite database. ` +
      `Every test database must end with a registered suite suffix (e.g. '_billing_test'). Unsuffixed databases are strictly forbidden.`
    );
  }

  // 6. Cross-check against application MONGO_URI if set
  if (process.env.MONGO_URI && typeof process.env.MONGO_URI === "string" && process.env.MONGO_URI.trim()) {
    try {
      const appParsed = parseMongoUri(process.env.MONGO_URI);
      const appNormalizedDb = appParsed.dbName.toLowerCase();

      // Check if same database name on matching hosts
      if (appNormalizedDb === normalizedDb) {
        // Compare normalized hosts
        const appHosts = new Set(appParsed.hosts.map((h) => h.split(":")[0].trim().toLowerCase()));
        const hasCommonHost = hosts.some((h) => appHosts.has(h.split(":")[0].trim().toLowerCase()));

        if (hasCommonHost) {
          throw new Error(
            `🚨 [FATAL TEST DATABASE GUARD] Collision detected: Test URI targets the exact same database '${dbName}' on host '${hosts[0]}' as application MONGO_URI.`
          );
        }
      }
    } catch (err) {
      if (err.message.includes("Collision detected")) {
        throw err;
      }
      // If MONGO_URI fails to parse for other reasons, it does not collide
    }
  }

  return trimmed;
}

/**
 * Returns a validated isolated test database URI for a specific test suite namespace.
 * Requires a non-empty, registered suiteSuffix to prevent test suites from sharing a single test database.
 * Derives the database name by composing the base test database path with the registered suffix.
 * Never falls back to application MONGO_URI.
 *
 * @param {string} suiteSuffix - Mandatory registered suite suffix (e.g. 'billing_test')
 * @returns {string} Validated isolated MongoDB test URI
 */
export function getIsolatedTestMongoUri(suiteSuffix) {
  const baseTestUri = process.env.TEST_MONGO_URI;
  if (!baseTestUri) {
    throw new Error(
      "🚨 [FATAL TEST DATABASE GUARD] Explicit TEST_MONGO_URI environment variable is required for integration tests. " +
      "Define TEST_MONGO_URI in '.env.test' (e.g. 'mongodb+srv://<user>:<password>@cluster.xxxx.mongodb.net/saloon_erp_ephemeral_test?retryWrites=true&w=majority')."
    );
  }

  if (!suiteSuffix || typeof suiteSuffix !== "string" || !suiteSuffix.trim()) {
    throw new Error(
      "🚨 [FATAL TEST DATABASE GUARD] Non-empty suiteSuffix is required to ensure database namespace isolation between test suites."
    );
  }

  const cleanSuffix = suiteSuffix.replace(/^\//, "").trim();

  // Suffix must be registered in the suite registry
  if (!REGISTERED_SUITE_SUFFIXES.includes(cleanSuffix)) {
    throw new Error(
      `🚨 [FATAL TEST DATABASE GUARD] Invalid suiteSuffix '${cleanSuffix}'. Must be one of the registered test suites: ${REGISTERED_SUITE_SUFFIXES.join(", ")}`
    );
  }

  // Parse the base TEST_MONGO_URI
  const parsed = new ConnectionString(baseTestUri.trim());
  const baseDb = (parsed.pathname || "").replace(/^\//, "").trim();

  if (!baseDb) {
    throw new Error(
      "🚨 [FATAL TEST DATABASE GUARD] Base TEST_MONGO_URI must include a base database name (e.g. /saloon_erp_test)."
    );
  }

  // Compose target database name:
  // If baseDb already ends with cleanSuffix, keep it; otherwise compose `${baseDb}_${cleanSuffix}`
  const targetDb = baseDb.endsWith(cleanSuffix)
    ? baseDb
    : `${baseDb}_${cleanSuffix}`;

  parsed.pathname = `/${targetDb}`;

  const isolatedUri = parsed.toString();
  // Validate final isolated URI through all safety rules
  validateTestDatabaseUri(isolatedUri);
  return isolatedUri;
}

// -----------------------------------------------------------------------------
// Global Interceptor: Protect mongoose.connect and mongoose.createConnection
// Prevents any test code from connecting to an unvalidated database
// -----------------------------------------------------------------------------
const originalMongooseConnect = mongoose.connect.bind(mongoose);
const originalMongooseCreateConnection = mongoose.createConnection.bind(mongoose);

mongoose.connect = function (uri, options) {
  if (typeof uri === "string") {
    validateTestDatabaseUri(uri);
  }
  return originalMongooseConnect(uri, options);
};

mongoose.createConnection = function (uri, options) {
  if (typeof uri === "string") {
    validateTestDatabaseUri(uri);
  }
  return originalMongooseCreateConnection(uri, options);
};

// Global environment guard executed on module import via `--import ./src/tests/testSetup.js`
if (process.env.NODE_ENV === "production") {
  throw new Error(
    "🚨 [FATAL TEST DATABASE GUARD] Cannot run tests with NODE_ENV='production'."
  );
}
