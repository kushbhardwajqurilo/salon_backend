import { jest } from "@jest/globals";
import mongoose from "mongoose";

// Mock BullMQ queues & providers before importing pipeline modules
const mockNotificationAdd = jest.fn(async () => ({ id: "notif-job-1" }));
const mockEmailAdd = jest.fn(async () => ({ id: "email-job-1" }));
const mockSmsAdd = jest.fn(async () => ({ id: "sms-job-1" }));

jest.unstable_mockModule("../../queues/client.js", () => ({
  notificationQueue: { add: mockNotificationAdd, removeJobScheduler: jest.fn() },
  emailQueue: { add: mockEmailAdd },
  smsQueue: { add: mockSmsAdd },
  whatsappQueue: { add: jest.fn() },
  reportsQueue: { add: jest.fn() },
  subscriptionCancellationQueue: { add: jest.fn() },
  stockReservationExpiryQueue: { add: jest.fn(), getQueue: jest.fn() },
}));

const mockSendMail = jest.fn(async () => ({ messageId: "msg-123" }));
const mockSendSms = jest.fn(async () => ({ success: true, response: "OK" }));

jest.unstable_mockModule("../../services/notifications/email.service.js", () => ({
  EmailService: class {
    sendMail = mockSendMail;
  },
}));

jest.unstable_mockModule("../../services/notifications/sms.service.js", () => ({
  SmsService: class {
    sendSms = mockSendSms;
  },
}));

jest.unstable_mockModule("../../services/appointments/appointment.service.js", () => ({
  recoverPendingAppointmentOutboxEvents: jest.fn(async () => 0),
  formatUTCToLocal: jest.fn(() => ({ dateStr: "2026-11-28", timeStr: "10:00 AM" })),
}));

const { OutboxEvent } = await import("../../models/notifications/outboxEvent.model.js");
const { Notification } = await import("../../models/notifications/notification.model.js");
const { Branch } = await import("../../models/branches/branch.model.js");
const { Customer } = await import("../../models/customers/customer.model.js");
const { User } = await import("../../models/users/user.model.js");
const { NotificationTemplate } = await import("../../models/notifications/notificationTemplate.model.js");
const { OrganizationSettings } = await import("../../models/settings/organizationSettings.model.js");

const { createOutboxEvent } = await import("../../services/notifications/outbox.service.js");
const {
  runOutboxRelayCycle,
  startOutboxRelay,
  stopOutboxRelay,
} = await import("../../services/notifications/outboxRelay.service.js");
const {
  processNotificationJob,
  processOrchestratedNotificationJob,
  startNotificationWorkers,
  stopNotificationWorkers,
} = await import("../../workers/notification.worker.js");

