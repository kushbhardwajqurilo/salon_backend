import { asyncHandler, AppError } from "../../utils/errors.js";
import { Notification } from "../../models/notifications/notification.model.js";
import { NotificationTemplate } from "../../models/notifications/notificationTemplate.model.js";
import { NotificationAutomation } from "../../models/notifications/notificationAutomation.model.js";
import { SENSITIVE_PAYLOAD_KEYS } from "../../services/notifications/notificationEventContract.js";
import { resolveAndRenderNotificationTemplate } from "../../services/notifications/notificationTemplate.service.js";
import {
  createAutomation,
  setAutomationEnabled,
  updateAutomationSchedule,
  deleteAutomation,
} from "../../services/notifications/notificationAutomation.service.js";

export const listNotifications = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const filter = { organizationId: req.organizationId };

  if (req.branchId) filter.branchId = req.branchId;
  if (req.query.channel) filter.channel = String(req.query.channel);
  if (req.query.status) filter.status = String(req.query.status);
  if (req.query.purpose) filter.purpose = String(req.query.purpose);

  const [items, total] = await Promise.all([
    Notification.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select("-failureReason")
      .lean(),
    Notification.countDocuments(filter),
  ]);

  const sanitized = items.map((n) => ({
    ...n,
    metadata: n.purpose === "payroll" ? { portalLinkOnly: true } : n.metadata,
  }));

  res.json({ success: true, data: sanitized, pagination: { page, limit, total } });
});

export const getNotificationById = asyncHandler(async (req, res) => {
  const filter = { _id: req.params.id, organizationId: req.organizationId };
  if (req.branchId) filter.branchId = req.branchId;

  const doc = await Notification.findOne(filter).select("-failureReason").lean();
  if (!doc) throw new AppError("Notification not found", 404);

  res.json({
    success: true,
    data: {
      ...doc,
      metadata: doc.purpose === "payroll" ? { portalLinkOnly: true } : doc.metadata,
    },
  });
});

export const listTemplates = asyncHandler(async (req, res) => {
  const templates = await NotificationTemplate.find({
    organizationId: { $in: [req.organizationId, null] },
  })
    .sort({ eventType: 1, channel: 1 })
    .lean();

  res.json({ success: true, data: templates });
});

export const upsertOrgTemplate = asyncHandler(async (req, res) => {
  const { eventType, channel, purpose, subject = "", body, allowedVariables = [], isActive = true } = req.body;
  if (!eventType || !channel || !purpose || !body) {
    throw new AppError("eventType, channel, purpose, and body are required", 400);
  }

  const hasSensitiveVar = allowedVariables.some((v) =>
    SENSITIVE_PAYLOAD_KEYS.includes(String(v).toLowerCase()),
  );
  if (hasSensitiveVar || (String(eventType).startsWith("payroll.") && allowedVariables.some((v) => v !== "brandName"))) {
    throw new AppError("Sensitive or restricted payroll variables are not permitted", 400);
  }

  const doc = await NotificationTemplate.findOneAndUpdate(
    { organizationId: req.organizationId, eventType, channel },
    {
      $set: {
        purpose,
        subject: String(subject).slice(0, 200),
        body: String(body).slice(0, 4000),
        allowedVariables,
        isActive: Boolean(isActive),
      },
    },
    { upsert: true, new: true, runValidators: true },
  );

  res.json({ success: true, data: doc });
});

export const previewTemplate = asyncHandler(async (req, res) => {
  const { eventType, channel, variables = {} } = req.body;
  if (!eventType || !channel) {
    throw new AppError("eventType and channel are required", 400);
  }
  const rendered = await resolveAndRenderNotificationTemplate({
    organizationId: req.organizationId,
    eventType,
    channel,
    variables,
  });
  res.json({ success: true, data: rendered });
});

export const listAutomations = asyncHandler(async (req, res) => {
  const filter = { organizationId: req.organizationId };
  if (req.branchId) filter.branchId = req.branchId;
  const items = await NotificationAutomation.find(filter).sort({ createdAt: -1 }).lean();
  res.json({ success: true, data: items });
});

