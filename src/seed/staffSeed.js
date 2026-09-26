import mongoose from "mongoose";
import { connectDB } from "../database/db.js";
import { Organization } from "../models/organizations/organization.model.js";
import { Branch } from "../models/branches/branch.model.js";
import { Staff } from "../models/staff/staff.model.js";
import { StaffBranch } from "../models/staff/staffBranch.model.js";
import { StaffService } from "../models/staff/staffService.model.js";
import { Service } from "../models/services/service.model.js";
import { ServiceCategory } from "../models/services/serviceCategory.model.js";
import { Sequence } from "../models/sequence/sequence.model.js";

// Professional salon staff profiles with specialized categories matching your 11 price list pages
const STAFF_SEED_PROFILES = [
  {
    name: "Aarti Sharma",
    phone: "+919871001001",
    email: "aarti.sharma@parlour.com",
    designation: "Senior Hair Stylist & Colorist",
    joiningDate: new Date("2024-01-15"),
    targetCategories: ["Hair Styling", "Hair Coloring", "Hair Cut", "Chemical Jobs", "Hair Treatment", "Head Wash"],
    branchIndex: 0, // Koramangala
  },
  {
    name: "Pooja Verma",
    phone: "+919871001002",
    email: "pooja.verma@parlour.com",
    designation: "Master Makeup Artist & PMU Specialist",
    joiningDate: new Date("2024-02-01"),
    targetCategories: [
      "Permanent Make-Up",
      "Flawless Make-Up",
      "MAC Make-Up",
      "Air Brush Make-Up",
      "Celebrity Make-Up",
      "Hollywood Celebrity Make-Up",
    ],
    branchIndex: 0, // Koramangala
  },
  {
    name: "Sunita Patel",
    phone: "+919871001003",
    email: "sunita.patel@parlour.com",
    designation: "Skin Aesthetician & Laser Therapist",
    joiningDate: new Date("2024-02-15"),
    targetCategories: [
      "Skin Treatment",
      "Facials",
      "IPL",
      "Bleach Oxy",
      "O3+ D-Tan",
      "Jolen / Protein",
    ],
    branchIndex: 1, // Indiranagar
  },
  {
    name: "Rohan Kapoor",
    phone: "+919871001004",
    email: "rohan.kapoor@parlour.com",
    designation: "Senior Hairdresser & Chemical Specialist",
    joiningDate: new Date("2024-03-01"),
    targetCategories: ["Hair Cut", "Chemical Jobs", "Hair Coloring", "Hair Treatment", "Hair Styling"],
    branchIndex: 1, // Indiranagar
  },
  {
    name: "Meera Nair",
    phone: "+919871001005",
    email: "meera.nair@parlour.com",
    designation: "Nail Artist & Waxing Specialist",
    joiningDate: new Date("2024-03-10"),
    targetCategories: [
      "Nail Servicing",
      "Manicure & Pedicure",
      "Rica Wax",
      "Chocolate / Aloevera Wax",
      "Regular Wax",
      "Red Wax / Brazilian Wax",
      "Threading",
    ],
    branchIndex: 0, // Koramangala
  },
  {
    name: "Kavita Rao",
    phone: "+919871001006",
    email: "kavita.rao@parlour.com",
    designation: "Body Spa Therapist & Polishing Expert",
    joiningDate: new Date("2024-03-20"),
    targetCategories: ["Body Massage", "Body Polishing", "Facials", "Manicure & Pedicure"],
    branchIndex: 1, // Indiranagar
  },
];