describe("Common Notification Pipeline E2E", () => {
  const orgId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();
  const customerId = new mongoose.Types.ObjectId();
  const employeeId = new mongoose.Types.ObjectId();

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Branch, "exists").mockResolvedValue(true);
    jest.spyOn(OrganizationSettings, "findOne").mockReturnValue({
      lean: async () => ({ profile: { displayName: "Glamour Studio" } }),
    });
    jest.spyOn(NotificationTemplate, "findOne").mockReturnValue({
      lean: async () => null, // Use BUILTIN_DEFAULTS
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("delivers email & sms end-to-end from outbox creation through worker processing", async () => {
    const outboxDoc = {
      _id: new mongoose.Types.ObjectId(),
      eventId: "evt-e2e-1",
      organizationId: orgId,
      branchId,
      eventType: "customer.created",
      idempotencyKey: "customer.created:1",
      schemaVersion: 1,
      payload: { customerId: String(customerId), customerName: "Aarav" },
      status: "pending",
      attempts: 0,
    };

    jest.spyOn(OutboxEvent, "findOne").mockResolvedValue(null);
    jest.spyOn(OutboxEvent, "create").mockResolvedValue(outboxDoc);

    const created = await createOutboxEvent({
      organizationId: orgId,
      branchId,
      eventType: "customer.created",
      idempotencyKey: "customer.created:1",
      payload: { customerId: String(customerId), customerName: "Aarav" },
    });
    expect(created.created).toBe(true);

    // Relay claims & publishes to notificationQueue
    jest.spyOn(OutboxEvent, "updateMany").mockResolvedValue({ modifiedCount: 0 });
    jest
      .spyOn(OutboxEvent, "findOneAndUpdate")
      .mockResolvedValueOnce({ ...outboxDoc, status: "processing", claimedBy: "relay-1", attempts: 1 })
      .mockResolvedValueOnce(null);
    jest.spyOn(OutboxEvent, "updateOne").mockResolvedValue({ modifiedCount: 1 });

    const relayRes = await runOutboxRelayCycle({ workerId: "relay-1" });
    expect(relayRes.publishedCount).toBe(1);
    expect(mockNotificationAdd).toHaveBeenCalledTimes(1);

    const [, notificationJobData] = mockNotificationAdd.mock.calls[0];

    // Notification worker orchestrates outbox event
    const customerRecord = {
      _id: customerId,
      organizationId: orgId,
      name: "Aarav",
      email: "aarav@example.com",
      phone: "+919876543210",
      notificationPreferences: { email: true, sms: true, whatsapp: false, marketing: false },
    };
    jest.spyOn(Customer, "findOne").mockReturnValue({
      lean: async () => customerRecord,
      then: (resolve) => resolve(customerRecord),
    });

    const createdNotifications = [];
    jest.spyOn(Notification, "create").mockImplementation(async (doc) => {
      const saved = { ...doc, _id: new mongoose.Types.ObjectId() };
      createdNotifications.push(saved);
      return saved;
    });
    jest.spyOn(Notification, "updateOne").mockResolvedValue({ modifiedCount: 1 });

    const orchResults = await processNotificationJob({
      id: "notif-job-1",
      name: notificationJobData.eventType,
      data: notificationJobData,
    });

    expect(orchResults.some((r) => r.channel === "email" && r.status === "queued")).toBe(true);
    expect(orchResults.some((r) => r.channel === "sms" && r.status === "queued")).toBe(true);
    expect(mockEmailAdd).toHaveBeenCalledTimes(1);
    expect(mockSmsAdd).toHaveBeenCalledTimes(1);

    // Email & SMS workers process the enqueued jobs
    const [emailJobName, emailJobData] = mockEmailAdd.mock.calls[0];
    const [smsJobName, smsJobData] = mockSmsAdd.mock.calls[0];

    const emailNotif = createdNotifications.find((n) => n.channel === "email");
    const smsNotif = createdNotifications.find((n) => n.channel === "sms");

    jest.spyOn(Notification, "findOne").mockImplementation(({ notificationId }) => ({
      lean: async () =>
        notificationId === emailNotif.notificationId
          ? { ...emailNotif, status: "queued" }
          : { ...smsNotif, status: "queued" },
    }));
    jest.spyOn(Notification, "findOneAndUpdate").mockImplementation(async ({ _id }) =>
      String(_id) === String(emailNotif._id)
        ? { ...emailNotif, status: "processing" }
        : { ...smsNotif, status: "processing" },
    );

    const emailOk = await processOrchestratedNotificationJob(
      { id: "e1", name: emailJobName, data: emailJobData },
      "email",
    );
    const smsOk = await processOrchestratedNotificationJob(
      { id: "s1", name: smsJobName, data: smsJobData },
      "sms",
    );

    expect(emailOk).toBe(true);
    expect(smsOk).toBe(true);
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "aarav@example.com" }),
    );
    expect(mockSendSms).toHaveBeenCalledWith(
      expect.objectContaining({ phone: "+919876543210" }),
    );
  });

  it("marks notification failed and rethrows on provider error for BullMQ retry", async () => {
    const notifId = "notif-fail-1";
    const notifDoc = {
      _id: new mongoose.Types.ObjectId(),
      notificationId: notifId,
      organizationId: orgId,
      recipientType: "employee",
      recipientId: employeeId,
      channel: "email",
      status: "queued",
      metadata: { payslipId: "pay-1" },
    };

    jest.spyOn(Notification, "findOne").mockReturnValue({ lean: async () => notifDoc });
    jest.spyOn(Notification, "findOneAndUpdate").mockResolvedValue({ ...notifDoc, status: "processing" });
    const updateSpy = jest.spyOn(Notification, "updateOne").mockResolvedValue({ modifiedCount: 1 });
    jest.spyOn(User, "findOne").mockReturnValue({
      lean: async () => ({ _id: employeeId, email: "emp@example.com" }),
    });

    mockSendMail.mockRejectedValueOnce(new Error("SMTP connection timeout"));

    await expect(
      processOrchestratedNotificationJob(
        {
          id: "e-fail",
          name: "payroll.payslip_published",
          data: { notificationId: notifId, organizationId: String(orgId), recipientId: String(employeeId) },
        },
        "email",
      ),
    ).rejects.toThrow("SMTP connection timeout");

    expect(updateSpy).toHaveBeenCalledWith(
      { _id: notifDoc._id },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "failed",
          failureReason: "SMTP connection timeout",
        }),
      }),
    );
  });

  it("skips duplicate delivery when notification is already sent", async () => {
    jest.spyOn(Notification, "findOne").mockReturnValue({
      lean: async () => ({ notificationId: "notif-dup", status: "sent" }),
    });

    const res = await processOrchestratedNotificationJob(
      {
        id: "e-dup",
        name: "appointment.created",
        data: { notificationId: "notif-dup", organizationId: String(orgId) },
      },
      "email",
    );

    expect(res).toBe(true);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it.each([
    ["customer.created", "customer"],
    ["appointment.created", "customer"],
    ["invoice.payment_recorded", "customer"],
    ["payroll.payslip_published", "employee"],
  ])("processes representative event %s uniformly through the common pipeline", async (eventType, recipientType) => {
    const notifId = `notif-${eventType}`;
    const notifDoc = {
      _id: new mongoose.Types.ObjectId(),
      notificationId: notifId,
      organizationId: orgId,
      recipientType,
      recipientId: recipientType === "employee" ? employeeId : customerId,
      channel: "email",
      status: "queued",
      metadata: { customerName: "Aarav", appointmentCode: "APT-1", invoiceNumber: "INV-1", payslipId: "PAY-1" },
    };

    jest.spyOn(Notification, "findOne").mockReturnValue({ lean: async () => notifDoc });
    jest.spyOn(Notification, "findOneAndUpdate").mockResolvedValue({ ...notifDoc, status: "processing" });
    jest.spyOn(Notification, "updateOne").mockResolvedValue({ modifiedCount: 1 });
    jest.spyOn(Customer, "findOne").mockReturnValue({
      lean: async () => ({ _id: customerId, email: "cust@example.com" }),
    });
    jest.spyOn(User, "findOne").mockReturnValue({
      lean: async () => ({ _id: employeeId, email: "emp@example.com" }),
    });

    const ok = await processOrchestratedNotificationJob(
      {
        id: `job-${eventType}`,
        name: eventType,
        data: { notificationId: notifId, organizationId: String(orgId), recipientId: String(notifDoc.recipientId) },
      },
      "email",
    );

    expect(ok).toBe(true);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  it("starts and stops outbox relay cleanly without overlapping or duplicate timers", async () => {
    startOutboxRelay({ intervalMs: 60000 });
    startOutboxRelay({ intervalMs: 60000 }); // Idempotent second call
    await stopOutboxRelay();
  });

  it("skips worker startup in Jest mode and stops cleanly", async () => {
    startNotificationWorkers();
    await stopNotificationWorkers();
  });
});
