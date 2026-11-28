import { NotificationAutomation } from "../../models/notifications/notificationAutomation.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { notificationQueue } from "../../queues/client.js";
import { createOutboxEvent } from "./outbox.service.js";

const CRON_REGEX = /^(\*|[0-9,\-/*]+)\s+(\*|[0-9,\-/*]+)\s+(\*|[0-9,\-/*]+)\s+(\*|[0-9,\-/*]+)\s+(\*|[0-9,\-/*]+)$/;

export async function createAutomation(input, { organizationId, userId = null }) {
  if (!organizationId) {
    throw new Error("organizationId is required");
  }
  if (input.branchId) {
    const branchExists = await Branch.exists({
      _id: input.branchId,
      organizationId,
      isActive: true,
    });
    if (!branchExists) {
      throw new Error("Active branch not found for organization");
    }
  }
  if (input.triggerType === "schedule") {
    if (!input.scheduleCron || !CRON_REGEX.test(input.scheduleCron.trim())) {
      throw new Error("Valid 5-field scheduleCron is required for scheduled automations");
    }
  }

  const doc = await NotificationAutomation.create({
    ...input,
    organizationId,
    createdBy: userId,
    updatedBy: userId,
  });

  if (doc.triggerType === "schedule" && doc.isEnabled) {
    await notificationQueue.add(
      "automation.scheduled_run",
      {
        automationId: String(doc._id),
        organizationId: String(organizationId),
        branchId: doc.branchId ? String(doc.branchId) : null,
      },
      {
        jobId: `automation:${doc._id}`,
        repeat: { pattern: doc.scheduleCron },
      },
    );
  }

  return doc;
}

export async function registerAutomationSchedule(automation) {
  if (automation.triggerType !== "schedule" || !automation.isEnabled) return false;
  await notificationQueue.add(
    "automation.scheduled_run",
    {
      automationId: String(automation._id),
      organizationId: String(automation.organizationId),
      branchId: automation.branchId ? String(automation.branchId) : null,
    },
    {
      jobId: `automation:${automation._id}`,
      repeat: {
        pattern: automation.scheduleCron,
        ...(automation.timezone ? { tz: automation.timezone } : {}),
      },
    },
  );
  return true;
}

export async function removeAutomationSchedule(automationId) {
  if (typeof notificationQueue.removeJobScheduler === "function") {
    await notificationQueue.removeJobScheduler(`automation:${automationId}`);
  }
}

export async function setAutomationEnabled(automationId, isEnabled, { organizationId, userId = null }) {
  const updated = await NotificationAutomation.findOneAndUpdate(
    { _id: automationId, organizationId },
    { $set: { isEnabled: Boolean(isEnabled), updatedBy: userId } },
    { returnDocument: 'after' },
  );
  if (!updated) {
    throw new Error("Automation not found");
  }
  if (updated.triggerType === "schedule") {
    if (updated.isEnabled) {
      await registerAutomationSchedule(updated);
    } else {
      await removeAutomationSchedule(updated._id);
    }
  }
  return updated;
}

export async function updateAutomationSchedule(
  automationId,
  { scheduleCron },
  { organizationId, userId = null },
) {
  if (!scheduleCron || !CRON_REGEX.test(scheduleCron.trim())) {
    throw new Error("Valid 5-field scheduleCron is required");
  }
  const updated = await NotificationAutomation.findOneAndUpdate(
    { _id: automationId, organizationId, triggerType: "schedule" },
    { $set: { scheduleCron: scheduleCron.trim(), updatedBy: userId } },
    { returnDocument: 'after' },
  );
  if (!updated) {
    throw new Error("Scheduled automation not found");
  }
  await removeAutomationSchedule(updated._id);
  if (updated.isEnabled) {
    await registerAutomationSchedule(updated);
  }
  return updated;
}

export async function deleteAutomation(automationId, { organizationId }) {
  const deleted = await NotificationAutomation.findOneAndDelete({
    _id: automationId,
    organizationId,
  });
  if (!deleted) {
    throw new Error("Automation not found");
  }
  if (deleted.triggerType === "schedule") {
    await removeAutomationSchedule(deleted._id);
  }
  return deleted;
}

/**
 * Executes a scheduled automation by routing it through the OutboxEvent
 * foundation (preserving consent, doNotContact, and payroll confidentiality).
 */
export async function executeScheduledAutomation(automationId, { organizationId, runKey }) {
  if (!runKey) {
    throw new Error("runKey is required for deterministic automation idempotency");
  }
  const automation = await NotificationAutomation.findOne({
    _id: automationId,
    organizationId,
    isEnabled: true,
  });
  if (!automation) {
    return { skipped: true, reason: "Automation disabled or not found" };
  }

  return createOutboxEvent(
    {
      organizationId,
      branchId: automation.branchId ?? null,
      eventType: automation.eventType,
      idempotencyKey: `automation:${automation._id}:${runKey}`,
      payload: {
        automationId: String(automation._id),
        purpose: automation.purpose,
      },
    },
    { validateBranch: false },
  );
}
