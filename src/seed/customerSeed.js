import mongoose from "mongoose";
import { connectDB } from "../database/db.js";
import { Organization } from "../models/organizations/organization.model.js";
import { Branch } from "../models/branches/branch.model.js";
import { Customer } from "../models/customers/customer.model.js";

// Exact profiles requested by user:
// Phone: 9654165886, Email: kushqurilo@gmail.com
// Phone: 9958062867, Email: kushgemini05@gmail.com
const PRIMARY_PROFILES = [
  {
    branchIndex: 0, // Koramangala
    name: "Kush Qurilo",
    phone: "9654165886",
    email: "kushqurilo@gmail.com",
    gender: "male",
    tags: ["VIP", "Primary"]
  },
  {
    branchIndex: 1, // Indiranagar
    name: "Kush Gemini",
    phone: "9958062867",
    email: "kushgemini05@gmail.com",
    gender: "male",
    tags: ["VIP", "Primary"]
  }
];

const FIRST_NAMES = [
  "Aarav", "Aditi", "Ananya", "Arjun", "Deepika", "Ishaan", "Kavya", "Manish",
  "Meera", "Neha", "Nikhil", "Pooja", "Rahul", "Rhea", "Rohan", "Sanya",
  "Shreya", "Siddharth", "Sneha", "Tanvi", "Varun", "Vikram", "Zoya", "Kunal",
  "Priyanka", "Karan", "Divya", "Aditya", "Ritu", "Harsh", "Simran", "Gaurav",
  "Aakash", "Bhavna", "Chetan", "Dia", "Esha", "Farhan", "Geeta", "Hemant",
  "Isha", "Jatin", "Komal", "Lavanya", "Mohit", "Naveen", "Pallavi", "Rajesh",
  "Swati", "Tarun"
];

const LAST_NAMES = [
  "Sharma", "Verma", "Patel", "Reddy", "Rao", "Nair", "Iyer", "Mehta",
  "Kapoor", "Malhotra", "Joshi", "Bhat", "Kulkarni", "Deshmukh", "Chopra",
  "Singh", "Das", "Menon", "Pillai", "Hegde"
];

const SOURCES = ["walk_in", "instagram", "facebook", "google", "website", "referral"];
const GENDERS = ["female", "female", "male", "male", "female", "prefer_not_to_say"];

/**
 * Generates 50 customer documents for a specific branch
 */
function generateCustomersForBranch(orgId, branch, otherBranchIds, branchIndex) {
  const customers = [];
  const primaryProfile = PRIMARY_PROFILES.find((p) => p.branchIndex === branchIndex);

  for (let i = 1; i <= 50; i++) {
    // Inject the requested custom profile as customer #1 of this branch
    if (i === 1 && primaryProfile) {
      customers.push({
        name: primaryProfile.name,
        email: primaryProfile.email,
        phone: primaryProfile.phone,
        organizationId: orgId,
        homeBranchId: branch._id,
        visitedBranchIds: [branch._id, ...(otherBranchIds.length > 0 ? [otherBranchIds[0]] : [])],
        loyaltyPoints: 300,
        gender: primaryProfile.gender,
        acquisitionSource: "referral",
        status: "active",
        marketingPreferences: {
          sms: true,
          whatsapp: true,
          email: true,
          promotions: true,
          appointmentReminders: true
        },
        address: {
          addressLine1: `#101, ${branch.name} Prime Arcade`,
          city: "Bengaluru",
          state: "Karnataka",
          postalCode: "560001",
          country: "India"
        },
        tags: primaryProfile.tags
      });
      continue;
    }

    const firstName = FIRST_NAMES[(i - 1) % FIRST_NAMES.length];
    const lastName = LAST_NAMES[(i + branchIndex) % LAST_NAMES.length];
    const fullName = `${firstName} ${lastName}`;

    // Unique deterministic phone numbers
    // Branch 0 (Koramangala): 9811000001 to 9811000050
    // Branch 1 (Indiranagar): 9812000001 to 9812000050
    // Branch 2 (Whitefield):  9813000001 to 9813000050
    const phoneSuffix = String(i).padStart(4, "0");
    const phone = `981${branchIndex + 1}00${phoneSuffix}`;
    const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}${branchIndex + 1}${i}@example.com`;

    const visitedBranchIds = [branch._id];
    if (i % 4 === 0 && otherBranchIds.length > 0) {
      visitedBranchIds.push(otherBranchIds[i % otherBranchIds.length]);
    }

    customers.push({
      name: fullName,
      email,
      phone,
      organizationId: orgId,
      homeBranchId: branch._id,
      visitedBranchIds,
      loyaltyPoints: (i * 15) % 350,
      gender: GENDERS[i % GENDERS.length],
      acquisitionSource: SOURCES[i % SOURCES.length],
      status: i % 25 === 0 ? "inactive" : "active",
      marketingPreferences: {
        sms: true,
        whatsapp: i % 2 === 0,
        email: i % 3 === 0,
        promotions: i % 2 === 0,
        appointmentReminders: true
      },
      address: {
        addressLine1: `#${100 + i}, ${branch.name} Main Road`,
        city: "Bengaluru",
        state: "Karnataka",
        postalCode: "560001",
        country: "India"
      },
      tags: i % 5 === 0 ? ["VIP", "Regular"] : ["Regular"]
    });
  }

  return customers;
}

