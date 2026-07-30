import mongoose from "mongoose";
import { connectDB } from "../database/db.js";
import { Customer } from "../models/customers/customer.model.js";
import { CustomerNote } from "../models/customers/customerNote.model.js";
import { AuditLog, AUDIT_ACTIONS } from "../models/audit/auditLog.model.js";
import { normalizePhone } from "../utils/phone.js";

const mapAction = (legacyAction) => {
  const mapping = {
    customer_created: AUDIT_ACTIONS.CUSTOMER_CREATED,
    customer_updated: AUDIT_ACTIONS.CUSTOMER_UPDATED,
    customer_deactivated: AUDIT_ACTIONS.CUSTOMER_DEACTIVATED,
    customer_reactivated: AUDIT_ACTIONS.CUSTOMER_REACTIVATED,
    customer_deleted: AUDIT_ACTIONS.CUSTOMER_DELETED,
    customer_note_added: AUDIT_ACTIONS.NOTE_ADDED,
    customer_home_branch_changed: AUDIT_ACTIONS.CUSTOMER_UPDATED,
  };
  return mapping[legacyAction] || AUDIT_ACTIONS.CUSTOMER_UPDATED;
};

export const migrateCustomersLogic = async () => {
  console.log("Starting Customer migration...");

  // Load all customers including soft-deleted ones
  // Note: we temporarily query using mongo driver bypass to read legacy notes & activityTimeline if the model schema has been updated.
  const customersCursor = mongoose.connection.db.collection("customers").find({});
  const customersRaw = await customersCursor.toArray();
  console.log(`Found ${customersRaw.length} total customers in database.`);

  let notesMigrated = 0;
  let notesSkipped = 0;
  let notesErrors = 0;

  let activityMigrated = 0;
  let activitySkipped = 0;
  let activityErrors = 0;

  // Track counts
  for (const customerDoc of customersRaw) {
    const orgId = customerDoc.organizationId;
    const fallbackBranchId = customerDoc.homeBranchId;

    // 1. Migrate Notes
    if (customerDoc.notes && customerDoc.notes.length > 0) {
      for (const note of customerDoc.notes) {
        try {
          const noteText = (note.text || "").trim();
          if (!noteText) {
            notesSkipped++;
            continue;
          }

          // Idempotency check: see if note already exists
          const existingNote = await CustomerNote.findOne({
            customerId: customerDoc._id,
            text: noteText,
            createdBy: note.createdBy,
            createdAt: note.createdAt || note.date,
          });

          if (existingNote) {
            notesSkipped++;
          } else {
            await CustomerNote.create({
              organizationId: orgId,
              branchId: note.branchId || fallbackBranchId,
              customerId: customerDoc._id,
              text: noteText,
              createdBy: note.createdBy,
              createdAt: note.createdAt || note.date || new Date(),
              updatedAt: note.updatedAt || note.createdAt || note.date || new Date(),
            });
            notesMigrated++;
          }
        } catch (err) {
          console.error(`Error migrating note for customer ${customerDoc._id}:`, err);
          notesErrors++;
        }
      }
    }

    // 2. Migrate Activity Timeline
    if (customerDoc.activityTimeline && customerDoc.activityTimeline.length > 0) {
      for (const act of customerDoc.activityTimeline) {
        try {
          const actionStr = mapAction(act.action);
          const descriptionStr = act.description || "";

          // Idempotency check
          const existingAudit = await AuditLog.findOne({
            organizationId: orgId,
            entityType: "Customer",
            entityId: customerDoc._id,
            action: actionStr,
            description: descriptionStr,
            actorId: act.performedBy,
            createdAt: act.date,
          });

          if (existingAudit) {
            activitySkipped++;
          } else {
            await AuditLog.create({
              organizationId: orgId,
              branchId: act.branchId || fallbackBranchId,
              actorId: act.performedBy,
              action: actionStr,
              entityType: "Customer",
              entityId: customerDoc._id,
              description: descriptionStr,
              metadata: { migratedFromLegacy: true },
              createdAt: act.date || new Date(),
            });
            activityMigrated++;
          }
        } catch (err) {
          console.error(`Error migrating activity for customer ${customerDoc._id}:`, err);
          activityErrors++;
        }
      }
    }
  }

  // 3. Resolve duplicates by phone number using Mongoose Customer model (sync indexes, normalization)
  const customers = await Customer.find({}).setOptions({ includeDeleted: true });
  const groups = {};
  for (const customer of customers) {
    const orgId = customer.organizationId.toString();
    const phone = normalizePhone(customer.phone);
    
    let needsSave = false;
    if (customer.phone !== phone) {
      customer.phone = phone;
      needsSave = true;
    }
    if (customer.alternatePhone) {
      const altPhone = normalizePhone(customer.alternatePhone);
      if (customer.alternatePhone !== altPhone) {
        customer.alternatePhone = altPhone;
        needsSave = true;
      }
    }
    if (!customer.status) {
      customer.status = "active";
      needsSave = true;
    }
    
    if (needsSave) {
      await customer.save();
    }

    if (!customer.isDeleted) {
      const key = `${orgId}_${phone}`;
      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push(customer);
    }
  }

  let duplicatesResolvedCount = 0;
  for (const key of Object.keys(groups)) {
    const list = groups[key];
    if (list.length > 1) {
      list.sort((a, b) => b.updatedAt - a.updatedAt);
      const primary = list[0];
      const duplicates = list.slice(1);

      console.log(`Duplicate detected for phone ${primary.phone} in organization ${primary.organizationId}. Merging ${duplicates.length} duplicates into primary customer ${primary._id}.`);

      for (const dup of duplicates) {
        if (dup.visitedBranchIds && dup.visitedBranchIds.length > 0) {
          const combined = [...primary.visitedBranchIds, ...dup.visitedBranchIds].map(id => id.toString());
          primary.visitedBranchIds = [...new Set(combined)];
        }
        if (dup.preferences?.preferredStaff && dup.preferences.preferredStaff.length > 0) {
          const combined = [...(primary.preferences?.preferredStaff || []), ...dup.preferences.preferredStaff].map(id => id.toString());
          primary.preferences.preferredStaff = [...new Set(combined)];
        }
        if (dup.preferences?.preferredServices && dup.preferences.preferredServices.length > 0) {
          const combined = [...(primary.preferences?.preferredServices || []), ...dup.preferences.preferredServices].map(id => id.toString());
          primary.preferences.preferredServices = [...new Set(combined)];
        }

        dup.isDeleted = true;
        dup.status = "inactive";
        dup.deletedAt = new Date();
        await dup.save();
        duplicatesResolvedCount++;
      }

      await primary.save();
    }
  }

  console.log("Synchronizing database indexes...");
  await Customer.syncIndexes();
  await CustomerNote.syncIndexes();
  await AuditLog.syncIndexes();

  console.log("Migration complete!");
  console.log(`Resolved duplicates: ${duplicatesResolvedCount}`);
  console.log(`Notes: migrated=${notesMigrated}, skipped=${notesSkipped}, errors=${notesErrors}`);
  console.log(`Activity: migrated=${activityMigrated}, skipped=${activitySkipped}, errors=${activityErrors}`);

  return {
    duplicatesResolvedCount,
    notesMigrated,
    notesSkipped,
    notesErrors,
    activityMigrated,
    activitySkipped,
    activityErrors
  };
};

const run = async () => {
  try {
    await connectDB();
    await migrateCustomersLogic();
    await mongoose.connection.close();
    console.log("Database connection closed cleanly.");
    process.exit(0);
  } catch (err) {
    console.error("Migration failed:", err);
    try {
      await mongoose.connection.close();
    } catch (_) {}
    process.exit(1);
  }
};

// Execute if run directly
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('migrateCustomers.js')) {
  run();
}
