import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { VERIFIED_EVENT_TYPES } from "../../services/notifications/notificationEventContract.js";
import { resolveAndRenderNotificationTemplate } from "../../services/notifications/notificationTemplate.service.js";
import {
  resolveRecipientsForEvent,
  evaluateConsentAndChannel,
} from "../../services/notifications/recipientResolver.service.js";
import { NotificationTemplate } from "../../models/notifications/notificationTemplate.model.js";
import { OrganizationSettings } from "../../models/settings/organizationSettings.model.js";
import { Customer } from "../../models/customers/customer.model.js";
import { Appointment } from "../../models/appointments/appointment.model.js";
import { OutboxEvent } from "../../models/notifications/outboxEvent.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { recoverPendingAppointmentOutboxEvents } from "../../services/appointments/appointment.service.js";

describe("Appointment Lifecycle Notifications", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("includes appointment.created, appointment.rescheduled, and appointment.cancelled in VERIFIED_EVENT_TYPES", () => {
    for (const ev of [
      "appointment.created",
      "appointment.rescheduled",
      "appointment.cancelled",
    ]) {
      expect(VERIFIED_EVENT_TYPES).toContain(ev);
    }
  });

  it("renders built-in email and sms templates for appointment lifecycle events", async () => {
    const orgId = new mongoose.Types.ObjectId();
    jest.spyOn(OrganizationSettings, "findOne").mockReturnValue({
      lean: jest.fn().mockResolvedValue({ profile: { displayName: "GLAM SALOON" } }),
    });
    jest.spyOn(NotificationTemplate, "findOne").mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    });

    const created = await resolveAndRenderNotificationTemplate({
      organizationId: orgId,
      eventType: "appointment.created",
      channel: "email",
      variables: { customerName: "Asha", appointmentCode: "APT-101", startAt: "2026-11-28T10:00:00Z" },
    });
    expect(created.source).toBe("builtin_default");
    expect(created.body).toContain("APT-101");

    const rescheduled = await resolveAndRenderNotificationTemplate({
      organizationId: orgId,
      eventType: "appointment.rescheduled",
      channel: "sms",
      variables: { appointmentCode: "APT-101", startAt: "2026-11-29T11:00:00Z" },
    });
    expect(rescheduled.body).toContain("rescheduled");

    const cancelled = await resolveAndRenderNotificationTemplate({
      organizationId: orgId,
      eventType: "appointment.cancelled",
      channel: "sms",
      variables: { appointmentCode: "APT-101" },
    });
    expect(cancelled.body).toContain("cancelled");
  });

  it("resolves customer recipient within organization and enforces transactional consent/contact rules", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const customerId = new mongoose.Types.ObjectId();

    const findOneSpy = jest.spyOn(Customer, "findOne").mockResolvedValue({
      _id: customerId,
      name: "Asha",
      email: "asha@example.com",
      phone: "",
      doNotContact: true,
    });

    const targets = await resolveRecipientsForEvent({
      organizationId: orgId,
      eventType: "appointment.created",
      payload: { customerId: String(customerId) },
    });

    expect(targets).toHaveLength(1);
    expect(targets[0].purpose).toBe("transactional");
    expect(findOneSpy).toHaveBeenCalledWith({
      _id: String(customerId),
      organizationId: orgId,
      isDeleted: false,
    });

    const emailEligibility = evaluateConsentAndChannel({
      recipient: targets[0].recipient,
      purpose: "transactional",
      channel: "email",
    });
    expect(emailEligibility.eligible).toBe(true);

    const smsEligibility = evaluateConsentAndChannel({
      recipient: targets[0].recipient,
      purpose: "transactional",
      channel: "sms",
    });
    expect(smsEligibility.eligible).toBe(false);
    expect(smsEligibility.reason).toBe("Missing phone number");
  });

  it("recovers pending appointment outbox events and pulls them on success", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    const apptId = new mongoose.Types.ObjectId();
    const customerId = new mongoose.Types.ObjectId();

    jest.spyOn(Appointment, "find").mockReturnValue({
      select: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([
            {
              _id: apptId,
              organizationId: orgId,
              branchId,
              pendingOutboxEvents: [
                {
                  eventType: "appointment.created",
                  idempotencyKey: `appointment-created:${apptId}`,
                  branchId,
                  payload: {
                    appointmentId: String(apptId),
                    appointmentCode: "APT-101",
                    customerId: String(customerId),
                    startAt: "2026-11-28T10:00:00Z",
                  },
                },
              ],
            },
          ]),
        }),
      }),
    });
    jest.spyOn(Branch, "exists").mockResolvedValue(true);
    const outboxCreateSpy = jest.spyOn(OutboxEvent, "create").mockResolvedValue([{}]);
    const apptUpdateSpy = jest.spyOn(Appointment, "updateOne").mockResolvedValue({ modifiedCount: 1 });

    const res = await recoverPendingAppointmentOutboxEvents(orgId);

    expect(res.recovered).toBe(1);
    expect(outboxCreateSpy).toHaveBeenCalledTimes(1);
    expect(apptUpdateSpy).toHaveBeenCalledWith(
      { _id: apptId, organizationId: orgId },
      { $pull: { pendingOutboxEvents: { idempotencyKey: `appointment-created:${apptId}` } } },
    );
  });
});
