import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { VERIFIED_EVENT_TYPES } from "../../services/notifications/notificationEventContract.js";
import { resolveAndRenderNotificationTemplate } from "../../services/notifications/notificationTemplate.service.js";
import { NotificationTemplate } from "../../models/notifications/notificationTemplate.model.js";
import { OrganizationSettings } from "../../models/settings/organizationSettings.model.js";
import { OutboxEvent } from "../../models/notifications/outboxEvent.model.js";
import { procurementService } from "../../services/procurement/procurement.service.js";
import { supplierRepository } from "../../repositories/procurement/supplier.repository.js";
import { purchaseOrderRepository } from "../../repositories/procurement/purchaseOrder.repository.js";
import { productRepository } from "../../repositories/inventory/product.repository.js";
import { AuditLog } from "../../models/audit/auditLog.model.js";
import { PurchaseOrder } from "../../models/procurement/purchaseOrder.model.js";
import { Branch } from "../../models/branches/branch.model.js";

describe("Inventory & Procurement Notification Contracts", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("includes inventory and procurement events in VERIFIED_EVENT_TYPES", () => {
    const expected = [
      "inventory.low_stock",
      "inventory.out_of_stock",
      "inventory.stock_received",
      "inventory.stock_adjusted",
      "procurement.po_created",
      "procurement.po_submitted",
      "procurement.po_approved",
      "procurement.po_rejected",
      "procurement.goods_received",
    ];
    for (const ev of expected) {
      expect(VERIFIED_EVENT_TYPES).toContain(ev);
    }
  });

  it("renders built-in email and sms templates for inventory and procurement events", async () => {
    const orgId = new mongoose.Types.ObjectId();
    jest.spyOn(OrganizationSettings, "findOne").mockReturnValue({
      lean: jest.fn().mockResolvedValue({ profile: { displayName: "GLAM SALOON" } }),
    });
    jest.spyOn(NotificationTemplate, "findOne").mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    });

    const invRes = await resolveAndRenderNotificationTemplate({
      organizationId: orgId,
      eventType: "inventory.low_stock",
      channel: "email",
      variables: {
        itemName: "Hair Colour - Black",
        stockDomain: "Salon Consumables",
        branchName: "Main Branch",
        quantity: "3",
      },
    });
    expect(invRes.source).toBe("builtin_default");
    expect(invRes.subject).toContain("GLAM SALOON");
    expect(invRes.body).toContain("Salon Consumables");

    const poRes = await resolveAndRenderNotificationTemplate({
      organizationId: orgId,
      eventType: "procurement.po_submitted",
      channel: "sms",
      variables: {
        poNumber: "PO-1042",
        supplierName: "ABC Distributors",
      },
    });
    expect(poRes.source).toBe("builtin_default");
    expect(poRes.body).toContain("PO-1042");
    expect(poRes.body).toContain("ABC Distributors");
  });

  it("ProcurementService.createPurchaseOrder creates procurement.po_created outbox event", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const supplierId = new mongoose.Types.ObjectId();
    const productId = new mongoose.Types.ObjectId();
    const poId = new mongoose.Types.ObjectId();

    jest.spyOn(supplierRepository, "findById").mockResolvedValue({
      _id: supplierId,
      name: "ABC Distributors",
      status: "active",
    });
    jest.spyOn(productRepository, "findById").mockResolvedValue({
      _id: productId,
      name: "Shampoo 500ml",
      sku: "SH-500",
      stockUnit: "pcs",
      usageType: "retail_sale",
      status: "active",
    });
    jest.spyOn(PurchaseOrder, "countDocuments").mockResolvedValue(0);
    jest.spyOn(purchaseOrderRepository, "create").mockResolvedValue({
      _id: poId,
      poNumber: "PO-2026-0001",
      totalAmount: 1000,
    });
    jest.spyOn(AuditLog.prototype, "save").mockResolvedValue(true);
    jest.spyOn(Branch, "exists").mockResolvedValue(true);
    const outboxSpy = jest.spyOn(OutboxEvent, "create").mockResolvedValue([{}]);

    await procurementService.createPurchaseOrder(
      {
        supplierId: supplierId.toString(),
        branchId: branchId.toString(),
        items: [{ productId: productId.toString(), orderedQuantity: 10, unitCostPrice: 100, targetDomain: "retail_products" }],
      },
      orgId,
      branchId,
      userId,
    );

    expect(outboxSpy).toHaveBeenCalledTimes(1);
    const doc = outboxSpy.mock.calls[0][0];
    expect(doc.eventType).toBe("procurement.po_created");
    expect(doc.organizationId).toEqual(orgId);
    expect(doc.branchId).toEqual(branchId);
    expect(doc.payload.supplierName).toBe("ABC Distributors");
    expect(doc.payload.actorId).toBe(String(userId));
  });

  it("ProcurementService.updatePurchaseOrderStatus emits status-specific events and skips on invalid transition", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const poId = new mongoose.Types.ObjectId();

    jest.spyOn(purchaseOrderRepository, "findById").mockResolvedValue({
      _id: poId,
      poNumber: "PO-2026-0002",
      branchId,
      status: "draft",
      items: [],
    });
    jest.spyOn(purchaseOrderRepository, "update").mockResolvedValue({
      _id: poId,
      poNumber: "PO-2026-0002",
      branchId,
      status: "cancelled",
    });
    jest.spyOn(AuditLog.prototype, "save").mockResolvedValue(true);
    jest.spyOn(Branch, "exists").mockResolvedValue(true);
    const outboxSpy = jest.spyOn(OutboxEvent, "create").mockResolvedValue([{}]);

    await procurementService.updatePurchaseOrderStatus(
      poId.toString(),
      { status: "cancelled", cancelReason: "No longer needed" },
      orgId,
      userId,
    );

    expect(outboxSpy).toHaveBeenCalledTimes(1);
    expect(outboxSpy.mock.calls[0][0].eventType).toBe("procurement.po_rejected");

    outboxSpy.mockClear();
    await expect(
      procurementService.updatePurchaseOrderStatus(
        poId.toString(),
        { status: "invalid_status" },
        orgId,
        userId,
      ),
    ).rejects.toThrow();
    expect(outboxSpy).not.toHaveBeenCalled();
  });
});