export const seedCustomers = async () => {
  try {
    await connectDB();
    console.log("Connected to database for customer seeding...");

    const org = await Organization.findOne({ name: "Unisex Parlour" });
    if (!org) {
      throw new Error('Organization "Unisex Parlour" not found. Run "npm run seed" first.');
    }

    // Fetch the 3 branches
    const branches = await Branch.find({ organizationId: org._id }).sort({ createdAt: 1 }).limit(3);
    if (branches.length < 3) {
      throw new Error(`Found only ${branches.length} branches. Need at least 3 branches.`);
    }

    console.log("Target branches:");
    branches.forEach((b, idx) => console.log(`  [${idx + 1}] ${b.name} (${b._id})`));

    // Handle existing customers with the provided phone numbers
    // 9654165886 -> Update or set to Koramangala
    // 9958062867 -> Update or set to Indiranagar
    const targetPhones = ["9654165886", "9958062867"];
    await Customer.deleteMany({
      organizationId: org._id,
      phone: { $in: targetPhones }
    });
    console.log("Cleared existing records matching target phones to re-insert cleanly.");

    let totalInserted = 0;

    for (let bIdx = 0; bIdx < branches.length; bIdx++) {
      const branch = branches[bIdx];
      const otherBranchIds = branches.filter((_, idx) => idx !== bIdx).map((b) => b._id);

      const candidateCustomers = generateCustomersForBranch(org._id, branch, otherBranchIds, bIdx);
      console.log(`\nProcessing ${candidateCustomers.length} customers for branch: ${branch.name}...`);

      for (const custData of candidateCustomers) {
        // Upsert or recreate cleanly
        await Customer.deleteOne({
          organizationId: org._id,
          phone: custData.phone
        });

        await Customer.create(custData);
        totalInserted++;
      }

      const currentCount = await Customer.countDocuments({
        organizationId: org._id,
        homeBranchId: branch._id,
        isDeleted: false
      });
      console.log(`  Branch "${branch.name}" active customers count: ${currentCount}`);
    }

    console.log(`\n========================================`);
    console.log(`Customer seeding completed!`);
    console.log(`  Total customers inserted: ${totalInserted}`);
    console.log(`========================================\n`);

    // Verify target profiles
    const verified = await Customer.find({
      organizationId: org._id,
      phone: { $in: ["9654165886", "9958062867"] }
    }).populate("homeBranchId", "name");

    console.log("Verified Requested Profiles in DB:");
    verified.forEach((c) => {
      console.log(`  - Name: ${c.name} | Phone: ${c.phone} | Email: ${c.email} | Branch: ${c.homeBranchId?.name}`);
    });

    process.exit(0);
  } catch (error) {
    console.error("Error during customer seeding:", error);
    process.exit(1);
  }
};

if (process.argv[1]?.endsWith("customerSeed.js")) {
  seedCustomers();
}
