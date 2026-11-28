import mongoose from "mongoose";
import { ScopeLock } from "../../models/incentives/scopeLock.model.js";
import { AppError } from "../../utils/errors.js";

const DEFAULT_LEASE_DURATION_MS = 30000; // 30 seconds default lease
const DEFAULT_MAX_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 50;

/**
 * Service to manage mutual exclusion ScopeLocks across organization, branch, role, and staff entities.
 */
export class ScopeLockService {
  /**
   * Sorts scope descriptors in deterministic lexicographical order.
   * Order: scopeType ASC, then scopeKey ASC.
   *
   * @param {Array<{ scopeType: string, scopeKey: string }>} scopes
   * @returns {Array<{ scopeType: string, scopeKey: string }>}
   */
  static sortScopes(scopes) {
    return [...scopes].sort((a, b) => {
      const typeCompare = a.scopeType.localeCompare(b.scopeType);
      if (typeCompare !== 0) return typeCompare;
      return a.scopeKey.localeCompare(b.scopeKey);
    });
  }

  /**
   * Acquires a single scope lock atomically within an active MongoDB session.
   * Handles:
   * 1. Creating the lock document if none exists.
   * 2. Claiming an existing expired lease.
   * 3. Re-entrant acquisition by the same lockOwner.
   * 4. Retrying on duplicate key errors (code 11000) or transient transaction write conflicts.
   *
   * @param {Object} params
   * @param {mongoose.Types.ObjectId|string} params.organizationId
   * @param {string} params.scopeType - "ORGANIZATION" | "BRANCH" | "ROLE" | "STAFF"
   * @param {string} params.scopeKey
   * @param {string} params.lockOwner - Unique worker or operation identifier
   * @param {number} [params.leaseDurationMs=30000]
   * @param {mongoose.ClientSession} params.session - Active MongoDB ClientSession
   * @param {number} [params.maxRetries=5]
   * @returns {Promise<ScopeLock>}
   */
  async acquireLock({
    organizationId,
    scopeType,
    scopeKey,
    lockOwner,
    leaseDurationMs = DEFAULT_LEASE_DURATION_MS,
    session,
    maxRetries = DEFAULT_MAX_RETRIES,
  }) {
    if (!organizationId || !scopeType || !scopeKey || !lockOwner) {
      throw new AppError("organizationId, scopeType, scopeKey, and lockOwner are required to acquire ScopeLock", 400);
    }
    if (!session) {
      throw new AppError("ScopeLock acquisition requires an active MongoDB ClientSession", 500);
    }

    const orgObjectId = new mongoose.Types.ObjectId(organizationId);
    const scopeKeyStr = String(scopeKey);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const now = new Date();
      const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);

      try {
        // Attempt atomic claim or takeover of expired/owned lease
        const lock = await ScopeLock.findOneAndUpdate(
          {
            organizationId: orgObjectId,
            scopeType,
            scopeKey: scopeKeyStr,
            $or: [
              { leaseExpiresAt: null },
              { leaseExpiresAt: { $lt: now } }, // Expired lease
              { lockOwner: lockOwner },          // Re-entrant lock by same owner
            ],
          },
          {
            $set: {
              lockOwner,
              lockedAt: now,
              leaseExpiresAt,
            },
          },
          { session, returnDocument: 'after' }
        );

        if (lock) {
          return lock;
        }

        // If not found, attempt to insert a new ScopeLock document
        const existingLock = await ScopeLock.findOne(
          { organizationId: orgObjectId, scopeType, scopeKey: scopeKeyStr },
          null,
          { session }
        );

        if (!existingLock) {
          try {
            const [newLock] = await ScopeLock.create(
              [
                {
                  organizationId: orgObjectId,
                  scopeType,
                  scopeKey: scopeKeyStr,
                  lockOwner,
                  lockedAt: now,
                  leaseExpiresAt,
                },
              ],
              { session }
            );
            return newLock;
          } catch (createErr) {
            // Check if error is duplicate key on ScopeLock unique index
            if (createErr.code === 11000) {
              const isScopeLockKey =
                createErr.keyPattern?.organizationId &&
                createErr.keyPattern?.scopeType &&
                createErr.keyPattern?.scopeKey;

              if (isScopeLockKey || createErr.message?.includes("organizationId_1_scopeType_1_scopeKey_1")) {
                // Race condition on insert: wait and retry next attempt
                if (attempt < maxRetries) {
                  await this.delay(BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1));
                  continue;
                }
                throw new AppError(
                  `ScopeLock conflict: Scope [${scopeType}:${scopeKeyStr}] is locked by another owner`,
                  409
                );
              }
              // Unrelated duplicate key error: rethrow immediately!
              throw createErr;
            }
            throw createErr;
          }
        }

