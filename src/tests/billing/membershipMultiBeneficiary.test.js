import { describe, expect, it, beforeAll, afterAll, jest } from "@jest/globals";
import mongoose from "mongoose";
import { getIsolatedTestMongoUri } from "../testSetup.js";
import { MembershipPlan } from "../../models/memberships/membershipPlan.model.js";
import { CustomerMembership } from "../../models/memberships/customerMembership.model.js";
import { Customer } from "../../models/customers/customer.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Organization } from "../../models/organizations/organization.model.js";
import { billingService } from "../../services/billing/billing.service.js";
import { membershipService } from "../../services/memberships/membership.service.js";

describe("Multi-Beneficiary Membership Purchase & Lifecycle Integration", () => {
  jest.setTimeout(45000);
  let orgId;
  let branchId;
  let payerId;
  let beneficiaryBId;
  let beneficiaryCId;
  let outsiderCustomerId;
  let planId;
  let cashierUserId;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    const testUri = getIsolatedTestMongoUri("checkout_queue_test");
    await mongoose.connect(testUri);

    await MembershipPlan.syncIndexes();
    await CustomerMembership.syncIndexes();

    // Ensure indexes for settlement event collection are created upfront so MongoDB transactions don't fail on catalog changes
    const { InvoiceSettlementEvent } = await import("../../models/incentives/invoiceSettlementEvent.model.js");
    await InvoiceSettlementEvent.syncIndexes();

    const org = await Organization.create({
      name: "Multi-Beneficiary Test Org",
      ownerEmail: `mb.owner.${Date.now()}@test.com`,
    });
    orgId = org._id;

    const branch = await Branch.create({
      organizationId: orgId,
      name: "Central Salon Branch",
      code: `CSB_${Date.now()}`,
    });
    branchId = branch._id;

    cashierUserId = new mongoose.Types.ObjectId();

    const payer = await Customer.create({
      organizationId: orgId,
      homeBranchId: branchId,
      name: "Payer Alice",
      phone: `+919999${Math.floor(100000 + Math.random() * 900000)}`,
      email: "alice.payer@test.com",
    });
    payerId = payer._id;

    const benB = await Customer.create({
      organizationId: orgId,
      homeBranchId: branchId,
      name: "Beneficiary Bob",
      phone: `+919999${Math.floor(100000 + Math.random() * 900000)}`,
      email: "bob.beneficiary@test.com",
    });
    beneficiaryBId = benB._id;

    const benC = await Customer.create({
      organizationId: orgId,
      homeBranchId: branchId,
      name: "Beneficiary Charlie",
      phone: `+919999${Math.floor(100000 + Math.random() * 900000)}`,
      email: "charlie.beneficiary@test.com",
    });
    beneficiaryCId = benC._id;

    const outsider = await Customer.create({
      organizationId: orgId,
      homeBranchId: branchId,
      name: "Outsider David",
      phone: `+919999${Math.floor(100000 + Math.random() * 900000)}`,
      email: "david.outsider@test.com",
    });
    outsiderCustomerId = outsider._id;

    // Create a 2-beneficiary maximum Family Gold Plan
    const plan = await MembershipPlan.create({
      organizationId: orgId,
      name: "Family Gold VIP",
      code: `FAM_GOLD_${Date.now()}`,
      tier: "Gold",
      price: 4999,
      validityMonths: 12,
      maxBeneficiaries: 2,
      benefits: {
        serviceDiscountPercentage: 20,
        productDiscountPercentage: 10,
        complimentaryPerks: ["Free Blowdry", "VIP Lounge"],
      },
      permittedBranchIds: [branchId],
    });
    planId = plan._id;
  });

  afterAll(async () => {
    await MembershipPlan.deleteMany({ organizationId: orgId });
    await CustomerMembership.deleteMany({ organizationId: orgId });
    await Customer.deleteMany({ organizationId: orgId });
    await Branch.deleteMany({ organizationId: orgId });
    await Organization.deleteOne({ _id: orgId });
    await mongoose.disconnect();
  });

  it("1. Rejects purchase when beneficiary count exceeds plan maxBeneficiaries", async () => {
    await expect(
      billingService.createUnifiedInvoice(
        {
          branchId,
          customerId: payerId,
          membershipLines: [
            {
              membershipPlanId: planId,
              quantity: 1,
              payerCustomerId: payerId,
              // 3 beneficiaries provided for plan with maxBeneficiaries = 2
              beneficiaryCustomerIds: [beneficiaryBId, beneficiaryCId, outsiderCustomerId],
            },
          ],
        },
        orgId,
        cashierUserId
      )
    ).rejects.toThrow(/allows at most 2 beneficiaries/);
  });

  it("2. Rejects duplicate beneficiaries in a single purchase", async () => {
    await expect(
      billingService.createUnifiedInvoice(
        {
          branchId,
          customerId: payerId,
          membershipLines: [
            {
              membershipPlanId: planId,
              quantity: 1,
              payerCustomerId: payerId,
              beneficiaryCustomerIds: [beneficiaryBId, beneficiaryBId],
            },
          ],
        },
        orgId,
        cashierUserId
      )
    ).rejects.toThrow(/Duplicate beneficiaries detected/);
  });

  it("3. Successfully creates unified invoice for 2 distinct beneficiaries and activates both upon payment", async () => {
    const draftInvoice = await billingService.createUnifiedInvoice(
      {
        branchId,
        customerId: payerId,
        membershipLines: [
          {
            membershipPlanId: planId,
            quantity: 1,
            payerCustomerId: payerId,
            beneficiaryCustomerIds: [beneficiaryBId, beneficiaryCId],
          },
        ],
      },
      orgId,
      cashierUserId
    );

    expect(draftInvoice._id).toBeDefined();
    expect(draftInvoice.status).toBe("draft");
    expect(draftInvoice.lines[0].lineType).toBe("membership");
    expect(draftInvoice.lines[0].beneficiaryCustomerIds).toHaveLength(2);

    // Prior to payment, no active membership must exist
    const priorMemberships = await CustomerMembership.find({
      organizationId: orgId,
      customerId: { $in: [beneficiaryBId, beneficiaryCId] },
      status: "active",
    });
    expect(priorMemberships).toHaveLength(0);

    // Finalize invoice before recording payment as required by billing rules
    await billingService.finalizeInvoice(
      draftInvoice._id,
      {},
      orgId,
      branchId,
      cashierUserId
    );

    // Record full payment
    const paymentResult = await billingService.recordPayment(
      draftInvoice._id,
      {
        amount: draftInvoice.payableAmount,
        paymentMethod: "card",
        referenceNote: "Multi-beneficiary test settlement",
      },
      orgId,
      branchId,
      cashierUserId
    );

    expect(paymentResult.invoice.paymentStatus).toBe("paid");

    // Both beneficiaries now have independent active membership records linked by membershipPurchaseId
    const activeMemberships = await CustomerMembership.find({
      organizationId: orgId,
      customerId: { $in: [beneficiaryBId, beneficiaryCId] },
      status: "active",
    });

    expect(activeMemberships).toHaveLength(2);

    const memB = activeMemberships.find((m) => m.customerId.toString() === beneficiaryBId.toString());
    const memC = activeMemberships.find((m) => m.customerId.toString() === beneficiaryCId.toString());

    expect(memB).toBeDefined();
    expect(memC).toBeDefined();
    expect(memB.payerCustomerId.toString()).toBe(payerId.toString());
    expect(memC.payerCustomerId.toString()).toBe(payerId.toString());
    expect(memB.membershipPurchaseId.toString()).toBe(memC.membershipPurchaseId.toString());
    expect(memB.membershipCode).not.toBe(memC.membershipCode);
  });

  it("4. Enforces privilege isolation: Payer does not receive membership discounts because payer is not a beneficiary", async () => {
    // Payer Alice visits the salon
    const payerBenefit = await membershipService.resolveActiveMembershipForCustomer(
      payerId,
      branchId,
      orgId
    );
    expect(payerBenefit).toBeNull();

    // Beneficiary Bob visits the salon
    const bobBenefit = await membershipService.resolveActiveMembershipForCustomer(
      beneficiaryBId,
      branchId,
      orgId
    );
    expect(bobBenefit).not.toBeNull();
    expect(bobBenefit.planSnapshot.benefits.serviceDiscountPercentage).toBe(20);
  });

  it("5. Individual beneficiary deactivation does not affect other beneficiaries under the same purchase", async () => {
    const bobMembership = await CustomerMembership.findOne({
      organizationId: orgId,
      customerId: beneficiaryBId,
      status: "active",
    });
    expect(bobMembership).toBeDefined();

    // Cancel Bob's membership
    await membershipService.cancelBeneficiaryMembership(
      bobMembership._id,
      { reason: "Customer requested cancellation" },
      orgId,
      cashierUserId
    );

    const bobCancelled = await CustomerMembership.findById(bobMembership._id);
    expect(bobCancelled.status).toBe("cancelled");

    // Charlie remains active and retains privileges
    const charlieMembership = await CustomerMembership.findOne({
      organizationId: orgId,
      customerId: beneficiaryCId,
      status: "active",
    });
    expect(charlieMembership).toBeDefined();
    expect(charlieMembership.status).toBe("active");
  });

  it("6. Supports beneficiary suspension and reactivation lifecycle transitions", async () => {
    const charlieMembership = await CustomerMembership.findOne({
      organizationId: orgId,
      customerId: beneficiaryCId,
      status: "active",
    });

    // Suspend Charlie
    await membershipService.suspendBeneficiaryMembership(
      charlieMembership._id,
      { reason: "Temporary travel suspension" },
      orgId,
      cashierUserId
    );

    const suspendedMem = await CustomerMembership.findById(charlieMembership._id);
    expect(suspendedMem.status).toBe("suspended");
    expect(suspendedMem.suspensionReason).toBe("Temporary travel suspension");

    // Suspended customer receives NO active benefits
    const suspendedBenefit = await membershipService.resolveActiveMembershipForCustomer(
      beneficiaryCId,
      branchId,
      orgId
    );
    expect(suspendedBenefit).toBeNull();

    // Reactivate Charlie
    await membershipService.reactivateBeneficiaryMembership(
      charlieMembership._id,
      orgId,
      cashierUserId
    );

    const reactivatedMem = await CustomerMembership.findById(charlieMembership._id);
    expect(reactivatedMem.status).toBe("active");
    expect(reactivatedMem.suspensionReason).toBeNull();
  });

  it("7. Duplicates membership plan safely with inactive status and decoupled unique code", async () => {
    const duplicate = await membershipService.duplicatePlan(planId, orgId, cashierUserId);
    expect(duplicate._id).toBeDefined();
    expect(duplicate.name).toBe("Family Gold VIP (Copy)");
    expect(duplicate.isActive).toBe(false);
    expect(duplicate.maxBeneficiaries).toBe(2);
    expect(duplicate.code).not.toBe(planId.code);
  });
});
