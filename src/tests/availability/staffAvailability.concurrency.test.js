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
import { Attendance } from "../../models/attendance/attendance.model.js";
import { AttendanceBranchConflict } from "../../models/attendance/AttendanceLeaveAppointmentConflict.model.js";
import { AuditLog } from "../../models/audit/auditLog.model.js";
import { AppointmentService } from "../../services/appointments/appointment.service.js";
import { resolveBranchAttendanceConflict, deriveBusinessDate } from "../../services/attendance/attendance.service.js";

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
    await Attendance.deleteMany({ organizationId: orgId });
    await AttendanceBranchConflict.deleteMany({ organizationId: orgId });
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

  // -------------------------------------------------------------------------
  // Attendance Reconciliation vs Appointment Booking Concurrency Tests
  // -------------------------------------------------------------------------

  it("Scenario A: Deterministic barrier test - booking paused after availability evaluation cannot commit on stale state", async () => {
    const tz = branchA.timezone || "Asia/Kolkata";
    const todayStr = deriveBusinessDate(new Date(), tz);

    // Create pending attendance branch conflict
    const conflict = await AttendanceBranchConflict.create({
      organizationId: orgId,
      staffId: staffA._id,
      primaryBranchId: branchA._id,
      date: todayStr,
      conflictStatus: "pending",
      branchesInvolved: [{ branchId: branchA._id }, { branchId: branchB._id }],
      isActive: true,
    });

    await Attendance.create({
      organizationId: orgId,
      branchId: branchA._id,
      staffId: staffA._id,
      attendanceDate: new Date(`${todayStr}T00:00:00.000Z`),
      status: "incomplete",
      conflictType: "appointment",
      isReconciled: false,
    });

    // We build a deterministic barrier to pause appointment booking right after availability validation
    let evaluateBarrierTriggered = false;
    let resumeBookingPromiseResolve;
    const resumeBookingPromise = new Promise((resolve) => {
      resumeBookingPromiseResolve = resolve;
    });

    const originalValidate = appointmentService.validateStaffAvailability.bind(appointmentService);
    const validateSpy = jest.spyOn(appointmentService, "validateStaffAvailability").mockImplementation(async (...args) => {
      // 1. Let authoritative evaluation run
      let caughtErr = null;
      try {
        await originalValidate(...args);
      } catch (err) {
        caughtErr = err;
      }
      // Signal barrier reached
      evaluateBarrierTriggered = true;
      // Wait for test coordinator to resolve conflict or continue
      await resumeBookingPromise;
      if (caughtErr) throw caughtErr;
    });

    // Start booking operation (will pause at barrier)
    const bookingPromise = appointmentService.createAppointment({
      branchId: branchA._id.toString(),
      customerId: customer1._id.toString(),
      staffId: staffA._id.toString(),
      serviceIds: [serviceHaircut._id.toString()],
      date: todayStr,
      startTime: "15:00",
      bookingType: "walk_in",
    }, orgId);

    // Wait until booking reaches the barrier
    while (!evaluateBarrierTriggered) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // While booking is paused, manager reconciles conflict
    await resolveBranchAttendanceConflict({
      organizationId: orgId,
      branchId: branchA._id,
      actorId: new mongoose.Types.ObjectId(),
      conflictId: conflict._id,
      reason: "Manager verified valid clock-in at Branch Alpha",
    });

    // Now resume paused booking
    resumeBookingPromiseResolve();

    // The booking attempt was evaluated while conflict was pending -> must reject!
    await expect(bookingPromise).rejects.toThrow();

    validateSpy.mockRestore();

    // Verify zero appointments were committed
    const count = await Appointment.countDocuments({
      organizationId: orgId,
      staffId: staffA._id,
      appointmentDate: todayStr,
    });
    expect(count).toBe(0);
  });

  it("Scenario B: After reconciliation commits, subsequent booking performs fresh validation and succeeds", async () => {
    const tz = branchA.timezone || "Asia/Kolkata";
    const todayStr = deriveBusinessDate(new Date(), tz);

    // Create pending conflict
    const conflict = await AttendanceBranchConflict.create({
      organizationId: orgId,
      staffId: staffA._id,
      primaryBranchId: branchA._id,
      date: todayStr,
      conflictStatus: "pending",
      branchesInvolved: [{ branchId: branchA._id }, { branchId: branchB._id }],
      isActive: true,
    });

    const attRecord = await Attendance.create({
      organizationId: orgId,
      branchId: branchA._id,
      staffId: staffA._id,
      attendanceDate: new Date(`${todayStr}T00:00:00.000Z`),
      status: "present",
      conflictType: "appointment",
      isReconciled: false,
    });

    // Manager reconciles the conflict
    const resolvedConflict = await resolveBranchAttendanceConflict({
      organizationId: orgId,
      branchId: branchA._id,
      actorId: new mongoose.Types.ObjectId(),
      conflictId: conflict._id,
      reason: "Manager verified valid clock-in at Branch Alpha",
    });
    expect(resolvedConflict.conflictStatus).toBe("resolved");

    // Fresh booking attempt (walk-in for today) now succeeds
    const apt = await appointmentService.createAppointment({
      branchId: branchA._id.toString(),
      customerId: customer1._id.toString(),
      staffId: staffA._id.toString(),
      serviceIds: [serviceHaircut._id.toString()],
      date: todayStr,
      startTime: "16:00",
      bookingType: "walk_in",
    }, orgId);

    expect(apt).toBeDefined();
    expect(apt.staffId.toString()).toBe(staffA._id.toString());
  });

  it("Scenario C: If reconciliation fails or is rejected, unresolved conflict continues blocking booking", async () => {
    const tz = branchA.timezone || "Asia/Kolkata";
    const todayStr = deriveBusinessDate(new Date(), tz);

    // Create pending conflict
    const conflict = await AttendanceBranchConflict.create({
      organizationId: orgId,
      staffId: staffA._id,
      primaryBranchId: branchA._id,
      date: todayStr,
      conflictStatus: "pending",
      branchesInvolved: [{ branchId: branchA._id }, { branchId: branchB._id }],
      isActive: true,
    });

    await Attendance.create({
      organizationId: orgId,
      branchId: branchA._id,
      staffId: staffA._id,
      attendanceDate: new Date(`${todayStr}T00:00:00.000Z`),
      status: "incomplete",
      conflictType: "appointment",
      isReconciled: false,
    });

    // Forced failure: manager passes invalid reason (< 3 chars)
    await expect(
      resolveBranchAttendanceConflict({
        organizationId: orgId,
        branchId: branchA._id,
        actorId: new mongoose.Types.ObjectId(),
        conflictId: conflict._id,
        reason: "no",
      }),
    ).rejects.toThrow();

    // Verify conflict is still pending
    const dbConflict = await AttendanceBranchConflict.findById(conflict._id);
    expect(dbConflict.conflictStatus).toBe("pending");

    // Booking attempt must continue to be blocked
    await expect(
      appointmentService.createAppointment({
        branchId: branchA._id.toString(),
        customerId: customer1._id.toString(),
        staffId: staffA._id.toString(),
        serviceIds: [serviceHaircut._id.toString()],
        date: todayStr,
        startTime: "17:00",
        bookingType: "walk_in",
      }, orgId),
    ).rejects.toThrow();
  });

  it("Scenario D: Concurrent booking attempts while reconciliation occurs create no invalid duplicate appointments", async () => {
    const tz = branchA.timezone || "Asia/Kolkata";
    const todayStr = deriveBusinessDate(new Date(), tz);

    const conflict = await AttendanceBranchConflict.create({
      organizationId: orgId,
      staffId: staffA._id,
      primaryBranchId: branchA._id,
      date: todayStr,
      conflictStatus: "pending",
      branchesInvolved: [{ branchId: branchA._id }, { branchId: branchB._id }],
      isActive: true,
    });

    await Attendance.create({
      organizationId: orgId,
      branchId: branchA._id,
      staffId: staffA._id,
      attendanceDate: new Date(`${todayStr}T00:00:00.000Z`),
      status: "present",
      conflictType: "appointment",
      isReconciled: false,
    });

    // Concurrently trigger reconciliation and 3 overlapping booking requests for the same slot
    const results = await Promise.allSettled([
      resolveBranchAttendanceConflict({
        organizationId: orgId,
        branchId: branchA._id,
        actorId: new mongoose.Types.ObjectId(),
        conflictId: conflict._id,
        reason: "Valid reconciliation under high concurrency",
      }),
      appointmentService.createAppointment({
        branchId: branchA._id.toString(),
        customerId: customer1._id.toString(),
        staffId: staffA._id.toString(),
        serviceIds: [serviceHaircut._id.toString()],
        date: todayStr,
        startTime: "18:00",
        bookingType: "walk_in",
      }, orgId),
      appointmentService.createAppointment({
        branchId: branchA._id.toString(),
        customerId: customer2._id.toString(),
        staffId: staffA._id.toString(),
        serviceIds: [serviceHaircut._id.toString()],
        date: todayStr,
        startTime: "18:00",
        bookingType: "walk_in",
      }, orgId),
    ]);

    // Even under concurrency, at most ONE appointment can be scheduled in that slot
    const committedAppointments = await Appointment.find({
      organizationId: orgId,
      staffId: staffA._id,
      appointmentDate: todayStr,
      startTime: "18:00",
      status: { $in: ["scheduled", "in_progress"] },
    });

    expect(committedAppointments.length).toBeLessThanOrEqual(1);
  });

  it("Scenario E: Partial-write failure test - when conflict transition fails, conflict remains pending and availability is blocked", async () => {
    const tz = branchA.timezone || "Asia/Kolkata";
    const todayStr = deriveBusinessDate(new Date(), tz);

    const conflict = await AttendanceBranchConflict.create({
      organizationId: orgId,
      staffId: staffA._id,
      primaryBranchId: branchA._id,
      date: todayStr,
      conflictStatus: "pending",
      branchesInvolved: [{ branchId: branchA._id }, { branchId: branchB._id }],
      isActive: true,
    });

    await Attendance.create({
      organizationId: orgId,
      branchId: branchA._id,
      staffId: staffA._id,
      attendanceDate: new Date(`${todayStr}T00:00:00.000Z`),
      status: "incomplete",
      conflictType: "appointment",
      isReconciled: false,
    });

    // Mock AttendanceBranchConflict.findOneAndUpdate to simulate partial-write failure on transition
    const originalFindOneAndUpdate = AttendanceBranchConflict.findOneAndUpdate.bind(AttendanceBranchConflict);
    jest.spyOn(AttendanceBranchConflict, "findOneAndUpdate").mockRejectedValueOnce(
      new Error("Simulated network/disk write failure on conflict transition")
    );

    // Manager reconciliation attempt fails
    await expect(
      resolveBranchAttendanceConflict({
        organizationId: orgId,
        branchId: branchA._id,
        actorId: new mongoose.Types.ObjectId(),
        conflictId: conflict._id,
        reason: "Valid reason but system fails on step 2",
      }),
    ).rejects.toThrow("Simulated network/disk write failure");

    AttendanceBranchConflict.findOneAndUpdate.mockRestore();

    // Verify the conflict remains pending in MongoDB
    const currentConflict = await AttendanceBranchConflict.findById(conflict._id);
    expect(currentConflict.conflictStatus).toBe("pending");

    // Staff availability must remain blocked
    await expect(
      appointmentService.createAppointment({
        branchId: branchA._id.toString(),
        customerId: customer1._id.toString(),
        staffId: staffA._id.toString(),
        serviceIds: [serviceHaircut._id.toString()],
        date: todayStr,
        startTime: "18:30",
        bookingType: "walk_in",
      }, orgId),
    ).rejects.toThrow();

    // No appointment committed
    const aptCount = await Appointment.countDocuments({
      organizationId: orgId,
      staffId: staffA._id,
      appointmentDate: todayStr,
      startTime: "18:30",
    });
    expect(aptCount).toBe(0);
  });

  it("Scenario F: Duplicate reconciliation test - two simultaneous requests allow exactly one resolution and audit record", async () => {
    const tz = branchA.timezone || "Asia/Kolkata";
    const todayStr = deriveBusinessDate(new Date(), tz);

    const conflict = await AttendanceBranchConflict.create({
      organizationId: orgId,
      staffId: staffA._id,
      primaryBranchId: branchA._id,
      date: todayStr,
      conflictStatus: "pending",
      branchesInvolved: [{ branchId: branchA._id }, { branchId: branchB._id }],
      isActive: true,
    });

    await Attendance.create({
      organizationId: orgId,
      branchId: branchA._id,
      staffId: staffA._id,
      attendanceDate: new Date(`${todayStr}T00:00:00.000Z`),
      status: "present",
      conflictType: "appointment",
      isReconciled: false,
    });

    const manager1 = new mongoose.Types.ObjectId();
    const manager2 = new mongoose.Types.ObjectId();

    // Two managers submit reconciliation simultaneously for the exact same conflict
    const [result1, result2] = await Promise.allSettled([
      resolveBranchAttendanceConflict({
        organizationId: orgId,
        branchId: branchA._id,
        actorId: manager1,
        conflictId: conflict._id,
        reason: "Manager 1 reconciliation resolution",
      }),
      resolveBranchAttendanceConflict({
        organizationId: orgId,
        branchId: branchA._id,
        actorId: manager2,
        conflictId: conflict._id,
        reason: "Manager 2 simultaneous resolution",
      }),
    ]);

    const successes = [result1, result2].filter((r) => r.status === "fulfilled");
    const failures = [result1, result2].filter((r) => r.status === "rejected");

    // Exactly one must succeed, the other must fail with conflict/409 error
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    expect(failures[0].reason.statusCode).toBe(409);

    // Final database state check: conflict is resolved
    const finalConflict = await AttendanceBranchConflict.findById(conflict._id);
    expect(finalConflict.conflictStatus).toBe("resolved");

    // Exactly one AuditLog recorded for this conflict resolution
    const auditCount = await mongoose.model("AuditLog").countDocuments({
      organizationId: orgId,
      entityId: conflict._id,
      action: "ATTENDANCE_CONFLICT_RESOLVED",
    });
    expect(auditCount).toBe(1);
  });

  it("Scenario G: Missing Attendance record - reconciliation fails with 422 and preserves pending conflict", async () => {
    const tz = branchA.timezone || "Asia/Kolkata";
    const todayStr = deriveBusinessDate(new Date(), tz);

    const conflict = await AttendanceBranchConflict.create({
      organizationId: orgId,
      staffId: staffA._id,
      primaryBranchId: branchA._id,
      date: todayStr,
      conflictStatus: "pending",
      branchesInvolved: [{ branchId: branchA._id }, { branchId: branchB._id }],
      isActive: true,
    });

    // Deliberately DO NOT create Attendance record for today
    await expect(
      resolveBranchAttendanceConflict({
        organizationId: orgId,
        branchId: branchA._id,
        actorId: new mongoose.Types.ObjectId(),
        conflictId: conflict._id,
        reason: "Manager attempts reconciliation without attendance record",
      }),
    ).rejects.toThrow("Required daily Attendance record for this staff and date does not exist");

    // Verify conflict remains pending
    const dbConflict = await AttendanceBranchConflict.findById(conflict._id);
    expect(dbConflict.conflictStatus).toBe("pending");

    // Availability must still be blocked
    await expect(
      appointmentService.createAppointment({
        branchId: branchA._id.toString(),
        customerId: customer1._id.toString(),
        staffId: staffA._id.toString(),
        serviceIds: [serviceHaircut._id.toString()],
        date: todayStr,
        startTime: "17:30",
        bookingType: "walk_in",
      }, orgId),
    ).rejects.toThrow();
  });

  it("Scenario H: Retry after partial failure - compensation restores Attendance isReconciled: false, and retry succeeds without duplicate audit", async () => {
    const tz = branchA.timezone || "Asia/Kolkata";
    const todayStr = deriveBusinessDate(new Date(), tz);

    const conflict = await AttendanceBranchConflict.create({
      organizationId: orgId,
      staffId: staffA._id,
      primaryBranchId: branchA._id,
      date: todayStr,
      conflictStatus: "pending",
      branchesInvolved: [{ branchId: branchA._id }, { branchId: branchB._id }],
      isActive: true,
    });

    const att = await Attendance.create({
      organizationId: orgId,
      branchId: branchA._id,
      staffId: staffA._id,
      attendanceDate: new Date(`${todayStr}T00:00:00.000Z`),
      status: "present",
      conflictType: "appointment",
      isReconciled: false,
    });

    // 1. First attempt fails on conflict transition step
    jest.spyOn(AttendanceBranchConflict, "findOneAndUpdate").mockRejectedValueOnce(
      new Error("Simulated transition network crash"),
    );

    await expect(
      resolveBranchAttendanceConflict({
        organizationId: orgId,
        branchId: branchA._id,
        actorId: new mongoose.Types.ObjectId(),
        conflictId: conflict._id,
        reason: "First reconciliation attempt",
      }),
    ).rejects.toThrow("Simulated transition network crash");

    AttendanceBranchConflict.findOneAndUpdate.mockRestore();

    // Verify compensation: Attendance isReconciled was reverted back to false
    const attAfterFailure = await Attendance.findById(att._id);
    expect(attAfterFailure.isReconciled).toBe(false);

    // Conflict remains pending
    const conflictAfterFailure = await AttendanceBranchConflict.findById(conflict._id);
    expect(conflictAfterFailure.conflictStatus).toBe("pending");

    // Zero audit logs recorded
    const auditCount1 = await mongoose.model("AuditLog").countDocuments({
      organizationId: orgId,
      entityId: conflict._id,
      action: "ATTENDANCE_CONFLICT_RESOLVED",
    });
    expect(auditCount1).toBe(0);

    // 2. Safe Manager Retry
    const retryResult = await resolveBranchAttendanceConflict({
      organizationId: orgId,
      branchId: branchA._id,
      actorId: new mongoose.Types.ObjectId(),
      conflictId: conflict._id,
      reason: "Retry reconciliation attempt",
    });

    expect(retryResult.conflictStatus).toBe("resolved");

    const attAfterRetry = await Attendance.findById(att._id);
    expect(attAfterRetry.isReconciled).toBe(true);

    // Exactly 1 audit log created
    const auditCount2 = await mongoose.model("AuditLog").countDocuments({
      organizationId: orgId,
      entityId: conflict._id,
      action: "ATTENDANCE_CONFLICT_RESOLVED",
    });
    expect(auditCount2).toBe(1);
  });

  it("Scenario I: Deterministic barrier test - pauses between conflict transition and audit failure, verifies availability remains blocked, compensation restores both documents, and retry succeeds exactly once", async () => {
    const tz = branchA.timezone || "Asia/Kolkata";
    const todayStr = deriveBusinessDate(new Date(), tz);

    const conflict = await AttendanceBranchConflict.create({
      organizationId: orgId,
      staffId: staffA._id,
      primaryBranchId: branchA._id,
      date: todayStr,
      conflictStatus: "pending",
      branchesInvolved: [{ branchId: branchA._id }, { branchId: branchB._id }],
      isActive: true,
    });

    const att = await Attendance.create({
      organizationId: orgId,
      branchId: branchA._id,
      staffId: staffA._id,
      attendanceDate: new Date(`${todayStr}T00:00:00.000Z`),
      status: "present",
      conflictType: "appointment",
      isReconciled: false,
    });

    // 1. Build a deterministic barrier right after AttendanceBranchConflict transition succeeds but before AuditLog.create
    let barrierReached = false;
    let resumeAuditPromiseResolve;
    const resumeAuditPromise = new Promise((resolve) => {
      resumeAuditPromiseResolve = resolve;
    });

    let createCalled = false;
    let createArgsReceived = null;
    const auditSpy = jest.spyOn(AuditLog, "create").mockImplementationOnce(async function (...args) {
      createCalled = true;
      createArgsReceived = args;
      barrierReached = true;
      // Pause at barrier to allow concurrent booking attempt
      await resumeAuditPromise;
      // Force AuditLog creation to fail
      throw new Error("Simulated audit write failure after conflict transition");
    });

    // Start reconciliation (it will pause inside AuditLog.create at barrier)
    const reconciliationPromise = resolveBranchAttendanceConflict({
      organizationId: orgId,
      branchId: branchA._id,
      actorId: new mongoose.Types.ObjectId(),
      conflictId: conflict._id,
      reason: "Reconciliation with deterministic barrier before failing audit",
    });

    // Wait until reconciliation reaches the barrier (conflict is resolved in memory/DB, audit has not succeeded)
    let loopCount = 0;
    while (!barrierReached && loopCount < 500) {
      await new Promise((r) => setTimeout(r, 10));
      loopCount++;
    }
    expect(createCalled).toBe(true);

    // 2. While paused at the barrier:
    // When running under a multi-document ACID transaction, MongoDB snapshot isolation ensures external queries
    // outside the transaction session cannot see intermediate uncommitted changes.
    // If querying with the transaction session, the conflict is resolved; querying outside it, it remains pending.
    const session = createArgsReceived?.[1]?.session;
    if (session) {
      const midConflictInTx = await AttendanceBranchConflict.findById(conflict._id, null, { session });
      expect(midConflictInTx.conflictStatus).toBe("resolved");

      // External readers (e.g. appointment booking query outside the uncommitted transaction) see "pending"
      const midConflictExternal = await AttendanceBranchConflict.findById(conflict._id);
      expect(midConflictExternal.conflictStatus).toBe("pending");
    } else {
      // In standalone compensation mode, intermediate transition is visible
      const midConflict = await AttendanceBranchConflict.findById(conflict._id);
      expect(midConflict.conflictStatus).toBe("resolved");
    }

    // 3. While paused at intermediate state, attempt to book the affected staff member.
    // In BOTH topologies (transaction snapshot isolation or intermediate state check),
    // availability evaluation must remain strictly blocked!
    await expect(
      appointmentService.createAppointment({
        branchId: branchA._id.toString(),
        customerId: customer1._id.toString(),
        staffId: staffA._id.toString(),
        serviceIds: [serviceHaircut._id.toString()],
        date: todayStr,
        startTime: "19:00",
        bookingType: "walk_in",
      }, orgId),
    ).rejects.toThrow();

    // 4. Resume the barrier to force AuditLog.create to throw its error
    resumeAuditPromiseResolve();

    // The reconciliation promise must reject with the simulated audit failure
    await expect(reconciliationPromise).rejects.toThrow("Simulated audit write failure after conflict transition");

    auditSpy.mockRestore();

    // 5. Verify compensation restored BOTH documents conditionally
    const attAfterFail = await Attendance.findById(att._id);
    expect(attAfterFail.isReconciled).toBe(false);
    expect(attAfterFail.reconciliationReason).toBeUndefined();
    expect(attAfterFail.reconciledBy).toBeUndefined();

    const conflictAfterFail = await AttendanceBranchConflict.findById(conflict._id);
    expect(conflictAfterFail.conflictStatus).toBe("pending");
    expect(conflictAfterFail.reason).toBeUndefined();
    expect(conflictAfterFail.resolvedBy).toBeUndefined();

    // 6. Verify no false successful audit event exists
    const auditCount = await mongoose.model("AuditLog").countDocuments({
      organizationId: orgId,
      entityId: conflict._id,
    });
    expect(auditCount).toBe(0);

    // 7. Verify staff availability remains blocked after compensation
    await expect(
      appointmentService.createAppointment({
        branchId: branchA._id.toString(),
        customerId: customer1._id.toString(),
        staffId: staffA._id.toString(),
        serviceIds: [serviceHaircut._id.toString()],
        date: todayStr,
        startTime: "19:00",
        bookingType: "walk_in",
      }, orgId),
    ).rejects.toThrow();

    // 8. Retry reconciliation and verify it succeeds exactly once
    const retryResult = await resolveBranchAttendanceConflict({
      organizationId: orgId,
      branchId: branchA._id,
      actorId: new mongoose.Types.ObjectId(),
      conflictId: conflict._id,
      reason: "Successful retry after audit failure compensation",
    });

    expect(retryResult.conflictStatus).toBe("resolved");

    const attFinal = await Attendance.findById(att._id);
    expect(attFinal.isReconciled).toBe(true);

    const conflictFinal = await AttendanceBranchConflict.findById(conflict._id);
    expect(conflictFinal.conflictStatus).toBe("resolved");

    const finalAuditCount = await mongoose.model("AuditLog").countDocuments({
      organizationId: orgId,
      entityId: conflict._id,
      action: "ATTENDANCE_CONFLICT_RESOLVED",
    });
    expect(finalAuditCount).toBe(1);

    // 9. Availability after reconciliation completes now succeeds
    const finalBooking = await appointmentService.createAppointment({
      branchId: branchA._id.toString(),
      customerId: customer1._id.toString(),
      staffId: staffA._id.toString(),
      serviceIds: [serviceHaircut._id.toString()],
      date: todayStr,
      startTime: "19:00",
      bookingType: "walk_in",
    }, orgId);
    expect(finalBooking).toBeDefined();
    expect(finalBooking.staffId.toString()).toBe(staffA._id.toString());
  });

  it("Scenario J: Explicit Standalone Mode - Deterministic barrier pauses before failing audit, asserts blocked booking, compensation restores both documents, and retry succeeds", async () => {
    const tz = branchA.timezone || "Asia/Kolkata";
    const todayStr = deriveBusinessDate(new Date(), tz);

    const conflict = await AttendanceBranchConflict.create({
      organizationId: orgId,
      staffId: staffA._id,
      primaryBranchId: branchA._id,
      date: todayStr,
      conflictStatus: "pending",
      branchesInvolved: [{ branchId: branchA._id }, { branchId: branchB._id }],
      isActive: true,
    });

    const att = await Attendance.create({
      organizationId: orgId,
      branchId: branchA._id,
      staffId: staffA._id,
      attendanceDate: new Date(`${todayStr}T00:00:00.000Z`),
      status: "present",
      conflictType: "appointment",
      isReconciled: false,
    });

    // 1. Build barrier right after AttendanceBranchConflict transition succeeds but before AuditLog.create
    let barrierReached = false;
    let resumeAuditPromiseResolve;
    const resumeAuditPromise = new Promise((resolve) => {
      resumeAuditPromiseResolve = resolve;
    });

    let createCalled = false;
    let sessionPassed = undefined;
    const auditSpy = jest.spyOn(AuditLog, "create").mockImplementationOnce(async function (...args) {
      createCalled = true;
      sessionPassed = args[1]?.session;
      barrierReached = true;
      await resumeAuditPromise;
      throw new Error("Simulated audit write failure in explicit standalone mode");
    });

    // Explicitly force standalone execution path via forceStandalone: true
    const reconciliationPromise = resolveBranchAttendanceConflict({
      organizationId: orgId,
      branchId: branchA._id,
      actorId: new mongoose.Types.ObjectId(),
      conflictId: conflict._id,
      reason: "Standalone mode reconciliation under test",
      forceStandalone: true,
    });

    let loopCount = 0;
    while (!barrierReached && loopCount < 500) {
      await new Promise((r) => setTimeout(r, 10));
      loopCount++;
    }
    expect(createCalled).toBe(true);
    // Explicit assertion: in standalone mode, no transaction session is passed
    expect(sessionPassed).toBeUndefined();

    // 2. While paused at the barrier in standalone mode:
    // Conflict in DB was transitioned to 'resolved'
    const midConflict = await AttendanceBranchConflict.findById(conflict._id);
    expect(midConflict.conflictStatus).toBe("resolved");

    resumeAuditPromiseResolve();

    // The reconciliation promise must reject with the simulated audit failure
    await expect(reconciliationPromise).rejects.toThrow("Simulated audit write failure in explicit standalone mode");

    auditSpy.mockRestore();

    // 3. Verify compensation restored BOTH documents conditionally back to their exact previous state
    const attAfterFail = await Attendance.findById(att._id);
    expect(attAfterFail.isReconciled).toBe(false);
    expect(attAfterFail.reconciliationReason).toBeUndefined();
    expect(attAfterFail.reconciledBy).toBeUndefined();

    const conflictAfterFail = await AttendanceBranchConflict.findById(conflict._id);
    expect(conflictAfterFail.conflictStatus).toBe("pending");
    expect(conflictAfterFail.reason).toBeUndefined();
    expect(conflictAfterFail.resolvedBy).toBeUndefined();

    // 4. Verify no false audit event was recorded
    const auditCount = await mongoose.model("AuditLog").countDocuments({
      organizationId: orgId,
      entityId: conflict._id,
    });
    expect(auditCount).toBe(0);

    // 5. Booking remains blocked since conflict is restored to pending
    await expect(
      appointmentService.createAppointment({
        branchId: branchA._id.toString(),
        customerId: customer1._id.toString(),
        staffId: staffA._id.toString(),
        serviceIds: [serviceHaircut._id.toString()],
        date: todayStr,
        startTime: "19:15",
        bookingType: "walk_in",
      }, orgId),
    ).rejects.toThrow();

    // 6. Retry reconciliation and verify it succeeds cleanly
    const retryResult = await resolveBranchAttendanceConflict({
      organizationId: orgId,
      branchId: branchA._id,
      actorId: new mongoose.Types.ObjectId(),
      conflictId: conflict._id,
      reason: "Successful retry after standalone compensation",
      forceStandalone: true,
    });

    expect(retryResult.conflictStatus).toBe("resolved");

    const attFinal = await Attendance.findById(att._id);
    expect(attFinal.isReconciled).toBe(true);

    const conflictFinal = await AttendanceBranchConflict.findById(conflict._id);
    expect(conflictFinal.conflictStatus).toBe("resolved");

    const finalAuditCount = await mongoose.model("AuditLog").countDocuments({
      organizationId: orgId,
      entityId: conflict._id,
      action: "ATTENDANCE_CONFLICT_RESOLVED",
    });
    expect(finalAuditCount).toBe(1);
  });

  it("Scenario K: Explicit Compensation Failure - Observable logging, context attachment, and fail-closed state", async () => {
    const tz = branchA.timezone || "Asia/Kolkata";
    const todayStr = deriveBusinessDate(new Date(), tz);

    const conflict = await AttendanceBranchConflict.create({
      organizationId: orgId,
      staffId: staffA._id,
      primaryBranchId: branchA._id,
      date: todayStr,
      conflictStatus: "pending",
      branchesInvolved: [{ branchId: branchA._id }, { branchId: branchB._id }],
      isActive: true,
    });

    const att = await Attendance.create({
      organizationId: orgId,
      branchId: branchA._id,
      staffId: staffA._id,
      attendanceDate: new Date(`${todayStr}T00:00:00.000Z`),
      status: "present",
      conflictType: "appointment",
      isReconciled: false,
    });

    // Cause AuditLog.create to fail, which triggers compensation
    jest.spyOn(AuditLog, "create").mockRejectedValueOnce(
      new Error("Forced audit failure to trigger compensation")
    );

    // Simulate compensation failure on AttendanceBranchConflict rollback
    const origConflictUpdateOne = AttendanceBranchConflict.updateOne.bind(AttendanceBranchConflict);
    jest.spyOn(AttendanceBranchConflict, "updateOne").mockImplementationOnce(async () => {
      throw new Error("Disk full: cannot rollback AttendanceBranchConflict");
    });

    let thrownError;
    try {
      await resolveBranchAttendanceConflict({
        organizationId: orgId,
        branchId: branchA._id,
        actorId: new mongoose.Types.ObjectId(),
        conflictId: conflict._id,
        reason: "Test compensation failure observability",
        forceStandalone: true,
      });
    } catch (err) {
      thrownError = err;
    }

    // 1. Root cause is preserved
    expect(thrownError).toBeDefined();
    expect(thrownError.message).toBe("Forced audit failure to trigger compensation");

    // 2. Structured compensation failure metadata is attached
    expect(thrownError.isCompensationFailure).toBe(true);
    expect(thrownError.compensationFailures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "AttendanceBranchConflict",
          id: conflict._id,
          error: "Disk full: cannot rollback AttendanceBranchConflict",
        }),
      ])
    );
    expect(thrownError.reconciliationContext).toEqual({
      conflictId: conflict._id,
      attendanceId: att._id,
      staffId: conflict.staffId,
      date: conflict.date,
    });

    // 3. Clean up mocks
    AuditLog.create.mockRestore();
    AttendanceBranchConflict.updateOne.mockRestore();
  });

  it("Scenario L: Standalone Compensation matchedCount !== 1 triggers critical error with operation context", async () => {
    const tz = branchA.timezone || "Asia/Kolkata";
    const todayStr = deriveBusinessDate(new Date(), tz);

    const conflict = await AttendanceBranchConflict.create({
      organizationId: orgId,
      staffId: staffA._id,
      primaryBranchId: branchA._id,
      date: todayStr,
      conflictStatus: "pending",
      branchesInvolved: [{ branchId: branchA._id }, { branchId: branchB._id }],
      isActive: true,
    });

    const att = await Attendance.create({
      organizationId: orgId,
      branchId: branchA._id,
      staffId: staffA._id,
      attendanceDate: new Date(`${todayStr}T00:00:00.000Z`),
      status: "present",
      conflictType: "appointment",
      isReconciled: false,
    });

    // Cause AuditLog.create to fail, which triggers compensation
    jest.spyOn(AuditLog, "create").mockRejectedValueOnce(
      new Error("Forced audit failure to trigger compensation")
    );

    // Simulate Attendance.updateOne returning matchedCount: 0 (e.g. concurrent state modification)
    jest.spyOn(Attendance, "updateOne").mockResolvedValueOnce({
      matchedCount: 0,
      modifiedCount: 0,
      acknowledged: true,
    });

    let thrownError;
    try {
      await resolveBranchAttendanceConflict({
        organizationId: orgId,
        branchId: branchA._id,
        actorId: new mongoose.Types.ObjectId(),
        conflictId: conflict._id,
        reason: "Test matchedCount !== 1 failure handling",
        forceStandalone: true,
      });
    } catch (err) {
      thrownError = err;
    }

    // 1. Root cause is preserved
    expect(thrownError).toBeDefined();
    expect(thrownError.message).toBe("Forced audit failure to trigger compensation");

    // 2. Structured compensation failure metadata is attached with target and operationContext
    expect(thrownError.isCompensationFailure).toBe(true);
    expect(thrownError.compensationFailures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "Attendance",
          id: att._id,
          error: expect.stringContaining("matchedCount 0 !== 1"),
          operationContext: expect.objectContaining({
            matchedCount: 0,
            modifiedCount: 0,
          }),
        }),
      ])
    );

    // 3. Clean up mocks
    AuditLog.create.mockRestore();
    Attendance.updateOne.mockRestore();
  });
});