        // Lock document exists and lease is currently active by another owner
        if (attempt < maxRetries) {
          await this.delay(BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1));
          continue;
        }

        throw new AppError(
          `ScopeLock acquisition timeout: Scope [${scopeType}:${scopeKeyStr}] is locked by '${existingLock.lockOwner}' until ${existingLock.leaseExpiresAt?.toISOString()}`,
          409
        );
      } catch (err) {
        if (err.hasErrorLabel && err.hasErrorLabel("TransientTransactionError")) {
          if (attempt < maxRetries) {
            await this.delay(BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1));
            continue;
          }
        }
        throw err;
      }
    }

    throw new AppError(`Failed to acquire ScopeLock for [${scopeType}:${scopeKey}] after ${maxRetries} attempts`, 409);
  }

  /**
   * Acquires multiple locks in deterministic lexicographical order.
   *
   * @param {Object} params
   * @param {mongoose.Types.ObjectId|string} params.organizationId
   * @param {Array<{ scopeType: string, scopeKey: string }>} params.scopes
   * @param {string} params.lockOwner
   * @param {number} [params.leaseDurationMs=30000]
   * @param {mongoose.ClientSession} params.session
   * @returns {Promise<ScopeLock[]>}
   */
  async acquireMultipleLocks({
    organizationId,
    scopes,
    lockOwner,
    leaseDurationMs = DEFAULT_LEASE_DURATION_MS,
    session,
  }) {
    if (!scopes || scopes.length === 0) return [];

    // Filter duplicate scope requests in memory
    const uniqueMap = new Map();
    for (const s of scopes) {
      const key = `${s.scopeType}:${s.scopeKey}`;
      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, s);
      }
    }
    const uniqueScopes = Array.from(uniqueMap.values());

    // Enforce deterministic lexicographical order to prevent deadlocks
    const sortedScopes = ScopeLockService.sortScopes(uniqueScopes);

    const acquiredLocks = [];
    for (const scope of sortedScopes) {
      const lock = await this.acquireLock({
        organizationId,
        scopeType: scope.scopeType,
        scopeKey: scope.scopeKey,
        lockOwner,
        leaseDurationMs,
        session,
      });
      acquiredLocks.push(lock);
    }

    return acquiredLocks;
  }

  /**
   * Releases a lock held by the specified lockOwner.
   *
   * @param {Object} params
   * @param {mongoose.Types.ObjectId|string} params.organizationId
   * @param {string} params.scopeType
   * @param {string} params.scopeKey
   * @param {string} params.lockOwner
   * @param {mongoose.ClientSession} [params.session]
   * @returns {Promise<boolean>}
   */
  async releaseLock({
    organizationId,
    scopeType,
    scopeKey,
    lockOwner,
    session = null,
  }) {
    const orgObjectId = new mongoose.Types.ObjectId(organizationId);
    const scopeKeyStr = String(scopeKey);

    const res = await ScopeLock.updateOne(
      {
        organizationId: orgObjectId,
        scopeType,
        scopeKey: scopeKeyStr,
        lockOwner,
      },
      {
        $set: {
          leaseExpiresAt: new Date(0), // Instantly expire lease
        },
      },
      session ? { session } : {}
    );

    return res.modifiedCount > 0;
  }

  /**
   * Helper delay utility
   */
  async delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const scopeLockService = new ScopeLockService();
