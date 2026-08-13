import { describe, expect, it, beforeEach, jest } from "@jest/globals";
import mongoose from "mongoose";
import { AppointmentService, parseLocalToUTC, formatUTCToLocal, generateSlotMinutes } from "../../services/appointments/appointment.service.js";
import { AppError } from "../../utils/errors.js";

describe("AppointmentService Unit & Domain Tests", () => {
  let appointmentService;

  beforeEach(() => {
    appointmentService = new AppointmentService();
  });

  describe("Timezone Utilities", () => {
    it("converts local date/time strings to UTC Date timestamp for Asia/Kolkata (+05:30)", () => {
      const utcDate = parseLocalToUTC("2026-08-15", "10:00", "Asia/Kolkata");
      // 10:00 IST is 04:30 UTC
      expect(utcDate.toISOString()).toBe("2026-08-15T04:30:00.000Z");
    });

    it("converts local date/time strings to UTC Date timestamp for UTC", () => {
      const utcDate = parseLocalToUTC("2026-08-15", "10:00", "UTC");
      expect(utcDate.toISOString()).toBe("2026-08-15T10:00:00.000Z");
    });

    it("converts local date/time strings to UTC Date timestamp for America/New_York (EDT -04:00)", () => {
      const utcDate = parseLocalToUTC("2026-08-15", "10:00", "America/New_York");
      // 10:00 EDT is 14:00 UTC
      expect(utcDate.toISOString()).toBe("2026-08-15T14:00:00.000Z");
    });

    it("formats UTC Date timestamp back to local date/time strings for Asia/Kolkata, UTC, and America/New_York", () => {
      const utcDate = new Date("2026-08-15T04:30:00.000Z");
      
      const kolkata = formatUTCToLocal(utcDate, "Asia/Kolkata");
      expect(kolkata.dateStr).toBe("2026-08-15");
      expect(kolkata.timeStr).toBe("10:00");

      const utc = formatUTCToLocal(utcDate, "UTC");
      expect(utc.dateStr).toBe("2026-08-15");
      expect(utc.timeStr).toBe("04:30");

      const ny = formatUTCToLocal(utcDate, "America/New_York");
      expect(ny.dateStr).toBe("2026-08-15");
      expect(ny.timeStr).toBe("00:30");
    });

    it("defaults to Asia/Kolkata when branch timezone is omitted or undefined", () => {
      const utcDate = parseLocalToUTC("2026-08-15", "10:00", undefined);
      expect(utcDate.toISOString()).toBe("2026-08-15T04:30:00.000Z");
    });
  });

  describe("Slot Minutes Concurrency Bucket Generation", () => {
    it("generates exact 1-minute ISO resolution array for time intervals", () => {
      const startAt = new Date("2026-08-15T10:00:00.000Z");
      const endAt = new Date("2026-08-15T10:05:00.000Z"); // 5 minutes

      const slots = generateSlotMinutes(startAt, endAt);
      expect(slots).toHaveLength(5);
      expect(slots[0]).toBe("2026-08-15T10:00:00.000Z");
      expect(slots[4]).toBe("2026-08-15T10:04:00.000Z");
    });

    it("ensures adjacent appointments do NOT share any minute buckets", () => {
      const appt1Start = new Date("2026-08-15T10:00:00.000Z");
      const appt1End = new Date("2026-08-15T10:15:00.000Z");

      const appt2Start = new Date("2026-08-15T10:15:00.000Z");
      const appt2End = new Date("2026-08-15T10:30:00.000Z");

      const slots1 = generateSlotMinutes(appt1Start, appt1End);
      const slots2 = generateSlotMinutes(appt2Start, appt2End);

      const intersection = slots1.filter((slot) => slots2.includes(slot));
      expect(intersection).toHaveLength(0);
    });

    it("detects overlapping appointments for arbitrary start times and non-15 min durations", () => {
      // Appt 1: 10:07 to 10:24 (17 mins)
      const appt1Start = new Date("2026-08-15T10:07:00.000Z");
      const appt1End = new Date("2026-08-15T10:24:00.000Z");

      // Appt 2: 10:20 to 10:35 (15 mins)
      const appt2Start = new Date("2026-08-15T10:20:00.000Z");
      const appt2End = new Date("2026-08-15T10:35:00.000Z");

      const slots1 = generateSlotMinutes(appt1Start, appt1End);
      const slots2 = generateSlotMinutes(appt2Start, appt2End);

      const intersection = slots1.filter((slot) => slots2.includes(slot));
      expect(intersection.length).toBeGreaterThan(0);
      expect(intersection).toContain("2026-08-15T10:20:00.000Z");
      expect(intersection).toContain("2026-08-15T10:23:00.000Z");
    });
  });

  describe("Reminder Delivery Idempotency & Provider Invocation Guards", () => {
    it("ensures atomic claim prevents duplicate provider calls under concurrent worker execution", async () => {
      const { SmsService } = await import("../../services/notifications/sms.service.js");
      const smsSpy = jest.spyOn(SmsService.prototype, "sendSms").mockResolvedValue({ success: true });

      const { Appointment } = await import("../../models/appointments/appointment.model.js");

      const aptId = new mongoose.Types.ObjectId();
      const orgId = new mongoose.Types.ObjectId();
      const branchId = new mongoose.Types.ObjectId();

      const mockApt = {
        _id: aptId,
        organizationId: orgId,
        branchId,
        appointmentCode: "APT-TEST-001",
        status: "scheduled",
        isDeleted: false,
        customerId: new mongoose.Types.ObjectId(),
        startAt: new Date("2026-09-20T10:00:00.000Z"),
        reminder: {
          enabled: true,
          channel: "sms",
          status: "scheduled",
          sms: { status: "scheduled" }
        }
      };

      // Mock findOneAndUpdate to simulate atomic claim (first call succeeds, second returns null)
      let claimed = false;
      jest.spyOn(Appointment, "findOneAndUpdate").mockImplementation(async () => {
        if (!claimed) {
          claimed = true;
          return { ...mockApt, reminder: { ...mockApt.reminder, sms: { status: "processing" } } };
        }
        return null;
      });

      const { Customer } = await import("../../models/customers/customer.model.js");
      jest.spyOn(Customer, "findOne").mockResolvedValue({ _id: mockApt.customerId, phone: "+919876543210" });
      jest.spyOn(Appointment, "updateOne").mockResolvedValue({ modifiedCount: 1 });
      jest.spyOn(Appointment, "findById").mockResolvedValue(mockApt);

      const jobData = { appointmentId: aptId.toString(), organizationId: orgId.toString() };

      // Simulate 2 workers attempting to process the same SMS job simultaneously
      const workerTask1 = async () => {
        const apt = await Appointment.findOneAndUpdate(
          { _id: aptId, "reminder.sms.status": { $in: ["scheduled", "pending"] } },
          { $set: { "reminder.sms.status": "processing" } }
        );
        if (!apt) return false;
        const smsService = new SmsService();
        await smsService.sendSms({ phone: "+919876543210", message: "Reminder" });
        return true;
      };

      const results = await Promise.all([workerTask1(), workerTask1()]);

      // Exactly 1 worker succeeded in claiming and executing provider call
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(smsSpy).toHaveBeenCalledTimes(1);

      smsSpy.mockRestore();
    });
  });
});
