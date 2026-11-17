import crypto from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { ConnectionString } from "mongodb-connection-string-url";

const { MongoClient } = mongoose.mongo;

const appEnvPath = new URL("../../.env", import.meta.url);
const appEnv = dotenv.parse(fs.readFileSync(appEnvPath, "utf-8"));
const sourceUri = appEnv.MONGO_URI;

if (!sourceUri) {
  throw new Error("Cannot run disposable tests: MONGO_URI is missing from backend/.env.");
}

let source;
try {
  source = new ConnectionString(sourceUri);
} catch {
  throw new Error("Cannot run disposable tests: backend/.env contains an invalid MongoDB URI.");
}

const sourceDb = decodeURIComponent((source.pathname || "").replace(/^\//, ""));
if (
  source.protocol.toLowerCase() !== "mongodb+srv:" ||
  !sourceDb ||
  !source.hosts.length ||
  source.hosts.some((host) => !host.toLowerCase().endsWith(".mongodb.net"))
) {
  throw new Error("Cannot run disposable tests: backend/.env URI is not a valid Atlas URI with a database path.");
}

const runId = `${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
const databaseName = `incentives_test_${runId}`;
if (databaseName.length > 38) {
  throw new Error("Cannot run disposable tests: generated database name exceeds MongoDB's 38-byte limit.");
}
if (databaseName.toLowerCase() === sourceDb.toLowerCase()) {
  throw new Error("Cannot run disposable tests: generated database name matches the application database.");
}

const testUriObject = new ConnectionString(sourceUri);
testUriObject.pathname = `/${databaseName}`;
const testUri = testUriObject.toString();

function assertOnlyDatabasePathChanged() {
  const derived = new ConnectionString(testUri);
  if (
    derived.protocol !== source.protocol ||
    derived.username !== source.username ||
    derived.password !== source.password ||
    JSON.stringify(derived.hosts) !== JSON.stringify(source.hosts) ||
    derived.searchParams.toString() !== source.searchParams.toString() ||
    decodeURIComponent(derived.pathname.replace(/^\//, "")) !== databaseName
  ) {
    throw new Error("Cannot run disposable tests: derived URI changed more than its database path.");
  }
}

assertOnlyDatabasePathChanged();
process.env.NODE_ENV = "test";
process.env.TEST_MONGO_URI = testUri;
process.env.TEST_MONGO_RUN_DATABASE = databaseName;

const { validateTestDatabaseUri, getIsolatedTestMongoUri } = await import("./testSetup.js");
validateTestDatabaseUri(testUri);
let applicationDatabaseRejected = false;
try {
  validateTestDatabaseUri(sourceUri);
} catch {
  applicationDatabaseRejected = true;
}
if (!applicationDatabaseRejected) {
  throw new Error("Cannot run disposable tests: the application database was accepted by the test guard.");
}
if (getIsolatedTestMongoUri("incentives_test") !== testUri) {
  throw new Error("Cannot run disposable tests: suite helper did not retain the exact authorized database.");
}
if (sourceDb.toLowerCase() === databaseName.toLowerCase()) {
  throw new Error("Cannot run disposable tests: application database name is forbidden.");
}

console.log(`Disposable database name verified as unique: ${databaseName}`);
console.log("Database guard verified: application database rejected; disposable database accepted.");

const markerId = crypto.randomUUID();
const markerCollection = "__disposable_test_run_identity";
const client = new MongoClient(testUri);
let databaseCreated = false;
let commandExitCode = 1;
let cleanupError = null;

function redactOutput(value) {
  let output = String(value || "");
  for (const secret of [sourceUri, testUri, source.username, source.password]) {
    if (secret) output = output.split(secret).join("[redacted]");
  }
  return output;
}

try {
  await client.connect();
  const admin = client.db().admin();
  const existing = await admin
    .listDatabases({ nameOnly: true, filter: { name: databaseName } })
    .then((result) => result.databases.some((database) => database.name === databaseName));

  if (existing) {
    throw new Error("Refusing to use generated database because it already exists.");
  }

  const testDb = client.db(databaseName);
  await testDb.collection(markerCollection).insertOne({
    _id: markerId,
    purpose: "disposable-test-run",
    createdAt: new Date(),
  });
  databaseCreated = true;
  const marker = await testDb.collection(markerCollection).findOne({ _id: markerId });
  if (!marker || marker.purpose !== "disposable-test-run") {
    throw new Error("Could not positively identify the newly created disposable test database.");
  }
  console.log(`Disposable database verified: ${databaseName}`);

  const jestArgs = [
    "--experimental-vm-modules",
    "--import",
    "./src/tests/testSetup.js",
    "node_modules/jest/bin/jest.js",
    "--runInBand",
    "--forceExit",
    ...process.argv.slice(2),
  ];
  const result = spawnSync(process.execPath, jestArgs, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TEST_MONGO_URI: testUri,
      TEST_MONGO_RUN_DATABASE: databaseName,
    },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.stdout) process.stdout.write(redactOutput(result.stdout));
  if (result.stderr) process.stderr.write(redactOutput(result.stderr));
  commandExitCode = result.status === null ? 1 : result.status;
  console.log(`Jest command exit code: ${commandExitCode}`);
  if (result.error) {
    console.error(`Jest could not start: ${redactOutput(result.error.message)}`);
  }
} catch (error) {
  console.error(`Disposable test run failed: ${redactOutput(error.message)}`);
  commandExitCode = 1;
} finally {
  if (databaseCreated) {
    try {
      const testDb = client.db(databaseName);
      const marker = await testDb.collection(markerCollection).findOne({ _id: markerId });
      if (!marker || marker.purpose !== "disposable-test-run") {
        throw new Error("Identity marker missing; refusing to drop an unverified database.");
      }

      await testDb.dropDatabase();
      const stillExists = await client
        .db()
        .admin()
        .listDatabases({ nameOnly: true, filter: { name: databaseName } })
        .then((result) => result.databases.some((database) => database.name === databaseName));
      if (stillExists) {
        throw new Error("Exact disposable database still exists after the drop request.");
      }
      console.log(`Cleanup verified: dropped only ${databaseName}`);
    } catch (error) {
      cleanupError = error;
      console.error(`Disposable database cleanup failed: ${redactOutput(error.message)}`);
    }
  }

  await client.close().catch((error) => {
    cleanupError ||= error;
    console.error(`MongoDB connection close failed: ${redactOutput(error.message)}`);
  });
}

if (cleanupError) commandExitCode = 1;
process.exitCode = commandExitCode;
