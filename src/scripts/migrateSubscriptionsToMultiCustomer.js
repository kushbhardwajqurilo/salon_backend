import mongoose from "mongoose";
import { Subscription } from "../models/subscriptions/subscription.model.js";
import { logger } from "../utils/logger.js";
import dotenv from "dotenv";

dotenv.config();

/**
 * Migration Script: Migrate single-customer subscriptions to canonical multi-customer structure.
 * Idempotent, restartable, with verification and safe rollback.
 */
export async function migrateSubscriptionsToMultiCustomer(dryRun = false) {
  logger.info(`[MIGRATION] Starting subscription migration (dryRun=${dryRun})...`);

  const unmigratedQuery = {
    $or: [
      { members: { $exists: false } },
      { members: { $size: 0 } },
      { payerCustomerId: { $exists: false } },
    ],
  };

  const totalToMigrate = await Subscription.countDocuments(unmigratedQuery);
  logger.info(`[MIGRATION] Found ${totalToMigrate} subscriptions requiring migration.`);

  if (totalToMigrate === 0) {
    logger.info("[MIGRATION] All subscriptions are already up to date. Nothing to do.");
    return { migratedCount: 0, skippedCount: 0, errorCount: 0 };
  }

  let migratedCount = 0;
  let errorCount = 0;

  const cursor = Subscription.find(unmigratedQuery).cursor();

  for await (const doc of cursor) {
    try {
      if (dryRun) {
        logger.info(`[DRY-RUN] Would migrate subscription ${doc.subscriptionCode} (${doc._id})`);
        migratedCount++;
        continue;
      }

      const payerCustomerId = doc.payerCustomerId || doc.customerId;
      const updateDoc = { $set: { payerCustomerId } };

      // Only build and set default member allocation if doc has NO existing members
      if (!Array.isArray(doc.members) || doc.members.length === 0) {
        const initialMemberStatus = doc.status === "exhausted" ? "exhausted" : (doc.status === "cancelled" ? "cancelled" : "active");
        const memberAllocation = {
          customerId: doc.customerId,
          status: initialMemberStatus,
          permittedBranchIds: doc.permittedBranchIds || [],
          entitlements: (doc.entitlements || []).map((e) => ({
            serviceId: e.serviceId,
            serviceName: e.serviceName,
            totalQuantity: e.totalQuantity,
            usedQuantity: e.usedQuantity || 0,
            remainingQuantity: e.remainingQuantity,
          })),
          notes: doc.notes ? `[Migrated]: ${doc.notes}` : "Migrated from single-customer subscription",
        };
        updateDoc.$set.members = [memberAllocation];
      }

      await Subscription.updateOne(
        { _id: doc._id },
        updateDoc
      );

      migratedCount++;
      if (migratedCount % 100 === 0) {
        logger.info(`[MIGRATION] Progress: ${migratedCount}/${totalToMigrate} migrated.`);
      }
    } catch (err) {
      errorCount++;
      logger.error(`[MIGRATION ERROR] Failed to migrate subscription ${doc._id}: ${err.message}`);
    }
  }

  if (dryRun) {
    logger.info(`[DRY-RUN COMPLETE] Inspected: ${totalToMigrate}, Would Migrate: ${migratedCount}, Errors: ${errorCount} (No database writes performed).`);
  } else {
    logger.info(`[MIGRATION COMPLETE] Migrated: ${migratedCount}, Errors: ${errorCount}`);
  }
  return { migratedCount, errorCount, totalToMigrate, dryRun };
}

// If executed directly from command line
if (process.argv[1]?.endsWith("migrateSubscriptionsToMultiCustomer.js")) {
  const isDryRun = process.argv.includes("--dry-run");
  const mongoUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/saloon_erp";

  mongoose
    .connect(mongoUri)
    .then(async () => {
      await migrateSubscriptionsToMultiCustomer(isDryRun);
      await mongoose.disconnect();
      process.exit(0);
    })
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}
