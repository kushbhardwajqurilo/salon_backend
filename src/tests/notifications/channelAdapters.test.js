import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { EmailService } from "../../services/notifications/email.service.js";
import { SmsService } from "../../services/notifications/sms.service.js";
import { Notification } from "../../models/notifications/notification.model.js";
import { OutboxEvent } from "../../models/notifications/outboxEvent.model.js";
import {
  sendViaEmailAdapter,
  sendViaSmsAdapter,
  dispatchNotificationJob,
  dispatchRenderedNotification,
} from "../../services/notifications/channelAdapters.service.js";
import { NotificationTemplate } from "../../models/notifications/notificationTemplate.model.js";
import { OrganizationSettings } from "../../models/settings/organizationSettings.model.js";
import {
  scheduleAppointmentReminderOutbox,
  cancelAppointmentReminderNotifications,
} from "../../services/appointments/appointmentReminderOutbox.service.js";

describe("Stage 2D — Channel Adapters & Appointment Reminder Migration", () => {
  const orgId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();
  const aptId = new mongoose.Types.ObjectId();
  const custId = new mongoose.Types.ObjectId();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("dispatches via email and SMS adapters", async () => {
    jest.spyOn(EmailService.prototype, "sendMail").mockResolvedValue({ messageId: "m-1" });
    jest.spyOn(SmsService.prototype, "sendSms").mockResolvedValue({ success: true });

    const emailRes = await sendViaEmailAdapter({ to: "a@b.com", subject: "Hi", text: "Hi" });
    const smsRes = await sendViaSmsAdapter({ phone: "+91111", message: "Hi" });

    expect(emailRes).toEqual({ accepted: true, provider: "nodemailer", messageId: "m-1", devMode: false });
    expect(smsRes).toEqual({ accepted: true, provider: "autobysms", devMode: false });
  });

  it("transitions Notification queued -> processing -> sent (never delivered) and skips duplicates", async () => {
    const mockNotif = { _id: "n1", notificationId: "nid-1", status: "processing" };
    jest.spyOn(Notification, "findOneAndUpdate")
      .mockResolvedValueOnce(mockNotif)
      .mockResolvedValueOnce(null);
    const updateSpy = jest.spyOn(Notification, "updateOne").mockResolvedValue({ modifiedCount: 1 });

    const first = await dispatchNotificationJob("nid-1", async () => ({ accepted: true }));
    const second = await dispatchNotificationJob("nid-1", async () => ({ accepted: true }));

    expect(first.status).toBe("sent");
    expect(second.skipped).toBe(true);
    expect(updateSpy).toHaveBeenCalledWith(
      { _id: "n1", status: "processing" },
      expect.objectContaining({ $set: expect.objectContaining({ status: "sent" }) }),
    );
  });

  it("marks Notification failed with redacted reason when adapter throws", async () => {
    jest.spyOn(Notification, "findOneAndUpdate").mockResolvedValue({ _id: "n2", notificationId: "nid-2", status: "processing" });
    const updateSpy = jest.spyOn(Notification, "updateOne").mockResolvedValue({ modifiedCount: 1 });

    await expect(
      dispatchNotificationJob("nid-2", async () => {
        throw new Error("SMTP failed with token=secret123");
      }),
    ).rejects.toThrow(/SMTP failed/);

    expect(updateSpy).toHaveBeenCalledWith(
      { _id: "n2", status: "processing" },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "failed",
          failureReason: "SMTP failed with token=[REDACTED]",
        }),
      }),
    );
  });

  it("schedules and cancels appointment reminder outbox/notifications", async () => {
    const startAt = new Date("2026-12-01T10:00:00.000Z");
    const availableAt = new Date("2026-12-01T08:00:00.000Z");
    jest.spyOn(OutboxEvent, "create").mockImplementation(async (doc) => ({ ...doc, _id: new mongoose.Types.ObjectId() }));
    jest.spyOn(OutboxEvent, "updateMany").mockResolvedValue({ modifiedCount: 1 });
    jest.spyOn(Notification, "updateMany").mockResolvedValue({ modifiedCount: 2 });

    const scheduled = await scheduleAppointmentReminderOutbox({
      appointment: { _id: aptId, organizationId: orgId, branchId, customerId: custId, appointmentCode: "APT-1", startAt },
      availableAt,
    });
    expect(scheduled.created).toBe(true);
    expect(scheduled.event.eventType).toBe("appointment.reminder_due");
    expect(scheduled.event.availableAt).toEqual(availableAt);

    const cancelled = await cancelAppointmentReminderNotifications({ organizationId: orgId, appointmentId: aptId });
    expect(cancelled.cancelledOutboxCount).toBe(1);
    expect(cancelled.cancelledCount).toBe(2);
  });

  it("renders template and dispatches email via dispatchRenderedNotification", async () => {
    jest.spyOn(Notification, "findOneAndUpdate").mockResolvedValue({
      _id: "n-tpl",
      notificationId: "nid-tpl",
      organizationId: orgId,
      eventType: "appointment.reminder_due",
      channel: "email",
      status: "processing",
    });
    jest.spyOn(Notification, "updateOne").mockResolvedValue({ modifiedCount: 1 });
    jest.spyOn(NotificationTemplate, "findOne")
      .mockReturnValueOnce({ lean: jest.fn().mockResolvedValue(null) })
      .mockReturnValueOnce({ lean: jest.fn().mockResolvedValue(null) });
    jest.spyOn(OrganizationSettings, "findOne").mockReturnValue({
      lean: jest.fn().mockResolvedValue({ businessName: "Luxe Salon" }),
    });
    const mailSpy = jest.spyOn(EmailService.prototype, "sendMail").mockResolvedValue({ messageId: "m-tpl" });

    const res = await dispatchRenderedNotification("nid-tpl", {
      to: "cust@test.com",
      variables: { appointmentCode: "APT-9", startAt: "11:00 AM" },
    });

    expect(res.status).toBe("sent");
    expect(mailSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "cust@test.com",
        subject: expect.stringContaining("Luxe Salon"),
        text: expect.stringContaining("APT-9"),
      }),
    );
  });
});
