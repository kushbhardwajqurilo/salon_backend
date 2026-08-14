import mongoose from "mongoose";
import { connectDB } from "../database/db.js";
import { Permission } from "../models/permissions/permission.model.js";
import { Role } from "../models/roles/role.model.js";
import { CANONICAL_PERMISSIONS } from "../config/permissions.js";
import { redis } from "../utils/redis.js";
import { logger } from "../utils/logger.js";

export const syncPermissionsLogic = async () => {
  logger.info("Starting permission synchronization...");
  
  // 1. Upsert permissions from canonical registry
  const canonicalNames = CANONICAL_PERMISSIONS.map(p => p.name.toLowerCase());
  
  let createdCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;
  
  const canonicalPermissionIds = [];
  
  for (const registryPerm of CANONICAL_PERMISSIONS) {
    const normalizedName = registryPerm.name.trim().toLowerCase();
    
    // Find existing permission
    let dbPerm = await Permission.findOne({ name: normalizedName });
    
    if (dbPerm) {
      // Check if metadata changed
      let hasChanges = false;
      if (dbPerm.module !== registryPerm.module) {
        dbPerm.module = registryPerm.module;
        hasChanges = true;
      }
      if (dbPerm.action !== registryPerm.action) {
        dbPerm.action = registryPerm.action;
        hasChanges = true;
      }
      if (dbPerm.description !== registryPerm.description) {
        dbPerm.description = registryPerm.description;
        hasChanges = true;
      }
      
      if (hasChanges) {
        await dbPerm.save();
        updatedCount++;
      } else {
        unchangedCount++;
      }
      
      canonicalPermissionIds.push(dbPerm._id);
    } else {
      // Create new permission while preserving the validation rules
      dbPerm = await Permission.create({
        name: normalizedName,
        module: registryPerm.module,
        action: registryPerm.action,
        description: registryPerm.description
      });
      createdCount++;
      canonicalPermissionIds.push(dbPerm._id);
    }
  }
  
  logger.info(`Permissions Sync Summary:
   - Canonical Registry Count: ${CANONICAL_PERMISSIONS.length}
   - Created: ${createdCount}
   - Updated metadata: ${updatedCount}
   - Unchanged: ${unchangedCount}`);
   
  // 2. Synchronize Owner Role permissions
  let ownerRole = await Role.findOne({ name: "owner" });
  if (!ownerRole) {
    logger.warn("Owner role not found in database. Creating a new one...");
    ownerRole = await Role.create({
      name: "owner",
      description: "Full access to all branches and all permissions (Explicitly Synced)",
      isSystem: true
    });
  } else {
    ownerRole.isSystem = true;
  }
  
  // Assign ALL and ONLY canonical registry permission IDs
  ownerRole.permissions = canonicalPermissionIds;
  await ownerRole.save();
  logger.info(`Owner role updated with exactly ${canonicalPermissionIds.length} canonical permissions.`);

  // 3. Synchronize Manager Role permissions
  const DEFAULT_MANAGER_PERM_NAMES = [
    "customers.view", "customers.create", "customers.update",
    "appointments.view", "appointments.book", "appointments.reschedule", "appointments.cancel",
    "employees.view",
    "billing.view", "billing.checkout",
    "reports.revenue.view"
  ];
  let managerRole = await Role.findOne({ name: "manager" });
  if (!managerRole) {
    logger.warn("Manager role not found in database. Creating a new one...");
    managerRole = await Role.create({
      name: "manager",
      description: "Operational management role",
      isSystem: true
    });
  } else {
    managerRole.isSystem = true;
  }
  const managerPermDocs = await Permission.find({ name: { $in: DEFAULT_MANAGER_PERM_NAMES } });
  managerRole.permissions = managerPermDocs.map(p => p._id);
  await managerRole.save();
  logger.info(`Manager role updated with ${managerPermDocs.length} permissions.`);
  
  // 4. Invalidate Cache
  await redis.del("rbac:role:owner:permissions");
  await redis.del("rbac:role:manager:permissions");
  await redis.del("rbac:modules");
  logger.info("Owner & Manager role permissions and modules cache invalidated.");
  
  // Return summary for testing/logs
  return {
    canonicalCount: CANONICAL_PERMISSIONS.length,
    createdCount,
    updatedCount,
    unchangedCount,
    ownerPermissionCount: canonicalPermissionIds.length,
    managerPermissionCount: managerPermDocs.length
  };
};

const run = async () => {
  // If this script is run directly from the command line
  if (process.argv[1] && (process.argv[1].endsWith("syncPermissions.js") || process.argv[1].endsWith("syncPermissions"))) {
    try {
      await connectDB();
      const summary = await syncPermissionsLogic();
      logger.info("Permissions sync completed successfully!");
      
      // Allow connection to close gracefully
      await mongoose.connection.close();
      // Quit Redis if it exists
      if (redis && typeof redis.quit === "function") {
        await redis.quit();
      }
      process.exit(0);
    } catch (error) {
      logger.error(`Permissions sync failed: ${error.stack}`);
      process.exit(1);
    }
  }
};

run();
