import mongoose from "mongoose";
import { connectDB } from "../database/db.js";
import { Customer } from "../models/customers/customer.model.js";

export const migrateCustomersLogic = async () => {
  console.log("Starting Customer isActive migration/backfill...");

  // Target legacy non-soft-deleted customers where isActive does not exist
  const query = { isActive: { $exists: false }, isDeleted: { $ne: true } };

  const result = await Customer.updateMany(
    query,
    { $set: { isActive: true } }
  );

  console.log("Migration Statistics:");
  console.log(`- Matched documents: ${result.matchedCount}`);
  console.log(`- Modified documents: ${result.modifiedCount}`);
  return result;
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
