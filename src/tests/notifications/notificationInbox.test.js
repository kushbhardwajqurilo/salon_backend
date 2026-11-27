import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { Notification } from "../../models/notifications/notification.model.js";
import {
  getMyInbox,
  markInboxItemRead,
  markAllInboxRead,
} from "../../controllers/notifications/notification.controller.js";

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

describe("Notification Inbox Controller", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("lists authenticated user's inbox with unreadCount and strips payroll metadata", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();

    const findChain = {
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        {
          _id: new mongoose.Types.ObjectId(),
          notificationId: "n1",
          eventType: "payroll.payslip_published",
          purpose: "payroll",
          channel: "email",
          createdAt: new Date(),
          readAt: null,
          metadata: { netPay: 50000, salary: 50000 },
        },
      ]),
    };

    jest.spyOn(Notification, "find").mockReturnValue(findChain);
    jest
      .spyOn(Notification, "countDocuments")
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);

    const req = {
      organizationId: orgId,
      user: { id: userId },
      query: { page: "1", limit: "100" },
    };
    const res = mockRes();

    await getMyInbox(req, res, jest.fn());

    expect(Notification.find).toHaveBeenCalledWith({
      organizationId: orgId,
      recipientId: userId,
    });
    expect(findChain.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
    expect(findChain.limit).toHaveBeenCalledWith(31);
    expect(res.body.pagination.limit).toBe(30);
    expect(res.body.success).toBe(true);
    expect(res.body.unreadCount).toBe(1);
    expect(res.body.data[0].metadata).toEqual({ portalLinkOnly: true });
    expect(res.body.data[0].isRead).toBe(false);
  });

  it("marks a single notification as read idempotently", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const notifId = new mongoose.Types.ObjectId();
    const save = jest.fn().mockResolvedValue(true);

    jest.spyOn(Notification, "findOne").mockResolvedValue({
      _id: notifId,
      readAt: null,
      save,
    });

    const req = {
      organizationId: orgId,
      user: { id: userId },
      params: { id: notifId.toString() },
    };
    const res = mockRes();

    await markInboxItemRead(req, res, jest.fn());

    expect(Notification.findOne).toHaveBeenCalledWith({
      _id: notifId.toString(),
      organizationId: orgId,
      recipientId: userId,
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(res.body.success).toBe(true);
    expect(res.body.data.isRead).toBe(true);
  });

  it("marks all unread notifications as read for the authenticated user", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();

    jest.spyOn(Notification, "updateMany").mockResolvedValue({ modifiedCount: 3 });

    const req = {
      organizationId: orgId,
      user: { id: userId },
    };
    const res = mockRes();

    await markAllInboxRead(req, res, jest.fn());

    expect(Notification.updateMany).toHaveBeenCalledWith(
      { organizationId: orgId, recipientId: userId, readAt: null },
      { $set: { readAt: expect.any(Date) } },
    );
    expect(res.body).toEqual({ success: true, modifiedCount: 3 });
  });

  it("returns 400 on invalid cursor and generates nextCursor when hasMore is true", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();

    const badReq = {
      organizationId: orgId,
      user: { id: userId },
      query: { cursor: "not-valid-base64-json" },
    };
    const badRes = mockRes();
    await getMyInbox(badReq, badRes, jest.fn());
    expect(badRes.statusCode).toBe(400);

    const t1 = new Date("2026-11-27T10:00:00.000Z");
    const id1 = new mongoose.Types.ObjectId();
    const id2 = new mongoose.Types.ObjectId();
    const id3 = new mongoose.Types.ObjectId();
    const findChain = {
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        { _id: id1, notificationId: "n1", eventType: "appointment.created", purpose: "transactional", channel: "in_app", createdAt: t1, readAt: null },
        { _id: id2, notificationId: "n2", eventType: "invoice.settled", purpose: "transactional", channel: "in_app", createdAt: t1, readAt: null },
        { _id: id3, notificationId: "n3", eventType: "customer.created", purpose: "transactional", channel: "in_app", createdAt: t1, readAt: null },
      ]),
    };
    jest.spyOn(Notification, "find").mockReturnValue(findChain);
    jest.spyOn(Notification, "countDocuments").mockResolvedValueOnce(3).mockResolvedValueOnce(3);

    const req = { organizationId: orgId, user: { id: userId }, query: { limit: "2" } };
    const res = mockRes();
    await getMyInbox(req, res, jest.fn());

    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination.hasMore).toBe(true);
    expect(typeof res.body.pagination.nextCursor).toBe("string");
  });
});
