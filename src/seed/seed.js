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

    // 2. Create Organization if it doesn't exist
    let org = await Organization.findOne({ name: "Unisex Parlour" });
    if (!org) {
      org = await Organization.create({
        name: "Unisex Parlour",
        logo: null,
        isActive: true
      });
      console.log(`Created Organization: ${org.name} (${org._id})`);
    } else {
      console.log(`Organization "Unisex Parlour" already exists (${org._id})`);
    }
 
    // 3. Create Branches if they don't exist
    let koramangala = await Branch.findOne({ name: "Koramangala", organizationId: org._id });
    if (!koramangala) {
      koramangala = await Branch.create({
        organizationId: org._id,
        name: "Koramangala",
        address: "5th Block, Koramangala, Bengaluru",
        phone: "+91 98765 43210",
        isActive: true
      });
      console.log("Created Koramangala branch.");
    } else {
      console.log("Koramangala branch already exists.");
    }
 
    let indiranagar = await Branch.findOne({ name: "Indiranagar", organizationId: org._id });
    if (!indiranagar) {
      indiranagar = await Branch.create({
        organizationId: org._id,
        name: "Indiranagar",
        address: "12th Main, Indiranagar, Bengaluru",
        phone: "+91 98765 43211",
        isActive: true
      });
      console.log("Created Indiranagar branch.");
    } else {
      console.log("Indiranagar branch already exists.");
    }
 
    let whitefield = await Branch.findOne({ name: "Whitefield", organizationId: org._id });
    if (!whitefield) {
      whitefield = await Branch.create({
        organizationId: org._id,
        name: "Whitefield",
        address: "ITPL Road, Whitefield, Bengaluru",
        phone: "+91 98765 43212",
        isActive: false
      });
      console.log("Created Whitefield branch.");
    } else {
      console.log("Whitefield branch already exists.");
    }
 
    // 4. Run Canonical Permissions Synchronization
    await syncPermissionsLogic();
    console.log("Canonical permissions synchronized.");
 
    // 5. Get Owner Role
    const ownerRole = await Role.findOne({ name: "owner" });
 
    // 6. Create Manager Role if it doesn't exist
    let managerRole = await Role.findOne({ name: "manager" });
    if (!managerRole) {
      const managerPermNames = [
        "customers.view", "customers.create",
        "appointments.view", "appointments.book", "appointments.reschedule",
        "employees.view",
        "billing.view", "billing.checkout",
        "reports.revenue.view"
      ];
      const managerPerms = await Permission.find({ name: { $in: managerPermNames } });
      managerRole = await Role.create({
        name: "manager",
        description: "Operational management role",
        permissions: managerPerms.map(p => p._id)
      });
      console.log("Created Manager role.");
    } else {
      console.log("Manager role already exists.");
    }
 
    // 7. Create Owner user if it doesn't exist
    let ownerUser = await User.findOne({ email: "owner@parlour.com" });
    if (!ownerUser) {
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
      console.log("Created Owner user (John Doe).");
    } else {
      console.log("Owner user (John Doe) already exists.");
    }
 
    // 8. Create Manager user if it doesn't exist
    let managerUser = await User.findOne({ email: "manager@parlour.com" });
    if (!managerUser) {
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
      console.log("Created Manager user (Jane Manager).");
    } else {
      console.log("Manager user (Jane Manager) already exists.");
    }

    console.log("Created Owner (John Doe) and Manager (Jane Manager) users.");
    console.log("Database seeding completed successfully!");
    process.exit(0);
  } catch (error) {
    console.error("Error during database seeding:", error);
    process.exit(1);
  }
};

seed();
