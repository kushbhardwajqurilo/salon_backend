import mongoose from "mongoose";
import dotenv from "dotenv";
import dns from "dns";
import { Service } from "../models/services/service.model.js";
import { ServiceCategory } from "../models/services/serviceCategory.model.js";

dotenv.config();

// Fix for Windows DNS resolution for MongoDB Atlas SRV connection strings
try {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch (e) {
  // Ignore if not supported in environment
}

/**
 * Classifies a service as 'male', 'female', or 'unisex' based on its category and name.
 */
export const classifyServiceGender = (service) => {
  const cat = (service.categoryId?.name || service.category || "").trim();
  const name = (service.name || "").trim().toLowerCase();

  // 1. Explicit Male services (e.g., Beard, Shaving, Men specific)
  if (
    /\b(beard|shave|shaving|moustache|moustaches|men|mens|boy|boys|groom)\b/i.test(name) ||
    /\b(men|mens|male)\b/i.test(cat)
  ) {
    return "male";
  }

  // 2. Explicit Female Categories:
  // - Makeup & Permanent Makeup (Bridal, Party, Engagement, Eye/Lip Liner, Kajal, Micro Blading)
  // - Nail Servicing & Extensions
  // - Waxing categories (Chocolate, Rica, Regular, Red Wax / Brazilian)
  // - Bleach & Jolen Protein
  // - Threading
  if (
    cat.toLowerCase().includes("make-up") ||
    cat.toLowerCase().includes("makeup") ||
    cat === "Nail Servicing" ||
    cat.includes("Wax") ||
    cat === "Bleach Oxy" ||
    cat === "Jolen / Protein" ||
    cat === "Threading"
  ) {
    return "female";
  }

  // 3. Female-specific keywords within Hair Styling or general services
  if (
    name.includes("bun") ||
    name.includes("fall") ||
    name.includes("tongs") ||
    name.includes("roller setting") ||
    name.includes("pressing") ||
    name.includes("bridal") ||
    name.includes("bikini") ||
    name.includes("blouse line") ||
    name.includes("cleopatra") ||
    name.includes("eyelash") ||
    name.includes("micro blading") ||
    name.includes("lip liner") ||
    name.includes("kajal") ||
    name.includes("upper lips") ||
    name.includes("henna application")
  ) {
    return "female";
  }

  // 4. Unisex services (Hair Cut, Hair Color, Hair Spa/Treatment, Head Wash, Facials, Skin Treatments, IPL, Body Massages, Manicure/Pedicure, D-Tan)
  return "unisex";
};

export const migrateServicesGender = async () => {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error("MONGO_URI or MONGODB_URI must be set in environment variables");
  }

  const isAlreadyConnected = mongoose.connection.readyState === 1;
  if (!isAlreadyConnected) {
    await mongoose.connect(mongoUri);
  }

  // Fetch all services with category populated
  const services = await Service.find({}).populate("categoryId", "name");
  console.log(`Found ${services.length} services to process...`);

  let updatedCount = 0;
  const breakdown = { male: 0, female: 0, unisex: 0 };

  const bulkOps = [];

  for (const s of services) {
    const determinedGender = classifyServiceGender(s);
    breakdown[determinedGender] = (breakdown[determinedGender] || 0) + 1;

    bulkOps.push({
      updateOne: {
        filter: { _id: s._id },
        update: { $set: { gender: determinedGender } },
      },
    });
  }

  if (bulkOps.length > 0) {
    const bulkRes = await Service.bulkWrite(bulkOps);
    updatedCount = bulkRes.modifiedCount;
  }

  console.log(`[Service Gender Migration] Processed: ${services.length}, Updated: ${updatedCount}`);
  console.log(`[Gender Distribution] Female: ${breakdown.female}, Unisex: ${breakdown.unisex}, Male: ${breakdown.male}`);

  if (!isAlreadyConnected && process.env.NODE_ENV !== "test") {
    await mongoose.disconnect();
  }

  return { processed: services.length, updatedCount, breakdown };
};

// If run directly from CLI
if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.replace(/\\/g, "/").endsWith("migrateServicesGender.js")
) {
  migrateServicesGender()
    .then(() => {
      console.log("Service gender migration completed successfully.");
      process.exit(0);
    })
    .catch((err) => {
      console.error("Error migrating service gender:", err);
      process.exit(1);
    });
}
