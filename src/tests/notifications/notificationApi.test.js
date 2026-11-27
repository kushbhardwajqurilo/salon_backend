import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { Notification } from "../../models/notifications/notification.model.js";
import { NotificationTemplate } from "../../models/notifications/notificationTemplate.model.js";
import { NotificationAutomation } from "../../models/notifications/notificationAutomation.model.js";
import {
  listNotifications,
  upsertOrgTemplate,
  createAutomationHandler,
} from "../../controllers/notifications/notification.controller.js";

describe("Stage 3A — Notifications & Automation API Controller", () => {
  const orgId = new mongoose.Types.ObjectId();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("caps pagination at 50 and strips payroll metadata in listNotifications", async () => {
    const chain = {
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        { _id: "n1", purpose: "payroll", metadata: { secret: 123 } },
      ]),
    };
    jest.spyOn(Notification, "find").mockReturnValue(chain);
    jest.spyOn(Notification, "countDocuments").mockResolvedValue(1);

    const req = { organizationId: orgId, query: { limit: "500", page: "1" } };
    const res = { json: jest.fn() };
    const next = jest.fn();

    await listNotifications(req, res, next);

    expect(chain.limit).toHaveBeenCalledWith(50);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [{ _id: "n1", purpose: "payroll", metadata: { portalLinkOnly: true } }],
      }),
    );
  });

  it("rejects sensitive/payroll variables in upsertOrgTemplate", async () => {
    const req = {
      organizationId: orgId,
      body: {
        eventType: "payroll.payslip_published",
        channel: "email",
        purpose: "payroll",
        body: "Pay {{netPay}}",
        allowedVariables: ["netPay"],
      },
    };
    const res = { json: jest.fn() };
    const next = jest.fn();

    await upsertOrgTemplate(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it("ignores client-supplied organizationId in createAutomationHandler", async () => {
    const req = {
      organizationId: orgId,
      user: { id: new mongoose.Types.ObjectId() },
      body: {
        organizationId: new mongoose.Types.ObjectId(), // untrusted
        name: "Test",
        triggerType: "event",
        eventType: "invoice.settled",
        channel: "sms",
        purpose: "transactional",
      },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();

    const createSpy = jest
      .spyOn(NotificationAutomation, "create")
      .mockImplementation(async (doc) => ({ ...doc, _id: new mongoose.Types.ObjectId() }));
    await createAutomationHandler(req, res, next);
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ organizationId: orgId }));
  });
});
