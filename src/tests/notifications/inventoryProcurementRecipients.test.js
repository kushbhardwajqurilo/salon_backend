import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { resolveRecipientsForEvent } from "../../services/notifications/recipientResolver.service.js";
import { orchestrateOutboxEvent } from "../../services/notifications/notificationOrchestrator.service.js";
import { Role } from "../../models/roles/role.model.js";
import { User } from "../../models/users/user.model.js";
import { Notification } from "../../models/notifications/notification.model.js";

describe("Inventory & Procurement Recipient Resolution", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function mockRoles(roles) {
    jest.spyOn(Role, "find").mockReturnValue({
      populate: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(roles),
      }),
    });
  }

  function mockUsers(users) {
    return jest.spyOn(User, "find").mockReturnValue({
      lean: jest.fn().mockResolvedValue(users),
    });
  }

  it("resolves multiple eligible inventory recipients within org and branch", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    const invRoleId = new mongoose.Types.ObjectId();
    const otherRoleId = new mongoose.Types.ObjectId();

    mockRoles([
      { _id: invRoleId, permissions: [{ name: "inventory.adjust" }] },
      { _id: otherRoleId, permissions: [{ name: "billing.view" }] },
    ]);

    const userFindSpy = mockUsers([
      { _id: new mongoose.Types.ObjectId(), email: "mgr@salon.com", status: "active" },
      { _id: new mongoose.Types.ObjectId(), email: "owner@salon.com", status: "active" },
    ]);

    const targets = await resolveRecipientsForEvent({
      organizationId: orgId,
      branchId,
      eventType: "inventory.low_stock",
      payload: {},
    });

    expect(targets).toHaveLength(2);
    expect(targets[0].recipientType).toBe("staff");
    expect(targets[0].purpose).toBe("operational");
    expect(targets[0].channels).toEqual(["in_app", "email"]);

    const query = userFindSpy.mock.calls[0][0];
    expect(query.organizationId).toEqual(orgId);
    expect(query.status).toBe("active");
    expect(query.role.$in).toEqual([invRoleId]);
    expect(query.$or).toEqual([
      { hasOrgWideAccess: true },
      { branchAccess: { $elemMatch: { branchId, isActive: true } } },
    ]);
  });

  it("restricts to hasOrgWideAccess when branchId is missing for procurement events", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const procRoleId = new mongoose.Types.ObjectId();

    mockRoles([{ _id: procRoleId, permissions: [{ name: "procurement.orders.update" }] }]);
    const userFindSpy = mockUsers([
      { _id: new mongoose.Types.ObjectId(), email: "orgadmin@salon.com", status: "active" },
    ]);

    const targets = await resolveRecipientsForEvent({
      organizationId: orgId,
      branchId: null,
      eventType: "procurement.po_created",
      payload: {},
    });

    expect(targets).toHaveLength(1);
    const query = userFindSpy.mock.calls[0][0];
    expect(query.hasOrgWideAccess).toBe(true);
    expect(query.$or).toBeUndefined();
  });

  it("returns empty array when no role has matching permissions", async () => {
    const orgId = new mongoose.Types.ObjectId();
    mockRoles([{ _id: new mongoose.Types.ObjectId(), permissions: [{ name: "billing.view" }] }]);
    const userFindSpy = mockUsers([]);

    const targets = await resolveRecipientsForEvent({
      organizationId: orgId,
      branchId: new mongoose.Types.ObjectId(),
      eventType: "inventory.out_of_stock",
      payload: {},
    });

    expect(targets).toEqual([]);
    expect(userFindSpy).not.toHaveBeenCalled();
  });

  it("orchestrator handles empty recipient resolution safely without creating notifications", async () => {
    const orgId = new mongoose.Types.ObjectId();
    mockRoles([]);
    const notifSpy = jest.spyOn(Notification, "create");

    const results = await orchestrateOutboxEvent({
      eventId: "evt-empty-1",
      organizationId: orgId,
      branchId: new mongoose.Types.ObjectId(),
      eventType: "procurement.po_approved",
      payload: {},
    });

    expect(results).toEqual([]);
    expect(notifSpy).not.toHaveBeenCalled();
  });
});
