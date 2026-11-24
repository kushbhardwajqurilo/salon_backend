import { describe, expect, it, beforeAll, afterAll, beforeEach, jest } from "@jest/globals";
import mongoose from "mongoose";
import { getIsolatedTestMongoUri } from "../testSetup.js";
import { Organization } from "../../models/organizations/organization.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Staff } from "../../models/staff/staff.model.js";
import { StaffBranch } from "../../models/staff/staffBranch.model.js";
import { StaffService } from "../../models/staff/staffService.model.js";
import { Service } from "../../models/services/service.model.js";
import { ServiceCategory } from "../../models/services/serviceCategory.model.js";
import { Appointment } from "../../models/appointments/appointment.model.js";
import { Customer } from "../../models/customers/customer.model.js";
import { AppointmentService } from "../../services/appointments/appointment.service.js";

const getFutureDateStr = (daysAhead = 20) => {
  const d = new Date(Date.now() + daysAhead * 86400000);
  return d.toISOString().split("T")[0];
};

describe("Concurrency Safety & Persistence-Level Conflict Prevention", () => {
  jest.setTimeout(45000);

  let orgId;
  let branchA, branchB;
  let staffA;
  let serviceHaircut;
  let category;
  let customer1, customer2;
  let appointmentService;

  beforeAll(async () => {
    const mongoUri = getIsolatedTestMongoUri("apt_test");
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(mongoUri);
    }

    // Ensure all indexes (including multikey slotMinutes unique index) are initialized in MongoDB
    await Appointment.syncIndexes();

    appointmentService = new AppointmentService();

    const org = await Organization.create({
      name: `Concurrency Test Org ${Date.now()}`,
      currency: "INR",
    });
    orgId = org._id;

    branchA = await Branch.create({
      organizationId: orgId,
      name: "Branch Alpha",
      code: `BRA-${Date.now()}`,
      timezone: "Asia/Kolkata",
      bufferMinutes: 30,
      isActive: true,
      operatingHours: {
        monday: { isOpen: true, open: "08:00", close: "20:00" },
        tuesday: { isOpen: true, open: "08:00", close: "20:00" },
        wednesday: { isOpen: true, open: "08:00", close: "20:00" },
        thursday: { isOpen: true, open: "08:00", close: "20:00" },
        friday: { isOpen: true, open: "08:00", close: "20:00" },
        saturday: { isOpen: true, open: "08:00", close: "20:00" },
        sunday: { isOpen: true, open: "08:00", close: "20:00" },
      },
    });

    branchB = await Branch.create({
      organizationId: orgId,
      name: "Branch Beta",
      code: `BRB-${Date.now()}`,
      timezone: "Asia/Kolkata",
      bufferMinutes: 30,
      isActive: true,
      operatingHours: {
        monday: { isOpen: true, open: "08:00", close: "20:00" },
        tuesday: { isOpen: true, open: "08:00", close: "20:00" },
        wednesday: { isOpen: true, open: "08:00", close: "20:00" },
        thursday: { isOpen: true, open: "08:00", close: "20:00" },
        friday: { isOpen: true, open: "08:00", close: "20:00" },
        saturday: { isOpen: true, open: "08:00", close: "20:00" },
        sunday: { isOpen: true, open: "08:00", close: "20:00" },
      },
    });

    category = await ServiceCategory.create({
      organizationId: orgId,
      name: "Hair Services",
    });

    serviceHaircut = await Service.create({
      organizationId: orgId,
      name: "Standard Haircut",
      categoryId: category._id,
      duration: 30,
      pricing: { basePrice: 500 },
      status: "active",
    });

    staffA = await Staff.create({
      organizationId: orgId,
      name: "Alex Stylist",
      firstName: "Alex",
      lastName: "Stylist",
      staffCode: `STF-${Date.now()}`,
      designation: "Stylist",
      email: `alex.${Date.now()}@example.com`,
      phone: `98765${Math.floor(Math.random() * 90000 + 10000)}`,
      joiningDate: new Date("2024-01-01"),
      status: "active",
      isActive: true,
    });

    // Assign Alex to both Branch Alpha and Branch Beta
    await StaffBranch.create([
      { organizationId: orgId, staffId: staffA._id, branchId: branchA._id, isActive: true },
      { organizationId: orgId, staffId: staffA._id, branchId: branchB._id, isActive: true },
    ]);

    // Qualify Alex for haircut
    await StaffService.create({
      organizationId: orgId,
      staffId: staffA._id,
      serviceId: serviceHaircut._id,
      isActive: true,
    });

    customer1 = await Customer.create({
      organizationId: orgId,
      homeBranchId: branchA._id,
      name: "Customer One",
      phone: `91234${Math.floor(Math.random() * 90000 + 10000)}`,
      status: "active",
    });

    customer2 = await Customer.create({
      organizationId: orgId,
      homeBranchId: branchB._id,
      name: "Customer Two",
      phone: `91235${Math.floor(Math.random() * 90000 + 10000)}`,
      status: "active",
    });
  }, 60000);

  afterAll(async () => {
    if (mongoose.connection.readyState !== 0) {
      await Appointment.deleteMany({ organizationId: orgId });
      await Staff.deleteMany({ organizationId: orgId });
      await StaffBranch.deleteMany({ organizationId: orgId });
      await StaffService.deleteMany({ organizationId: orgId });
      await Service.deleteMany({ organizationId: orgId });
      await ServiceCategory.deleteMany({ organizationId: orgId });
      await Customer.deleteMany({ organizationId: orgId });
      await Branch.deleteMany({ organizationId: orgId });
      await Organization.deleteMany({ _id: orgId });
      await mongoose.disconnect();
    }
  }, 60000);

  beforeEach(async () => {
    await Appointment.deleteMany({ organizationId: orgId });
  });

  // -------------------------------------------------------------------------
  // Test 1: Two simultaneous requests for the same staff member and overlapping time
  // -------------------------------------------------------------------------
  it("Test 1: Two simultaneous booking requests for the same staff member allow exactly one to commit", async () => {
    const targetDate = getFutureDateStr(21);

    const bookingPayload1 = {
      branchId: branchA._id.toString(),
      customerId: customer1._id.toString(),
      staffId: staffA._id.toString(),
      serviceIds: [serviceHaircut._id.toString()],
      date: targetDate,
      startTime: "10:00",
      bookingType: "advance",
    };

    const bookingPayload2 = {
      branchId: branchA._id.toString(),
      customerId: customer2._id.toString(),
      staffId: staffA._id.toString(),
      serviceIds: [serviceHaircut._id.toString()],
      date: targetDate,
      startTime: "10:15", // 10:15 - 10:45 overlaps with 10:00 - 10:30
      bookingType: "advance",
    };

    // Execute concurrently
    const [result1, result2] = await Promise.allSettled([
      appointmentService.createAppointment(bookingPayload1, orgId),
      appointmentService.createAppointment(bookingPayload2, orgId),
    ]);

    const successes = [result1, result2].filter((r) => r.status === "fulfilled");
    const failures = [result1, result2].filter((r) => r.status === "rejected");

    // Exactly one must succeed, exactly one must fail
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);

    // Rejected reason must be 409 conflict
    expect(failures[0].reason.statusCode).toBe(409);

    // Database must contain exactly 1 appointment
    const count = await Appointment.countDocuments({
      organizationId: orgId,
      staffId: staffA._id,
      status: { $in: ["scheduled", "in_progress"] },
    });
    expect(count).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Test 2: Two simultaneous requests from different branches for the same staff
  // -------------------------------------------------------------------------
  it("Test 2: Two simultaneous requests from different branches for the same staff member allow only one", async () => {
    const targetDate = getFutureDateStr(22);

    const bookingBranchA = {
      branchId: branchA._id.toString(),
      customerId: customer1._id.toString(),
      staffId: staffA._id.toString(),
      serviceIds: [serviceHaircut._id.toString()],
      date: targetDate,
      startTime: "11:00",
      bookingType: "advance",
    };

    const bookingBranchB = {
      branchId: branchB._id.toString(),
      customerId: customer2._id.toString(),
      staffId: staffA._id.toString(),
      serviceIds: [serviceHaircut._id.toString()],
      date: targetDate,
      startTime: "11:00",
      bookingType: "advance",
    };

    const [resultA, resultB] = await Promise.allSettled([
      appointmentService.createAppointment(bookingBranchA, orgId),
      appointmentService.createAppointment(bookingBranchB, orgId),
    ]);

    const successes = [resultA, resultB].filter((r) => r.status === "fulfilled");
    const failures = [resultA, resultB].filter((r) => r.status === "rejected");

    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    expect(failures[0].reason.statusCode).toBe(409);

    const count = await Appointment.countDocuments({
      organizationId: orgId,
      staffId: staffA._id,
      status: { $in: ["scheduled", "in_progress"] },
    });
    expect(count).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Test 3: Two requests whose appointments overlap by only one minute
  // -------------------------------------------------------------------------
  it("Test 3: Appointments overlapping by only one minute are prevented from double-booking", async () => {
    const targetDate = getFutureDateStr(23);

    // First appointment: 10:00 - 10:30 (30 mins)
    const apt1 = await appointmentService.createAppointment({
      branchId: branchA._id.toString(),
      customerId: customer1._id.toString(),
      staffId: staffA._id.toString(),
      serviceIds: [serviceHaircut._id.toString()],
      date: targetDate,
      startTime: "10:00",
      bookingType: "advance",
    }, orgId);

    expect(apt1).toBeDefined();

    // Second appointment: 10:29 - 10:59 (overlaps by exactly 1 minute at 10:29)
    await expect(
      appointmentService.createAppointment({
        branchId: branchA._id.toString(),
        customerId: customer2._id.toString(),
        staffId: staffA._id.toString(),
        serviceIds: [serviceHaircut._id.toString()],
        date: targetDate,
        startTime: "10:29",
        bookingType: "advance",
      }, orgId),
    ).rejects.toThrow();

    const count = await Appointment.countDocuments({
      organizationId: orgId,
      staffId: staffA._id,
      status: { $in: ["scheduled", "in_progress"] },
    });
    expect(count).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Test 4: Two requests whose appointment boundaries touch exactly (e.g. 10:00-10:30 & 10:30-11:00)
  // -------------------------------------------------------------------------
  it("Test 4: Consecutive appointments touching exactly at boundary are both allowed", async () => {
    const targetDate = getFutureDateStr(24);

    // Slot 1: 10:00 - 10:30
    const apt1 = await appointmentService.createAppointment({
      branchId: branchA._id.toString(),
      customerId: customer1._id.toString(),
      staffId: staffA._id.toString(),
      serviceIds: [serviceHaircut._id.toString()],
      date: targetDate,
      startTime: "10:00",
      bookingType: "advance",
    }, orgId);

    // Slot 2: 10:30 - 11:00 (boundary touch, zero overlap)
    const apt2 = await appointmentService.createAppointment({
      branchId: branchA._id.toString(),
      customerId: customer2._id.toString(),
      staffId: staffA._id.toString(),
      serviceIds: [serviceHaircut._id.toString()],
      date: targetDate,
      startTime: "10:30",
      bookingType: "advance",
    }, orgId);

    expect(apt1).toBeDefined();
    expect(apt2).toBeDefined();

    const count = await Appointment.countDocuments({
      organizationId: orgId,
      staffId: staffA._id,
      status: { $in: ["scheduled", "in_progress"] },
    });
    expect(count).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Test 5: Concurrent reschedule and new-booking requests
  // -------------------------------------------------------------------------
  it("Test 5: Concurrent reschedule and new-booking targeting the same slot allow only one", async () => {
    const targetDate = getFutureDateStr(25);

    // Create existing appointment at 09:00 - 09:30
    const existingApt = await appointmentService.createAppointment({
      branchId: branchA._id.toString(),
      customerId: customer1._id.toString(),
      staffId: staffA._id.toString(),
      serviceIds: [serviceHaircut._id.toString()],
      date: targetDate,
      startTime: "09:00",
      bookingType: "advance",
    }, orgId);

    // Concurrently:
    // A) Reschedule existingApt to 14:00 - 14:30
    // B) Book a new appointment for customer2 at 14:00 - 14:30
    const [rescheduleResult, newBookingResult] = await Promise.allSettled([
      appointmentService.rescheduleAppointment(
        existingApt._id.toString(),
        {
          branchId: branchA._id.toString(),
          date: targetDate,
          startTime: "14:00",
        },
        orgId,
      ),
      appointmentService.createAppointment({
        branchId: branchA._id.toString(),
        customerId: customer2._id.toString(),
        staffId: staffA._id.toString(),
        serviceIds: [serviceHaircut._id.toString()],
        date: targetDate,
        startTime: "14:00",
        bookingType: "advance",
      }, orgId),
    ]);

    const successes = [rescheduleResult, newBookingResult].filter((r) => r.status === "fulfilled");
    const failures = [rescheduleResult, newBookingResult].filter((r) => r.status === "rejected");

    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    expect(failures[0].reason.statusCode).toBe(409);
  });
});
