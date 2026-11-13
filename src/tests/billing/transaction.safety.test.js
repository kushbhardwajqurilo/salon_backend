import { describe, expect, it, beforeAll, afterAll } from "@jest/globals";
import mongoose from "mongoose";
import "../../../src/config/env.js";
import { runInTransaction, isTransactionSupported } from "../../../src/utils/transaction.js";
import { AppError } from "../../../src/utils/errors.js";
import { getIsolatedTestMongoUri } from "../testSetup.js";

describe("Production Transaction Safety & Verification Suite", () => {
  beforeAll(async () => {
    const testUri = getIsolatedTestMongoUri("tx_safety_test");
    await mongoose.connect(testUri);
  });

  afterAll(async () => {
    const col = mongoose.connection.collection("tx_safety_verifications");
    try {
      await col.drop();
    } catch (_) {}
    await mongoose.connection.close();
  });

  it("1. correctly detects transaction capability in the environment", () => {
    const supported = isTransactionSupported();
    const topologyType = mongoose.connection.client?.topology?.description?.type;
    const isReplicaOrSharded = ["ReplicaSetWithPrimary", "ReplicaSetNoPrimary", "Sharded", "LoadBalanced"].includes(topologyType);
    expect(supported).toBe(isReplicaOrSharded);
  });

  it("2. rolls back multiple writes atomically when an error is thrown inside transaction", async () => {
    const col = mongoose.connection.collection("tx_safety_verifications");
    const uniqueKey = `tx-rollback-${Date.now()}`;

    let errorThrown = false;
    try {
      await runInTransaction(async (session) => {
        await col.insertOne({ key: uniqueKey, step: 1 }, { session });
        await col.insertOne({ key: uniqueKey, step: 2 }, { session });
        throw new Error("Intentional failure mid-transaction");
      }, { requireTransaction: true });
    } catch (err) {
      errorThrown = true;
      expect(err.message).toBe("Intentional failure mid-transaction");
    }

    expect(errorThrown).toBe(true);
    const count = await col.countDocuments({ key: uniqueKey });
    expect(count).toBe(0); // Proves atomic rollback occurred!
  });

  it("3. commits all writes atomically when transaction succeeds", async () => {
    const col = mongoose.connection.collection("tx_safety_verifications");
    const uniqueKey = `tx-commit-${Date.now()}`;

    const result = await runInTransaction(async (session) => {
      await col.insertOne({ key: uniqueKey, step: 1 }, { session });
      await col.insertOne({ key: uniqueKey, step: 2 }, { session });
      return { committed: true };
    }, { requireTransaction: true });

    expect(result.committed).toBe(true);
    const docs = await col.find({ key: uniqueKey }).toArray();
    expect(docs).toHaveLength(2);
  });

  it("4. rejects execution with 500 AppError when requireTransaction is true and transactions are unsupported", async () => {
    const origClient = mongoose.connection.client;
    const origHost = mongoose.connection.host;

    // Temporarily simulate a Standalone / Single topology with consistent mock state
    mongoose.connection.host = "standalone-mongo.local";
    mongoose.connection.client = {
      ...origClient,
      topology: {
        description: {
          type: "Single",
        },
      },
    };

    try {
      await expect(
        runInTransaction(async () => {
          return "should-not-run";
        }, { requireTransaction: true })
      ).rejects.toThrow(AppError);
    } finally {
      mongoose.connection.client = origClient;
      mongoose.connection.host = origHost;
    }
  });

  it("5. strictly prevents silent fallback in non-replica environments when requireTransaction is true, even if fallback flag is present", async () => {
    const origClient = mongoose.connection.client;
    const origHost = mongoose.connection.host;
    const oldFlag = process.env.ALLOW_STANDALONE_TRANSACTION_FALLBACK;
    process.env.ALLOW_STANDALONE_TRANSACTION_FALLBACK = "true";

    mongoose.connection.host = "standalone-mongo.local";
    mongoose.connection.client = {
      ...origClient,
      topology: {
        description: {
          type: "Single",
        },
      },
    };

    try {
      await expect(
        runInTransaction(async () => {
          return "should-not-run";
        }, { requireTransaction: true })
      ).rejects.toThrow(
        /ACID transaction support is required for this operation/
      );
    } finally {
      mongoose.connection.client = origClient;
      mongoose.connection.host = origHost;
      if (oldFlag !== undefined) {
        process.env.ALLOW_STANDALONE_TRANSACTION_FALLBACK = oldFlag;
      } else {
        delete process.env.ALLOW_STANDALONE_TRANSACTION_FALLBACK;
      }
    }
  });
});
