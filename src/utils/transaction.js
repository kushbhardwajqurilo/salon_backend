import mongoose from "mongoose";
import { AppError } from "./errors.js";

/**
 * Checks if the current MongoDB connection supports multi-document transactions.
 * Transactions require a ReplicaSet or Sharded topology.
 */
export const isTransactionSupported = () => {
  const topologyType = mongoose.connection.client?.topology?.description?.type;
  return ["ReplicaSetWithPrimary", "ReplicaSetNoPrimary", "Sharded"].includes(topologyType);
};

/**
 * Standardized transaction execution helper for MongoDB operations.
 *
 * Guarantees:
 * - Uses MongoDB's official `session.withTransaction` for automatic handling of transient errors and commit retries.
 * - Enforces ACID transaction guarantees when `requireTransaction: true` (e.g. financial payments, subscription redemption).
 * - Never silently falls back in production environments.
 * - Test/standalone fallback is ONLY permitted when explicitly enabled via `ALLOW_STANDALONE_TRANSACTION_FALLBACK=true` AND `requireTransaction: false`.
 * - Guarantees proper session cleanup (`session.endSession()`) in finally block.
 *
 * @param {Function} callback - Async function receiving `session` (or `null` if standalone fallback is legitimately active).
 * @param {Object} options
 * @param {boolean} [options.requireTransaction=true] - If true, throws error if transactions are unsupported. Defaults to true for safety.
 * @returns {Promise<any>} Result of callback
 */
export const runInTransaction = async (callback, { requireTransaction = true } = {}) => {
  const supportsTx = isTransactionSupported();
  const allowFallback = process.env.ALLOW_STANDALONE_TRANSACTION_FALLBACK === "true";

  if (!supportsTx) {
    if (requireTransaction || !allowFallback) {
      throw new AppError(
        "ACID transaction support is required for this operation but unavailable in the database environment (MongoDB replica set required)",
        500
      );
    }
    // Genuinely non-critical operation in a standalone test environment where fallback was explicitly requested
    return await callback(null);
  }

  const session = await mongoose.connection.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await callback(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
};
