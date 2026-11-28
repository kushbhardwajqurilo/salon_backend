import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { computeBenefitAccountingForInvoice } from "../../services/billing/benefitAccounting.service.js";
import { Invoice } from "../../models/billing/invoice.model.js";
import { CustomerMembership } from "../../models/memberships/customerMembership.model.js";
import { Subscription } from "../../models/subscriptions/subscription.model.js";
import { SubscriptionUsage } from "../../models/subscriptions/subscriptionUsage.model.js";
import { Branch } from "../../models/branches/branch.model.js";

const mockFindChain = (result) => ({
  select: jest.fn().mockReturnThis(),
  session: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(result),
});

const mockFindOneChain = (result) => ({
  select: jest.fn().mockReturnThis(),
  session: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(result),
});

describe("Benefit Accounting (Historical Membership & Subscription)", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("1. Aggregates subscription usage across multiple branches, deduplicates, excludes cancelled, and caps at 0", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const branchA = new mongoose.Types.ObjectId();
    const branchB = new mongoose.Types.ObjectId();
    const subId = new mongoose.Types.ObjectId();
    const lineId = new mongoose.Types.ObjectId();
    const purchaseInvId = new mongoose.Types.ObjectId();
    const apptSvcId = new mongoose.Types.ObjectId();

    const purchaseInvoice = {
      _id: purchaseInvId,
      organizationId: orgId,
      branchId: branchA,
      lines: [
        {
          _id: lineId,
          lineType: "subscription",
          name: "Hair Spa Pack",
          subscriptionId: subId,
          customerPayable: 1000,
        },
      ],
    };

    jest.spyOn(Subscription, "findOne").mockReturnValue(
      mockFindOneChain({ _id: subId, organizationId: orgId }),
    );
    jest.spyOn(Branch, "findOne").mockImplementation(({ _id }) =>
      mockFindOneChain({
        name: String(_id) === String(branchB) ? "Branch B" : "Branch A",
      }),
    );

    const histInv1 = {
      _id: new mongoose.Types.ObjectId(),
      invoiceNumber: "INV-101",
      branchId: branchA,
      createdAt: new Date("2026-10-01"),
      status: "finalized",
      lines: [
        {
          _id: new mongoose.Types.ObjectId(),
          lineType: "service",
          name: "Hair Spa",
          subscriptionId: subId,
          appointmentServiceId: apptSvcId,
          subscriptionCoveredAmount: 400,
          quantity: 1,
        },
        {
          _id: new mongoose.Types.ObjectId(),
          lineType: "service",
          name: "Cancelled Hair Spa",
          subscriptionId: subId,
          status: "cancelled",
          subscriptionCoveredAmount: 400,
          quantity: 1,
        },
      ],
    };

    const histInv2 = {
      _id: new mongoose.Types.ObjectId(),
      invoiceNumber: "INV-102",
      branchId: branchB,
      createdAt: new Date("2026-10-05"),
      status: "finalized",
      lines: [
        {
          _id: new mongoose.Types.ObjectId(),
          lineType: "service",
          name: "Hair Spa",
          subscriptionId: subId,
          subscriptionCoveredAmount: 350,
          quantity: 1,
        },
      ],
    };

    jest.spyOn(Invoice, "find").mockReturnValue(
      mockFindChain([histInv1, histInv2]),
    );

    // Duplicate SubscriptionUsage for apptSvcId should be deduplicated
    jest.spyOn(SubscriptionUsage, "find").mockReturnValue(
      mockFindChain([
        {
          _id: new mongoose.Types.ObjectId(),
          subscriptionId: subId,
          appointmentServiceId: apptSvcId,
          serviceName: "Hair Spa",
          quantity: 1,
          valuePaise: 40000,
          branchId: branchA,
          status: "consumed",
          createdAt: new Date("2026-10-01"),
        },
      ]),
    );

    const result = await computeBenefitAccountingForInvoice({
      invoice: purchaseInvoice,
      organizationId: orgId,
      refundCases: [],
      netLinePaidByLineId: new Map([[String(lineId), 100000]]),
    });

    expect(result.reconciliationRequired).toBe(false);
    expect(result.benefitAccounting).toHaveLength(1);
    const subAcct = result.benefitAccounting[0];
    expect(subAcct.lifetimeConsumedPaise).toBe(75000);
    expect(subAcct.remainingRefundablePaise).toBe(25000);
    expect(subAcct.usageHistory).toHaveLength(2);
  });

  test("2. Flags reconciliationRequired when historical usage snapshot is missing", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const subId = new mongoose.Types.ObjectId();
    const lineId = new mongoose.Types.ObjectId();

    jest.spyOn(Subscription, "findOne").mockReturnValue(
      mockFindOneChain({ _id: subId, organizationId: orgId }),
    );
    jest.spyOn(Branch, "findOne").mockReturnValue(mockFindOneChain({ name: "Main" }));
    jest.spyOn(Invoice, "find").mockReturnValue(mockFindChain([]));
    jest.spyOn(SubscriptionUsage, "find").mockReturnValue(
      mockFindChain([
        {
          _id: new mongoose.Types.ObjectId(),
          subscriptionId: subId,
          serviceName: "Unknown Snapshot Service",
          quantity: 1,
          branchId: new mongoose.Types.ObjectId(),
          status: "consumed",
          createdAt: new Date(),
        },
      ]),
    );

    const result = await computeBenefitAccountingForInvoice({
      invoice: {
        _id: new mongoose.Types.ObjectId(),
        lines: [
          {
            _id: lineId,
            lineType: "subscription",
            name: "Pack",
            subscriptionId: subId,
            customerPayable: 500,
          },
        ],
      },
      organizationId: orgId,
      refundCases: [],
      netLinePaidByLineId: new Map([[String(lineId), 50000]]),
    });

    expect(result.reconciliationRequired).toBe(true);
    expect(result.reconciliationReasons.length).toBeGreaterThan(0);
  });

  test("3. Aggregates membership discounts across service and retail invoices and clamps excess usage to 0", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const customerId = new mongoose.Types.ObjectId();
    const memId = new mongoose.Types.ObjectId();
    const lineId = new mongoose.Types.ObjectId();

    jest.spyOn(CustomerMembership, "findOne").mockReturnValue(
      mockFindOneChain({ _id: memId, organizationId: orgId, customerId }),
    );
    jest.spyOn(Branch, "findOne").mockReturnValue(mockFindOneChain({ name: "Main" }));
    jest.spyOn(Invoice, "find").mockReturnValue(
      mockFindChain([
        {
          _id: new mongoose.Types.ObjectId(),
          invoiceNumber: "INV-201",
          branchId: new mongoose.Types.ObjectId(),
          createdAt: new Date(),
          status: "finalized",
          lines: [
            {
              _id: new mongoose.Types.ObjectId(),
              lineType: "service",
              name: "Facial",
              quantity: 1,
              appliedDiscounts: [
                {
                  membershipId: memId,
                  source: "membership",
                  calculatedAmount: 700,
                },
              ],
            },
            {
              _id: new mongoose.Types.ObjectId(),
              lineType: "product",
              name: "Serum",
              quantity: 1,
              appliedDiscounts: [
                {
                  membershipId: memId,
                  source: "membership",
                  calculatedAmount: 500,
                },
              ],
            },
          ],
        },
      ]),
    );

    const result = await computeBenefitAccountingForInvoice({
      invoice: {
        _id: new mongoose.Types.ObjectId(),
        lines: [
          {
            _id: lineId,
            lineType: "membership",
            name: "Gold Membership",
            membershipId: memId,
            customerPayable: 1000,
          },
        ],
      },
      organizationId: orgId,
      refundCases: [],
      netLinePaidByLineId: new Map([[String(lineId), 100000]]),
    });

    expect(result.reconciliationRequired).toBe(false);
    expect(result.benefitAccounting[0].lifetimeConsumedPaise).toBe(120000);
    expect(result.benefitAccounting[0].remainingRefundablePaise).toBe(0);
  });
});
