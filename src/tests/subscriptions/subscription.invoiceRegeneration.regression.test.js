import { describe, expect, it, beforeAll, afterAll, beforeEach, jest } from "@jest/globals";
import mongoose from "mongoose";
import { Organization } from "../../models/organizations/organization.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Customer } from "../../models/customers/customer.model.js";
import { Service } from "../../models/services/service.model.js";
import { ServiceCategory } from "../../models/services/serviceCategory.model.js";
import { Subscription } from "../../models/subscriptions/subscription.model.js";
import { SubscriptionPlan } from "../../models/subscriptions/subscriptionPlan.model.js";
import { Invoice } from "../../models/billing/invoice.model.js";
import { billingService } from "../../services/billing/billing.service.js";
import { subscriptionService } from "../../services/subscriptions/subscription.service.js";
import { getIsolatedTestMongoUri } from "../testSetup.js";

describe("Subscription Invoice Lifecycle & Regeneration Regression Suite", () => {
  jest.setTimeout(30000);

  let org, branch, customer, service, plan, testUserId;

  beforeAll(async () => {
    process.env.ALLOW_STANDALONE_TRANSACTION_FALLBACK = "true";
    const testUri = getIsolatedTestMongoUri("sub_listing_test");
    await mongoose.connect(testUri);
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    testUserId = new mongoose.Types.ObjectId();

    org = await Organization.create({
      name: "Salon Regeneration Org",
      slug: `salon-regen-${Date.now()}-${Math.random()}`,
      currency: "INR",
    });

    branch = await Branch.create({
      name: "Main Branch",
      organizationId: org._id,
      slug: `branch-regen-${Date.now()}-${Math.random()}`,
    });

    customer = await Customer.create({
      name: "Alice Wonderland",
      phone: `+9198${Math.floor(10000000 + Math.random() * 90000000)}`,
      organizationId: org._id,
      branchId: branch._id,
      homeBranchId: branch._id,
    });

    const category = await ServiceCategory.create({
      name: "Hair Services",
      organizationId: org._id,
      branchId: branch._id,
    });

    service = await Service.create({
      name: "Keratin Treatment",
      pricing: { basePrice: 2500 },
      duration: 60,
      categoryId: category._id,
      organizationId: org._id,
      branchId: branch._id,
    });

    plan = await SubscriptionPlan.create({
      name: "Keratin VIP",
      description: "VIP plan",
      suggestedPrice: 2500,
      validityMonths: 6,
      entitlements: [
        {
          serviceId: service._id,
          serviceName: service.name,
          quantity: 2,
        },
      ],
      organizationId: org._id,
      branchId: branch._id,
      isActive: true,
    });
  });

  it("1. Generates invoice, cancels invoice, regenerates replacement with new ID & number without duplicating records", async () => {
    const now = new Date();
    const futureDate = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);

    // Create subscription without immediate billing
    const subscription = await subscriptionService.createSubscription(
      {
        customerId: customer._id,
        planId: plan._id,
        branchId: branch._id,
        price: 2500,
        startDate: now,
        endDate: futureDate,
        entitlements: [
          {
            serviceId: service._id,
            serviceName: service.name,
            quantity: 2,
            totalQuantity: 2,
            remainingQuantity: 2,
          },
        ],
        shouldBill: false,
      },
      org._id,
      testUserId
    );

    expect(subscription.invoiceId).toBeNull();

    // 1. Generate first invoice
    const firstInvoice = await billingService.createUnifiedInvoice(
      {
        subscriptionId: subscription._id,
        branchId: branch._id,
        customerId: customer._id,
      },
      org._id,
      testUserId
    );

    expect(firstInvoice).toBeDefined();
    expect(firstInvoice.status).toBe("draft");
    expect(firstInvoice.subscriptionId.toString()).toBe(subscription._id.toString());

    // Verify subscription is linked
    const subAfterInv1 = await Subscription.findById(subscription._id);
    expect(subAfterInv1.invoiceId.toString()).toBe(firstInvoice._id.toString());
    expect(subAfterInv1.invoiceHistory.length).toBe(1);
    expect(subAfterInv1.invoiceHistory[0].invoiceId.toString()).toBe(firstInvoice._id.toString());
    expect(subAfterInv1.invoiceHistory[0].status).toBe("draft");

    // 2. Cancel the first invoice
    await billingService.cancelInvoice(
      firstInvoice._id,
      "Customer requested alternate billing method",
      org._id,
      branch._id,
      testUserId
    );

    // Verify first invoice is permanently marked cancelled (GAAP compliance)
    const cancelledInvDoc = await Invoice.findById(firstInvoice._id);
    expect(cancelledInvDoc.status).toBe("cancelled");
    expect(cancelledInvDoc.cancellationReason).toBe("Customer requested alternate billing method");

    // Verify subscription invoiceId is cleared and invoiceHistory reflects cancellation
    const subAfterCancel = await Subscription.findById(subscription._id);
    expect(subAfterCancel.invoiceId).toBeNull();
    expect(subAfterCancel.invoiceHistory.length).toBe(1);
    expect(subAfterCancel.invoiceHistory[0].status).toBe("cancelled");
    expect(subAfterCancel.invoiceHistory[0].cancelledAt).toBeDefined();

    // 3. Regenerate new invoice
    const secondInvoice = await billingService.createUnifiedInvoice(
      {
        subscriptionId: subscription._id,
        branchId: branch._id,
        customerId: customer._id,
      },
      org._id,
      testUserId
    );

    expect(secondInvoice).toBeDefined();
    expect(secondInvoice._id.toString()).not.toBe(firstInvoice._id.toString());
    expect(secondInvoice.invoiceNumber).not.toBe(firstInvoice.invoiceNumber);
    expect(secondInvoice.status).toBe("draft");

    // Verify subscription now links to the replacement invoice and has full audit history
    const subAfterRegen = await Subscription.findById(subscription._id);
    expect(subAfterRegen.invoiceId.toString()).toBe(secondInvoice._id.toString());
    expect(subAfterRegen.invoiceHistory.length).toBe(2);
    expect(subAfterRegen.invoiceHistory[0].invoiceId.toString()).toBe(firstInvoice._id.toString());
    expect(subAfterRegen.invoiceHistory[0].status).toBe("cancelled");
    expect(subAfterRegen.invoiceHistory[1].invoiceId.toString()).toBe(secondInvoice._id.toString());
    expect(subAfterRegen.invoiceHistory[1].status).toBe("draft");
  });

  it("2. Salon Sale Workspace query (isInvoiced: false) correctly includes subscriptions with cancelled invoices", async () => {
    const now = new Date();
    const futureDate = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);

    // Create subscription and generate + cancel invoice
    const subscription = await subscriptionService.createSubscription(
      {
        customerId: customer._id,
        planId: plan._id,
        branchId: branch._id,
        price: 2500,
        startDate: now,
        endDate: futureDate,
        entitlements: [
          {
            serviceId: service._id,
            serviceName: service.name,
            quantity: 2,
            totalQuantity: 2,
            remainingQuantity: 2,
          },
        ],
        shouldBill: false,
      },
      org._id,
      testUserId
    );

    const invoice = await billingService.createUnifiedInvoice(
      {
        subscriptionId: subscription._id,
        branchId: branch._id,
        customerId: customer._id,
      },
      org._id,
      testUserId
    );

    await billingService.cancelInvoice(
      invoice._id,
      "Test cancellation",
      org._id,
      branch._id,
      testUserId
    );

    // Query uninvoiced subscriptions as SalesWorkspaceView does
    const listResult = await subscriptionService.listSubscriptions(
      {
        isInvoiced: "false",
        customerId: customer._id.toString(),
      },
      org._id
    );

    expect(listResult.data.length).toBe(1);
    expect(listResult.data[0]._id.toString()).toBe(subscription._id.toString());
  });

  it("3. Prevents duplicate active invoices for the same subscription concurrently or consecutively", async () => {
    const now = new Date();
    const futureDate = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);

    const subscription = await subscriptionService.createSubscription(
      {
        customerId: customer._id,
        planId: plan._id,
        branchId: branch._id,
        price: 2500,
        startDate: now,
        endDate: futureDate,
        entitlements: [
          {
            serviceId: service._id,
            serviceName: service.name,
            quantity: 2,
            totalQuantity: 2,
            remainingQuantity: 2,
          },
        ],
        shouldBill: false,
      },
      org._id,
      testUserId
    );

    // Create active invoice
    await billingService.createUnifiedInvoice(
      {
        subscriptionId: subscription._id,
        branchId: branch._id,
        customerId: customer._id,
      },
      org._id,
      testUserId
    );

    // Attempting to generate another invoice while an active draft/finalized invoice exists must fail
    await expect(
      billingService.createInvoiceForSubscriptionSale(
        {
          subscriptionId: subscription._id,
          branchId: branch._id,
        },
        org._id,
        testUserId
      )
    ).rejects.toThrow(/already exists for this subscription/i);
  });
});
