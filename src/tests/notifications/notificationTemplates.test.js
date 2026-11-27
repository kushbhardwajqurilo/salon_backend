import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { NotificationTemplate } from "../../models/notifications/notificationTemplate.model.js";
import { OrganizationSettings } from "../../models/settings/organizationSettings.model.js";
import {
  renderTemplateString,
  resolveAndRenderNotificationTemplate,
} from "../../services/notifications/notificationTemplate.service.js";

describe("Stage 2H — Notification Templates & Branding Foundation", () => {
  const orgId = new mongoose.Types.ObjectId();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("uses org override when active and falls back to builtin default when absent", async () => {
    jest.spyOn(OrganizationSettings, "findOne").mockReturnValue({
      lean: jest.fn().mockResolvedValue({ businessName: "Luxe Salon" }),
    });

    // 1. Org override present
    jest.spyOn(NotificationTemplate, "findOne").mockReturnValueOnce({
      lean: jest.fn().mockResolvedValue({
        subject: "Custom {{brandName}}",
        body: "Hi {{appointmentCode}}",
        allowedVariables: ["brandName", "appointmentCode"],
      }),
    });

    const overrideRes = await resolveAndRenderNotificationTemplate({
      organizationId: orgId,
      eventType: "appointment.reminder_due",
      channel: "email",
      variables: { appointmentCode: "APT-10" },
    });
    expect(overrideRes.source).toBe("org_override");
    expect(overrideRes.subject).toBe("Custom Luxe Salon");
    expect(overrideRes.body).toContain("Hi APT-10");
    expect(overrideRes.body).toContain("<!DOCTYPE html>");

    // 2. No org override & no global default -> builtin_default
    jest.spyOn(NotificationTemplate, "findOne")
      .mockReturnValueOnce({ lean: jest.fn().mockResolvedValue(null) })
      .mockReturnValueOnce({ lean: jest.fn().mockResolvedValue(null) });

    const fallbackRes = await resolveAndRenderNotificationTemplate({
      organizationId: orgId,
      eventType: "appointment.reminder_due",
      channel: "sms",
      variables: { appointmentCode: "APT-10", startAt: "10:00 AM" },
    });
    expect(fallbackRes.source).toBe("builtin_default");
    expect(fallbackRes.body).toContain("Luxe Salon");
    expect(fallbackRes.body).toContain("APT-10");
  });

  it("blocks non-allowlisted variables and escapes HTML/script injection for email", () => {
    const rendered = renderTemplateString(
      "Hello {{name}} {{unexpected}} {{salary}}",
      { name: "<script>alert(1)</script>", unexpected: "hack", salary: "99999" },
      ["name", "salary"],
      { escapeHtmlValues: true },
    );

    expect(rendered).toBe("Hello &lt;script&gt;alert(1)&lt;/script&gt;  ");
    expect(rendered).not.toContain("<script>");
    expect(rendered).not.toContain("99999");
  });

  it("strips confidential variables from payroll templates", async () => {
    jest.spyOn(OrganizationSettings, "findOne").mockReturnValue({
      lean: jest.fn().mockResolvedValue({ businessName: "Luxe Salon" }),
    });
    jest.spyOn(NotificationTemplate, "findOne")
      .mockReturnValueOnce({ lean: jest.fn().mockResolvedValue(null) })
      .mockReturnValueOnce({ lean: jest.fn().mockResolvedValue(null) });

    const res = await resolveAndRenderNotificationTemplate({
      organizationId: orgId,
      eventType: "payroll.payslip_published",
      channel: "email",
      variables: { netPay: 50000, salary: 50000 },
    });

    expect(res.source).toBe("builtin_default");
    expect(res.body).not.toContain("50000");
    expect(res.body).toContain("Luxe Salon");
    expect(res.body).toContain("portal");
  });
});
