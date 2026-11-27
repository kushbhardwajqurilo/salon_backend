import { jest } from "@jest/globals";
import mongoose from "mongoose";

const mockSession = { id: "mock-session" };
const orgId = new mongoose.Types.ObjectId();
const branchId = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();
const invoiceId = new mongoose.Types.ObjectId();

const mockRefundCaseFindOne = jest.fn();
const mockRefundCaseUpdateOne = jest.fn();
const mockCustomerMembershipFindOne = jest.fn();
const mockAppointmentFindOne = jest.fn();
const mockInvoiceExists = jest.fn();
const mockInventoryReverse = jest.fn();
const mockLoyaltyReverse = jest.fn();
const mockCancelSubscription = jest.fn();
const mockHandlePurchaseRefundProcessed = jest.fn();
const mockHandleProductReturnProcessed = jest.fn();

jest.unstable_mockModule("../../models/billing/refundCase.model.js", () => ({
  RefundCase: {
    findOne: mockRefundCaseFindOne,
    updateOne: mockRefundCaseUpdateOne,
  },
}));

jest.unstable_mockModule(
  "../../models/memberships/customerMembership.model.js",
  () => ({
    CustomerMembership: {
      findOne: mockCustomerMembershipFindOne,
    },
  }),
);

jest.unstable_mockModule("../../models/billing/invoice.model.js", () => ({
  Invoice: {
    exists: mockInvoiceExists,
  },
}));

jest.unstable_mockModule("../../models/appointments/appointment.model.js", () => ({
  Appointment: {
    findOne: mockAppointmentFindOne,
  },
}));

jest.unstable_mockModule(
  "../../services/inventory/inventory.service.js",
  () => ({
    inventoryService: {
      reverseSaleForRefund: mockInventoryReverse,
    },
  }),
);

jest.unstable_mockModule("../../services/loyalty/loyalty.service.js", () => ({
  loyaltyService: {
    reverseForRefund: mockLoyaltyReverse,
  },
}));

jest.unstable_mockModule("../../services/subscriptions/subscription.service.js", () => ({
  subscriptionService: {
    cancelSubscription: mockCancelSubscription,
  },
}));

jest.unstable_mockModule(
  "../../services/incentives/settlementFulfillmentEvent.service.js",
  () => ({
    settlementFulfillmentEventService: {
      handlePurchaseRefundProcessed: mockHandlePurchaseRefundProcessed,
      handleProductReturnProcessed: mockHandleProductReturnProcessed,
    },
  }),
);

const { refundService } =
  await import("../../services/billing/refund.service.js");

function makeInvoice() {
  return { _id: invoiceId, organizationId: orgId, branchId };
}

function makeRefundPayment() {
  return { _id: new mongoose.Types.ObjectId(), type: "refund", amount: -500 };
}

