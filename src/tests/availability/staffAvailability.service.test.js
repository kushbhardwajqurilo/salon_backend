import { describe, expect, it, beforeAll, afterAll, beforeEach, jest } from "@jest/globals";
import mongoose from "mongoose";
import { getIsolatedTestMongoUri } from "../testSetup.js";
import { Organization } from "../../models/organizations/organization.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Staff } from "../../models/staff/staff.model.js";
import { StaffBranch } from "../../models/staff/staffBranch.model.js";
import { StaffService } from "../../models/staff/staffService.model.js";
import { StaffRoster } from "../../models/staff/staffRoster.model.js";
import { Service } from "../../models/services/service.model.js";
import { ServiceCategory } from "../../models/services/serviceCategory.model.js";
import { Appointment } from "../../models/appointments/appointment.model.js";
import { Leave } from "../../models/leaves/leave.model.js";
import { Attendance } from "../../models/attendance/attendance.model.js";
import { AttendancePunch } from "../../models/attendance/attendancePunch.model.js";
import { Customer } from "../../models/customers/customer.model.js";
import { User } from "../../models/users/user.model.js";
import { Role } from "../../models/roles/role.model.js";
import {
  staffAvailabilityService,
  AVAILABILITY_STATUS,
  REASON_CODES,
} from "../../services/availability/staffAvailability.service.js";
import { parseLocalToUTC, formatUTCToLocal } from "../../utils/date.js";
import { deriveBusinessDate } from "../../services/attendance/attendance.service.js";

const getFutureDateStr = (daysAhead = 14) => {
  const d = new Date(Date.now() + daysAhead * 86400000);
  return d.toISOString().split("T")[0];
};

