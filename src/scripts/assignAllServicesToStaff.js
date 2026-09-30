import mongoose from "mongoose";
import { connectDB } from "../database/db.js";
import { Staff } from "../models/staff/staff.model.js";
import { Service } from "../models/services/service.model.js";
import { StaffService } from "../models/staff/staffService.model.js";

export const assignAllServicesToExistingStaff = async () => {
  try {
    await connectDB();
    console.log("Starting bulk assignment of all active services to existing staff...");

    // Find all active, non-deleted staff
    const staffList = await Staff.find({ isDeleted: false, status: "active" }).select("_id organizationId name staffCode");
    console.log(`Found ${staffList.length} active staff members.`);

    let totalAssigned = 0;
    let totalAlreadyExisted = 0;

    for (const staff of staffList) {
      // Find all active, non-deleted services for the staff member's organization
      const services = await Service.find({
        organizationId: staff.organizationId,
        status: "active",
        isDeleted: false,
      }).select("_id name");

      if (services.length === 0) {
        console.log(`Staff [${staff.staffCode}] ${staff.name}: No active services in organization.`);
        continue;
      }

      // Check existing StaffService mappings for this staff
      const existingMappings = await StaffService.find({
        staffId: staff._id,
        organizationId: staff.organizationId,
        isActive: true,
      }).select("serviceId");

      const existingServiceIdSet = new Set(
        existingMappings.map((m) => m.serviceId.toString())
      );

      const toInsert = [];
      for (const service of services) {
        if (!existingServiceIdSet.has(service._id.toString())) {
          toInsert.push({
            staffId: staff._id,
            serviceId: service._id,
            organizationId: staff.organizationId,
            isActive: true,
          });
        }
      }

      totalAlreadyExisted += existingMappings.length;

      if (toInsert.length > 0) {
        await StaffService.insertMany(toInsert);
        totalAssigned += toInsert.length;
        console.log(
          `Staff [${staff.staffCode}] ${staff.name}: Assigned ${toInsert.length} new services (${existingMappings.length} already assigned).`
        );
      } else {
        console.log(
          `Staff [${staff.staffCode}] ${staff.name}: All ${services.length} services already assigned.`
        );
      }
    }

    console.log("\n==========================================");
    console.log(`Bulk Assignment Completed Successfully!`);
    console.log(`Total new service mappings created: ${totalAssigned}`);
    console.log(`Total existing mappings kept: ${totalAlreadyExisted}`);
    console.log("==========================================\n");
  } catch (error) {
    console.error("Error running assignAllServicesToExistingStaff:", error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    process.exit(0);
  }
};

assignAllServicesToExistingStaff();
