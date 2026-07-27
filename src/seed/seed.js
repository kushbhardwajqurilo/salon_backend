import mongoose from "mongoose";
import { connectDB } from "../database/db.js";
import { Organization } from "../models/organizations/organization.model.js";
import { Branch } from "../models/branches/branch.model.js";
import { Role } from "../models/roles/role.model.js";
import { Permission } from "../models/permissions/permission.model.js";
import { User } from "../models/users/user.model.js";
import { syncPermissionsLogic } from "../scripts/syncPermissions.js";

const seed = async () => {
  try {
    await connectDB();
    console.log("Connected to database for seeding...");

    // 1. Clear existing collections to start fresh
    await User.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});
    await Role.deleteMany({});
    await Permission.deleteMany({});
    console.log("Cleared old database records.");

    // 2. Create Organization
    const org = await Organization.create({
      name: "Unisex Parlour",
      logo: null,
      isActive: true
    });
    console.log(`Created Organization: ${org.name} (${org._id})`);

    // 3. Create Branches
    const koramangala = await Branch.create({
      organizationId: org._id,
      name: "Koramangala",
      address: "5th Block, Koramangala, Bengaluru",
      phone: "+91 98765 43210",
      isActive: true
    });

    const indiranagar = await Branch.create({
      organizationId: org._id,
      name: "Indiranagar",
      address: "12th Main, Indiranagar, Bengaluru",
      phone: "+91 98765 43211",
      isActive: true
    });

    const whitefield = await Branch.create({
      organizationId: org._id,
      name: "Whitefield",
      address: "ITPL Road, Whitefield, Bengaluru",
      phone: "+91 98765 43212",
      isActive: false
    });
    console.log("Created Branches: Koramangala (active), Indiranagar (active), Whitefield (inactive).");

    // 4. Run Canonical Permissions Synchronization
    await syncPermissionsLogic();
    console.log("Canonical permissions synchronized.");

    // 5. Get Owner Role
    const ownerRole = await Role.findOne({ name: "owner" });

    // 6. Create Manager Role
    const managerPermNames = [
      "customers.view", "customers.create",
      "appointments.view", "appointments.book", "appointments.reschedule",
      "employees.view",
      "billing.view", "billing.checkout",
      "reports.revenue.view"
    ];
    const managerPerms = await Permission.find({ name: { $in: managerPermNames } });
    const managerRole = await Role.create({
      name: "manager",
      description: "Operational management role",
      permissions: managerPerms.map(p => p._id)
    });
    console.log("Created Roles: owner, manager.");

    // 7. Create Owner user
    await User.create({
      name: "John Doe",
      email: "owner@parlour.com",
      phone: "+91 9999999999",
      password: "Admin@1234",
      role: ownerRole._id,
      organizationId: org._id,
      isVerified: true,
      branchAccess: [
        { branchId: koramangala._id, branchName: koramangala.name, isActive: koramangala.isActive },
        { branchId: indiranagar._id, branchName: indiranagar.name, isActive: indiranagar.isActive },
        { branchId: whitefield._id, branchName: whitefield.name, isActive: whitefield.isActive }
      ]
    });

    // 8. Create Manager user
    await User.create({
      name: "Jane Manager",
      email: "manager@parlour.com",
      phone: "+91 8888888888",
      password: "Manager@1234",
      role: managerRole._id,
      organizationId: org._id,
      isVerified: true,
      branchAccess: [
        { branchId: koramangala._id, branchName: koramangala.name, isActive: koramangala.isActive }
      ]
    });

    console.log("Created Owner (John Doe) and Manager (Jane Manager) users.");
    console.log("Database seeding completed successfully!");
    process.exit(0);
  } catch (error) {
    console.error("Error during database seeding:", error);
    process.exit(1);
  }
};

seed();
