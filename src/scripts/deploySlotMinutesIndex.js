import mongoose from "mongoose";
import dns from "node:dns";
import dotenv from "dotenv";

try {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch {
  // pass
}
import { Appointment } from "../models/appointments/appointment.model.js";
import { generateSlotMinutes } from "../services/appointments/appointment.service.js";
import { logger } from "../utils/logger.js";

dotenv.config();

/**
 * PRODUCTION DEPLOYMENT & MIGRATION SCRIPT:
 * Backfills slotMinutes and safely deploys the atomic covered multikey unique index:
 *   { organizationId: 1, staffId: 1, slotMinutes: 1 }
 *
 * Usage:
 *   node src/scripts/deploySlotMinutesIndex.js [--dry-run] [--reconcile-strategy=flag|abort]
 */
export async function deploySlotMinutesIndex(options = {}) {
  const isDryRun = options.dryRun ?? process.argv.includes("--dry-run");
  const reconcileStrategy = options.reconcileStrategy || 
    (process.argv.find(a => a.startsWith("--reconcile-strategy="))?.split("=")[1]) || "abort";

  logger.info(`Starting slotMinutes index deployment pre-flight. DryRun: ${isDryRun}, Strategy: ${reconcileStrategy}`);

  // 1. Audit active appointments requiring slotMinutes backfill
  const activeUnpopulated = await Appointment.find({
    isDeleted: false,
    status: { $in: ["scheduled", "in_progress"] },
    staffId: { $type: "objectId" },
    $or: [
      { slotMinutes: { $exists: false } },
      { slotMinutes: { $size: 0 } },
    ],
  });

  logger.info(`Found ${activeUnpopulated.length} active appointments needing slotMinutes backfill.`);

  if (!isDryRun && activeUnpopulated.length > 0) {
    let updatedCount = 0;
    for (const apt of activeUnpopulated) {
      if (apt.startAt && apt.endAt) {
        const slots = generateSlotMinutes(apt.startAt, apt.endAt);
        await Appointment.updateOne({ _id: apt._id }, { $set: { slotMinutes: slots } });
        updatedCount++;
      }
    }
    logger.info(`Successfully backfilled slotMinutes for ${updatedCount} active appointments.`);
  }

  // 2. Clean up terminal / deleted appointments (ensure empty slotMinutes)
  const terminalWithSlots = await Appointment.find({
    $or: [
      { isDeleted: true },
      { status: { $in: ["completed", "cancelled", "no_show"] } },
    ],
    slotMinutes: { $exists: true, $ne: [] },
  });

  if (terminalWithSlots.length > 0) {
    logger.info(`Found ${terminalWithSlots.length} terminal/deleted appointments with lingering slotMinutes.`);
    if (!isDryRun) {
      await Appointment.updateMany(
        { _id: { $in: terminalWithSlots.map(a => a._id) } },
        { $set: { slotMinutes: [] } }
      );
      logger.info(`Released slotMinutes for ${terminalWithSlots.length} terminal/deleted appointments.`);
    }
  }

  // 3. Pre-flight Conflict Detection: detect any duplicate active minute collisions
  const activeAppointments = await Appointment.find({
    isDeleted: false,
    status: { $in: ["scheduled", "in_progress"] },
    staffId: { $type: "objectId" },
  }).select("organizationId staffId appointmentCode appointmentDate startTime endTime slotMinutes startAt endAt");

  const minuteRegistry = new Map(); // key: `${orgId}_${staffId}_${minute}` -> appointment
  const detectedCollisions = [];

  for (const apt of activeAppointments) {
    const orgStaffKey = `${apt.organizationId.toString()}_${apt.staffId.toString()}`;
    const slots = (apt.slotMinutes && apt.slotMinutes.length > 0)
      ? apt.slotMinutes
      : (apt.startAt && apt.endAt ? generateSlotMinutes(apt.startAt, apt.endAt) : []);

    for (const minute of slots) {
      const collisionKey = `${orgStaffKey}_${minute}`;
      if (minuteRegistry.has(collisionKey)) {
        const existingApt = minuteRegistry.get(collisionKey);
        if (existingApt._id.toString() !== apt._id.toString()) {
          detectedCollisions.push({
            minute,
            existing: {
              id: existingApt._id,
              code: existingApt.appointmentCode,
              date: existingApt.appointmentDate,
              time: `${existingApt.startTime} - ${existingApt.endTime}`,
            },
            colliding: {
              id: apt._id,
              code: apt.appointmentCode,
              date: apt.appointmentDate,
              time: `${apt.startTime} - ${apt.endTime}`,
            },
          });
          break; // Flag this appointment and proceed
        }
      } else {
        minuteRegistry.set(collisionKey, apt);
      }
    }
  }

  if (detectedCollisions.length > 0) {
    logger.error(`CRITICAL: Detected ${detectedCollisions.length} preexisting active appointment collisions!`);
    console.table(detectedCollisions.map(c => ({
      Minute: c.minute,
      ExistingCode: c.existing.code,
      ExistingSlot: `${c.existing.date} ${c.existing.time}`,
      CollidingCode: c.colliding.code,
      CollidingSlot: `${c.colliding.date} ${c.colliding.time}`,
    })));

    if (reconcileStrategy === "abort") {
      throw new Error(
        `[INDEX DEPLOYMENT ABORTED] Database contains ${detectedCollisions.length} pre-existing active collisions. Reconcile these conflicts prior to building unique index to prevent index build failure.`
      );
    }
  } else {
    logger.info("Pre-flight collision check passed: 0 active conflicts detected in dataset.");
  }

  // 4. Safe index deployment
  const indexDefinition = { organizationId: 1, staffId: 1, slotMinutes: 1 };
  const indexOptions = {
    unique: true,
    name: "unique_staff_slot_minutes_v1",
    partialFilterExpression: {
      isDeleted: false,
      status: { $in: ["scheduled", "in_progress"] },
      staffId: { $type: "objectId" },
    },
  };

  if (!isDryRun) {
    logger.info("Deploying unique index 'unique_staff_slot_minutes_v1' on appointments collection...");
    const result = await Appointment.collection.createIndex(indexDefinition, indexOptions);
    logger.info(`Index creation successful: ${result}`);

    // Verify index exists
    const indexes = await Appointment.collection.indexes();
    const created = indexes.find(idx => idx.name === "unique_staff_slot_minutes_v1");
    if (!created) {
      throw new Error("Index verification failed: 'unique_staff_slot_minutes_v1' not found in indexes list.");
    }
    logger.info("Index verified successfully in production schema.");
  } else {
    logger.info("[DryRun] Skipping index creation step.");
  }

  return {
    success: true,
    activeBackfilled: activeUnpopulated.length,
    terminalCleaned: terminalWithSlots.length,
    collisionsDetected: detectedCollisions.length,
  };
}

// Standalone execution entrypoint
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("deploySlotMinutesIndex.js")) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(`
Usage: node src/scripts/deploySlotMinutesIndex.js [options]

Options:
  --help, -h                  Display this help message
  --dry-run                   Perform conflict detection & audit without database modifications
  --reconcile-strategy=STRAT  Conflict strategy: 'abort' (default, safe for prod) or 'flag'
    `);
    process.exit(0);
  }

  const mongoUri = process.env.MONGODB_URI || process.env.DATABASE_URL || process.env.TEST_MONGO_URI || process.env.MONGO_URI;
  if (!mongoUri) {
    console.error("MONGODB_URI (or TEST_MONGO_URI / MONGO_URI) is required in environment.");
    process.exit(1);
  }

  mongoose.connect(mongoUri)
    .then(() => deploySlotMinutesIndex())
    .then((res) => {
      console.log("Deployment completed successfully:", res);
      return mongoose.disconnect();
    })
    .catch((err) => {
      console.error("Index deployment failed:", err);
      process.exit(1);
    });
}
