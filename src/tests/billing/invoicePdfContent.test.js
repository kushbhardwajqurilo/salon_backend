import { generateInvoiceHtml } from "../../services/billing/invoicePdf.service.js";

describe("Official A4 Invoice PDF Content (Phase 2.2)", () => {
  const baseOrg = { name: "Luxe Corp", displayName: "Luxe Salon" };
  const baseBranch = { name: "Indiranagar", timezone: "Asia/Kolkata" };

  it("renders service, product, subscription, and membership lines with accurate metadata and no duration on product/membership", () => {
    const html = generateInvoiceHtml({
      invoice: {
        invoiceNumber: "INV-20261125-0010",
        status: "finalized",
        paymentStatus: "partially_paid",
        createdAt: new Date("2026-11-25T10:00:00Z"),
        lines: [
          {
            lineType: "service",
            name: "Haircut & Styling",
            quantity: 1,
            duration: 45,
            unitPrice: 800,
            lineDiscountTotal: 100,
            customerPayable: 700,
            staffId: { name: "Aarav" },
          },
          {
            lineType: "product",
            name: "Argan Serum",
            sku: "ARG-100",
            stockUnit: "ml",
            quantity: 2,
            unitPrice: 500,
            customerPayable: 1000,
            staffId: { name: "Priya" },
          },
          {
            lineType: "subscription",
            name: "Annual Grooming Plan",
            quantity: 1,
            unitPrice: 3000,
            customerPayable: 3000,
          },
          {
            lineType: "membership",
            name: "Gold Membership",
            membershipTierSnapshot: "GOLD",
            quantity: 1,
            unitPrice: 2000,
            membershipDiscountAmount: 200,
            customerPayable: 1800,
          },
        ],
        subtotal: 6800,
        discountTotal: 500,
        coupon: { code: "WELCOME10", calculatedDiscountAmount: 150 },
        loyaltyRedeemedPoints: 50,
        loyaltyDiscountAmount: 50,
        subscriptionCoveredAmount: 0,
        payableAmount: 6300,
        amountPaid: 4000,
        amountDue: 2300,
      },
      organization: baseOrg,
      branch: baseBranch,
    });

    // Service
    expect(html).toContain("Haircut &amp; Styling");
    expect(html).toContain("45 mins");
    expect(html).toContain("Staff: Aarav");
    expect(html).toContain("Line Disc:");

    // Product (no 0 mins!)
    expect(html).toContain("Argan Serum");
    expect(html).toContain("SKU: ARG-100");
    expect(html).toContain("Qty: 2 ml");
    expect(html).toContain("Staff: Priya");
    expect(html).not.toContain("0 mins");

    // Subscription
    expect(html).toContain("Annual Grooming Plan");
    expect(html).toContain("Membership / Subscription Package");

    // Membership
    expect(html).toContain("Gold Membership");
    expect(html).toContain("Tier: GOLD");
    expect(html).toContain("Membership Disc:");

    // Discount & Financial Summary (persisted values)
    expect(html).toContain("Coupon (WELCOME10):");
    expect(html).toContain("Loyalty (50 pts):");
    expect(html).toContain("6,800.00");
    expect(html).toContain("6,300.00");
    expect(html).toContain("4,000.00");
    expect(html).toContain("2,300.00");
  });

  it("renders completed payments, refunds, and voided transactions distinctly", () => {
    const html = generateInvoiceHtml({
      invoice: {
        invoiceNumber: "INV-20261125-0011",
        status: "finalized",
        paymentStatus: "partially_paid",
        createdAt: new Date("2026-11-25T10:00:00Z"),
        lines: [],
        subtotal: 1000,
        discountTotal: 0,
        subscriptionCoveredAmount: 0,
        payableAmount: 1000,
        amountPaid: 700,
        amountDue: 300,
      },
      payments: [
        {
          paymentNumber: "PAY-20261125-0001",
          type: "payment",
          method: "upi",
          amount: 1000,
          status: "completed",
          paymentDate: new Date("2026-11-25T10:05:00Z"),
          referenceNote: "GPay #123",
        },
        {
          paymentNumber: "PAY-20261125-0002",
          type: "refund",
          method: "upi",
          amount: 300,
          status: "completed",
          paymentDate: new Date("2026-11-25T10:10:00Z"),
          referenceNote: "Partial refund",
        },
        {
          paymentNumber: "PAY-20261125-0003",
          type: "payment",
          method: "cash",
          amount: 200,
          status: "voided",
          paymentDate: new Date("2026-11-25T10:15:00Z"),
        },
      ],
      organization: baseOrg,
      branch: baseBranch,
    });

    expect(html).toContain("PAY-20261125-0001");
    expect(html).toContain("PAYMENT");
    expect(html).toContain("COMPLETED");
    expect(html).toContain("PAY-20261125-0002");
    expect(html).toContain("REFUND");
    expect(html).toContain("REFUNDED");
    expect(html).toContain("PAY-20261125-0003");
    expect(html).toContain("VOIDED");
  });

  it("includes A4 page dimensions, repeated table headers, break-inside avoidance, and safe text wrapping", () => {
    const html = generateInvoiceHtml({
      invoice: {
        invoiceNumber: "INV-20261125-0012",
        status: "finalized",
        paymentStatus: "paid",
        createdAt: new Date("2026-11-25T10:00:00Z"),
        lines: Array.from({ length: 25 }, (_, i) => ({
          lineType: "service",
          name: `Very Long Service Name Without Spaces ${"X".repeat(40)} #${i + 1}`,
          quantity: 1,
          duration: 30,
          unitPrice: 100,
          customerPayable: 100,
        })),
        subtotal: 2500,
        discountTotal: 0,
        subscriptionCoveredAmount: 0,
        payableAmount: 2500,
        amountPaid: 2500,
        amountDue: 0,
      },
      organization: baseOrg,
      branch: baseBranch,
    });

    expect(html).toContain("size: A4;");
    expect(html).toContain("margin: 15mm;");
    expect(html).toContain("display: table-header-group;");
    expect(html).toContain("break-inside: avoid;");
    expect(html).toContain("table-layout: fixed;");
    expect(html).toContain("overflow-wrap: anywhere;");
  });
});
