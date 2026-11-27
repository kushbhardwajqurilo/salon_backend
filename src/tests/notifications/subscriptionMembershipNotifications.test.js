import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { VERIFIED_EVENT_TYPES } from "../../services/notifications/notificationEventContract.js";
import { resolveAndRenderNotificationTemplate } from "../../services/notifications/notificationTemplate.service.js";
import { resolveRecipientsForEvent } from "../../services/notifications/recipientResolver.service.js";
import { NotificationTemplate } from "../../models/notifications/notificationTemplate.model.js";
import { OrganizationSettings } from "../../models/settings/organizationSettings.model.js";
import { Customer } from "../../models/customers/customer.model.js";
import { OutboxEvent } from "../../models/notifications/outboxEvent.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { SubscriptionService } from "../../services/subscriptions/subscription.service.js";
import { smsQueue } from "../../queues/client.js";

describe("Subscription & Membership Notification Integration", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("includes all subscription and membership events in VERIFIED_EVENT_TYPES", () => {
    for (const ev of [
      "subscription.created",
      "subscription.redemption_otp",
      "subscription.redeemed",
      "membership.activated",
    ]) {
      expect(VERIFIED_EVENT_TYPES).toContain(ev);
    }
  });

  it("renders built-in templates for subscription and membership events", async () => {
    const orgId = new mongoose.Types.ObjectId();
    jest.spyOn(OrganizationSettings, "findOne").mockReturnValue({
      lean: jest.fn().mockResolvedValue({ profile: { displayName: "GLAM SALOON" } }),
    });
    jest.spyOn(NotificationTemplate, "findOne").mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    });

    const subRes = await resolveAndRenderNotificationTemplate({
      organizationId: orgId,
      eventType: "subscription.created",
      channel: "email",
      variables: { customerName: "Asha", planName: "SUB-001" },
    });
    expect(subRes.source).toBe("builtin_default");
    expect(subRes.body).toContain("Asha");

    const memRes = await resolveAndRenderNotificationTemplate({
      organizationId: orgId,
      eventType: "membership.activated",
      channel: "email",
      variables: { customerName: "Riya", planName: "Gold" },
    });
    expect(memRes.source).toBe("builtin_default");
    expect(memRes.body).toContain("Gold");
  });

  it("resolves customer recipients for subscription.* and membership.activated within organization", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const customerId = new mongoose.Types.ObjectId();

    const findOneSpy = jest.spyOn(Customer, "findOne").mockResolvedValue({
      _id: customerId,
      name: "Asha",
      email: "asha@example.com",
      phone: "9999999999",
    });

    const targets = await resolveRecipientsForEvent({
      organizationId: orgId,
      eventType: "membership.activated",
      payload: { payerCustomerId: String(customerId) },
    });

    expect(targets).toHaveLength(1);
    expect(targets[0].recipientType).toBe("payer");
    expect(targets[0].channels).toEqual(["sms", "email"]);
    expect(findOneSpy).toHaveBeenCalledWith({
      _id: String(customerId),
      organizationId: orgId,
      isDeleted: false,
    });
  });

  it("SubscriptionService.sendRedemptionOTP creates outbox event without leaking rawOtp and survives outbox failure", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const subId = new mongoose.Types.ObjectId();
    const customerId = new mongoose.Types.ObjectId();

    const subRepo = {
      findOne: jest.fn().mockResolvedValue({
        _id: subId,
        status: "active",
        endDate: new Date(Date.now() + 86400000),
        customerId,
        redemptionOtpSentAt: null,
        save: jest.fn().mockResolvedValue(true),
      }),
    };
    const customerRepo = {
      findById: jest.fn().mockResolvedValue({
        _id: customerId,
        name: "Asha",
        phone: "9999999999",
        isDeleted: false,
        status: "active",
        save: jest.fn().mockResolvedValue(true),
      }),
    };
    const auditRepo = { create: jest.fn().mockResolvedValue(true) };

    const service = new SubscriptionService(subRepo, null, customerRepo, null, null, auditRepo);
    jest.spyOn(smsQueue, "add").mockResolvedValue({ id: "job-1" });
    jest.spyOn(Branch, "exists").mockResolvedValue(true);
    const outboxSpy = jest.spyOn(OutboxEvent, "create").mockRejectedValue(new Error("Outbox down"));

    const res = await service.sendRedemptionOTP(subId, branchId, orgId, userId);

    expect(res.success).toBe(true);
    expect(outboxSpy).toHaveBeenCalledTimes(1);
    const doc = outboxSpy.mock.calls[0][0];
    expect(doc.eventType).toBe("subscription.redemption_otp");
    expect(doc.payload.otp).toBeUndefined();
    expect(doc.payload.rawOtp).toBeUndefined();
  });
});
