import { jest } from "@jest/globals";
import mongoose from "mongoose";

import { VERIFIED_EVENT_TYPES } from "../../services/notifications/notificationEventContract.js";
import { resolveAndRenderNotificationTemplate } from "../../services/notifications/notificationTemplate.service.js";
import { resolveRecipientsForEvent } from "../../services/notifications/recipientResolver.service.js";
import { OrganizationSettings } from "../../models/settings/organizationSettings.model.js";
import { NotificationTemplate } from "../../models/notifications/notificationTemplate.model.js";
import { Customer } from "../../models/customers/customer.model.js";
import { OutboxEvent } from "../../models/notifications/outboxEvent.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import {
  emitCouponRedeemedOutboxEvent,
  emitCouponUsageLimitExhaustedOutboxEvent,
} from "../../services/coupons/couponNotificationOutbox.service.js";

describe("Coupon Notification Integration", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("registers only verified coupon lifecycle event types", () => {
    expect(VERIFIED_EVENT_TYPES).toContain("coupon.redeemed");
    expect(VERIFIED_EVENT_TYPES).toContain("coupon.usage_limit_exhausted");
  });

  it("renders transactional coupon redemption templates without sensitive fields", async () => {
    const orgId = new mongoose.Types.ObjectId();
    jest.spyOn(OrganizationSettings, "findOne").mockReturnValue({
      lean: jest.fn().mockResolvedValue({ profile: { displayName: "GLAM SALOON" } }),
    });
    jest.spyOn(NotificationTemplate, "findOne").mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    });

    const result = await resolveAndRenderNotificationTemplate({
      organizationId: orgId,
      eventType: "coupon.redeemed",
      channel: "email",
      variables: {
        customerName: "Asha",
        couponCode: "SAVE20",
        invoiceNumber: "INV-100",
        otp: "123456",
        salary: 50000,
      },
    });

    expect(result.source).toBe("builtin_default");
    expect(result.body).toContain("SAVE20");
    expect(result.body).toContain("INV-100");
    expect(result.body).not.toContain("123456");
    expect(result.body).not.toContain("50000");
  });

  it("resolves coupon redemption recipients within organization scope", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const customerId = new mongoose.Types.ObjectId();
    const findOneSpy = jest.spyOn(Customer, "findOne").mockResolvedValue({
      _id: customerId,
      name: "Asha",
      email: "asha@example.com",
      phone: "9999999999",
      doNotContact: false,
      marketingPreferences: {},
    });

    const targets = await resolveRecipientsForEvent({
      organizationId: orgId,
      branchId: new mongoose.Types.ObjectId(),
      eventType: "coupon.redeemed",
      payload: { customerId: String(customerId) },
    });

    expect(targets).toHaveLength(1);
    expect(targets[0].recipientType).toBe("customer");
    expect(targets[0].purpose).toBe("transactional");
    expect(targets[0].channels).toEqual(["sms", "email"]);
    expect(findOneSpy).toHaveBeenCalledWith({
      _id: String(customerId),
      organizationId: orgId,
      isDeleted: false,
    });
  });

  it("coupon redemption producer emits stable payload and session", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    const customerId = new mongoose.Types.ObjectId();
    const invoiceId = new mongoose.Types.ObjectId();
    const couponId = new mongoose.Types.ObjectId();
    const usageLedgerId = new mongoose.Types.ObjectId();
    const session = { id: "coupon-finalize-session" };

    jest.spyOn(Branch, "exists").mockReturnValue({
      session: jest.fn().mockResolvedValue({ _id: branchId }),
    });
    const createSpy = jest.spyOn(OutboxEvent, "create").mockImplementation(async (docs) => [
      { ...docs[0], _id: new mongoose.Types.ObjectId() },
    ]);

    await emitCouponRedeemedOutboxEvent({
      invoice: {
        _id: invoiceId,
        organizationId: orgId,
        branchId,
        customerId,
        invoiceNumber: "INV-100",
      },
      coupon: { _id: couponId, code: "SAVE20" },
      usageLedgerId,
      session,
    });

    expect(createSpy).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          organizationId: orgId,
          branchId,
          eventType: "coupon.redeemed",
          idempotencyKey: `coupon-redeemed:${usageLedgerId}`,
          payload: expect.objectContaining({
            customerId: String(customerId),
            invoiceId: String(invoiceId),
            couponId: String(couponId),
            couponCode: "SAVE20",
          }),
        }),
      ]),
      { session },
    );
  });

  it("usage-limit producer is stable and does not expose discount or financial fields", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    const couponId = new mongoose.Types.ObjectId();
    const createSpy = jest.spyOn(OutboxEvent, "create").mockImplementation(async (docs) => [
      { ...docs[0], _id: new mongoose.Types.ObjectId() },
    ]);

    await emitCouponUsageLimitExhaustedOutboxEvent({
      coupon: { _id: couponId, code: "SAVE20", totalUsageLimit: 10 },
      organizationId: orgId,
      branchId,
      session: { id: "usage-limit-session" },
    });

    const doc = createSpy.mock.calls[0][0][0];
    expect(doc.idempotencyKey).toBe(`coupon-usage-limit-exhausted:${couponId}`);
    expect(doc.payload).toEqual({
      couponId: String(couponId),
      couponCode: "SAVE20",
      usageLimit: 10,
    });
  });

  it("preserves business operation when outbox creation fails", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const invoiceId = new mongoose.Types.ObjectId();
    const couponId = new mongoose.Types.ObjectId();

    jest.spyOn(OutboxEvent, "create").mockRejectedValue(new Error("Outbox down"));

    await expect(
      emitCouponRedeemedOutboxEvent({
        invoice: {
          _id: invoiceId,
          organizationId: orgId,
          branchId: null,
          customerId: new mongoose.Types.ObjectId(),
        },
        coupon: { _id: couponId, code: "SAVE20" },
        usageLedgerId: new mongoose.Types.ObjectId(),
        session: null,
      }),
    ).resolves.toBeNull();
  });
});