function makeRefundCase(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    organizationId: orgId,
    invoiceId,
    refundNumber: "RF-200",
    refundMode: "item_linked",
    refundKind: "item_linked",
    paymentSettlementStatus: "settled",
    status: "processing",
    reason: "Customer return",
    allocations: [],
    domainReversals: {
      inventory: { status: "pending", referenceIds: [] },
      membership: { status: "pending", referenceIds: [] },
      subscription: { status: "pending", referenceIds: [] },
      appointment: { status: "pending", referenceIds: [] },
      loyalty: { status: "pending", referenceIds: [] },
      incentives: { status: "pending", referenceIds: [] },
    },
    save: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe("refundService.orchestrateDomainReversals (unit)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRefundCaseUpdateOne.mockResolvedValue({
      acknowledged: true,
      modifiedCount: 1,
    });
  });

  test("1. unsettled refunds cannot start domain reversals", async () => {
    const rc = makeRefundCase({ paymentSettlementStatus: "pending" });
    mockRefundCaseFindOne.mockReturnValue({
      session: () => Promise.resolve(rc),
    });

    await expect(
      refundService.orchestrateDomainReversals({
        invoice: makeInvoice(),
        refundCase: rc,
        refundPayment: makeRefundPayment(),
        userId,
        session: mockSession,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(mockInventoryReverse).not.toHaveBeenCalled();
  });

  test("2. financial_only refunds skip all domain handlers", async () => {
    const rc = makeRefundCase({
      refundMode: "financial_only",
      refundKind: "financial_only",
    });
    mockRefundCaseFindOne.mockReturnValue({
      session: () => Promise.resolve(rc),
    });

    const res = await refundService.orchestrateDomainReversals({
      invoice: makeInvoice(),
      refundCase: rc,
      refundPayment: makeRefundPayment(),
      userId,
      session: mockSession,
    });

    expect(res.skipped).toBe(true);
    expect(res.status).toBe("completed");
    expect(mockInventoryReverse).not.toHaveBeenCalled();
    expect(mockLoyaltyReverse).not.toHaveBeenCalled();
    expect(mockHandlePurchaseRefundProcessed).not.toHaveBeenCalled();
  });

  test("3. successful inventory, membership, loyalty, and incentive orchestration sets status to completed", async () => {
    const memLineId = new mongoose.Types.ObjectId();
    const custMemId = new mongoose.Types.ObjectId();
    const prodLineId = new mongoose.Types.ObjectId();
    const rc = makeRefundCase({
      allocations: [
        {
          lineId: memLineId,
          lineType: "membership",
          allocatedAmountPaise: 50000,
        },
        {
          lineId: prodLineId,
          lineType: "product",
          allocatedAmountPaise: 20000,
          quantity: 1,
        },
      ],
    });
    const invoice = {
      ...makeInvoice(),
      lines: [
        {
          _id: memLineId,
          lineType: "membership",
          customerMembershipId: custMemId,
        },
      ],
    };
    const membershipDoc = {
      _id: custMemId,
      status: "active",
      save: jest.fn().mockResolvedValue(true),
    };
    mockRefundCaseFindOne.mockReturnValue({
      session: () => Promise.resolve(rc),
    });
    mockCustomerMembershipFindOne.mockReturnValue({
      session: () => Promise.resolve(membershipDoc),
    });
    mockInvoiceExists.mockReturnValue({ session: () => Promise.resolve(null) });
    mockInventoryReverse.mockResolvedValue({ status: "completed" });
    mockLoyaltyReverse.mockResolvedValue({ status: "completed" });
    mockHandlePurchaseRefundProcessed.mockResolvedValue({
      clawbacks: [{ _id: new mongoose.Types.ObjectId() }],
    });

    const res = await refundService.orchestrateDomainReversals({
      invoice,
      refundCase: rc,
      refundPayment: makeRefundPayment(),
      userId,
      session: mockSession,
    });

    expect(res.status).toBe("completed");
    expect(membershipDoc.status).toBe("cancelled");
    expect(membershipDoc.save).toHaveBeenCalledWith({ session: mockSession });
    expect(mockInventoryReverse).toHaveBeenCalledTimes(1);
    expect(mockLoyaltyReverse).toHaveBeenCalledTimes(1);
    expect(mockHandlePurchaseRefundProcessed).toHaveBeenCalledTimes(1);
  });

  test("3b. rejects used membership (ineligible) and aborts transaction", async () => {
    const memLineId = new mongoose.Types.ObjectId();
    const custMemId = new mongoose.Types.ObjectId();
    const prodLineId = new mongoose.Types.ObjectId();
    const rc = makeRefundCase({
      allocations: [
        {
          lineId: memLineId,
          lineType: "membership",
          allocatedAmountPaise: 50000,
        },
        {
          lineId: prodLineId,
          lineType: "product",
          allocatedAmountPaise: 20000,
          quantity: 1,
        },
      ],
    });
    const invoice = {
      ...makeInvoice(),
      lines: [
        {
          _id: memLineId,
          lineType: "membership",
          customerMembershipId: custMemId,
        },
      ],
    };
    mockRefundCaseFindOne.mockReturnValue({
      session: () => Promise.resolve(rc),
    });
    mockCustomerMembershipFindOne.mockReturnValue({
      session: () => Promise.resolve({ _id: custMemId, status: "active" }),
    });
    mockInvoiceExists.mockReturnValue({
      session: () => Promise.resolve({ _id: new mongoose.Types.ObjectId() }),
    });
    mockInventoryReverse.mockResolvedValue({ status: "completed" });

    await expect(
      refundService.orchestrateDomainReversals({
        invoice,
        refundCase: rc,
        refundPayment: makeRefundPayment(),
        userId,
        session: mockSession,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test("4. domain error propagates to abort the shared transaction without saving partial state", async () => {
    const rc = makeRefundCase();
    mockRefundCaseFindOne.mockReturnValue({
      session: () => Promise.resolve(rc),
    });
    mockInventoryReverse.mockResolvedValue({ status: "completed" });
    mockLoyaltyReverse.mockRejectedValue(new Error("Loyalty DB timeout"));

    await expect(
      refundService.orchestrateDomainReversals({
        invoice: makeInvoice(),
        refundCase: rc,
        refundPayment: makeRefundPayment(),
        userId,
        session: mockSession,
      }),
    ).rejects.toThrow("Loyalty DB timeout");

    expect(mockRefundCaseUpdateOne).not.toHaveBeenCalled();
  });

  test("5. retry resumes only incomplete domains and preserves freshly persisted domain statuses", async () => {
    const invRef = new mongoose.Types.ObjectId();
    const rc = makeRefundCase({
      domainReversals: {
        inventory: { status: "completed", referenceIds: [invRef] },
        membership: { status: "not_applicable", referenceIds: [] },
        subscription: { status: "not_applicable", referenceIds: [] },
        subscription: { status: "not_applicable", referenceIds: [] },
        appointment: { status: "not_applicable", referenceIds: [] },
        membership: { status: "not_applicable", referenceIds: [] },
        loyalty: {
          status: "failed",
          errorMessage: "timeout",
          referenceIds: [],
        },
        incentives: { status: "completed", referenceIds: [] },
      },
    });
    mockRefundCaseFindOne.mockReturnValue({
      session: () => Promise.resolve(rc),
    });
    mockLoyaltyReverse.mockResolvedValue({ status: "completed" });

    const res = await refundService.orchestrateDomainReversals({
      invoice: makeInvoice(),
      refundCase: rc,
      refundPayment: makeRefundPayment(),
      userId,
      session: mockSession,
    });

    expect(res.status).toBe("completed");
    expect(mockInventoryReverse).not.toHaveBeenCalled();
    expect(mockLoyaltyReverse).toHaveBeenCalledTimes(1);
    expect(mockHandlePurchaseRefundProcessed).not.toHaveBeenCalled();
    expect(mockRefundCaseUpdateOne).toHaveBeenCalledWith(
      { _id: rc._id, organizationId: orgId },
      { $set: { status: "completed" } },
      { session: mockSession },
    );
  });

  test("6. unsupported service allocations do not produce a false overall-completed status", async () => {
    const apptId = new mongoose.Types.ObjectId();
    const rc = makeRefundCase({
      allocations: [
        {
          lineId: new mongoose.Types.ObjectId(),
          lineType: "service",
          quantity: 1,
          allocatedAmountPaise: 20000,
        },
      ],
    });
    const apptDoc = { _id: apptId, status: "scheduled", save: jest.fn().mockResolvedValue(true) };
    mockRefundCaseFindOne.mockReturnValue({
      session: () => Promise.resolve(rc),
    });
    mockAppointmentFindOne.mockReturnValue({
      session: () => Promise.resolve(apptDoc),
    });
    mockInventoryReverse.mockResolvedValue({ status: "completed" });
    mockLoyaltyReverse.mockResolvedValue({ status: "completed" });

    const res = await refundService.orchestrateDomainReversals({
      invoice: { ...makeInvoice(), appointmentId: apptId },
      refundCase: rc,
      refundPayment: makeRefundPayment(),
      userId,
      session: mockSession,
    });

    expect(apptDoc.status).toBe("cancelled");
    expect(res.domainResults.appointment.status).toBe("completed");
    expect(res.domainResults.incentives.status).toBe("pending");
    expect(res.status).toBe("processing");
  });

  test("7. rejects completed-service item-linked refunds under current policy", async () => {
    const apptId = new mongoose.Types.ObjectId();
    const rc = makeRefundCase({
      allocations: [
        {
          lineId: new mongoose.Types.ObjectId(),
          lineType: "service",
          quantity: 1,
          allocatedAmountPaise: 20000,
        },
      ],
    });
    mockRefundCaseFindOne.mockReturnValue({
      session: () => Promise.resolve(rc),
    });
    mockAppointmentFindOne.mockReturnValue({
      session: () => Promise.resolve({ _id: apptId, status: "completed" }),
    });
    mockInventoryReverse.mockResolvedValue({ status: "completed" });

    await expect(
      refundService.orchestrateDomainReversals({
        invoice: { ...makeInvoice(), appointmentId: apptId },
        refundCase: rc,
        refundPayment: makeRefundPayment(),
        userId,
        session: mockSession,
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
