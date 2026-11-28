import { EmailService } from "./email.service.js";
import { SmsService } from "./sms.service.js";
import { Notification } from "../../models/notifications/notification.model.js";
import { redactSensitiveText } from "./notificationEventContract.js";
import { resolveAndRenderNotificationTemplate } from "./notificationTemplate.service.js";

const emailService = new EmailService();
const smsService = new SmsService();

export async function sendViaEmailAdapter({ to, subject, html, text }) {
  const info = await emailService.sendMail({ to, subject, html, text });
  return {
    accepted: true,
    provider: "nodemailer",
    messageId: info?.messageId || null,
    devMode: Boolean(info?.devMode),
  };
}

export async function sendViaSmsAdapter({ phone, message, templateId }) {
  const res = await smsService.sendSms({ phone, message, templateId });
  return {
    accepted: true,
    provider: "autobysms",
    devMode: Boolean(res?.devMode),
  };
}

/**
 * Executes a notification delivery atomically through its Notification record.
 * Transitions: queued/pending -> processing -> sent (or failed).
 * Never sets `delivered` without genuine provider delivery evidence.
 */
export async function dispatchNotificationJob(notificationId, dispatchFn) {
  const notification = await Notification.findOneAndUpdate(
    {
      notificationId,
      status: { $in: ["queued", "pending"] },
    },
    { $set: { status: "processing" } },
    { returnDocument: 'after' },
  );

  if (!notification) {
    return { skipped: true, notificationId };
  }

  try {
    const result = await dispatchFn(notification);
    await Notification.updateOne(
      { _id: notification._id, status: "processing" },
      {
        $set: {
          status: "sent",
          sentAt: new Date(),
          failureReason: null,
        },
      },
    );
    return { skipped: false, status: "sent", notificationId, result };
  } catch (err) {
    await Notification.updateOne(
      { _id: notification._id, status: "processing" },
      {
        $set: {
          status: "failed",
          failureReason: redactSensitiveText(err?.message || "Provider dispatch failed"),
        },
      },
    );
    throw err;
  }
}

/**
 * Renders notification content using trusted persisted Notification context
 * and dispatches via the appropriate channel adapter.
 */
export async function dispatchRenderedNotification(
  notificationId,
  { to = null, phone = null, variables = {}, fallbackSubject = "", fallbackText = "" } = {},
) {
  return dispatchNotificationJob(notificationId, async (notification) => {
    let rendered = { subject: "", body: "", source: "none" };
    try {
      rendered = await resolveAndRenderNotificationTemplate({
        organizationId: notification.organizationId,
        eventType: notification.eventType,
        channel: notification.channel,
        variables,
      });
    } catch {
      rendered = { subject: "", body: "", source: "none" };
    }

    const subject = rendered.subject || fallbackSubject;
    const body = rendered.body || fallbackText;
    if (!body) {
      throw new Error("No rendered or fallback notification body available");
    }

    if (notification.channel === "email") {
      return sendViaEmailAdapter({ to, subject, html: body, text: body });
    }
    if (notification.channel === "sms") {
      return sendViaSmsAdapter({ phone, message: body });
    }
    throw new Error(`Unsupported dispatch channel: ${notification.channel}`);
  });
}
