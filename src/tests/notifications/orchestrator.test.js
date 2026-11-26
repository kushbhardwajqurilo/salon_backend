import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { Notification } from "../../models/notifications/notification.model.js";
import { Customer } from "../../models/customers/customer.model.js";
import { User } from "../../models/users/user.model.js";
import { emailQueue, smsQueue } from "../../queues/client.js";
import { orchestrateOutboxEvent } from "../../services/notifications/notificationOrchestrator.service.js";
import { evaluateConsentAndChannel } from "../../services/notifications/recipientResolver.service.js";

describe("Notification Orchestration Foundation (Stage 2C)", () => {
  const orgId = new mongoose.Types.ObjectId();
  const payerId = new mongoose.Types.ObjectId();
  const beneficiaryId = new mongoose.Types.ObjectId();
  const empId = new mongoose.Types.ObjectId();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("distinguishes payer and beneficiary and enqueues sms/email as queued", async () => {
    jest.spyOn(Customer, "findOne")
      .mockResolvedValueOnce({ _id: payerId, phone: "+91111", email: "payer@test.com", doNotContact: false })
      .mockResolvedValueOnce({ _id: beneficiaryId, phone: "+91222", email: null, doNotContact: false });

    jest.spyOn(Notification, "create").mockImplementation(async (doc) => ({ ...doc, _id: new mongoose.Types.ObjectId() }));
    jest.spyOn(Notification, "updateOne").mockResolvedValue({ modifiedCount: 1 });
    jest.spyOn(smsQueue, "add").mockResolvedValue({ id: "sms-1" });
    jest.spyOn(emailQueue, "add").mockResolvedValue({ id: "email-1" });

    const results = await orchestrateOutboxEvent({
      eventId: "evt-1",
      organizationId: orgId,
      eventType: "invoice.settled",
      payload: { payerCustomerId: payerId, beneficiaryCustomerId: beneficiaryId },
    });

    expect(results.filter((r) => r.status === "queued")).toHaveLength(3); // payer sms+email, beneficiary sms
    expect(results.some((r) => r.status === "skipped" && r.reason === "Missing email address")).toBe(true);
  });

  it("enforces doNotContact for reminders and marketing", () => {
    const optedOut = { phone: "+91111", email: "a@b.com", doNotContact: true, marketingPreferences: { promotions: true, sms: true } };
    expect(evaluateConsentAndChannel({ recipient: optedOut, purpose: "reminder", channel: "sms" }).eligible).toBe(false);
    expect(evaluateConsentAndChannel({ recipient: optedOut, purpose: "marketing", channel: "sms" }).eligible).toBe(false);
    expect(evaluateConsentAndChannel({ recipient: optedOut, purpose: "transactional", channel: "sms" }).eligible).toBe(true);
  });

  it("prevents duplicate Notification records on relay retry (11000)", async () => {
    jest.spyOn(Customer, "findOne").mockResolvedValue({ _id: payerId, phone: "+91111", doNotContact: false });
    jest.spyOn(Notification, "create").mockRejectedValue({ code: 11000 });
    jest.spyOn(Notification, "findOne").mockResolvedValue({ _id: "n-1", status: "queued" });

    const results = await orchestrateOutboxEvent({
      eventId: "evt-dup",
      organizationId: orgId,
      eventType: "invoice.settled",
      payload: { customerId: payerId },
    });

    expect(results).toEqual([
      { recipientId: payerId, channel: "sms", status: "duplicate" },
      { recipientId: payerId, channel: "email", status: "skipped", reason: "Missing email address" },
    ]);
  });

  it("strips sensitive payroll metadata and uses portalLinkOnly", async () => {
    jest.spyOn(User, "findOne").mockResolvedValue({ _id: empId, email: "emp@salon.com", isActive: true });
    const createSpy = jest.spyOn(Notification, "create").mockImplementation(async (doc) => ({ ...doc, _id: new mongoose.Types.ObjectId() }));
    jest.spyOn(Notification, "updateOne").mockResolvedValue({ modifiedCount: 1 });
    jest.spyOn(emailQueue, "add").mockResolvedValue({ id: "email-pay" });

    await orchestrateOutboxEvent({
      eventId: "evt-pay",
      organizationId: orgId,
      eventType: "payroll.payslip_published",
      payload: { employeeUserId: empId, payslipId: "ps-1" },
    });

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "payroll",
        metadata: { portalLinkOnly: true, payslipId: "ps-1" },
      }),
    );
  });

  it("marks notification failed when queue enqueue fails", async () => {
    jest.spyOn(Customer, "findOne").mockResolvedValue({ _id: payerId, phone: "+91111", doNotContact: false });
    jest.spyOn(Notification, "create").mockImplementation(async (doc) => ({ ...doc, _id: new mongoose.Types.ObjectId() }));
    const updateSpy = jest.spyOn(Notification, "updateOne").mockResolvedValue({ modifiedCount: 1 });
    jest.spyOn(smsQueue, "add").mockRejectedValue(new Error("Redis unavailable"));

    const results = await orchestrateOutboxEvent({
      eventId: "evt-fail",
      organizationId: orgId,
      eventType: "invoice.settled",
      payload: { customerId: payerId },
    });

    expect(results[0].status).toBe("failed");
    expect(updateSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ $set: expect.objectContaining({ status: "failed" }) }),
    );
  });
});
