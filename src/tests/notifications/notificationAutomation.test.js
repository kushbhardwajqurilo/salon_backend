import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { NotificationAutomation } from "../../models/notifications/notificationAutomation.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { OutboxEvent } from "../../models/notifications/outboxEvent.model.js";
import { notificationQueue } from "../../queues/client.js";
import {
  createAutomation,
  setAutomationEnabled,
  updateAutomationSchedule,
  deleteAutomation,
  executeScheduledAutomation,
} from "../../services/notifications/notificationAutomation.service.js";

describe("Stage 2I — Automation & Scheduling Backend Foundation", () => {
  const orgId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const autoId = new mongoose.Types.ObjectId();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("validates branch ownership and schedules repeatable job with deterministic jobId", async () => {
    jest.spyOn(Branch, "exists").mockResolvedValue({ _id: branchId });
    jest.spyOn(NotificationAutomation, "create").mockResolvedValue({
      _id: autoId,
      organizationId: orgId,
      branchId,
      triggerType: "schedule",
      scheduleCron: "0 9 * * *",
      isEnabled: true,
    });
    const queueSpy = jest.spyOn(notificationQueue, "add").mockResolvedValue({ id: `automation:${autoId}` });

    const doc = await createAutomation(
      {
        name: "Daily Summary",
        triggerType: "schedule",
        eventType: "appointment.reminder_due",
        scheduleCron: "0 9 * * *",
        channel: "email",
        purpose: "operational",
        branchId,
      },
      { organizationId: orgId, userId },
    );

    expect(doc._id).toEqual(autoId);
    expect(queueSpy).toHaveBeenCalledWith(
      "automation.scheduled_run",
      expect.objectContaining({ automationId: String(autoId), organizationId: String(orgId) }),
      expect.objectContaining({ jobId: `automation:${autoId}` }),
    );
  });

  it("pauses/resumes automation scoped by organizationId and routes execution through OutboxEvent", async () => {
    jest.spyOn(NotificationAutomation, "findOneAndUpdate").mockResolvedValue({ _id: autoId, isEnabled: false });
    const paused = await setAutomationEnabled(autoId, false, { organizationId: orgId, userId });
    expect(paused.isEnabled).toBe(false);

    jest.spyOn(NotificationAutomation, "findOne").mockResolvedValue({
      _id: autoId,
      organizationId: orgId,
      branchId,
      eventType: "appointment.reminder_due",
      purpose: "reminder",
      isEnabled: true,
    });
    const outboxSpy = jest
      .spyOn(OutboxEvent, "create")
      .mockImplementation(async (doc) => ({ ...doc, _id: new mongoose.Types.ObjectId() }));

    const res = await executeScheduledAutomation(autoId, { organizationId: orgId, runKey: "2026-11-26" });
    expect(res.created).toBe(true);
    expect(outboxSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `automation:${autoId}:2026-11-26`,
        organizationId: orgId,
      }),
    );
  });

  it("reschedules, pauses, and deletes automation schedules cleanly", async () => {
    const removeSpy = jest.spyOn(notificationQueue, "removeJobScheduler").mockResolvedValue(true);
    const addSpy = jest.spyOn(notificationQueue, "add").mockResolvedValue({ id: `automation:${autoId}` });

    jest.spyOn(NotificationAutomation, "findOneAndUpdate").mockResolvedValueOnce({
      _id: autoId,
      organizationId: orgId,
      triggerType: "schedule",
      scheduleCron: "0 10 * * *",
      isEnabled: true,
    });
    await updateAutomationSchedule(autoId, { scheduleCron: "0 10 * * *" }, { organizationId: orgId, userId });
    expect(removeSpy).toHaveBeenCalledWith(`automation:${autoId}`);
    expect(addSpy).toHaveBeenCalledTimes(1);

    jest.spyOn(NotificationAutomation, "findOneAndDelete").mockResolvedValueOnce({
      _id: autoId,
      organizationId: orgId,
      triggerType: "schedule",
    });
    await deleteAutomation(autoId, { organizationId: orgId });
    expect(removeSpy).toHaveBeenCalledTimes(2);
  });
});
