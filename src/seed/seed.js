import mongoose from "mongoose";
import { connectDB } from "../database/db.js";
import { Organization } from "../models/organizations/organization.model.js";
import { Branch } from "../models/branches/branch.model.js";
import { Role } from "../models/roles/role.model.js";
import { Permission } from "../models/permissions/permission.model.js";
import { User } from "../models/users/user.model.js";

const permissionsList = [
  "customers.view", "customers.create", "customers.edit", "customers.delete",
  "appointments.view", "appointments.create", "appointments.edit", "appointments.cancel",
  "employees.view", "employees.create", "employees.edit", "employees.delete",
  "services.view", "services.create", "services.edit", "services.delete",
  "billing.view", "billing.create", "billing.refund",
  "finance.view", "finance.create", "finance.edit",
  "inventory.view", "inventory.create", "inventory.adjust",
  "reports.view",
  "settings.view", "settings.edit",
  "users.manage",
  "roles.manage",
  "branches.manage",
  "activity-logs.view"
];

const seed = async () => {
  try {
    await connectDB();
    console.log("Connected to database for seeding...");

    // 1. Clear existing Organization, Branch, User, Role, Permission to start fresh
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

    // 4. Create Permissions
    const permissionDocs = [];
    for (const name of permissionsList) {
      const perm = await Permission.create({
        name,
        description: `Permission to access ${name}`
      });
      permissionDocs.push(perm);
    }
    console.log(`Created ${permissionDocs.length} permissions.`);

    // Helper to get permission ObjectId by name
    const getPermId = (name) => {
      const found = permissionDocs.find((p) => p.name === name);
      return found ? found._id : null;
    };

    // 5. Create Roles
    const ownerRole = await Role.create({
      name: "owner",
      description: "Full access to all branches and all permissions",
      permissions: permissionDocs.map((p) => p._id)
    });

    const managerPermNames = [
      "customers.view", "customers.create",
      "appointments.view", "appointments.create", "appointments.edit",
      "employees.view",
      "billing.view", "billing.create",
      "reports.view"
    ];
    const managerPermIds = managerPermNames.map(getPermId).filter(id => id !== null);

    const managerRole = await Role.create({
      name: "manager",
      description: "Operational management role",
      permissions: managerPermIds
    });
    console.log("Created Roles: owner, manager.");

    // 6. Create Owner user
    // Password will be hashed in the pre-save hook of User model
    const ownerUser = await User.create({
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

    // 7. Create Manager user
    const managerUser = await User.create({
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