export const createAutomationHandler = asyncHandler(async (req, res) => {
  const { name, description, triggerType, eventType, scheduleCron, channel, purpose, branchId, templateId } = req.body;
  const doc = await createAutomation(
    { name, description, triggerType, eventType, scheduleCron, channel, purpose, branchId: branchId || null, templateId: templateId || null },
    { organizationId: req.organizationId, userId: req.user?.id || null },
  );
  res.status(201).json({ success: true, data: doc });
});

export const toggleAutomationHandler = asyncHandler(async (req, res) => {
  const doc = await setAutomationEnabled(req.params.id, Boolean(req.body.isEnabled), {
    organizationId: req.organizationId,
    userId: req.user?.id || null,
  });
  res.json({ success: true, data: doc });
});

export const updateAutomationScheduleHandler = asyncHandler(async (req, res) => {
  const doc = await updateAutomationSchedule(
    req.params.id,
    { scheduleCron: req.body.scheduleCron },
    { organizationId: req.organizationId, userId: req.user?.id || null },
  );
  res.json({ success: true, data: doc });
});

export const deleteAutomationHandler = asyncHandler(async (req, res) => {
  const doc = await deleteAutomation(req.params.id, { organizationId: req.organizationId });
  res.json({ success: true, data: doc });
});

export const getMyInbox = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const recipientId = req.user?.id || req.user?._id;
  if (!recipientId) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 10));
  const baseFilter = { organizationId, recipientId };
  const queryFilter = { ...baseFilter };

  if (req.query.cursor) {
    try {
      const decoded = JSON.parse(
        Buffer.from(String(req.query.cursor), "base64url").toString("utf8"),
      );
      const cursorDate = new Date(decoded.createdAt);
      const cursorId = decoded._id;
      if (Number.isNaN(cursorDate.getTime()) || !cursorId) {
        return res.status(400).json({ success: false, message: "Invalid cursor" });
      }
      queryFilter.$or = [
        { createdAt: { $lt: cursorDate } },
        { createdAt: cursorDate, _id: { $lt: cursorId } },
      ];
    } catch {
      return res.status(400).json({ success: false, message: "Invalid cursor" });
    }
  }

  const query = Notification.find(queryFilter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1);
  if (!req.query.cursor && page > 1) {
    query.skip((page - 1) * limit);
  }

  const [rawItems, total, unreadCount] = await Promise.all([
    query.lean(),
    Notification.countDocuments(baseFilter),
    Notification.countDocuments({ ...baseFilter, readAt: null }),
  ]);

  const hasMore = rawItems.length > limit;
  const items = hasMore ? rawItems.slice(0, limit) : rawItems;
  const lastItem = items[items.length - 1];
  const nextCursor =
    hasMore && lastItem
      ? Buffer.from(
          JSON.stringify({ createdAt: lastItem.createdAt, _id: lastItem._id }),
          "utf8",
        ).toString("base64url")
      : null;

  const safeItems = items.map((item) => ({
    _id: item._id,
    notificationId: item.notificationId,
    eventType: item.eventType,
    purpose: item.purpose,
    channel: item.channel,
    branchId: item.branchId || null,
    createdAt: item.createdAt,
    readAt: item.readAt || null,
    isRead: Boolean(item.readAt),
    metadata: item.purpose === "payroll" ? { portalLinkOnly: true } : item.metadata || {},
  }));

  res.json({
    success: true,
    data: safeItems,
    unreadCount,
    pagination: { page, limit, total, hasMore, nextCursor },
  });
});

export const markInboxItemRead = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const recipientId = req.user?.id || req.user?._id;
  if (!recipientId) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  const existing = await Notification.findOne({
    _id: req.params.id,
    organizationId,
    recipientId,
  });
  if (!existing) {
    return res.status(404).json({ success: false, message: "Notification not found" });
  }

  if (!existing.readAt) {
    existing.readAt = new Date();
    await existing.save();
  }

  res.json({
    success: true,
    data: {
      _id: existing._id,
      readAt: existing.readAt,
      isRead: true,
    },
  });
});

export const markAllInboxRead = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const recipientId = req.user?.id || req.user?._id;
  if (!recipientId) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  const result = await Notification.updateMany(
    { organizationId, recipientId, readAt: null },
    { $set: { readAt: new Date() } },
  );

  res.json({
    success: true,
    modifiedCount: result.modifiedCount ?? 0,
  });
});