describe("Authoritative Staff Availability Engine - 28 Production Scenarios", () => {
  jest.setTimeout(45000);

  let orgId;
  let branchA, branchB;
  let staffA, staffB;
  let serviceHaircut, serviceColor;
  let category;
  let customer;
  let ownerUser;

  // Helpers to create valid test entities
  const createTestAppointment = async ({
    branchId = branchA._id,
    staffId = staffA._id,
    date,
    startTime = "10:00",
    endTime = "11:00",
    duration = 60,
    services = null,
    status = "scheduled",
  }) => {
    const tz = branchA.timezone || "Asia/Kolkata";
    const startAt = parseLocalToUTC(date, startTime, tz);
    const endAt = parseLocalToUTC(date, endTime, tz);
    const startMs = startAt.getTime();
    const endMs = endAt.getTime();
    const slotMinutes = [];
    for (let ms = startMs; ms < endMs; ms += 60000) {
      slotMinutes.push(new Date(ms).toISOString());
    }

    return Appointment.create({
      organizationId: orgId,
      branchId,
      customerId: customer._id,
      staffId,
      appointmentCode: `APT-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      appointmentDate: date,
      startTime,
      endTime,
      totalDuration: duration,
      startAt,
      endAt,
      slotMinutes,
      status,
      bookingType: "advance",
      pricing: { subtotal: 500, discount: 0, total: 500 },
      services: services || [
        {
          serviceType: "registered",
          serviceId: serviceHaircut._id,
          name: "Master Haircut",
          duration,
          price: 500,
        },
      ],
    });
  };

  const createTestLeave = async ({
    branchId = branchA._id,
    staffId = staffA._id,
    startDate,
    endDate,
    status = "approved",
    isPartialDay = false,
    dayPart = null,
    startTime = null,
    endTime = null,
    startAt = null,
    endAt = null,
  }) => {
    const tz = branchA.timezone || "Asia/Kolkata";
    const dateStr = formatUTCToLocal(startDate, tz).dateStr;
    return Leave.create({
      organizationId: orgId,
      branchId,
      staffId,
      leaveCode: `LV-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      leaveType: "paid",
      reason: "Medical leave",
      submittedBy: ownerUser._id,
      submittedFor: "staff",
      startDate,
      endDate,
      dates: [dateStr],
      status,
      isPartialDay,
      dayPart,
      startTime,
      endTime,
      startAt,
      endAt,
    });
  };

  beforeAll(async () => {
    const testUri = getIsolatedTestMongoUri("apt_test");
    await mongoose.connect(testUri);
    await Appointment.syncIndexes();
  });

  afterAll(async () => {
    await Appointment.deleteMany({});
    await Leave.deleteMany({});
    await Attendance.deleteMany({});
    await AttendancePunch.deleteMany({});
    await StaffRoster.deleteMany({});
    await StaffService.deleteMany({});
    await StaffBranch.deleteMany({});
    await Staff.deleteMany({});
    await Service.deleteMany({});
    await ServiceCategory.deleteMany({});
    await Customer.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await Appointment.deleteMany({});
    await Leave.deleteMany({});
    await Attendance.deleteMany({});
    await AttendancePunch.deleteMany({});
    await StaffRoster.deleteMany({});
    await StaffService.deleteMany({});
    await StaffBranch.deleteMany({});
    await Staff.deleteMany({});
    await Service.deleteMany({});
    await ServiceCategory.deleteMany({});
    await Customer.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});

    // 1. Organization & Branches
    const org = await Organization.create({ name: "Availability Engine Test Salon" });
    orgId = org._id;

    branchA = await Branch.create({
      organizationId: orgId,
      name: "Downtown Salon A",
      timezone: "Asia/Kolkata",
      bufferMinutes: 30,
      isActive: true,
      operatingHours: {
        monday: { openTime: "09:00", closeTime: "20:00", isOpen: true },
        tuesday: { openTime: "09:00", closeTime: "20:00", isOpen: true },
        wednesday: { openTime: "09:00", closeTime: "20:00", isOpen: true },
        thursday: { openTime: "09:00", closeTime: "20:00", isOpen: true },
        friday: { openTime: "09:00", closeTime: "20:00", isOpen: true },
        saturday: { openTime: "09:00", closeTime: "20:00", isOpen: true },
        sunday: { openTime: "09:00", closeTime: "20:00", isOpen: true },
      },
    });

    branchB = await Branch.create({
      organizationId: orgId,
      name: "Uptown Salon B",
      timezone: "Asia/Kolkata",
      bufferMinutes: 30,
      isActive: true,
      operatingHours: {
        monday: { openTime: "09:00", closeTime: "20:00", isOpen: true },
        tuesday: { openTime: "09:00", closeTime: "20:00", isOpen: true },
        wednesday: { openTime: "09:00", closeTime: "20:00", isOpen: true },
        thursday: { openTime: "09:00", closeTime: "20:00", isOpen: true },
        friday: { openTime: "09:00", closeTime: "20:00", isOpen: true },
        saturday: { openTime: "09:00", closeTime: "20:00", isOpen: true },
        sunday: { openTime: "09:00", closeTime: "20:00", isOpen: true },
      },
    });

    // 2. Services
    category = await ServiceCategory.create({
      organizationId: orgId,
      name: "General Hair Styling",
    });

    serviceHaircut = await Service.create({
      organizationId: orgId,
      name: "Master Haircut",
      categoryId: category._id,
      duration: 30,
      pricing: { basePrice: 500 },
      status: "active",
      isActive: true,
    });

    serviceColor = await Service.create({
      organizationId: orgId,
      name: "Global Hair Coloring",
      categoryId: category._id,
      duration: 60,
      pricing: { basePrice: 1500 },
      status: "active",
      isActive: true,
    });

    // 3. Staff Members
    staffA = await Staff.create({
      organizationId: orgId,
      name: "Senior Stylist Alice",
      phone: `+91912${Math.floor(1000000 + Math.random() * 9000000)}`,
      email: `alice_${Date.now()}_${Math.random()}@salon.com`,
      designation: "Senior Stylist",
      staffCode: `STF-A-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      joiningDate: new Date(),
      status: "active",
      isDeleted: false,
    });

    staffB = await Staff.create({
      organizationId: orgId,
      name: "Junior Stylist Bob",
      phone: `+91913${Math.floor(1000000 + Math.random() * 9000000)}`,
      email: `bob_${Date.now()}_${Math.random()}@salon.com`,
      designation: "Junior Stylist",
      staffCode: `STF-B-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      joiningDate: new Date(),
      status: "active",
      isDeleted: false,
    });

    // 4. Role & User
    const role = await Role.create({
      name: "owner",
      isSystem: true,
      permissions: [],
    });

    ownerUser = await User.create({
      name: "Salon Admin",
      email: `admin_${Date.now()}@salon.com`,
      phone: "+919876543210",
      password: "Password@123",
      role: role._id,
      organizationId: orgId,
      status: "active",
    });

    // 5. Customer
    customer = await Customer.create({
      organizationId: orgId,
      homeBranchId: branchA._id,
      name: "Test Customer",
      phone: "+919988776655",
      isDeleted: false,
    });
  });

  // =========================================================================
  // SCENARIOS 1-5: Branch Assignment & Staff Active Status
  // =========================================================================
  describe("Scenarios 1-5: Branch Assignment & Active Status", () => {
    it("Scenario 1: Staff assigned only to Branch A cannot be booked at Branch B (BRANCH_NOT_ASSIGNED)", async () => {
      await StaffBranch.create({
        organizationId: orgId,
        staffId: staffA._id,
        branchId: branchA._id,
        isActive: true,
      });

      const res = await staffAvailabilityService.checkStaffSlotAvailability({
        organizationId: orgId.toString(),
        branchId: branchB._id.toString(),
        staffId: staffA._id.toString(),
        date: getFutureDateStr(10),
        startTime: "10:00",
        duration: 30,
      });

      expect(res.status).toBe(AVAILABILITY_STATUS.UNAVAILABLE);
      expect(res.reasons).toContain(REASON_CODES.BRANCH_NOT_ASSIGNED);
    });

    it("Scenario 2: Staff assigned to Branch A & Branch B can be booked at Branch A", async () => {
      await StaffBranch.create({
        organizationId: orgId,
        staffId: staffA._id,
        branchId: branchA._id,
        isActive: true,
      });
      await StaffBranch.create({
        organizationId: orgId,
        staffId: staffA._id,
        branchId: branchB._id,
        isActive: true,
      });

      const res = await staffAvailabilityService.checkStaffSlotAvailability({
        organizationId: orgId.toString(),
        branchId: branchA._id.toString(),
        staffId: staffA._id.toString(),
        date: getFutureDateStr(10),
        startTime: "10:00",
        duration: 30,
      });

      expect(res.status).toBe(AVAILABILITY_STATUS.AVAILABLE);
    });

    it("Scenario 3: Staff assigned to Branch A & Branch B can be booked at Branch B", async () => {
      await StaffBranch.create({
        organizationId: orgId,
        staffId: staffA._id,
        branchId: branchA._id,
        isActive: true,
      });
      await StaffBranch.create({
        organizationId: orgId,
        staffId: staffA._id,
        branchId: branchB._id,
        isActive: true,
      });

      const res = await staffAvailabilityService.checkStaffSlotAvailability({
        organizationId: orgId.toString(),
        branchId: branchB._id.toString(),
        staffId: staffA._id.toString(),
        date: getFutureDateStr(10),
        startTime: "11:00",
        duration: 30,
      });

      expect(res.status).toBe(AVAILABILITY_STATUS.AVAILABLE);
    });

    it("Scenario 4: Inactive staff member rejected (STAFF_INACTIVE)", async () => {
      await Staff.findByIdAndUpdate(staffA._id, { status: "inactive" });
      await StaffBranch.create({
        organizationId: orgId,
        staffId: staffA._id,
        branchId: branchA._id,
        isActive: true,
      });

      const res = await staffAvailabilityService.checkStaffSlotAvailability({
        organizationId: orgId.toString(),
        branchId: branchA._id.toString(),
        staffId: staffA._id.toString(),
        date: getFutureDateStr(10),
        startTime: "10:00",
        duration: 30,
      });

      expect(res.status).toBe(AVAILABILITY_STATUS.UNAVAILABLE);
      expect(res.reasons).toContain(REASON_CODES.STAFF_INACTIVE);
    });

    it("Scenario 5: Inactive StaffBranch relationship rejected (BRANCH_NOT_ASSIGNED)", async () => {
      await StaffBranch.create({
        organizationId: orgId,
        staffId: staffA._id,
        branchId: branchA._id,
        isActive: false,
      });

      const res = await staffAvailabilityService.checkStaffSlotAvailability({
        organizationId: orgId.toString(),
        branchId: branchA._id.toString(),
        staffId: staffA._id.toString(),
        date: getFutureDateStr(10),
        startTime: "10:00",
        duration: 30,
      });

      expect(res.status).toBe(AVAILABILITY_STATUS.UNAVAILABLE);
      expect(res.reasons).toContain(REASON_CODES.BRANCH_NOT_ASSIGNED);
    });
  });

  // =========================================================================
  // SCENARIOS 6-7: Service Eligibility & Qualifications
  // =========================================================================
  describe("Scenarios 6-7: Service Eligibility", () => {
    beforeEach(async () => {
      await StaffBranch.create({
        organizationId: orgId,
        staffId: staffA._id,
        branchId: branchA._id,
        isActive: true,
      });
      await StaffService.create({
        organizationId: orgId,
        staffId: staffA._id,
        serviceId: serviceHaircut._id,
        isActive: true,
      });
    });

    it("Scenario 6: Staff lacking one of multiple requested services rejected (SERVICE_NOT_SUPPORTED)", async () => {
      const res = await staffAvailabilityService.checkStaffSlotAvailability({
        organizationId: orgId.toString(),
        branchId: branchA._id.toString(),
        staffId: staffA._id.toString(),
        date: getFutureDateStr(10),
        startTime: "10:00",
        duration: 90,
        serviceIds: [serviceHaircut._id.toString(), serviceColor._id.toString()],
      });

      expect(res.status).toBe(AVAILABILITY_STATUS.UNAVAILABLE);
      expect(res.reasons).toContain(REASON_CODES.SERVICE_NOT_SUPPORTED);
    });

    it("Scenario 7: Staff having all requested services accepted", async () => {
      await StaffService.create({
        organizationId: orgId,
        staffId: staffA._id,
        serviceId: serviceColor._id,
        isActive: true,
      });

      const res = await staffAvailabilityService.checkStaffSlotAvailability({
        organizationId: orgId.toString(),
        branchId: branchA._id.toString(),
        staffId: staffA._id.toString(),
        date: getFutureDateStr(10),
        startTime: "10:00",
        duration: 90,
        serviceIds: [serviceHaircut._id.toString(), serviceColor._id.toString()],
      });

      expect(res.status).toBe(AVAILABILITY_STATUS.AVAILABLE);
    });
  });

  // =========================================================================
  // SCENARIOS 8-17: Leave Management & Interval Overlaps
  // =========================================================================
  describe("Scenarios 8-17: Leave Overlap Detection", () => {
    const leaveDate = getFutureDateStr(20);

    beforeEach(async () => {
      await StaffBranch.create({
        organizationId: orgId,
        staffId: staffA._id,
        branchId: branchA._id,
        isActive: true,
      });
    });

    it("Scenario 8: Approved full-day leave blocks entire day (APPROVED_LEAVE)", async () => {
      await createTestLeave({
        staffId: staffA._id,
        startDate: new Date(`${leaveDate}T00:00:00.000Z`),
        endDate: new Date(`${leaveDate}T23:59:59.999Z`),
        status: "approved",
      });

      const res = await staffAvailabilityService.checkStaffSlotAvailability({
        organizationId: orgId.toString(),
        branchId: branchA._id.toString(),
        staffId: staffA._id.toString(),
        date: leaveDate,
        startTime: "10:00",
        duration: 30,
      });

      expect(res.status).toBe(AVAILABILITY_STATUS.UNAVAILABLE);
      expect(res.reasons).toContain(REASON_CODES.APPROVED_LEAVE);
    });

    it("Scenario 9: Approved partial-day first-half leave blocks morning slots (PARTIAL_DAY_LEAVE_CONFLICT)", async () => {
      await createTestLeave({
        staffId: staffA._id,
        startDate: new Date(`${leaveDate}T00:00:00.000Z`),
        endDate: new Date(`${leaveDate}T23:59:59.999Z`),
        status: "approved",
        isPartialDay: true,
        dayPart: "first_half",
      });

      const res = await staffAvailabilityService.checkStaffSlotAvailability({
        organizationId: orgId.toString(),
        branchId: branchA._id.toString(),
        staffId: staffA._id.toString(),
        date: leaveDate,
        startTime: "10:00",
        duration: 30,
      });

      expect(res.status).toBe(AVAILABILITY_STATUS.UNAVAILABLE);
      expect(res.reasons).toContain(REASON_CODES.PARTIAL_DAY_LEAVE_CONFLICT);
    });

    it("Scenario 10: Approved partial-day first-half leave allows afternoon slots (available)", async () => {
      await createTestLeave({
        staffId: staffA._id,
        startDate: new Date(`${leaveDate}T00:00:00.000Z`),
        endDate: new Date(`${leaveDate}T23:59:59.999Z`),
        status: "approved",
        isPartialDay: true,
        dayPart: "first_half",
      });

      const res = await staffAvailabilityService.checkStaffSlotAvailability({
        organizationId: orgId.toString(),
        branchId: branchA._id.toString(),
        staffId: staffA._id.toString(),
        date: leaveDate,
        startTime: "14:00",
        duration: 30,
      });

      expect(res.status).toBe(AVAILABILITY_STATUS.AVAILABLE);
    });

    it("Scenario 11: Approved partial-day second-half leave blocks afternoon slots (PARTIAL_DAY_LEAVE_CONFLICT)", async () => {
      await createTestLeave({
        staffId: staffA._id,
        startDate: new Date(`${leaveDate}T00:00:00.000Z`),
        endDate: new Date(`${leaveDate}T23:59:59.999Z`),
        status: "approved",
        isPartialDay: true,
        dayPart: "second_half",
      });

      const res = await staffAvailabilityService.checkStaffSlotAvailability({
        organizationId: orgId.toString(),
        branchId: branchA._id.toString(),
        staffId: staffA._id.toString(),
        date: leaveDate,
        startTime: "15:00",
        duration: 30,
      });

      expect(res.status).toBe(AVAILABILITY_STATUS.UNAVAILABLE);
      expect(res.reasons).toContain(REASON_CODES.PARTIAL_DAY_LEAVE_CONFLICT);
    });

    it("Scenario 12: Approved partial-day second-half leave allows morning slots (available)", async () => {
      await createTestLeave({
        staffId: staffA._id,
        startDate: new Date(`${leaveDate}T00:00:00.000Z`),
        endDate: new Date(`${leaveDate}T23:59:59.999Z`),
        status: "approved",
        isPartialDay: true,
        dayPart: "second_half",
      });

      const res = await staffAvailabilityService.checkStaffSlotAvailability({
        organizationId: orgId.toString(),
        branchId: branchA._id.toString(),
        staffId: staffA._id.toString(),
        date: leaveDate,
        startTime: "10:00",
        duration: 30,
      });

      expect(res.status).toBe(AVAILABILITY_STATUS.AVAILABLE);
    });

    it("Scenario 13: Approved custom time leave blocks overlapping interval", async () => {
      const tz = branchA.timezone;
      const leaveStart = parseLocalToUTC(leaveDate, "14:00", tz);
      const leaveEnd = parseLocalToUTC(leaveDate, "16:00", tz);

      await createTestLeave({
        staffId: staffA._id,
        startDate: leaveStart,
        endDate: leaveEnd,
        status: "approved",
        isPartialDay: true,
        dayPart: "custom",
        startTime: "14:00",
        endTime: "16:00",
        startAt: leaveStart,
        endAt: leaveEnd,
      });

      const res = await staffAvailabilityService.checkStaffSlotAvailability({
        organizationId: orgId.toString(),
        branchId: branchA._id.toString(),
        staffId: staffA._id.toString(),
        date: leaveDate,
        startTime: "14:30",
        duration: 30,
      });

      expect(res.status).toBe(AVAILABILITY_STATUS.UNAVAILABLE);
      expect(res.reasons).toContain(REASON_CODES.PARTIAL_DAY_LEAVE_CONFLICT);
    });

    it("Scenario 14: Approved custom time leave allows non-overlapping interval on same day", async () => {
      const tz = branchA.timezone;
      const leaveStart = parseLocalToUTC(leaveDate, "14:00", tz);
      const leaveEnd = parseLocalToUTC(leaveDate, "16:00", tz);

      await createTestLeave({
        staffId: staffA._id,
        startDate: leaveStart,
        endDate: leaveEnd,
        status: "approved",
        isPartialDay: true,
        dayPart: "custom",
        startTime: "14:00",
        endTime: "16:00",
        startAt: leaveStart,
        endAt: leaveEnd,
      });

      const res = await staffAvailabilityService.checkStaffSlotAvailability({
        organizationId: orgId.toString(),
        branchId: branchA._id.toString(),
        staffId: staffA._id.toString(),
        date: leaveDate,
        startTime: "11:00",
        duration: 30,
      });

      expect(res.status).toBe(AVAILABILITY_STATUS.AVAILABLE);
    });

    it("Scenario 15: Pending leave does not block availability (business policy)", async () => {
      await createTestLeave({
        staffId: staffA._id,
        startDate: new Date(`${leaveDate}T00:00:00.000Z`),
        endDate: new Date(`${leaveDate}T23:59:59.999Z`),
        status: "pending",
      });

      const res = await staffAvailabilityService.checkStaffSlotAvailability({
        organizationId: orgId.toString(),
        branchId: branchA._id.toString(),
        staffId: staffA._id.toString(),
        date: leaveDate,
        startTime: "10:00",
        duration: 30,
      });

      expect(res.status).toBe(AVAILABILITY_STATUS.AVAILABLE);
    });

    it("Scenario 16: Rejected leave does not block availability", async () => {
      await createTestLeave({
        staffId: staffA._id,
        startDate: new Date(`${leaveDate}T00:00:00.000Z`),
        endDate: new Date(`${leaveDate}T23:59:59.999Z`),
        status: "rejected",
      });

      const res = await staffAvailabilityService.checkStaffSlotAvailability({
        organizationId: orgId.toString(),
        branchId: branchA._id.toString(),
        staffId: staffA._id.toString(),
        date: leaveDate,
        startTime: "10:00",
        duration: 30,
      });

      expect(res.status).toBe(AVAILABILITY_STATUS.AVAILABLE);
    });

    it("Scenario 17: Cancelled leave does not block availability", async () => {
      await createTestLeave({
        staffId: staffA._id,
        startDate: new Date(`${leaveDate}T00:00:00.000Z`),
        endDate: new Date(`${leaveDate}T23:59:59.999Z`),
        status: "cancelled",
      });

      const res = await staffAvailabilityService.checkStaffSlotAvailability({
        organizationId: orgId.toString(),
        branchId: branchA._id.toString(),
        staffId: staffA._id.toString(),
        date: leaveDate,
        startTime: "10:00",
        duration: 30,
      });

      expect(res.status).toBe(AVAILABILITY_STATUS.AVAILABLE);
    });
  });

  // =========================================================================
  // SCENARIOS 18-19: Appointment Overlaps & Self-Exclusion in Reschedule
  // =========================================================================
  describe("Scenarios 18-19: Appointment Conflicts & Self-Exclusion", () => {
    const aptDate = getFutureDateStr(12);

    beforeEach(async () => {
      await StaffBranch.create({
        organizationId: orgId,
        staffId: staffA._id,
        branchId: branchA._id,
        isActive: true,
      });
    });

    it("Scenario 18: Existing appointment at target branch blocks exact slot overlap (APPOINTMENT_CONFLICT)", async () => {
      await createTestAppointment({
        branchId: branchA._id,
        staffId: staffA._id,
        date: aptDate,
        startTime: "11:00",
        endTime: "12:00",
        duration: 60,
      });

      const res = await staffAvailabilityService.checkStaffSlotAvailability({
        organizationId: orgId.toString(),
        branchId: branchA._id.toString(),
        staffId: staffA._id.toString(),
        date: aptDate,
        startTime: "11:30",
        duration: 30,
      });

      expect(res.status).toBe(AVAILABILITY_STATUS.UNAVAILABLE);
      expect(res.reasons).toContain(REASON_CODES.APPOINTMENT_CONFLICT);
    });

    it("Scenario 19: Rescheduling an appointment does not self-conflict with its current slot (excludeAppointmentId)", async () => {
      const existingApt = await createTestAppointment({
        branchId: branchA._id,
        staffId: staffA._id,
        date: aptDate,
        startTime: "14:00",
        endTime: "15:00",
        duration: 60,
      });

      const res = await staffAvailabilityService.checkStaffSlotAvailability({
        organizationId: orgId.toString(),
        branchId: branchA._id.toString(),
        staffId: staffA._id.toString(),
        date: aptDate,
        startTime: "14:00",
        duration: 60,
        excludeAppointmentId: existingApt._id.toString(),
      });

      expect(res.status).toBe(AVAILABILITY_STATUS.AVAILABLE);
    });
  });

  // =========================================================================
  // SCENARIOS 20-23: Attendance-Aware Rules
  // =========================================================================
  describe("Scenarios 20-23: Attendance Operational Signals", () => {
    beforeEach(async () => {
      await StaffBranch.create({
        organizationId: orgId,
        staffId: staffA._id,
        branchId: branchA._id,
        isActive: true,
      });
    });

    it("Scenario 20: Future booking allowed when staff is not yet clocked in", async () => {
      const futureDate = getFutureDateStr(25);
      const res = await staffAvailabilityService.checkStaffSlotAvailability({
        organizationId: orgId.toString(),
        branchId: branchA._id.toString(),
        staffId: staffA._id.toString(),
        date: futureDate,
        startTime: "10:00",
        duration: 30,
      });

      expect(res.status).toBe(AVAILABILITY_STATUS.AVAILABLE);
    });

    it("Scenario 21: Same-day appointment when staff has clocked out blocks availability (ATTENDANCE_CLOCKED_OUT)", async () => {
      const tz = branchA.timezone;
      const now = new Date();
      const todayStr = deriveBusinessDate(now, tz);
      const startAt = parseLocalToUTC(todayStr, "18:00", tz);

      await Attendance.create({
        organizationId: orgId,
        branchId: branchA._id,
        staffId: staffA._id,
        attendanceDate: new Date(`${todayStr}T00:00:00.000Z`),
        status: "incomplete",
      });

      await AttendancePunch.create({
        organizationId: orgId,
        branchId: branchA._id,
        staffId: staffA._id,
        punchType: "out",
        punchAt: new Date(startAt.getTime() - 60 * 60000), // Clocked out 1 hour before start
        provider: "biometric",
      });

      const res = await staffAvailabilityService.checkStaffSlotAvailability({
        organizationId: orgId.toString(),
        branchId: branchA._id.toString(),
        staffId: staffA._id.toString(),
        date: todayStr,
        startTime: "18:00",
        duration: 30,
      });

      expect(res.status).toBe(AVAILABILITY_STATUS.UNAVAILABLE);
      expect(res.reasons).toContain(REASON_CODES.ATTENDANCE_CLOCKED_OUT);
    });

    it("Scenario 22: Same-day appointment when staff attendance is incomplete with no punches returns requires_review", async () => {
      const tz = branchA.timezone;
      const now = new Date();
      const todayStr = deriveBusinessDate(now, tz);

      await Attendance.create({
        organizationId: orgId,
        branchId: branchA._id,
        staffId: staffA._id,
        attendanceDate: new Date(`${todayStr}T00:00:00.000Z`),
        status: "incomplete",
      });

      const res = await staffAvailabilityService.checkStaffSlotAvailability({
        organizationId: orgId.toString(),
        branchId: branchA._id.toString(),
        staffId: staffA._id.toString(),
        date: todayStr,
        startTime: "16:00",
        duration: 30,
      });

      expect(res.status).toBe(AVAILABILITY_STATUS.REQUIRES_REVIEW);
      expect(res.reasons).toContain(REASON_CODES.ATTENDANCE_INCOMPLETE);
    });

    it("Scenario 23: Disputed or unreconciled attendance conflict returns requires_review", async () => {
      const tz = branchA.timezone;
      const now = new Date();
      const todayStr = deriveBusinessDate(now, tz);

      await Attendance.create({
        organizationId: orgId,
        branchId: branchA._id,
        staffId: staffA._id,
        attendanceDate: new Date(`${todayStr}T00:00:00.000Z`),
        status: "incomplete",
        conflictType: "appointment",
        isReconciled: false,
      });

      const res = await staffAvailabilityService.checkStaffSlotAvailability({
        organizationId: orgId.toString(),
        branchId: branchA._id.toString(),
        staffId: staffA._id.toString(),
        date: todayStr,
        startTime: "15:00",
        duration: 30,
      });

      expect(res.status).toBe(AVAILABILITY_STATUS.REQUIRES_REVIEW);
      expect(res.reasons).toContain(REASON_CODES.ATTENDANCE_CONFLICT);
    });
  });

  // =========================================================================
  // SCENARIOS 24-26: Cross-Branch Conflicts & Travel Time Buffer
  // =========================================================================
  describe("Scenarios 24-26: Cross-Branch Overlaps & Travel Buffer", () => {
    const testDate = getFutureDateStr(8);

    beforeEach(async () => {
      await StaffBranch.create({
        organizationId: orgId,
        staffId: staffA._id,
        branchId: branchA._id,
        isActive: true,
      });
      await StaffBranch.create({
        organizationId: orgId,
        staffId: staffA._id,
        branchId: branchB._id,
        isActive: true,
      });
    });

    it("Scenario 24: Cross-branch overlap: appointment at Branch A blocks simultaneous appointment at Branch B (CROSS_BRANCH_CONFLICT)", async () => {
      await createTestAppointment({
        branchId: branchA._id,
        staffId: staffA._id,
        date: testDate,
        startTime: "14:00",
        endTime: "15:00",
        duration: 60,
      });

      const res = await staffAvailabilityService.checkStaffSlotAvailability({
        organizationId: orgId.toString(),
        branchId: branchB._id.toString(),
        staffId: staffA._id.toString(),
        date: testDate,
        startTime: "14:30",
        duration: 30,
      });

      expect(res.status).toBe(AVAILABILITY_STATUS.UNAVAILABLE);
      expect(res.reasons).toContain(REASON_CODES.CROSS_BRANCH_CONFLICT);
    });

    it("Scenario 25: Cross-branch travel buffer: appointment at Branch A ending 12:00 blocks appointment at Branch B starting at 12:15 when buffer is 30m (TRAVEL_TIME_CONFLICT)", async () => {
      await createTestAppointment({
        branchId: branchA._id,
        staffId: staffA._id,
        date: testDate,
        startTime: "11:00",
        endTime: "12:00",
        duration: 60,
      });

      const res = await staffAvailabilityService.checkStaffSlotAvailability({
        organizationId: orgId.toString(),
        branchId: branchB._id.toString(),
        staffId: staffA._id.toString(),
        date: testDate,
        startTime: "12:15",
        duration: 45,
      });

      expect(res.status).toBe(AVAILABILITY_STATUS.UNAVAILABLE);
      expect(res.reasons).toContain(REASON_CODES.TRAVEL_TIME_CONFLICT);
    });

    it("Scenario 26: Cross-branch travel buffer: appointment at Branch A ending 12:00 allows appointment at Branch B starting at 12:45 when buffer is 30m", async () => {
      await createTestAppointment({
        branchId: branchA._id,
        staffId: staffA._id,
        date: testDate,
        startTime: "11:00",
        endTime: "12:00",
        duration: 60,
      });

      const res = await staffAvailabilityService.checkStaffSlotAvailability({
        organizationId: orgId.toString(),
        branchId: branchB._id.toString(),
        staffId: staffA._id.toString(),
        date: testDate,
        startTime: "12:45",
        duration: 45,
      });

      expect(res.status).toBe(AVAILABILITY_STATUS.AVAILABLE);
    });
  });

  // =========================================================================
  // SCENARIOS 27-28: Timezone Boundaries & Combined Multi-Service Duration
  // =========================================================================
  describe("Scenarios 27-28: Timezones & Duration Calculations", () => {
    it("Scenario 27: Timezone boundaries: correct local-to-UTC shift for branches in different timezones", async () => {
      const branchNY = await Branch.create({
        organizationId: orgId,
        name: "Manhattan Salon",
        timezone: "America/New_York",
        isActive: true,
        operatingHours: {
          monday: { openTime: "09:00", closeTime: "20:00", isOpen: true },
          tuesday: { openTime: "09:00", closeTime: "20:00", isOpen: true },
          wednesday: { openTime: "09:00", closeTime: "20:00", isOpen: true },
          thursday: { openTime: "09:00", closeTime: "20:00", isOpen: true },
          friday: { openTime: "09:00", closeTime: "20:00", isOpen: true },
          saturday: { openTime: "09:00", closeTime: "20:00", isOpen: true },
          sunday: { openTime: "09:00", closeTime: "20:00", isOpen: true },
        },
      });

      await StaffBranch.create({
        organizationId: orgId,
        staffId: staffA._id,
        branchId: branchNY._id,
        isActive: true,
      });

      const dateStr = getFutureDateStr(7);
      const res = await staffAvailabilityService.checkStaffSlotAvailability({
        organizationId: orgId.toString(),
        branchId: branchNY._id.toString(),
        staffId: staffA._id.toString(),
        date: dateStr,
        startTime: "10:00",
        duration: 60,
      });

      expect(res.status).toBe(AVAILABILITY_STATUS.AVAILABLE);
      // In November, New York is in Eastern Standard Time (EST = UTC-5). 10:00 EST + 5 hours = 15:00 UTC
      expect(new Date(res.startAt).getUTCHours()).toBe(15);
      expect(new Date(res.endAt).getUTCHours()).toBe(16);
    });

    it("Scenario 28: Combined multi-service duration: multi-service appointment properly calculates duration and checks full span", async () => {
      await StaffBranch.create({
        organizationId: orgId,
        staffId: staffA._id,
        branchId: branchA._id,
        isActive: true,
      });
      await StaffService.create({
        organizationId: orgId,
        staffId: staffA._id,
        serviceId: serviceHaircut._id,
        isActive: true,
      });
      await StaffService.create({
        organizationId: orgId,
        staffId: staffA._id,
        serviceId: serviceColor._id,
        isActive: true,
      });

      const dateStr = getFutureDateStr(5);

      // Existing appointment at 11:00 - 11:30
      await createTestAppointment({
        branchId: branchA._id,
        staffId: staffA._id,
        date: dateStr,
        startTime: "11:00",
        endTime: "11:30",
        duration: 30,
      });

      // New appointment requested at 10:00 with combined Haircut (30m) + Color (60m) = 90m (ends at 11:30)
      const res = await staffAvailabilityService.checkStaffSlotAvailability({
        organizationId: orgId.toString(),
        branchId: branchA._id.toString(),
        staffId: staffA._id.toString(),
        date: dateStr,
        startTime: "10:00",
        duration: 90,
        serviceIds: [serviceHaircut._id.toString(), serviceColor._id.toString()],
      });

      expect(res.status).toBe(AVAILABILITY_STATUS.UNAVAILABLE);
      expect(res.reasons).toContain(REASON_CODES.APPOINTMENT_CONFLICT);
    });
  });

  // =========================================================================
  // BATCH LOOKUP & CALENDAR ENGINE TESTS
  // =========================================================================
  describe("Batch Slot Search & Calendar Matrix", () => {
    it("finds all available staff for a given slot, sorting available staff first", async () => {
      await StaffBranch.create({
        organizationId: orgId,
        staffId: staffA._id,
        branchId: branchA._id,
        isActive: true,
      });
      await StaffService.create({
        organizationId: orgId,
        staffId: staffA._id,
        serviceId: serviceHaircut._id,
        isActive: true,
      });

      await StaffBranch.create({
        organizationId: orgId,
        staffId: staffB._id,
        branchId: branchA._id,
        isActive: true,
      });

      const dateStr = getFutureDateStr(6);
      const results = await staffAvailabilityService.findAvailableStaffForSlot({
        organizationId: orgId.toString(),
        branchId: branchA._id.toString(),
        date: dateStr,
        startTime: "10:00",
        duration: 30,
        serviceIds: [serviceHaircut._id.toString()],
      });

      expect(results.staff.length).toBe(2);
      expect(results.staff[0].staffId).toBe(staffA._id.toString());
      expect(results.staff[0].status).toBe(AVAILABILITY_STATUS.AVAILABLE);

      expect(results.staff[1].staffId).toBe(staffB._id.toString());
      expect(results.staff[1].status).toBe(AVAILABILITY_STATUS.UNAVAILABLE);
      expect(results.staff[1].reasons).toContain(REASON_CODES.SERVICE_NOT_SUPPORTED);
    });

    it("generates calendar availability lane for staff across date range with leaves and attendance", async () => {
      await StaffBranch.create({
        organizationId: orgId,
        staffId: staffA._id,
        branchId: branchA._id,
        isActive: true,
      });

      const dateStr = getFutureDateStr(15);
      const calendarData = await staffAvailabilityService.getStaffCalendarAvailability({
        organizationId: orgId.toString(),
        branchId: branchA._id.toString(),
        date: dateStr,
        staffId: staffA._id.toString(),
      });

      expect(calendarData.lanes.length).toBe(1);
      expect(calendarData.lanes[0].id).toBe(staffA._id.toString());
      expect(calendarData.lanes[0].name).toBe("Senior Stylist Alice");
    });
  });
});
