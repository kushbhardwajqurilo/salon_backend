import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { OutboxEvent } from "../../models/notifications/outboxEvent.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { CustomerService } from "../../services/customers/customer.service.js";
import { logger } from "../../utils/logger.js";

describe("Stage 2F — Customer Creation Notification Outbox Integration", () => {
  const orgId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const custId = new mongoose.Types.ObjectId();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("emits customer.created outbox event after successful createCustomer()", async () => {
    jest.spyOn(Branch, "findOne").mockResolvedValue({ _id: branchId, organizationId: orgId, isActive: true });
    const service = new CustomerService();
    service.customerRepo = {
      findByPhone: jest.fn().mockResolvedValue(null),
      findByEmail: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({
        _id: custId,
        organizationId: orgId,
        homeBranchId: branchId,
      }),
    };
    service.auditRepo = { create: jest.fn().mockResolvedValue({}) };

    const outboxSpy = jest
      .spyOn(OutboxEvent, "create")
      .mockImplementation(async (doc) => ({ ...doc, _id: new mongoose.Types.ObjectId() }));

    const customer = await service.createCustomer(
      { name: "Jane Doe", phone: "+919876543210", homeBranchId: branchId },
      orgId,
      userId,
    );

    expect(customer._id).toEqual(custId);
    expect(outboxSpy).toHaveBeenCalledTimes(1);
    expect(outboxSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: orgId,
        branchId,
        eventType: "customer.created",
        idempotencyKey: `customer.created:${custId}`,
        payload: {
          customerId: String(custId),
          homeBranchId: String(branchId),
        },
      }),
    );
  });

  it("does not fail createCustomer() when outbox write fails and logs error", async () => {
    jest.spyOn(Branch, "findOne").mockResolvedValue({ _id: branchId, organizationId: orgId, isActive: true });
    const service = new CustomerService();
    service.customerRepo = {
      findByPhone: jest.fn().mockResolvedValue(null),
      findByEmail: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({
        _id: custId,
        organizationId: orgId,
        homeBranchId: branchId,
      }),
    };
    service.auditRepo = { create: jest.fn().mockResolvedValue({}) };

    jest.spyOn(OutboxEvent, "create").mockRejectedValue(new Error("Mongo write timeout"));
    const logSpy = jest.spyOn(logger, "error").mockImplementation(() => {});

    const customer = await service.createCustomer(
      { name: "Jane Doe", phone: "+919876543210", homeBranchId: branchId },
      orgId,
      userId,
    );

    expect(customer._id).toEqual(custId);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[CUSTOMER_CREATED_OUTBOX_FAILED]"));
  });

  it("does not emit outbox event when customer persistence fails", async () => {
    jest.spyOn(Branch, "findOne").mockResolvedValue({ _id: branchId, organizationId: orgId, isActive: true });
    const service = new CustomerService();
    service.customerRepo = {
      findByPhone: jest.fn().mockResolvedValue(null),
      findByEmail: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockRejectedValue(new Error("DB error")),
    };
    const outboxSpy = jest.spyOn(OutboxEvent, "create");

    await expect(
      service.createCustomer({ name: "Jane Doe", phone: "+919876543210", homeBranchId: branchId }, orgId, userId),
    ).rejects.toThrow("DB error");
    expect(outboxSpy).not.toHaveBeenCalled();
  });
});
