import mongoose from "mongoose";
import { connectDB } from "../database/db.js";
import { Permission } from "../models/permissions/permission.model.js";
import { Role } from "../models/roles/role.model.js";
import { CANONICAL_PERMISSIONS } from "../config/permissions.js";
import { redis } from "../utils/redis.js";
import { logger } from "../utils/logger.js";

// Permission caches are scoped by organization.  A system-role update (such as
// owner) must therefore clear every tenant copy, not just the legacy key.
const invalidateRolePermissionCaches = async (roleName) => {
  const normalizedRole = roleName.toLowerCase().trim();
  const match = `rbac:org:*:role:${normalizedRole}:permissions`;

  try {
    if (typeof redis.scan === "function") {
      let cursor = "0";
      do {
        const [nextCursor, keys] = await redis.scan(cursor, "MATCH", match, "COUNT", 100);
        cursor = nextCursor;
        if (keys.length) await redis.del(...keys);
      } while (cursor !== "0");
    }

    // Supports global, legacy, and lightweight test Redis clients.
    await redis.del(
      `rbac:org:global:role:${normalizedRole}:permissions`,
      `rbac:role:${normalizedRole}:permissions`,
    );
  } catch (err) {
    logger.warn(`Failed to invalidate permission caches for role '${normalizedRole}': ${err.message}`);
  }
};

export const syncPermissionsLogic = async () => {
  logger.info("Starting permission synchronization...");

  // 1. Upsert permissions from canonical registry
  const canonicalNames = CANONICAL_PERMISSIONS.map((p) => p.name.toLowerCase());

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
        description: registryPerm.description,
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
      description:
        "Full access to all branches and all permissions (Explicitly Synced)",
      isSystem: true,
    });
  } else {
    ownerRole.isSystem = true;
  }

  // Assign ALL and ONLY canonical registry permission IDs
  ownerRole.permissions = canonicalPermissionIds;
  await ownerRole.save();
  logger.info(
    `Owner role updated with exactly ${canonicalPermissionIds.length} canonical permissions.`,
  );

  // 3. Synchronize Manager Role permissions
  const DEFAULT_MANAGER_PERM_NAMES = [
    // Customers (all)
    "customers.view",
    "customers.create",
    "customers.update",
    "customers.delete",
    "customers.export",
    "customers.edit",
    // Subscriptions (all)
    "subscriptions.view",
    "subscriptions.configure",
    "subscriptions.sell",
    "subscriptions.redeem",
    // Memberships (all)
    "memberships.view",
    "memberships.configure",
    "memberships.sell",
    // Employees (all)
    "employees.view",
    "employees.create",
    "employees.update",
    "employees.delete",
    "employees.assign_branch",
    "employees.assign_service",
    // Leaves (all)
    "employees.leaves.view",
    "employees.leaves.manage",
    // Payroll (HR/Manager operational capabilities)
    "payroll.view",
    "payroll.structure.manage",
    "payroll.calculate",
    "payroll.adjust",
    "payroll.export",
    // Incentives (Manager operational permissions)
    "incentives.view",
    "incentives.view.all",
    "incentives.rules.manage",
    "incentives.approve",
    "incentives.payout.sync",
    "incentives.fulfillment.confirm",
    "incentives.fulfillment.correct",
    // Procurement (Manager full operations)
    "procurement.suppliers.view",
    "procurement.suppliers.manage",
    "procurement.orders.view",
    "procurement.orders.create",
    "procurement.orders.update",
    "procurement.invoices.manage",
    "procurement.payments.manage",
    // Services (all)
    "services.view",
    "services.create",
    "services.update",
    "services.delete",
    // Existing defaults
    "appointments.view",
    "appointments.book",
    "appointments.create",
    "appointments.reschedule",
    "appointments.cancel",
    "billing.view",
    "billing.checkout",
    "billing.attribution.correct",
    "reports.revenue.view",
    "branches.view",
    "logs.view",
  ];
  let managerRole = await Role.findOne({ name: "manager" });
  if (!managerRole) {
    logger.warn("Manager role not found in database. Creating a new one...");
    managerRole = await Role.create({
      name: "manager",
      description: "Operational management role",
      isSystem: true,
    });
  } else {
    managerRole.isSystem = true;
  }
  const managerPermDocs = await Permission.find({
    name: { $in: DEFAULT_MANAGER_PERM_NAMES },
  });
  managerRole.permissions = managerPermDocs.map((p) => p._id);
  await managerRole.save();
  logger.info(
    `Manager role updated with ${managerPermDocs.length} permissions.`,
  );

  // 4. Update Receptionist Role if exists
  const receptionistRole = await Role.findOne({ name: "receptionist" });
  if (receptionistRole) {
    const branchesViewPerm = await Permission.findOne({ name: "branches.view" });
    if (branchesViewPerm && !receptionistRole.permissions.some((p) => p.toString() === branchesViewPerm._id.toString())) {
      receptionistRole.permissions.push(branchesViewPerm._id);
      await receptionistRole.save();
      logger.info("Added branches.view to receptionist role.");
    }
  }

  // 5. Invalidate Cache
  await invalidateRolePermissionCaches("owner");
  await invalidateRolePermissionCaches("manager");
  await invalidateRolePermissionCaches("receptionist");
  await redis.del("rbac:modules");

  logger.info(
    "Owner, Manager & Receptionist role permissions and modules cache invalidated.",
  );

  // Return summary for testing/logs
  return {
    canonicalCount: CANONICAL_PERMISSIONS.length,
    createdCount,
    updatedCount,
    unchangedCount,
    ownerPermissionCount: canonicalPermissionIds.length,
    managerPermissionCount: managerPermDocs.length,
  };
};

const run = async () => {
  // If this script is run directly from the command line
  if (
    process.argv[1] &&
    (process.argv[1].endsWith("syncPermissions.js") ||
      process.argv[1].endsWith("syncPermissions"))
  ) {
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
