import { auditHistoricalRecords } from "../../services/finance/historicalFinancialAudit.service.js";

describe("Historical Financial Impact Audit (Read-Only Dry-Run)", () => {
  test("identifies affected historical appointment (APT-20261128-0014) and linked paid invoice without mutating", () => {
    const report = auditHistoricalRecords({
      appointments: [
        {
          _id: "apt-1",
          appointmentCode: "APT-20261128-0014",
          status: "completed",
          services: [
            { price: 1000, appliedSubscriptionId: "sub-1", isRedeemedViaSubscription: true },
            { price: 700, appliedSubscriptionId: "sub-1", isRedeemedViaSubscription: true },
            { price: 10000, membershipDiscountAmount: 2000 },
            { price: 15000, membershipDiscountAmount: 3000 },
          ],
          pricing: {
            subtotal: 26700,
            discount: 5000,
            total: 21700,
          },
        },
      ],
      invoices: [
        {
          _id: "inv-1",
          invoiceNumber: "INV-20261128-0014",
          appointmentId: "apt-1",
          status: "paid",
          grandTotal: 21700,
          amountPaid: 21700,
        },
      ],
    });

    expect(report.dryRun).toBe(true);
    expect(report.summary.affectedAppointmentsCount).toBe(1);
    expect(report.summary.affectedInvoicesCount).toBe(1);

    const aptFinding = report.findings.find((f) => f.transactionType === "appointment");
    expect(aptFinding.original.total).toBe(21700);
    expect(aptFinding.expected.totalPayable).toBe(20000);
    expect(aptFinding.difference).toBe(-1700);
    expect(aptFinding.recommendedAction).toBe("SAFE_PRICING_RECONCILIATION_AFTER_APPROVAL");

    const invFinding = report.findings.find((f) => f.transactionType === "invoice");
    expect(invFinding.difference).toBe(-1700);
    expect(invFinding.recommendedAction).toBe("MANUAL_REVIEW_PAID_INVOICE_NO_AUTO_MUTATION");
  });

  test("does not flag clean new transactions with complete breakdown", () => {
    const report = auditHistoricalRecords({
      appointments: [
        {
          _id: "apt-2",
          appointmentCode: "APT-20261128-0015",
          status: "completed",
          services: [
            { price: 1000, isRedeemedViaSubscription: true },
            { price: 10000, membershipDiscountAmount: 2000 },
          ],
          pricing: {
            subtotal: 11000,
            grossSubtotal: 11000,
            subscriptionWaivedAmount: 1000,
            membershipDiscountAmount: 2000,
            manualDiscountAmount: 0,
            discount: 2000,
            total: 8000,
            totalPayable: 8000,
          },
        },
      ],
      invoices: [
        {
          _id: "inv-2",
          invoiceNumber: "INV-20261128-0015",
          appointmentId: "apt-2",
          status: "paid",
          grandTotal: 8000,
          amountPaid: 8000,
        },
      ],
    });

    expect(report.summary.affectedRecordsCount).toBe(0);
    expect(report.findings).toEqual([]);
  });

  test("flags legacy appointment with missing service snapshots for manual review without guessing", () => {
    const report = auditHistoricalRecords({
      appointments: [
        {
          _id: "apt-legacy",
          appointmentCode: "APT-LEGACY-001",
          status: "completed",
          services: [],
          pricing: { subtotal: 5000, discount: 500, total: 4500 },
        },
      ],
    });

    expect(report.summary.affectedAppointmentsCount).toBe(1);
    const finding = report.findings[0];
    expect(finding.expected).toBeNull();
    expect(finding.difference).toBeNull();
    expect(finding.recommendedAction).toBe(
      "MANUAL_REVIEW_INCOMPLETE_OR_AMBIGUOUS_LEGACY_RECORD",
    );
  });

  test("flags unmatched refunds and duplicate/excess refunds on invoices", () => {
    const report = auditHistoricalRecords({
      invoices: [
        {
          _id: "inv-10",
          invoiceNumber: "INV-0010",
          status: "paid",
          grandTotal: 1000,
          amountPaid: 1000,
        },
      ],
      refundCases: [
        {
          _id: "ref-unmatched",
          refundNumber: "REF-0001",
          invoiceId: "inv-missing",
          status: "completed",
          requestedAmountPaise: 50000,
        },
        {
          _id: "ref-1",
          refundNumber: "REF-0002",
          invoiceId: "inv-10",
          status: "completed",
          requestedAmountPaise: 60000,
        },
        {
          _id: "ref-2",
          refundNumber: "REF-0003",
          invoiceId: "inv-10",
          status: "completed",
          requestedAmountPaise: 60000,
        },
      ],
    });

    expect(report.summary.affectedRefundsCount).toBe(2);
    const unmatched = report.findings.find(
      (f) => f.recommendedAction === "MANUAL_REVIEW_UNMATCHED_REFUND",
    );
    expect(unmatched).toBeDefined();
    expect(unmatched.recordCode).toBe("REF-0001");

    const excess = report.findings.find(
      (f) => f.recommendedAction === "MANUAL_REVIEW_DUPLICATE_OR_EXCESS_REFUND",
    );
    expect(excess).toBeDefined();
    expect(excess.original.totalRefunded).toBe(1200);
    expect(excess.difference).toBe(200);
  });
});
