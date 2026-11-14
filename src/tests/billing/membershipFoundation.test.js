import { describe, expect, it, beforeAll, afterAll, jest } from "@jest/globals";
import mongoose from "mongoose";
import { getIsolatedTestMongoUri } from "../testSetup.js";
import { MembershipPlan } from "../../models/memberships/membershipPlan.model.js";
import { CustomerMembership } from "../../models/memberships/customerMembership.model.js";
import { Invoice } from "../../models/billing/invoice.model.js";
import { Customer } from "../../models/customers/customer.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Organization } from "../../models/organizations/organization.model.js";
import { createInvoiceSchema } from "../../validation/billing/billing.validation.js";

describe("Phase 1: Membership Foundation & Unified Invoice Schema Groundwork", () => {
  jest.setTimeout(45000);
  let orgId;
  let foreignOrgId;
  let branchId;
  let customerId;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    const testUri = getIsolatedTestMongoUri("checkout_queue_test");
    await mongoose.connect(testUri);

    // Ensure indexes are built for unique constraint tests
    await MembershipPlan.syncIndexes();
    await CustomerMembership.syncIndexes();
    await Invoice.syncIndexes();

    const org = await Organization.create({
      name: "Phase 1 Unified Salon Org",
      ownerEmail: "owner.phase1@test.com",
    });
    orgId = org._id;

    const foreignOrg = await Organization.create({
      name: "Foreign Org",
      ownerEmail: "owner.foreign@test.com",
    });
    foreignOrgId = foreignOrg._id;

    const branch = await Branch.create({
      organizationId: orgId,
      name: "Main Branch",
      code: "MB01",
    });
    branchId = branch._id;

    const customer = await Customer.create({
      organizationId: orgId,
      homeBranchId: branchId,
      name: "Alice Wonderland",
      phone: "+919876543210",
      email: "alice@wonderland.com",
    });
    customerId = customer._id;
  });

  afterAll(async () => {
    await MembershipPlan.deleteMany({ organizationId: { $in: [orgId, foreignOrgId] } });
    await CustomerMembership.deleteMany({ organizationId: { $in: [orgId, foreignOrgId] } });
    await Invoice.deleteMany({ organizationId: { $in: [orgId, foreignOrgId] } });
    await Customer.deleteMany({ organizationId: { $in: [orgId, foreignOrgId] } });
    await Branch.deleteMany({ organizationId: { $in: [orgId, foreignOrgId] } });
    await Organization.deleteMany({ _id: { $in: [orgId, foreignOrgId] } });
  });

  describe("1. MembershipPlan Model Validation & Constraints", () => {
    it("successfully creates a valid membership plan with tiered benefits", async () => {
      const plan = await MembershipPlan.create({
        organizationId: orgId,
        name: "Gold VIP Membership",
        code: "GOLDVIP",
        tier: "Gold",
        price: 2999,
        validityMonths: 12,
        benefits: {
          serviceDiscountPercentage: 15,
          productDiscountPercentage: 10,
          complimentaryPerks: ["Free Welcome Drink", "Priority Stylist Booking"],
        },
      });

      expect(plan._id).toBeDefined();
      expect(plan.name).toBe("Gold VIP Membership");
      expect(plan.code).toBe("GOLDVIP");
      expect(plan.price).toBe(2999);
      expect(plan.validityMonths).toBe(12);
      expect(plan.benefits.serviceDiscountPercentage).toBe(15);
      expect(plan.benefits.productDiscountPercentage).toBe(10);
      expect(plan.isActive).toBe(true);
    });

    it("enforces unique code per organization", async () => {
      await expect(
        MembershipPlan.create({
          organizationId: orgId,
          name: "Duplicate Code Plan",
          code: "GOLDVIP",
          price: 1999,
          validityMonths: 6,
        })
      ).rejects.toThrow();
    });

    it("allows the same plan code in a different organization (tenant isolation)", async () => {
      const foreignPlan = await MembershipPlan.create({
        organizationId: foreignOrgId,
        name: "Foreign Gold Plan",
        code: "GOLDVIP",
        price: 3500,
        validityMonths: 12,
      });

      expect(foreignPlan._id).toBeDefined();
      expect(foreignPlan.organizationId.toString()).toBe(foreignOrgId.toString());
    });

    it("rejects negative pricing or invalid discount percentages", async () => {
      await expect(
        MembershipPlan.create({
          organizationId: orgId,
          name: "Invalid Plan",
          price: -100,
          validityMonths: 3,
        })
      ).rejects.toThrow();

      await expect(
        MembershipPlan.create({
          organizationId: orgId,
          name: "Invalid Benefit Plan",
          price: 1000,
          validityMonths: 3,
          benefits: {
            serviceDiscountPercentage: 150, // exceeds 100%
          },
        })
      ).rejects.toThrow();
    });
  });

  describe("2. CustomerMembership Model & Lifecycle", () => {
    let planId;

    beforeAll(async () => {
      const plan = await MembershipPlan.findOne({ organizationId: orgId, code: "GOLDVIP" });
      planId = plan._id;
    });

    it("creates a customer membership in pending_payment state by default", async () => {
      const startDate = new Date();
      const endDate = new Date(startDate);
      endDate.setMonth(endDate.getMonth() + 12);

      const customerMembership = await CustomerMembership.create({
        organizationId: orgId,
        customerId,
        membershipPlanId: planId,
        membershipCode: "MEM-ALICE-001",
        planSnapshot: {
          name: "Gold VIP Membership",
          tier: "Gold",
          price: 2999,
          validityMonths: 12,
          benefits: {
            serviceDiscountPercentage: 15,
            productDiscountPercentage: 10,
            complimentaryPerks: ["Free Welcome Drink"],
          },
        },
        startDate,
        endDate,
      });

      expect(customerMembership._id).toBeDefined();
      expect(customerMembership.status).toBe("pending_payment");
      expect(customerMembership.planSnapshot.tier).toBe("Gold");
    });

    it("enforces unique membership code within the organization", async () => {
      const startDate = new Date();
      const endDate = new Date(startDate);
      endDate.setMonth(endDate.getMonth() + 12);

      await expect(
        CustomerMembership.create({
          organizationId: orgId,
          customerId,
          membershipPlanId: planId,
          membershipCode: "MEM-ALICE-001",
          planSnapshot: {
            name: "Gold VIP Membership",
            tier: "Gold",
            price: 2999,
            validityMonths: 12,
          },
          startDate,
          endDate,
        })
      ).rejects.toThrow();
    });
  });

  describe("3. Invoice Model Line Extension & Line Types", () => {
    it("supports membership purchase lines alongside service and product lines", async () => {
      const invoice = new Invoice({
        organizationId: orgId,
        branchId,
        invoiceNumber: "INV-PHASE1-001",
        invoiceType: "unified",
        customerId,
        customerSnapshot: {
          name: "Alice Wonderland",
          phone: "+919876543210",
        },
        lines: [
          {
            lineType: "membership",
            name: "Gold VIP Membership (12 Months)",
            membershipPlanId: new mongoose.Types.ObjectId(),
            membershipTierSnapshot: "Gold",
            quantity: 1,
            unitPrice: 2999,
            lineTotal: 2999,
            customerPayable: 2999,
          },
          {
            lineType: "product",
            name: "Luxury Keratin Shampoo",
            productId: new mongoose.Types.ObjectId(),
            sku: "SHAMPOO-01",
            stockUnit: "bottle",
            quantity: 1,
            unitPrice: 850,
            lineTotal: 850,
            // Membership discount applied separately to this line
            isDiscountedByMembership: true,
            membershipDiscountAmount: 85,
            customerPayable: 765,
          },
        ],
        subtotal: 3849,
        lineDiscountsTotal: 0,
        invoiceDiscountsTotal: 0,
        discountTotal: 85,
        grossPayable: 3764,
        payableAmount: 3764,
        amountDue: 3764,
        createdBy: new mongoose.Types.ObjectId(),
      });

      const validationError = invoice.validateSync();
      expect(validationError).toBeUndefined();

      await invoice.save();
      const savedInvoice = await Invoice.findById(invoice._id);
      expect(savedInvoice.lines).toHaveLength(2);
      expect(savedInvoice.lines[0].lineType).toBe("membership");
      expect(savedInvoice.lines[0].membershipTierSnapshot).toBe("Gold");
      expect(savedInvoice.lines[1].lineType).toBe("product");
      expect(savedInvoice.lines[1].isDiscountedByMembership).toBe(true);
      expect(savedInvoice.lines[1].membershipDiscountAmount).toBe(85);
    });
  });

  describe("4. Zod Unified Invoice Schema Backward Compatibility", () => {
    it("validates unified payload with membershipLines and productLines", () => {
      const validPayload = {
        body: {
          branchId: new mongoose.Types.ObjectId().toString(),
          customerId: new mongoose.Types.ObjectId().toString(),
          membershipLines: [
            {
              membershipPlanId: new mongoose.Types.ObjectId().toString(),
              quantity: 1,
            },
          ],
          productLines: [
            {
              productId: new mongoose.Types.ObjectId().toString(),
              quantity: 2,
            },
          ],
        },
      };

      const parsed = createInvoiceSchema.safeParse(validPayload);
      expect(parsed.success).toBe(true);
      expect(parsed.data.body.membershipLines).toHaveLength(1);
      expect(parsed.data.body.productLines).toHaveLength(1);
    });

    it("preserves backward compatibility with legacy appointment-only payload", () => {
      const legacyAppointmentPayload = {
        body: {
          branchId: new mongoose.Types.ObjectId().toString(),
          appointmentId: new mongoose.Types.ObjectId().toString(),
          redeemLoyaltyPoints: 0,
          notes: "Walk-in hair cut appointment",
        },
      };

      const parsed = createInvoiceSchema.safeParse(legacyAppointmentPayload);
      expect(parsed.success).toBe(true);
      expect(parsed.data.body.appointmentId).toBe(legacyAppointmentPayload.body.appointmentId);
    });

    it("preserves backward compatibility with legacy subscription-only payload", () => {
      const legacySubscriptionPayload = {
        body: {
          branchId: new mongoose.Types.ObjectId().toString(),
          subscriptionId: new mongoose.Types.ObjectId().toString(),
        },
      };

      const parsed = createInvoiceSchema.safeParse(legacySubscriptionPayload);
      expect(parsed.success).toBe(true);
      expect(parsed.data.body.subscriptionId).toBe(legacySubscriptionPayload.body.subscriptionId);
    });

    it("rejects an empty invoice with no appointment, subscription, customer or lines", () => {
      const emptyPayload = {
        body: {
          branchId: new mongoose.Types.ObjectId().toString(),
        },
      };

      const parsed = createInvoiceSchema.safeParse(emptyPayload);
      expect(parsed.success).toBe(false);
    });
  });
});
