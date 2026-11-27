import { jest } from "@jest/globals";
import { VERIFIED_EVENT_TYPES } from "../../services/notifications/notificationEventContract.js";

jest.unstable_mockModule("../../models/notifications/notificationTemplate.model.js", () => ({
  NotificationTemplate: {
    findOne: jest.fn().mockImplementation(() => {
      const q = Promise.resolve(null);
      q.lean = jest.fn().mockResolvedValue(null);
      q.exec = jest.fn().mockResolvedValue(null);
      return q;
    }),
  },
}));

const { resolveAndRenderNotificationTemplate } = await import(
  "../../services/notifications/notificationTemplate.service.js"
);

const EMAIL_ONLY_EVENTS = new Set([
  "expense.submitted",
  "expense.approved",
  "expense.rejected",
]);

const SAMPLE_VARIABLES = {
  brandName: "Glamour Studio",
  customerName: "Ananya",
  staffName: "Asha Rao",
  appointmentCode: "APT-1001",
  appointmentDate: "2026-12-01",
  appointmentTime: "11:00 AM",
  branchName: "Indiranagar",
  invoiceNumber: "INV-2026-01",
  poNumber: "PO-2026-01",
  grnNumber: "GRN-001",
  supplierName: "Loreal Pro",
  itemName: "Hair Serum",
  stockDomain: "Retail Products",
  quantity: 3,
  reorderPoint: 5,
  couponCode: "SAVE20",
  points: 50,
  balanceAfter: 150,
  portalUrl: "https://erp.example.com/portal",
  businessDate: "2026-11-27",
  reconciliationResult: "balanced",
};

describe("Release Verification: 45-Event Built-in Template Coverage", () => {
  it("verifies all 45 VERIFIED_EVENT_TYPES have complete applicable built-in email and SMS templates", async () => {
    expect(VERIFIED_EVENT_TYPES.length).toBe(45);

    let emailCount = 0;
    let smsCount = 0;

    for (const eventType of VERIFIED_EVENT_TYPES) {
      const emailRendered = await resolveAndRenderNotificationTemplate({
        organizationId: null,
        eventType,
        channel: "email",
        variables: SAMPLE_VARIABLES,
        brand: { brandName: "Glamour Studio" },
      });
      expect(emailRendered.source).toBe("builtin_default");
      expect(emailRendered.subject).toBeTruthy();
      expect(emailRendered.body).toBeTruthy();
      expect(emailRendered.body).not.toMatch(/\{\{.*?\}\}|undefined|null/);
      emailCount++;

      if (!EMAIL_ONLY_EVENTS.has(eventType)) {
        const smsRendered = await resolveAndRenderNotificationTemplate({
          organizationId: null,
          eventType,
          channel: "sms",
          variables: SAMPLE_VARIABLES,
          brand: { brandName: "Glamour Studio" },
        });
        expect(["builtin_default", "none"]).toContain(smsRendered.source);
        if (smsRendered.source === "builtin_default") {
          expect(smsRendered.body).toBeTruthy();
          expect(smsRendered.body).not.toMatch(/\{\{.*?\}\}|undefined|null/);
          smsCount++;
        }
      }
    }

    expect(emailCount).toBe(45);
    expect(smsCount).toBe(39);
  });
});