export const seedStaffWithServices = async () => {
  try {
    await connectDB();
    console.log("Connected to MongoDB for staff seeding...");

    const org = await Organization.findOne({ isActive: true }) || await Organization.findOne({});
    if (!org) {
      console.error("No organization found. Please run seed first.");
      process.exit(1);
    }
    console.log(`Using Organization: "${org.name}" (${org._id})`);

    const branches = await Branch.find({ organizationId: org._id, isActive: true });
    if (!branches.length) {
      console.error("No active branches found. Please seed branches first.");
      process.exit(1);
    }
    console.log(`Active branches found: ${branches.map((b) => b.name).join(", ")}`);

    let totalStaffCreatedOrUpdated = 0;
    let totalServicesAssigned = 0;

    for (const profile of STAFF_SEED_PROFILES) {
      // 1. Find or create staff
      let staff = await Staff.findOne({
        organizationId: org._id,
        $or: [{ email: profile.email }, { phone: profile.phone }],
        isDeleted: false,
      });

      if (!staff) {
        // Atomic sequence increment for staffCode
        const seqDoc = await Sequence.findOneAndUpdate(
          { key: `staffCode:${org._id}` },
          { $inc: { seq: 1 } },
          { new: true, upsert: true }
        );
        const staffCode = `STF-${String(seqDoc.seq).padStart(4, "0")}`;

        staff = await Staff.create({
          name: profile.name,
          phone: profile.phone,
          email: profile.email,
          designation: profile.designation,
          joiningDate: profile.joiningDate,
          staffCode,
          status: "active",
          organizationId: org._id,
        });
        console.log(`\n+ [Created Staff] ${staff.name} (${staff.staffCode}) - ${staff.designation}`);
      } else {
        staff.name = profile.name;
        staff.designation = profile.designation;
        staff.status = "active";
        await staff.save();
        console.log(`\n* [Found Staff] ${staff.name} (${staff.staffCode}) - ${staff.designation}`);
      }

      totalStaffCreatedOrUpdated++;

      // 2. Assign Primary Branch
      const branchToAssign = branches[profile.branchIndex % branches.length];
      const existingBranchAssignment = await StaffBranch.findOne({
        staffId: staff._id,
        branchId: branchToAssign._id,
        organizationId: org._id,
      });

      if (!existingBranchAssignment) {
        await StaffBranch.create({
          staffId: staff._id,
          branchId: branchToAssign._id,
          organizationId: org._id,
          isPrimary: true,
          isActive: true,
        });
        console.log(`  -> Assigned to branch: ${branchToAssign.name} (Primary)`);
      }

      // Also assign all other active branches as secondary so staff can take appointments
      for (const branch of branches) {
        if (branch._id.toString() !== branchToAssign._id.toString()) {
          const secBranch = await StaffBranch.findOne({
            staffId: staff._id,
            branchId: branch._id,
            organizationId: org._id,
          });
          if (!secBranch) {
            await StaffBranch.create({
              staffId: staff._id,
              branchId: branch._id,
              organizationId: org._id,
              isPrimary: false,
              isActive: true,
            });
          }
        }
      }

      // 3. Find matching categories for this staff's target skills
      const categories = await ServiceCategory.find({
        organizationId: org._id,
        name: { $in: profile.targetCategories },
        isDeleted: false,
      });
      const categoryIds = categories.map((c) => c._id);

      // Find services under these categories
      const services = await Service.find({
        organizationId: org._id,
        categoryId: { $in: categoryIds },
        isDeleted: false,
        status: "active",
      });

      let staffAssignedCount = 0;
      for (const service of services) {
        const existingMapping = await StaffService.findOne({
          staffId: staff._id,
          serviceId: service._id,
          organizationId: org._id,
        });

        if (!existingMapping) {
          await StaffService.create({
            staffId: staff._id,
            serviceId: service._id,
            organizationId: org._id,
            isActive: true,
          });
          staffAssignedCount++;
          totalServicesAssigned++;
        } else if (!existingMapping.isActive) {
          existingMapping.isActive = true;
          await existingMapping.save();
          staffAssignedCount++;
          totalServicesAssigned++;
        }
      }

      console.log(
        `  -> Assigned ${services.length} services across categories: [${profile.targetCategories.join(", ")}]`
      );
    }

    console.log("\n==========================================");
    console.log("Staff & Service Assignment Seeding Completed Successfully!");
    console.log(`Total Staff Processed: ${totalStaffCreatedOrUpdated}`);
    console.log(`Total New Service Mappings Assigned: ${totalServicesAssigned}`);
    console.log("==========================================\n");

    if (process.env.NODE_ENV !== "test") {
      process.exit(0);
    }
  } catch (error) {
    console.error("Error during staff seeding:", error);
    process.exit(1);
  }
};

if (process.argv[1]?.endsWith("staffSeed.js")) {
  seedStaffWithServices();
}
