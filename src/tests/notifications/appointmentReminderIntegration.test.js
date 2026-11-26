import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { emailQueue, smsQueue } from "../../queues/client.js";
import { OutboxEvent } from "../../models/notifications/outboxEvent.model.js";
import { Notification } from "../../models/notifications/notification.model.js";
import { AppointmentRepository } from "../../repositories/appointments/appointment.repository.js";
import { AppointmentService } from "../../services/appointments/appointment.service.js";

describe("Stage 2E — Appointment Reminder Outbox Activation", () => {
  const service = new AppointmentService();
  const orgId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();
  const aptId = new mongoose.Types.ObjectId();
  const custId = new mongoose.Types.ObjectId();

  const futureStart = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const mockApt = {
    _id: aptId,
    organizationId: orgId,
    branchId,
    customerId: custId,
    appointmentCode: "APT-2E",
    status: "scheduled",
    startAt: futureStart,
    reminder: { enabled: true, offsetMinutes: 60, channel: "both" },
  };

  const prevFlag = process.env.USE_OUTBOX_APPOINTMENT_REMINDERS;

  afterEach(() => {
    process.env.USE_OUTBOX_APPOINTMENT_REMINDERS = prevFlag;
    jest.restoreAllMocks();
  });

  it("uses OutboxEvent and skips legacy queues when USE_OUTBOX_APPOINTMENT_REMINDERS=true", async () => {
    process.env.USE_OUTBOX_APPOINTMENT_REMINDERS = "true";
    const outboxSpy = jest
      .spyOn(OutboxEvent, "create")
      .mockImplementation(async (doc) => ({ ...doc, _id: new mongoose.Types.ObjectId() }));
    const emailSpy = jest.spyOn(emailQueue, "add");
    const smsSpy = jest.spyOn(smsQueue, "add");
    jest.spyOn(AppointmentRepository.prototype, "update").mockResolvedValue({});

    await service.scheduleReminders(mockApt);

    expect(outboxSpy).toHaveBeenCalledTimes(1);
    expect(emailSpy).not.toHaveBeenCalled();
    expect(smsSpy).not.toHaveBeenCalled();
  });

  it("cancels OutboxEvent and Notification records when USE_OUTBOX_APPOINTMENT_REMINDERS=true", async () => {
    process.env.USE_OUTBOX_APPOINTMENT_REMINDERS = "true";
    const outboxCancelSpy = jest.spyOn(OutboxEvent, "updateMany").mockResolvedValue({ modifiedCount: 1 });
    const notifCancelSpy = jest.spyOn(Notification, "updateMany").mockResolvedValue({ modifiedCount: 1 });

    await service.cancelReminders(mockApt);

    expect(outboxCancelSpy).toHaveBeenCalledTimes(1);
    expect(notifCancelSpy).toHaveBeenCalledTimes(1);
  });

  it("preserves legacy BullMQ path when USE_OUTBOX_APPOINTMENT_REMINDERS is not true", async () => {
    process.env.USE_OUTBOX_APPOINTMENT_REMINDERS = "false";
    const outboxSpy = jest.spyOn(OutboxEvent, "create");
    const emailSpy = jest.spyOn(emailQueue, "add").mockResolvedValue({ id: "e1" });
    const smsSpy = jest.spyOn(smsQueue, "add").mockResolvedValue({ id: "s1" });
    jest.spyOn(AppointmentRepository.prototype, "update").mockResolvedValue({});

    await service.scheduleReminders(mockApt);

    expect(outboxSpy).not.toHaveBeenCalled();
    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(smsSpy).toHaveBeenCalledTimes(1);
  });
});
