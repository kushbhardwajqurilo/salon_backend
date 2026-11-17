import { describe, expect, it, beforeAll, afterAll, beforeEach, jest } from "@jest/globals";
import mongoose from "mongoose";
import { getIsolatedTestMongoUri } from "../testSetup.js";
import { Organization } from "../../models/organizations/organization.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { User } from "../../models/users/user.model.js";
import { Staff } from "../../models/staff/staff.model.js";
import { Appointment } from "../../models/appointments/appointment.model.js";
import { Invoice } from "../../models/billing/invoice.model.js";
import {
  InvoiceSettlementEvent,
  ServiceFulfillmentEvent,
  IncentiveLedger,
  IncentiveRecoveryObligation,
  IncentiveScheme,
  SchemeAssignment,
  IncentiveEvaluation,
  IncentiveEvaluationRevision,
} from "../../models/incentives/index.js";
import { settlementFulfillmentEventService } from "../../services/incentives/settlementFulfillmentEvent.service.js";
import { appendOnlyWriteBoundaryService } from "../../services/incentives/appendOnlyWriteBoundary.service.js";

describe("Stage 3 — Billing Settlement & Fulfillment Event Integration Suite", () => {
  jest.setTimeout(30000);
  let orgId, branchId, staffId, userId, schemeId;

  beforeAll(async () => {
    const mongoUri = getIsolatedTestMongoUri("incentives_test");
    await mongoose.connect(mongoUri);
    await Promise.all([
      InvoiceSettlementEvent.init(),
      ServiceFulfillmentEvent.init(),
      IncentiveLedger.init(),
      IncentiveRecoveryObligation.init(),
    ]);
  });

  afterAll(async () => {
    await Invoice.deleteMany({});
    await InvoiceSettlementEvent.deleteMany({});
    await ServiceFulfillmentEvent.deleteMany({});
    await IncentiveLedger.deleteMany({});
    await IncentiveRecoveryObligation.deleteMany({});
    await SchemeAssignment.deleteMany({});
    await IncentiveScheme.deleteMany({});
    await IncentiveEvaluation.deleteMany({});
    await IncentiveEvaluationRevision.deleteMany({});
    await Staff.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});
    await User.deleteMany({});
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await InvoiceSettlementEvent.deleteMany({});
    await ServiceFulfillmentEvent.deleteMany({});
    await IncentiveLedger.deleteMany({});
    await IncentiveRecoveryObligation.deleteMany({});
    await SchemeAssignment.deleteMany({});
    await IncentiveScheme.deleteMany({});
    await IncentiveEvaluation.deleteMany({});
    await IncentiveEvaluationRevision.deleteMany({});
    await Staff.deleteMany({});

    const org = await Organization.create({
      name: `Stage3 Salon ${Date.now()}`,
      slug: `s3-org-${Date.now()}-${Math.random()}`,
      status: "active",
    });
    orgId = org._id;

    const branch = await Branch.create({
      name: "Downtown Branch",
      organizationId: orgId,
      status: "active",
      isActive: true,
    });
    branchId = branch._id;

    userId = new mongoose.Types.ObjectId();

    const staff = await Staff.create({
      name: "Top Stylist",
      phone: `+919${Math.floor(100000000 + Math.random() * 900000000)}`,
      email: `stylist_${Date.now()}_${Math.random()}@test.com`,
      designation: "Senior Stylist",
      joiningDate: new Date(),
      organizationId: orgId,
      status: "active",
      staffCode: `STF-${Date.now()}`,
    });
    staffId = staff._id;

    const scheme = await IncentiveScheme.create({
      organizationId: orgId,
      name: "Hair Stylist Incentive Plan",
      code: `SCHEME_${Date.now()}`,
      schemeType: "COMMISSION",
      calculationBasis: "SERVICE_NET_REVENUE",
      rules: {
        tiers: [
          {
            minPaise: 0,
            maxPaise: null,
            percentage: 100, // 100% of revenue for standard 1:1 attribution in stage 3 tests
            fixedPaise: 0,
          },
        ],
      },
      status: "active",
    });
    schemeId = scheme._id;

    // Create active assignment for staff member
    await SchemeAssignment.create({
      organizationId: orgId,
      schemeId,
      scopeType: "STAFF",
      scopeId: staffId,
      startDate: new Date("2026-01-01T00:00:00.000Z"),
      endDate: null,
      status: "active",
    });
  });

  describe("1. Dual-Gate Order Verification", () => {
    it("snapshots persisted invoice lines and appointment staff attribution", async () => {
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        const [invoice] = await Invoice.create(
          [{
            organizationId: orgId,
            branchId,
            invoiceNumber: `INV-PERSISTED-${Date.now()}`,
            invoiceType: "appointment",
            appointmentId: new mongoose.Types.ObjectId(),
            customerId: new mongoose.Types.ObjectId(),
            customerSnapshot: { name: "Test Customer", phone: "+919876543210" },
            lines: [{
              lineType: "service",
              serviceType: "registered",
              serviceId: new mongoose.Types.ObjectId(),
              staffId,
              name: "Persisted Hair Spa",
              duration: 30,
              quantity: 1,
              unitPrice: 1000,
              lineTotal: 1000,
              isCoveredBySubscription: false,
              subscriptionCoveredAmount: 0,
              discountAmount: 100,
              customerPayable: 900,
            }],
            subtotal: 1000,
            discountTotal: 100,
            grossPayable: 900,
            payableAmount: 900,
            amountPaid: 900,
            amountDue: 0,
            paymentStatus: "paid",
            status: "finalized",
            createdBy: userId,
          }],
          { session }
        );

        const { settlementEvent, ledgerEntries } =
          await settlementFulfillmentEventService.handleInvoiceSettled({
            invoice,
            payment: { _id: new mongoose.Types.ObjectId() },
            appointment: { status: "completed", completedAt: new Date() },
            session,
            userId,
          });

        expect(settlementEvent.lineItems).toHaveLength(1);
        expect(settlementEvent.lineItems[0].itemType).toBe("service");
        expect(settlementEvent.lineItems[0].priceInPaise).toBe(100000);
        expect(settlementEvent.lineItems[0].discountInPaise).toBe(10000);
        expect(settlementEvent.lineItems[0].netRevenueInPaise).toBe(90000);
        expect(settlementEvent.lineItems[0].staffAttributions[0].staffId.toString()).toBe(
          staffId.toString()
        );
        expect(ledgerEntries).toHaveLength(1);
        expect(ledgerEntries[0].amountInPaise).toBe(90000);
        await session.commitTransaction();
      } catch (error) {
        await session.abortTransaction();
        throw error;
      } finally {
        await session.endSession();
      }
    });

    it("does not accrue service commission from a product invoice line", async () => {
      const session = await mongoose.startSession();
      session.startTransaction();
      try {
        const { settlementEvent, ledgerEntries } =
          await settlementFulfillmentEventService.handleInvoiceSettled({
            invoice: {
              _id: new mongoose.Types.ObjectId(),
              organizationId: orgId,
              branchId,
              appointmentId: new mongoose.Types.ObjectId(),
              paymentStatus: "paid",
              subtotal: 1000,
              discountTotal: 0,
              taxTotal: 0,
              payableAmount: 1000,
              items: [
                {
                  _id: new mongoose.Types.ObjectId(),
                  lineType: "product",
                  productId: new mongoose.Types.ObjectId(),
                  name: "Shampoo",
                  price: 1000,
                  finalPrice: 1000,
                  staffId,
                },
              ],
            },
            payment: { _id: new mongoose.Types.ObjectId() },
            appointment: { status: "completed", completedAt: new Date() },
            session,
            userId,
          });

        expect(settlementEvent.lineItems[0].itemType).toBe("product");
        expect(ledgerEntries).toHaveLength(0);
        expect(await IncentiveLedger.countDocuments({ organizationId: orgId }).session(session)).toBe(0);
        await session.commitTransaction();
      } catch (error) {
        await session.abortTransaction();
        throw error;
      } finally {
        await session.endSession();
      }
    });

    it("fails closed when invoice-level loyalty redemption is not allocated to service lines", async () => {
      const session = await mongoose.startSession();
      session.startTransaction();
      try {
        const [invoice] = await Invoice.create(
          [{
            organizationId: orgId,
            branchId,
            invoiceNumber: `INV-LOYALTY-${Date.now()}`,
            invoiceType: "appointment",
            appointmentId: new mongoose.Types.ObjectId(),
            customerId: new mongoose.Types.ObjectId(),
            customerSnapshot: { name: "Test Customer", phone: "+919876543210" },
            lines: [{
              lineType: "service",
              serviceType: "registered",
              serviceId: new mongoose.Types.ObjectId(),
              staffId,
              name: "Loyalty Discount Service",
              duration: 30,
              quantity: 1,
              unitPrice: 1000,
              lineTotal: 1000,
              isCoveredBySubscription: false,
              subscriptionCoveredAmount: 0,
              discountAmount: 100,
              customerPayable: 900,
            }],
            subtotal: 1000,
            discountTotal: 100,
            loyaltyDiscountAmount: 50,
            grossPayable: 850,
            payableAmount: 850,
            amountPaid: 850,
            amountDue: 0,
            paymentStatus: "paid",
            status: "finalized",
            createdBy: userId,
          }],
          { session }
        );

        const { settlementEvent, ledgerEntries } =
          await settlementFulfillmentEventService.handleInvoiceSettled({
            invoice,
            payment: { _id: new mongoose.Types.ObjectId() },
            appointment: { status: "completed", completedAt: new Date() },
            session,
            userId,
          });

        expect(settlementEvent.commissionSkipReason).toBe("UNALLOCATED_LOYALTY_DISCOUNT");
        expect(ledgerEntries).toHaveLength(0);
        expect(await IncentiveLedger.countDocuments({ organizationId: orgId }).session(session)).toBe(0);
        await session.commitTransaction();
      } catch (error) {
        await session.abortTransaction();
        throw error;
      } finally {
        await session.endSession();
      }
    });

    it("does not accrue commission from an attendance bonus scheme", async () => {
      const attendanceScheme = await IncentiveScheme.create({
        organizationId: orgId,
        name: "Attendance Bonus Plan",
        code: `ATTENDANCE_${Date.now()}`,
        schemeType: "ATTENDANCE_BONUS",
        calculationBasis: "ATTENDANCE_DAYS",
        rules: { minimumAttendanceDays: 24, fixedAmountPaise: 100000 },
        status: "active",
      });
      await SchemeAssignment.updateOne(
        { organizationId: orgId, scopeType: "STAFF", scopeId: staffId },
        { $set: { schemeId: attendanceScheme._id } }
      );

      const session = await mongoose.startSession();
      session.startTransaction();
      try {
        const { ledgerEntries } = await settlementFulfillmentEventService.handleInvoiceSettled({
          invoice: {
            _id: new mongoose.Types.ObjectId(),
            organizationId: orgId,
            branchId,
            appointmentId: new mongoose.Types.ObjectId(),
            paymentStatus: "paid",
            subtotal: 1000,
            discountTotal: 0,
            taxTotal: 0,
            payableAmount: 1000,
            items: [
              {
                _id: new mongoose.Types.ObjectId(),
                itemType: "service",
                name: "Hair Spa",
                price: 1000,
                finalPrice: 1000,
                staffId,
              },
            ],
          },
          payment: { _id: new mongoose.Types.ObjectId() },
          appointment: { status: "completed", completedAt: new Date() },
          session,
          userId,
        });

        expect(ledgerEntries).toHaveLength(0);
        expect(await IncentiveLedger.countDocuments({ organizationId: orgId }).session(session)).toBe(0);
        await session.commitTransaction();
      } catch (error) {
        await session.abortTransaction();
        throw error;
      } finally {
        await session.endSession();
      }
    });

    it.each(["subscription", "membership"])(
      "does not accrue service commission from a %s purchase line",
      async (lineType) => {
        const session = await mongoose.startSession();
        session.startTransaction();
        try {
          const { settlementEvent, ledgerEntries } =
            await settlementFulfillmentEventService.handleInvoiceSettled({
              invoice: {
                _id: new mongoose.Types.ObjectId(),
                organizationId: orgId,
                branchId,
                paymentStatus: "paid",
                subtotal: 1000,
                discountTotal: 0,
                taxTotal: 0,
                payableAmount: 1000,
                lines: [{
                  _id: new mongoose.Types.ObjectId(),
                  lineType,
                  name: `${lineType} purchase`,
                  lineTotal: 1000,
                  discountAmount: 0,
                  customerPayable: 1000,
                  staffId,
                }],
              },
              payment: { _id: new mongoose.Types.ObjectId() },
              appointment: { status: "completed", completedAt: new Date() },
              session,
              userId,
            });

          expect(settlementEvent.lineItems[0].itemType).toBe(lineType);
          expect(ledgerEntries).toHaveLength(0);
          await session.commitTransaction();
        } catch (error) {
          await session.abortTransaction();
          throw error;
        } finally {
          await session.endSession();
        }
      }
    );

    it("Gate Order A: Settlement then Fulfillment — accrual creates upon fulfillment completion", async () => {
      const session = await mongoose.startSession();
      session.startTransaction();

      const invoiceId = new mongoose.Types.ObjectId();
      const paymentId = new mongoose.Types.ObjectId();
      const appointmentId = new mongoose.Types.ObjectId();
      const lineItemId = new mongoose.Types.ObjectId();

      // Step 1: Invoice fully settled before physical fulfillment
      const invoice = {
        _id: invoiceId,
        organizationId: orgId,
        branchId,
        appointmentId,
        invoiceNumber: `INV-${Date.now()}-1`,
        paymentStatus: "paid",
        status: "finalized",
        subtotal: 1000,
        discountTotal: 0,
        taxTotal: 0,
        payableAmount: 1000,
        amountPaid: 1000,
        amountDue: 0,
        items: [
          {
            _id: lineItemId,
            itemType: "service",
            name: "Hair Spa",
            price: 1000,
            discount: 0,
            finalPrice: 1000,
            staffId,
          },
        ],
      };

      const payment = { _id: paymentId };

      // Gate 1 executes: settlement event created, but appointment is not completed yet
      const { settlementEvent, ledgerEntries: earlyEntries } =
        await settlementFulfillmentEventService.handleInvoiceSettled({
          invoice,
          payment,
          session,
          userId,
        });

      expect(settlementEvent).toBeDefined();
      expect(earlyEntries.length).toBe(0); // Gate 2 not satisfied yet!

      // Step 2: Appointment physical fulfillment completed
      const appointment = {
        _id: appointmentId,
        organizationId: orgId,
        branchId,
        status: "completed",
        completedAt: new Date(),
      };

      const ledgerEntries =
        await settlementFulfillmentEventService.handlePhysicalFulfillmentCompleted({
          appointment,
          invoice,
          session,
          userId,
        });

      expect(ledgerEntries.length).toBe(1);
      expect(ledgerEntries[0].amountInPaise).toBe(100000);
      expect(ledgerEntries[0].fulfillmentStatus).toBe("confirmed");
      expect(ledgerEntries[0].staffId.toString()).toBe(staffId.toString());

      await session.commitTransaction();
      await session.endSession();
    });

    it("Gate Order B: Fulfillment then Settlement — accrual creates upon payment settlement", async () => {
      const session = await mongoose.startSession();
      session.startTransaction();

      const invoiceId = new mongoose.Types.ObjectId();
      const paymentId = new mongoose.Types.ObjectId();
      const appointmentId = new mongoose.Types.ObjectId();
      const lineItemId = new mongoose.Types.ObjectId();

      const appointment = {
        _id: appointmentId,
        organizationId: orgId,
        branchId,
        status: "completed",
        completedAt: new Date(),
      };

      // Gate 2 completes first (service rendered before payment)
      const earlyEntries =
        await settlementFulfillmentEventService.handlePhysicalFulfillmentCompleted({
          appointment,
          session,
          userId,
        });
      expect(earlyEntries.length).toBe(0); // Settlement has not happened yet!

      // Gate 1 executes: Invoice settled
      const invoice = {
        _id: invoiceId,
        organizationId: orgId,
        branchId,
        appointmentId,
        invoiceNumber: `INV-${Date.now()}-2`,
        paymentStatus: "paid",
        status: "finalized",
        subtotal: 2000,
        discountTotal: 0,
        taxTotal: 0,
        payableAmount: 2000,
        amountPaid: 2000,
        amountDue: 0,
        items: [
          {
            _id: lineItemId,
            itemType: "service",
            name: "Keratin Treatment",
            price: 2000,
            discount: 0,
            finalPrice: 2000,
            staffId,
          },
        ],
      };

      const payment = { _id: paymentId };

      const { settlementEvent, ledgerEntries } =
        await settlementFulfillmentEventService.handleInvoiceSettled({
          invoice,
          payment,
          appointment,
          session,
          userId,
        });

      expect(settlementEvent).toBeDefined();
      expect(ledgerEntries.length).toBe(1);
      expect(ledgerEntries[0].amountInPaise).toBe(200000);
      expect(ledgerEntries[0].fulfillmentStatus).toBe("confirmed");

      await session.commitTransaction();
      await session.endSession();
    });

    it("walk-in settlement-first fulfillment is pending until confirmed and retries create one event and earning", async () => {
      const session = await mongoose.startSession();
      session.startTransaction();
      try {
        const invoice = {
          _id: new mongoose.Types.ObjectId(),
          organizationId: orgId,
          branchId,
          appointmentId: null,
          status: "finalized",
          paymentStatus: "paid",
          invoiceNumber: `INV-WALKIN-${Date.now()}`,
          subtotal: 1000,
          discountTotal: 0,
          taxTotal: 0,
          payableAmount: 1000,
          amountPaid: 1000,
          amountDue: 0,
          lines: [{
            _id: new mongoose.Types.ObjectId(),
            lineType: "service",
            serviceType: "registered",
            name: "Walk-in service",
            duration: 30,
            quantity: 1,
            unitPrice: 1000,
            lineTotal: 1000,
            discountAmount: 0,
            customerPayable: 1000,
            staffId,
          }],
        };
        const { settlementEvent, ledgerEntries: beforeFulfillment } =
          await settlementFulfillmentEventService.handleInvoiceSettled({
            invoice,
            payment: { _id: new mongoose.Types.ObjectId() },
            session,
            userId,
          });
        expect(settlementEvent).toBeDefined();
        expect(beforeFulfillment).toHaveLength(0);

        const confirmation = {
          invoice,
          lineIds: [invoice.lines[0]._id.toString()],
          reason: "Walk-in service completed",
          userId,
          session,
        };
        const firstConfirmation =
          await settlementFulfillmentEventService.confirmWalkInServiceFulfillment(confirmation);
        const retryConfirmation =
          await settlementFulfillmentEventService.confirmWalkInServiceFulfillment(confirmation);

        expect(firstConfirmation.ledgerEntries).toHaveLength(1);
        expect(retryConfirmation.ledgerEntries).toHaveLength(1);
        expect(await ServiceFulfillmentEvent.countDocuments({
          organizationId: orgId,
          invoiceId: invoice._id,
        }).session(session)).toBe(1);
        expect(await IncentiveLedger.countDocuments({
          organizationId: orgId,
          invoiceId: invoice._id,
          entryType: "ACCRUAL",
        }).session(session)).toBe(1);
        await session.commitTransaction();
      } finally {
        await session.endSession();
      }
    });

    it("walk-in fulfillment-first is recorded without earnings until full settlement", async () => {
      const session = await mongoose.startSession();
      session.startTransaction();
      try {
        const invoice = {
          _id: new mongoose.Types.ObjectId(),
          organizationId: orgId,
          branchId,
          appointmentId: null,
          status: "finalized",
          paymentStatus: "unpaid",
          invoiceNumber: `INV-WALKIN-FIRST-${Date.now()}`,
          subtotal: 1000,
          discountTotal: 0,
          taxTotal: 0,
          payableAmount: 1000,
          amountPaid: 0,
          amountDue: 1000,
          lines: [{
            _id: new mongoose.Types.ObjectId(),
            lineType: "service",
            serviceType: "registered",
            name: "Walk-in service",
            duration: 30,
            quantity: 1,
            unitPrice: 1000,
            lineTotal: 1000,
            discountAmount: 0,
            customerPayable: 1000,
            staffId,
          }],
        };
        const confirmation =
          await settlementFulfillmentEventService.confirmWalkInServiceFulfillment({
            invoice,
            lineIds: [invoice.lines[0]._id.toString()],
            reason: "Service completed before payment",
            userId,
            session,
          });
        expect(confirmation.ledgerEntries).toHaveLength(0);
        expect(await IncentiveLedger.countDocuments({
          organizationId: orgId,
          invoiceId: invoice._id,
          entryType: "ACCRUAL",
        }).session(session)).toBe(0);

        invoice.paymentStatus = "paid";
        invoice.amountPaid = 1000;
        invoice.amountDue = 0;
        const { ledgerEntries } =
          await settlementFulfillmentEventService.handleInvoiceSettled({
            invoice,
            payment: { _id: new mongoose.Types.ObjectId() },
            session,
            userId,
          });
        expect(ledgerEntries).toHaveLength(1);
        expect(ledgerEntries[0].fulfillmentStatus).toBe("confirmed");
        await session.commitTransaction();
      } finally {
        await session.endSession();
      }
    });
  });

  describe("2. Partial Payments, Voids, and Product Returns", () => {
    it("partial payment does not satisfy Gate 1 and emits no earning", async () => {
      const session = await mongoose.startSession();
      session.startTransaction();

      const invoice = {
        _id: new mongoose.Types.ObjectId(),
        organizationId: orgId,
        branchId,
        paymentStatus: "partially_paid", // NOT PAID
        subtotal: 1000,
        payableAmount: 1000,
        amountPaid: 400,
        items: [{ _id: new mongoose.Types.ObjectId(), name: "Cut", price: 1000, staffId }],
      };

      const payment = { _id: new mongoose.Types.ObjectId() };

      const { settlementEvent, ledgerEntries } =
        await settlementFulfillmentEventService.handleInvoiceSettled({
          invoice,
          payment,
          session,
          userId,
        });

      expect(settlementEvent).toBeDefined();
      expect(ledgerEntries.length).toBe(0); // No earning for partial payment!

      await session.commitTransaction();
      await session.endSession();
    });

    it("voided payment creates UNSETTLED event, clawback ledger entry, and recovery obligation", async () => {
      const session = await mongoose.startSession();
      session.startTransaction();

      const invoiceId = new mongoose.Types.ObjectId();
      const lineItemId = new mongoose.Types.ObjectId();
      const paymentId = new mongoose.Types.ObjectId();

      // Seed prior accrual
      const priorAccrual = await appendOnlyWriteBoundaryService.appendLedgerEntry(
        {
          branchId,
          staffId,
          schemeId,
          entryType: "ACCRUAL",
          settlementEventId: new mongoose.Types.ObjectId(),
          invoiceId,
          lineItemId,
          fulfillmentStatus: "confirmed",
          sourceRevenueInPaise: 100000,
          attributedRevenueInPaise: 100000,
          amountInPaise: 100000,
          idempotencyKey: `ACCRUAL:SEED:${invoiceId}`,
        },
        orgId,
        { session }
      );

      const invoice = {
        _id: invoiceId,
        organizationId: orgId,
        branchId,
        subtotal: 1000,
        discountTotal: 0,
        taxTotal: 0,
      };

      const payment = { _id: paymentId };

      const { unsettleEvent, clawbackEntries } =
        await settlementFulfillmentEventService.handlePaymentVoided({
          payment,
          invoice,
          session,
          userId,
          reason: "Customer check bounced",
        });
      const retryVoid =
        await settlementFulfillmentEventService.handlePaymentVoided({
          payment,
          invoice,
          session,
          userId,
          reason: "Customer check bounced",
        });

      expect(unsettleEvent.eventType).toBe("UNSETTLED");
      expect(clawbackEntries.length).toBe(1);
      expect(retryVoid.unsettleEvent._id.toString()).toBe(unsettleEvent._id.toString());
      expect(retryVoid.clawbackEntries[0]._id.toString()).toBe(clawbackEntries[0]._id.toString());
      expect(clawbackEntries[0].entryType).toBe("CLAWBACK");
      expect(clawbackEntries[0].amountInPaise).toBe(100000);

      // Verify Recovery Obligation created
      const obligation = await IncentiveRecoveryObligation.findOne(
        { organizationId: orgId, clawbackLedgerId: clawbackEntries[0]._id },
        null,
        { session }
      );
      expect(obligation).toBeDefined();
      expect(obligation.originalClawbackInPaise).toBe(100000);
      expect(obligation.status).toBe("pending");
      expect(await IncentiveRecoveryObligation.countDocuments({
        organizationId: orgId,
        clawbackLedgerId: clawbackEntries[0]._id,
      }).session(session)).toBe(1);
      expect(await InvoiceSettlementEvent.countDocuments({
        organizationId: orgId,
        invoiceId,
        eventType: "UNSETTLED",
      }).session(session)).toBe(1);

      await session.commitTransaction();
      await session.endSession();
    });

    it("product return creates incremental clawback and recovery obligation using returnOperationId", async () => {
      const session = await mongoose.startSession();
      session.startTransaction();

      const invoiceId = new mongoose.Types.ObjectId();
      const lineItemId = new mongoose.Types.ObjectId();

      await appendOnlyWriteBoundaryService.appendLedgerEntry(
        {
          branchId,
          staffId,
          schemeId,
          entryType: "ACCRUAL",
          settlementEventId: new mongoose.Types.ObjectId(),
          invoiceId,
          lineItemId,
          fulfillmentStatus: "confirmed",
          sourceRevenueInPaise: 50000,
          attributedRevenueInPaise: 50000,
          amountInPaise: 50000,
          idempotencyKey: `ACCRUAL:PROD:${lineItemId}`,
        },
        orgId,
        { session }
      );

      const invoice = { _id: invoiceId, organizationId: orgId, branchId };

      const clawbacks = await settlementFulfillmentEventService.handleProductReturnProcessed({
        invoice,
        returnedItems: [{ lineItemId: lineItemId.toString(), returnQty: 1, refundPaise: 50000 }],
        returnOperationId: "RET-OP-999",
        session,
        userId,
      });
      const retryClawbacks = await settlementFulfillmentEventService.handleProductReturnProcessed({
        invoice,
        returnedItems: [{ lineItemId: lineItemId.toString(), returnQty: 1, refundPaise: 50000 }],
        returnOperationId: "RET-OP-999",
        session,
        userId,
      });

      expect(clawbacks.length).toBe(1);
      expect(retryClawbacks.length).toBe(1);
      expect(retryClawbacks[0]._id.toString()).toBe(clawbacks[0]._id.toString());
      expect(clawbacks[0].entryType).toBe("CLAWBACK");
      expect(clawbacks[0].amountInPaise).toBe(50000);

      const obligation = await IncentiveRecoveryObligation.findOne(
        { organizationId: orgId, clawbackLedgerId: clawbacks[0]._id },
        null,
        { session }
      );
      expect(obligation).toBeDefined();
      expect(obligation.originalClawbackInPaise).toBe(50000);
      expect(await IncentiveRecoveryObligation.countDocuments({
        organizationId: orgId,
        clawbackLedgerId: clawbacks[0]._id,
      }).session(session)).toBe(1);

      await session.commitTransaction();
      await session.endSession();
    });

    it("claws back retail commission proportionally across separate partial refunds", async () => {
      const session = await mongoose.startSession();
      session.startTransaction();

      const invoiceId = new mongoose.Types.ObjectId();
      const lineItemId = new mongoose.Types.ObjectId();
      const settlementEventId = new mongoose.Types.ObjectId();
      const accrual = await appendOnlyWriteBoundaryService.appendLedgerEntry(
        {
          branchId,
          staffId,
          schemeId,
          entryType: "ACCRUAL",
          sourceType: "retail_sale_commission",
          settlementEventId,
          invoiceId,
          lineItemId,
          fulfillmentStatus: "not_applicable",
          sourceRevenueInPaise: 50000,
          attributedRevenueInPaise: 50000,
          amountInPaise: 5000,
          idempotencyKey: `ACCRUAL:RETAIL-PARTIAL:${lineItemId}`,
        },
        orgId,
        { session },
      );
      const invoice = { _id: invoiceId, organizationId: orgId, branchId };

      const firstClawback = await settlementFulfillmentEventService.handleProductReturnProcessed({
        invoice,
        returnedItems: [{
          lineItemId: lineItemId.toString(),
          returnQty: 1,
          refundPaise: 10000,
        }],
        returnOperationId: "RET-PARTIAL-1",
        session,
        userId,
      });
      const secondClawback = await settlementFulfillmentEventService.handleProductReturnProcessed({
        invoice,
        returnedItems: [{
          lineItemId: lineItemId.toString(),
          returnQty: 1,
          refundPaise: 10000,
        }],
        returnOperationId: "RET-PARTIAL-2",
        session,
        userId,
      });

      expect(firstClawback).toHaveLength(1);
      expect(firstClawback[0].amountInPaise).toBe(1000);
      expect(secondClawback).toHaveLength(1);
      expect(secondClawback[0].amountInPaise).toBe(1000);
      const persistedClawbacks = await IncentiveLedger.find({
        organizationId: orgId,
        reversesLedgerId: accrual._id,
        entryType: "CLAWBACK",
      }).session(session);
      expect(persistedClawbacks.reduce((sum, entry) => sum + entry.amountInPaise, 0)).toBe(2000);

      await session.commitTransaction();
      await session.endSession();
    });
  });

  describe("3. Subscription Manual Consumption & Legacy Missing Evidence", () => {
    it("manual POS subscription redemption without fulfillment evidence produces NO ledger earning", async () => {
      const session = await mongoose.startSession();
      session.startTransaction();

      // POS invoice without appointment containing unfulfilled manual service
      const invoice = {
        _id: new mongoose.Types.ObjectId(),
        organizationId: orgId,
        branchId,
        paymentStatus: "paid",
        appointmentId: null, // Walk-in / manual
        subtotal: 0,
        payableAmount: 0,
        amountPaid: 0,
        items: [
          {
            _id: new mongoose.Types.ObjectId(),
            itemType: "service", // Service line without verified appointment
            name: "Facial Session",
            price: 0,
            staffId,
          },
        ],
      };

      const payment = { _id: new mongoose.Types.ObjectId() };

      const { ledgerEntries } = await settlementFulfillmentEventService.handleInvoiceSettled({
        invoice,
        payment,
        session,
        userId,
      });

      expect(ledgerEntries.length).toBe(0); // Strict failure closed: no physical fulfillment proof!

      await session.commitTransaction();
      await session.endSession();
    });

    it("legacy transaction without staff attribution does not fabricate earning", async () => {
      const session = await mongoose.startSession();
      session.startTransaction();

      const invoice = {
        _id: new mongoose.Types.ObjectId(),
        organizationId: orgId,
        branchId,
        paymentStatus: "paid",
        subtotal: 1000,
        payableAmount: 1000,
        amountPaid: 1000,
        items: [
          {
            _id: new mongoose.Types.ObjectId(),
            itemType: "product",
            name: "Shampoo Bottle",
            price: 1000,
            staffId: null, // Legacy missing staff attribution!
          },
        ],
      };

      const payment = { _id: new mongoose.Types.ObjectId() };

      const { ledgerEntries } = await settlementFulfillmentEventService.handleInvoiceSettled({
        invoice,
        payment,
        session,
        userId,
      });

      expect(ledgerEntries.length).toBe(0); // Zero fabricated staff earnings!

      await session.commitTransaction();
      await session.endSession();
    });
  });

  describe("4. Stage 2 Review Close Checks", () => {
    it("appendLedgerEntry: rejects conflicting reuse of an existing idempotency key", async () => {
      const invoiceId = new mongoose.Types.ObjectId();
      const lineItemId = new mongoose.Types.ObjectId();
      const key = `KEY_REUSE_TEST_${Date.now()}`;

      // Insert first valid ledger entry
      await appendOnlyWriteBoundaryService.appendLedgerEntry(
        {
          branchId,
          staffId,
          schemeId,
          entryType: "ACCRUAL",
          settlementEventId: new mongoose.Types.ObjectId(),
          invoiceId,
          lineItemId,
          fulfillmentStatus: "confirmed",
          sourceRevenueInPaise: 50000,
          attributedRevenueInPaise: 50000,
          amountInPaise: 50000,
          idempotencyKey: key,
        },
        orgId
      );

      // Attempt conflicting reuse with differing amount
      await expect(
        appendOnlyWriteBoundaryService.appendLedgerEntry(
          {
            branchId,
            staffId,
            schemeId,
            entryType: "ACCRUAL",
            settlementEventId: new mongoose.Types.ObjectId(),
            invoiceId,
            lineItemId,
            fulfillmentStatus: "confirmed",
            sourceRevenueInPaise: 50000,
            attributedRevenueInPaise: 50000,
            amountInPaise: 99999, // Conflicting amount!
            idempotencyKey: key,
          },
          orgId
        )
      ).rejects.toThrow("Idempotency conflict");
    });

    it("appendEvaluationRevision: atomically updates evaluation and rolls back on revision failure", async () => {
      const evaluation = await IncentiveEvaluation.create({
        organizationId: orgId,
        branchId,
        staffId,
        schemeId,
        monthYear: "2026-11",
        evaluationType: "TARGET_BONUS",
        targetPaise: 500000,
        achievedPaise: 600000,
        isTargetMet: true,
        bonusAwardedInPaise: 20000,
      });

      const rev = await appendOnlyWriteBoundaryService.appendEvaluationRevision(
        {
          evaluationId: evaluation._id,
          previousValueInPaise: 20000,
          newValueInPaise: 35000,
          deltaInPaise: 15000,
          reason: "Approved performance override",
          updateEvaluation: true,
        },
        orgId,
        userId
      );

      expect(rev.revisionNumber).toBe(1);

      // Verify evaluation was updated in the same transaction
      const updatedEval = await IncentiveEvaluation.findById(evaluation._id);
      expect(updatedEval.bonusAwardedInPaise).toBe(35000);
      expect(updatedEval.status).toBe("overridden");
    });
  });
});
