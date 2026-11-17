import mongoose from "mongoose";
import { InvoiceSettlementEvent } from "../../models/incentives/invoiceSettlementEvent.model.js";
import { ServiceFulfillmentEvent } from "../../models/incentives/serviceFulfillmentEvent.model.js";
import { IncentiveLedger } from "../../models/incentives/incentiveLedger.model.js";
import { IncentiveRecoveryObligation } from "../../models/incentives/incentiveRecoveryObligation.model.js";
import { StockMovement } from "../../models/inventory/stockMovement.model.js";
import { SchemeAssignmentService, schemeAssignmentService } from "./schemeAssignment.service.js";
import { appendOnlyWriteBoundaryService } from "./appendOnlyWriteBoundary.service.js";
import { IncentiveCalculationEngine } from "./incentiveCalculation.engine.js";
import { AppError } from "../../utils/errors.js";

/**
 * Service managing billing settlement snapshot emission, physical fulfillment verification,
 * and exact-once incentive accrual upon satisfying dual-gate prerequisites:
 *   Gate 1: Full invoice settlement (`paymentStatus === "paid"`).
 *   Gate 2: Verified physical service fulfillment (`status === "completed"` or physical fulfillment confirmation).
 */
export class SettlementFulfillmentEventService {
  /**
   * Helper to convert rupee floating point values to integer paise safely.
   * @param {number} rupees
   * @returns {number}
   */
  static rupeesToPaise(rupees) {
    if (rupees === undefined || rupees === null) return 0;
    return Math.round(Number(rupees) * 100);
  }

  /**
   * 1. INVOICE SETTLEMENT HOOK
   * Called within the billing transaction when an invoice reaches `paymentStatus === "paid"`.
   * Emits an InvoiceSettlementEvent and assesses dual-gate incentive earning.
   *
   * @param {Object} params
   * @param {Object} params.invoice - Mongoose Invoice document
   * @param {Object} params.payment - Mongoose Payment document
   * @param {mongoose.ClientSession} params.session
   * @param {mongoose.Types.ObjectId|string} params.userId
   * @returns {Promise<{ settlementEvent: InvoiceSettlementEvent, ledgerEntries: IncentiveLedger[] }>}
   */
  async handleInvoiceSettled({ invoice, payment, appointment = null, session, userId }) {
    if (!invoice || !payment || !session) {
      throw new AppError("invoice, payment, and active session are required for handleInvoiceSettled", 400);
    }
    const invoiceLines = Array.isArray(invoice.lines)
      ? invoice.lines
      : Array.isArray(invoice.items)
        ? invoice.items
        : null;
    if (!invoiceLines) {
      throw new AppError("Invoice settlement requires persisted invoice lines", 400);
    }

    const organizationId = invoice.organizationId;
    const branchId = invoice.branchId;
    const hasUnallocatedLoyaltyDiscount = Number(invoice.loyaltyDiscountAmount || 0) > 0;

    // Count existing settlement events to calculate authoritative monotonic cycle
    const existingEventsCount = await InvoiceSettlementEvent.countDocuments({
      organizationId,
      invoiceId: invoice._id,
    }).session(session);

    const settlementCycle = existingEventsCount + 1;
    const idempotencyKey = `SETTLE:INV:${invoice._id}:PAY:${payment._id}:CYCLE:${settlementCycle}`;

    // Check idempotency
    let settlementEvent = await InvoiceSettlementEvent.findOne(
      { organizationId, idempotencyKey },
      null,
      { session }
    );

    if (!settlementEvent) {
      // Build immutable snapshot of invoice line items and source staff attributions
      const snapshotLineItems = invoiceLines.map((item) => {
        const lineTotal = item.lineTotal ??
          item.price ??
          Number(item.unitPrice || 0) * Number(item.quantity || 1);
        const discount = item.discountAmount ?? item.discount ?? 0;
        const customerPayable = item.customerPayable ??
          item.finalPrice ??
          Math.max(0, Number(lineTotal) - Number(discount));
        const itemType =
          item.itemType ||
          (item.lineType === "service" && item.serviceType === "custom"
            ? "custom_service"
            : item.lineType) ||
          (item.productId ? "product" : "service");
        const remainingProductQuantity =
          itemType === "product"
            ? Math.max(
                0,
                Number(item.quantity || 0) - Number(item.returnedQuantity || 0),
              )
            : Number(item.quantity || 1);
        const productRevenueRatio =
          itemType === "product" && Number(item.quantity) > 0
            ? remainingProductQuantity / Number(item.quantity)
            : 1;
        const priceInPaise = SettlementFulfillmentEventService.rupeesToPaise(
          lineTotal * productRevenueRatio,
        );
        const discountInPaise = SettlementFulfillmentEventService.rupeesToPaise(
          discount * productRevenueRatio,
        );
        const netRevenueInPaise = SettlementFulfillmentEventService.rupeesToPaise(
          customerPayable * productRevenueRatio,
        );
        const staffAttributions = [];
        const sourceStaffId = item.staffId || null;

        if (
          sourceStaffId &&
          (itemType === "service" || itemType === "custom_service")
        ) {
          staffAttributions.push({
            staffId: new mongoose.Types.ObjectId(sourceStaffId),
            splitPercentage: 100,
            attributedPaise: netRevenueInPaise,
          });
        }
        if (
          (itemType === "subscription" || itemType === "membership") &&
          item.attribution?.soldBy?.staffId
        ) {
          staffAttributions.push({
            staffId: new mongoose.Types.ObjectId(item.attribution.soldBy.staffId),
            splitPercentage: 100,
            attributedPaise: netRevenueInPaise,
          });
        }
        if (itemType === "product" && item.attribution?.soldBy?.staffId) {
          staffAttributions.push({
            staffId: new mongoose.Types.ObjectId(item.attribution.soldBy.staffId),
            splitPercentage: 100,
            attributedPaise: netRevenueInPaise,
          });
        }

        return {
          itemId: item._id || new mongoose.Types.ObjectId(),
          sourceEntityId:
            item.subscriptionId ||
            item.customerMembershipId ||
            item.productId ||
            null,
          itemType,
          name: item.name || "Line Item",
          priceInPaise,
          discountInPaise,
          netRevenueInPaise,
          staffAttributions,
          sourceAttribution: item.attribution || {},
        };
      });

      const [createdEvent] = await InvoiceSettlementEvent.create(
        [
          {
            organizationId,
            branchId,
            invoiceId: invoice._id,
            paymentId: payment._id,
            appointmentId: invoice.appointmentId || null,
            subscriptionId: invoice.subscriptionId || null,
            eventType: "SETTLED",
            settlementCycle,
            grossAmountInPaise: SettlementFulfillmentEventService.rupeesToPaise(invoice.subtotal),
            discountAmountInPaise: SettlementFulfillmentEventService.rupeesToPaise(invoice.discountTotal || 0),
            taxAmountInPaise: SettlementFulfillmentEventService.rupeesToPaise(invoice.taxTotal || 0),
            netSettledInPaise: SettlementFulfillmentEventService.rupeesToPaise(invoice.payableAmount || invoice.amountPaid),
            lineItems: snapshotLineItems,
            commissionSkipReason: hasUnallocatedLoyaltyDiscount
              ? "UNALLOCATED_LOYALTY_DISCOUNT"
              : null,
            idempotencyKey,
            eventTimestamp: new Date(),
          },
        ],
        { session }
      );
      settlementEvent = createdEvent;
    }

    // Now evaluate dual-gate condition: check if physical fulfillment is already verified
    const ledgerEntries = await this.evaluateDualGateIncentiveEarning({
      settlementEvent,
      invoice,
      appointment,
      session,
      userId,
    });

    return { settlementEvent, ledgerEntries };
  }

  /**
   * 2. PHYSICAL SERVICE FULFILLMENT HOOK
   * Called when an appointment reaches `status === "completed"`, or when physical fulfillment
   * is confirmed for pending services.
   *
   * @param {Object} params
   * @param {Object} params.appointment - Mongoose Appointment document
   * @param {mongoose.ClientSession} params.session
   * @param {mongoose.Types.ObjectId|string} params.userId
   * @returns {Promise<IncentiveLedger[]>}
   */
  async handlePhysicalFulfillmentCompleted({ appointment, invoice = null, session, userId }) {
    if (!appointment || !session) {
      throw new AppError("appointment and active session are required for handlePhysicalFulfillmentCompleted", 400);
    }
    const organizationId = appointment.organizationId;

    // Find the latest settled event associated with this appointment
    const settlementEvent = await InvoiceSettlementEvent.findOne(
      {
        organizationId,
        appointmentId: appointment._id,
        eventType: "SETTLED",
      },
      null,
      { session }
    ).sort({ settlementCycle: -1 });

    if (!settlementEvent) {
      // Payment has not happened yet (fulfillment-first ordering).
      // Ledger entry creation is deferred until handleInvoiceSettled executes.
      return [];
    }

    // Load invoice or use passed invoice
    const targetInvoice =
      invoice ||
      (await mongoose.model("Invoice").findOne(
        {
          _id: settlementEvent.invoiceId,
          organizationId,
        },
        null,
        { session }
      ));

    if (!targetInvoice || targetInvoice.paymentStatus !== "paid") {
      // Not fully settled financially
      return [];
    }

    return await this.evaluateDualGateIncentiveEarning({
      settlementEvent,
      invoice: targetInvoice,
      appointment,
      session,
      userId,
    });
  }

  async confirmWalkInServiceFulfillment({
    invoice,
    lineIds,
    reason,
    userId,
    session,
  }) {
    if (!invoice || !Array.isArray(lineIds) || !reason || !userId || !session) {
      throw new AppError("invoice, lineIds, reason, userId, and active session are required", 400);
    }
    if (invoice.appointmentId) {
      throw new AppError("Walk-in fulfillment cannot be recorded for an appointment invoice", 400);
    }
    if (!["finalized", "paid"].includes(invoice.status)) {
      throw new AppError("Invoice must be finalized before service fulfillment is confirmed", 409);
    }

    const requestedIds = [...new Set(lineIds.map((id) => id.toString()))];
    if (requestedIds.length !== lineIds.length) {
      throw new AppError("Duplicate invoice line IDs are not allowed", 400);
    }

    const linesById = new Map(
      (invoice.lines || []).map((line) => [line._id.toString(), line]),
    );
    const lineIdsToConfirm = requestedIds.map((id) => {
      const line = linesById.get(id);
      if (!line || line.lineType !== "service") {
        throw new AppError("Every fulfillment line must be a service on this invoice", 400);
      }
      return line._id;
    });

    const events = [];
    for (const lineItemId of lineIdsToConfirm) {
      const idempotencyKey = `FULFILL:WALKIN:INV:${invoice._id}:LINE:${lineItemId}`;
      let event = await ServiceFulfillmentEvent.findOne(
        { organizationId: invoice.organizationId, idempotencyKey },
        null,
        { session },
      );
      if (!event) {
        [event] = await ServiceFulfillmentEvent.create(
          [{
            organizationId: invoice.organizationId,
            branchId: invoice.branchId,
            invoiceId: invoice._id,
            lineItemId,
            confirmedBy: userId,
            reason,
            idempotencyKey,
            eventTimestamp: new Date(),
          }],
          { session },
        );
      }
      events.push(event);
    }

    const settlementEvent = await InvoiceSettlementEvent.findOne(
      {
        organizationId: invoice.organizationId,
        invoiceId: invoice._id,
        eventType: "SETTLED",
      },
      null,
      { session },
    ).sort({ settlementCycle: -1 });

    const ledgerEntries =
      invoice.paymentStatus === "paid" && settlementEvent
        ? await this.evaluateDualGateIncentiveEarning({
            settlementEvent,
            invoice,
            session,
            userId,
          })
        : [];

    return { events, ledgerEntries };
  }

  /**
   * 3. DUAL-GATE EVALUATION & EXACT-ONCE LEDGER EMISSION
   * Core logic ensuring earning entries are posted exactly once when both gates are satisfied.
   */
  async evaluateDualGateIncentiveEarning({
    settlementEvent,
    invoice,
    appointment = null,
    session,
    userId,
  }) {
    const organizationId = settlementEvent.organizationId;
    const branchId = settlementEvent.branchId;

    // Check Gate 1: Invoice must be fully settled ("paid")
    if (invoice.paymentStatus !== "paid") {
      return [];
    }
    if (
      settlementEvent.commissionSkipReason === "UNALLOCATED_LOYALTY_DISCOUNT" ||
      Number(invoice.loyaltyDiscountAmount || 0) > 0
    ) {
      return [];
    }

    // Check Gate 2 per service line so one confirmed walk-in line cannot release
    // commission for another line that is still physically pending.
    let completedAppointment = appointment;
    if (appointment) {
      completedAppointment =
        appointment.status === "completed" ? appointment : null;
    } else if (invoice.appointmentId) {
      completedAppointment = await mongoose.model("Appointment").findOne(
        { _id: invoice.appointmentId, organizationId, status: "completed" },
        null,
        { session }
      );
    }

    const serviceLineIds = (settlementEvent.lineItems || [])
      .filter((line) => line.itemType === "service" || line.itemType === "custom_service")
      .map((line) => line.itemId);
    const walkInFulfillmentEvents =
      !invoice.appointmentId && serviceLineIds.length > 0
        ? await ServiceFulfillmentEvent.find(
            {
              organizationId,
              invoiceId: invoice._id,
              lineItemId: { $in: serviceLineIds },
            },
            null,
            { session },
          ).lean()
        : [];
    const walkInFulfillmentByLine = new Map(
      walkInFulfillmentEvents.map((event) => [event.lineItemId.toString(), event]),
    );
    const productLines = (settlementEvent.lineItems || []).filter(
      (line) => line.itemType === "product" && line.sourceEntityId,
    );
    const productRequiredQuantities = new Map();
    for (const line of productLines) {
      const productId = line.sourceEntityId.toString();
      const invoiceLine = invoice.lines?.find(
        (item) => item._id?.toString() === line.itemId.toString(),
      );
      productRequiredQuantities.set(
        productId,
        (productRequiredQuantities.get(productId) || 0) +
          Math.max(
            0,
            Number(invoiceLine?.quantity || 0) -
              Number(invoiceLine?.returnedQuantity || 0),
          ),
      );
    }
    const productSaleMovements =
      productRequiredQuantities.size > 0
        ? await StockMovement.find(
            {
              organizationId,
              branchId,
              movementType: "pos_sale",
              "reference.entityType": "Invoice",
              "reference.entityId": invoice._id,
            },
            "productId quantityDelta",
            { session },
          ).lean()
        : [];
    const productIssuedQuantities = new Map();
    for (const movement of productSaleMovements) {
      const productId = movement.productId.toString();
      productIssuedQuantities.set(
        productId,
        (productIssuedQuantities.get(productId) || 0) +
          Math.max(0, -Number(movement.quantityDelta || 0)),
      );
    }
    const fullyIssuedProductIds = new Set(
      [...productRequiredQuantities.entries()]
        .filter(
          ([productId, requiredQuantity]) =>
            (productIssuedQuantities.get(productId) || 0) >= requiredQuantity,
        )
        .map(([productId]) => productId),
    );

    const createdLedgerEntries = [];

    // Iterate through line items and resolve active scheme for each staff attribution
    for (const line of settlementEvent.lineItems) {
      const calculationBasis =
        line.itemType === "subscription"
          ? "SUBSCRIPTION_NET_REVENUE"
          : line.itemType === "membership"
            ? "MEMBERSHIP_NET_REVENUE"
            : line.itemType === "product"
              ? "PRODUCT_NET_REVENUE"
            : line.itemType === "service" || line.itemType === "custom_service"
              ? "SERVICE_NET_REVENUE"
              : null;
      if (!calculationBasis) continue;

      const isServiceLine = calculationBasis === "SERVICE_NET_REVENUE";
      const invoiceLine = invoice.lines?.find(
        (item) => item._id?.toString() === line.itemId.toString(),
      );
      let saleWasIssued = false;
      if (calculationBasis === "SUBSCRIPTION_NET_REVENUE" && invoiceLine?.subscriptionId) {
        const issuedSubscription = await mongoose.model("Subscription").findOne(
          {
            _id: invoiceLine.subscriptionId,
            organizationId,
            status: { $in: ["active", "exhausted"] },
            isDeleted: false,
          },
          null,
          { session },
        );
        saleWasIssued = Boolean(issuedSubscription);
      } else if (
        calculationBasis === "MEMBERSHIP_NET_REVENUE" &&
        invoiceLine?.customerMembershipId
      ) {
        const issuedMembership = await mongoose.model("CustomerMembership").findOne(
          {
            _id: invoiceLine.customerMembershipId,
            organizationId,
            status: "active",
            isDeleted: false,
          },
          null,
          { session },
        );
        saleWasIssued = Boolean(issuedMembership);
      } else if (calculationBasis === "PRODUCT_NET_REVENUE") {
        saleWasIssued = fullyIssuedProductIds.has(line.sourceEntityId?.toString());
      }

      const lineFulfillment = isServiceLine
        ? completedAppointment
          ? {
              eventTimestamp: completedAppointment.completedAt || new Date(),
              confirmedBy: userId || null,
            }
          : walkInFulfillmentByLine.get(line.itemId.toString())
        : saleWasIssued
          ? { eventTimestamp: settlementEvent.eventTimestamp, confirmedBy: userId || null }
          : null;
      if (!lineFulfillment) continue;

      for (const attr of line.staffAttributions) {
        if (!attr.staffId || attr.attributedPaise <= 0) continue;

        if (calculationBasis === "PRODUCT_NET_REVENUE") {
          const priorRetailAccrual = await IncentiveLedger.findOne({
            organizationId,
            invoiceId: settlementEvent.invoiceId,
            lineItemId: line.itemId,
            staffId: attr.staffId,
            sourceType: "retail_sale_commission",
            entryType: "ACCRUAL",
          }).session(session);
          if (priorRetailAccrual) continue;
        }

        // Resolve active scheme for staff member using scope precedence: STAFF -> BRANCH -> ORGANIZATION
        const activeAssignment = await schemeAssignmentService.resolveActiveAssignment({
          organizationId,
          staffId: attr.staffId,
          branchId,
          calculationBasis,
          effectiveDate: settlementEvent.eventTimestamp,
          session,
        });

        if (!activeAssignment) {
          // No active incentive scheme configured for this scope/staff
          continue;
        }

        const schemeId = activeAssignment.schemeId;
        const schemeDoc = await mongoose.model("IncentiveScheme").findById(schemeId).session(session);
        if (!schemeDoc || schemeDoc.status !== "active") {
          continue;
        }
        if (!IncentiveCalculationEngine.supportsCommissionScheme(schemeDoc)) {
          continue;
        }

        // Calculate earned commission using pure integer calculation engine
        const calcResult = IncentiveCalculationEngine.calculateCommission(
          schemeDoc,
          attr.attributedPaise
        );

        const idempotencyKey =
          calculationBasis === "PRODUCT_NET_REVENUE"
            ? `ACCRUAL:RETAIL:INV:${settlementEvent.invoiceId}:LINE:${line.itemId}:STAFF:${attr.staffId}`
            : `ACCRUAL:SETTLE:${settlementEvent._id}:LINE:${line.itemId}:STAFF:${attr.staffId}`;
        const sourceType =
          calculationBasis === "SUBSCRIPTION_NET_REVENUE"
            ? "subscription_sale_commission"
            : calculationBasis === "MEMBERSHIP_NET_REVENUE"
              ? "membership_sale_commission"
              : calculationBasis === "PRODUCT_NET_REVENUE"
                ? "retail_sale_commission"
              : "service_commission";

        // Create append-only ledger entry using controlled write boundary
        const ledgerEntry = await appendOnlyWriteBoundaryService.appendLedgerEntry(
          {
            branchId,
            staffId: attr.staffId,
            schemeId,
            entryType: "ACCRUAL",
            sourceType,
            settlementEventId: settlementEvent._id,
            invoiceId: settlementEvent.invoiceId,
            lineItemId: line.itemId,
            fulfillmentStatus: isServiceLine ? "confirmed" : "not_applicable",
            fulfillmentConfirmedAt: isServiceLine ? lineFulfillment.eventTimestamp : null,
            fulfillmentConfirmedBy: lineFulfillment.confirmedBy,
            sourceRevenueInPaise: line.netRevenueInPaise,
            attributedRevenueInPaise: attr.attributedPaise,
            amountInPaise: calcResult.earnedCommissionInPaise,
            calculationSnapshot: calcResult.snapshot,
            idempotencyKey,
          },
          organizationId,
          { session }
        );

        createdLedgerEntries.push(ledgerEntry);
      }
    }

    return createdLedgerEntries;
  }

  /**
   * 4. PAYMENT VOID & FINANCIAL UNSETTLEMENT HOOK
   * Called within billing transaction when a payment is voided, unsettling the invoice.
   *
   * @param {Object} params
   * @param {Object} params.payment - Mongoose Payment document being voided
   * @param {Object} params.invoice - Mongoose Invoice document
   * @param {mongoose.ClientSession} params.session
   * @param {mongoose.Types.ObjectId|string} params.userId
   * @param {string} params.reason
   * @returns {Promise<{ unsettleEvent: InvoiceSettlementEvent, clawbackEntries: IncentiveLedger[] }>}
   */
  async handlePaymentVoided({ payment, invoice, session, userId, reason }) {
    if (!payment || !invoice || !session) {
      throw new AppError("payment, invoice, and active session are required for handlePaymentVoided", 400);
    }
    const organizationId = invoice.organizationId;
    const branchId = invoice.branchId;

    const idempotencyKey = `UNSETTLE:INV:${invoice._id}:PAY:${payment._id}`;
    let unsettleEvent = await InvoiceSettlementEvent.findOne(
      { organizationId, idempotencyKey },
      null,
      { session },
    );
    if (!unsettleEvent) {
      const existingEventsCount = await InvoiceSettlementEvent.countDocuments({
        organizationId,
        invoiceId: invoice._id,
      }).session(session);
      const [createdEvent] = await InvoiceSettlementEvent.create(
        [{
          organizationId,
          branchId,
          invoiceId: invoice._id,
          paymentId: payment._id,
          appointmentId: invoice.appointmentId || null,
          subscriptionId: invoice.subscriptionId || null,
          eventType: "UNSETTLED",
          settlementCycle: existingEventsCount + 1,
          grossAmountInPaise: SettlementFulfillmentEventService.rupeesToPaise(invoice.subtotal),
          discountAmountInPaise: SettlementFulfillmentEventService.rupeesToPaise(invoice.discountTotal || 0),
          taxAmountInPaise: SettlementFulfillmentEventService.rupeesToPaise(invoice.taxTotal || 0),
          netSettledInPaise: 0,
          idempotencyKey,
          eventTimestamp: new Date(),
        }],
        { session },
      );
      unsettleEvent = createdEvent;
    }

    // Find all active ledger accruals for this invoice that now require clawback
    const priorAccruals = await IncentiveLedger.find(
      {
        organizationId,
        invoiceId: invoice._id,
        entryType: "ACCRUAL",
      },
      null,
      { session }
    );

    const clawbackEntries = [];
    for (const accrual of priorAccruals) {
      const clawbackKey = `CLAWBACK:VOID:${payment._id}:ACCRUAL:${accrual._id}`;

      const clawbackEntry = await appendOnlyWriteBoundaryService.appendLedgerEntry(
        {
          branchId: accrual.branchId,
          staffId: accrual.staffId,
          schemeId: accrual.schemeId,
          entryType: "CLAWBACK",
          sourceType: accrual.sourceType,
          settlementEventId: unsettleEvent._id,
          invoiceId: accrual.invoiceId,
          lineItemId: accrual.lineItemId,
          fulfillmentStatus:
            accrual.sourceType === "service_commission" ? "cancelled" : "not_applicable",
          sourceRevenueInPaise: accrual.sourceRevenueInPaise,
          attributedRevenueInPaise: accrual.attributedRevenueInPaise,
          amountInPaise: accrual.amountInPaise,
          reversesLedgerId: accrual._id,
          idempotencyKey: clawbackKey,
        },
        organizationId,
        { session }
      );

      // Create IncentiveRecoveryObligation so this clawback is tracked for recovery
      const existingObligation = await IncentiveRecoveryObligation.findOne(
        { organizationId, clawbackLedgerId: clawbackEntry._id },
        null,
        { session },
      );
      if (!existingObligation) {
        await IncentiveRecoveryObligation.create(
          [{
            organizationId,
            branchId: accrual.branchId,
            staffId: accrual.staffId,
            clawbackLedgerId: clawbackEntry._id,
            originalClawbackInPaise: clawbackEntry.amountInPaise,
            totalReservedInPaise: 0,
            totalRecoveredInPaise: 0,
            status: "pending",
          }],
          { session },
        );
      }

      clawbackEntries.push(clawbackEntry);
    }

    return { unsettleEvent, clawbackEntries };
  }

  async handlePurchaseRefundProcessed({
    invoice,
    refundPayment,
    refundAllocations,
    customerMembershipId = null,
    reason,
    session,
    userId,
  }) {
    if (
      !invoice ||
      !refundPayment ||
      refundPayment.type !== "refund" ||
      refundPayment.amount >= 0 ||
      typeof reason !== "string" ||
      !reason.trim() ||
      !userId ||
      !Array.isArray(refundAllocations) ||
      refundAllocations.length === 0 ||
      !session
    ) {
      throw new AppError("A persisted purchase refund and line allocations are required", 400);
    }

    const organizationId = invoice.organizationId;
    const branchId = invoice.branchId;
    const idempotencyKey = `REFUND:INV:${invoice._id}:PAY:${refundPayment._id}`;
    const normalizedAllocations = refundAllocations.map((allocation) => ({
      lineItemId: new mongoose.Types.ObjectId(allocation.lineItemId),
      refundAmountInPaise: Number(allocation.refundAmountInPaise),
    }));

    if (
      normalizedAllocations.some(
        ({ refundAmountInPaise }) =>
          !Number.isInteger(refundAmountInPaise) || refundAmountInPaise <= 0,
      )
    ) {
      throw new AppError("Refund line amounts must be positive integer paise", 400);
    }
    if (
      new Set(normalizedAllocations.map(({ lineItemId }) => lineItemId.toString())).size !==
      normalizedAllocations.length
    ) {
      throw new AppError("Duplicate refund line allocations are not allowed", 400);
    }

    const totalRefundInPaise = normalizedAllocations.reduce(
      (total, allocation) => total + allocation.refundAmountInPaise,
      0,
    );
    if (totalRefundInPaise > SettlementFulfillmentEventService.rupeesToPaise(-refundPayment.amount)) {
      throw new AppError("Refund allocations exceed the recorded refund payment", 400);
    }

    let refundEvent = await InvoiceSettlementEvent.findOne(
      { organizationId, idempotencyKey },
      null,
      { session },
    );
    if (!refundEvent) {
      const eventCount = await InvoiceSettlementEvent.countDocuments({
        organizationId,
        invoiceId: invoice._id,
      }).session(session);
      const [createdEvent] = await InvoiceSettlementEvent.create(
        [{
          organizationId,
          branchId,
          invoiceId: invoice._id,
          paymentId: refundPayment._id,
          appointmentId: invoice.appointmentId || null,
          subscriptionId: invoice.subscriptionId || null,
          customerMembershipId,
          eventType: "RETURN_PROCESSED",
          settlementCycle: eventCount + 1,
          grossAmountInPaise: SettlementFulfillmentEventService.rupeesToPaise(invoice.subtotal || 0),
          discountAmountInPaise: SettlementFulfillmentEventService.rupeesToPaise(invoice.discountTotal || 0),
          taxAmountInPaise: SettlementFulfillmentEventService.rupeesToPaise(invoice.taxTotal || 0),
          netSettledInPaise: 0,
          refundAllocations: normalizedAllocations,
          reason: reason.trim(),
          recordedBy: userId,
          idempotencyKey,
          eventTimestamp: new Date(),
        }],
        { session },
      );
      refundEvent = createdEvent;
    } else {
      const existingAllocations = refundEvent.refundAllocations
        .map((allocation) => ({
          lineItemId: allocation.lineItemId.toString(),
          refundAmountInPaise: allocation.refundAmountInPaise,
        }))
        .sort((a, b) => a.lineItemId.localeCompare(b.lineItemId));
      const requestedAllocations = normalizedAllocations
        .map((allocation) => ({
          lineItemId: allocation.lineItemId.toString(),
          refundAmountInPaise: allocation.refundAmountInPaise,
        }))
        .sort((a, b) => a.lineItemId.localeCompare(b.lineItemId));
      if (JSON.stringify(existingAllocations) !== JSON.stringify(requestedAllocations)) {
        throw new AppError("Refund idempotency key was reused with different line allocations", 409);
      }
    }

    const clawbacks = [];
    for (const allocation of normalizedAllocations) {
      const accruals = await IncentiveLedger.find(
        {
          organizationId,
          invoiceId: invoice._id,
          lineItemId: allocation.lineItemId,
          entryType: "ACCRUAL",
          sourceType: {
            $in: ["subscription_sale_commission", "membership_sale_commission"],
          },
        },
        null,
        { session },
      );

      for (const accrual of accruals) {
        const baseRevenue = accrual.sourceRevenueInPaise;
        if (allocation.refundAmountInPaise > baseRevenue) {
          throw new AppError("Refund exceeds the commissionable sale-line net amount", 409);
        }

        const priorClawbacks = await IncentiveLedger.find(
          {
            organizationId,
            reversesLedgerId: accrual._id,
            entryType: "CLAWBACK",
          },
          null,
          { session },
        );
        const previousRefundedPaise = priorClawbacks.reduce(
          (total, entry) => total + Number(entry.refundAmountInPaise || 0),
          0,
        );
        const priorClawbackPaise = priorClawbacks.reduce(
          (total, entry) => total + entry.amountInPaise,
          0,
        );
        const cumulativeRefundPaise = previousRefundedPaise + allocation.refundAmountInPaise;
        if (cumulativeRefundPaise > baseRevenue) {
          throw new AppError("Cumulative refunds exceed the commissionable sale-line net amount", 409);
        }

        const targetClawbackPaise = Number(
          (
            BigInt(accrual.amountInPaise) * BigInt(cumulativeRefundPaise) +
            BigInt(baseRevenue / 2)
          ) / BigInt(baseRevenue),
        );
        const clawbackAmountInPaise = Math.max(0, targetClawbackPaise - priorClawbackPaise);
        if (clawbackAmountInPaise === 0) continue;

        const clawback = await appendOnlyWriteBoundaryService.appendLedgerEntry(
          {
            branchId: accrual.branchId,
            staffId: accrual.staffId,
            schemeId: accrual.schemeId,
            entryType: "CLAWBACK",
            sourceType: accrual.sourceType,
            settlementEventId: refundEvent._id,
            invoiceId: invoice._id,
            lineItemId: allocation.lineItemId,
            fulfillmentStatus: "not_applicable",
            sourceRevenueInPaise: accrual.sourceRevenueInPaise,
            attributedRevenueInPaise: accrual.attributedRevenueInPaise,
            amountInPaise: clawbackAmountInPaise,
            reversesLedgerId: accrual._id,
            refundAmountInPaise: allocation.refundAmountInPaise,
            idempotencyKey: `CLAWBACK:REFUND:${refundEvent._id}:ACCRUAL:${accrual._id}`,
          },
          organizationId,
          { session },
        );

        const existingObligation = await IncentiveRecoveryObligation.findOne(
          { organizationId, clawbackLedgerId: clawback._id },
          null,
          { session },
        );
        if (!existingObligation) {
          await IncentiveRecoveryObligation.create(
            [{
              organizationId,
              branchId: accrual.branchId,
              staffId: accrual.staffId,
              clawbackLedgerId: clawback._id,
              originalClawbackInPaise: clawback.amountInPaise,
              totalReservedInPaise: 0,
              totalRecoveredInPaise: 0,
              status: "pending",
            }],
            { session },
          );
        }
        clawbacks.push(clawback);
      }
    }

    return { refundEvent, clawbacks };
  }

  /**
   * 5. PRODUCT RETURN & CUMULATIVE CLAWBACK HOOK
   * Handles incremental product returns with stable operation-level idempotency
   * and cumulative clawback tracking.
   *
   * @param {Object} params
   * @param {Object} params.invoice
   * @param {Array<{ lineItemId: string, returnQty: number, refundPaise: number }>} params.returnedItems
   * @param {string} params.returnOperationId
   * @param {mongoose.ClientSession} params.session
   * @param {mongoose.Types.ObjectId|string} params.userId
   * @returns {Promise<IncentiveLedger[]>}
   */
  async handleProductReturnProcessed({
    invoice,
    returnedItems,
    returnOperationId,
    session,
    userId,
  }) {
    if (!invoice || !returnOperationId || !session) {
      throw new AppError("invoice, returnOperationId, and session are required", 400);
    }
    const organizationId = invoice.organizationId;
    const branchId = invoice.branchId;

    const clawbacks = [];

    for (const ret of returnedItems) {
      const lineItemId = new mongoose.Types.ObjectId(ret.lineItemId);
      const refundPaise = Number(ret.refundPaise);
      if (!Number.isInteger(refundPaise) || refundPaise <= 0) continue;

      // Find original accrual for this line item
      const accrual = await IncentiveLedger.findOne(
        {
          organizationId,
          invoiceId: invoice._id,
          lineItemId,
          entryType: "ACCRUAL",
        },
        null,
        { session }
      );

      if (!accrual) continue;

      const clawbackKey = `CLAWBACK:RETURN:${returnOperationId}:LINE:${lineItemId}`;
      const existingClawback = await IncentiveLedger.findOne({
        organizationId,
        idempotencyKey: clawbackKey,
      }).session(session);
      if (existingClawback) {
        clawbacks.push(existingClawback);
        continue;
      }
      const previousClawbacks = await IncentiveLedger.find(
        {
          organizationId,
          reversesLedgerId: accrual._id,
          entryType: "CLAWBACK",
        },
        "amountInPaise refundAmountInPaise",
        { session },
      ).lean();
      const cumulativeRefundPaise = previousClawbacks.reduce(
        (sum, entry) => sum + Number(entry.refundAmountInPaise || 0),
        refundPaise,
      );
      const previousClawbackPaise = previousClawbacks.reduce(
        (sum, entry) => sum + Number(entry.amountInPaise || 0),
        0,
      );
      const sourceRevenuePaise = Number(accrual.sourceRevenueInPaise || 0);
      if (sourceRevenuePaise <= 0) continue;
      const cumulativeRefundCapped = Math.min(
        cumulativeRefundPaise,
        sourceRevenuePaise,
      );
      const targetCumulativeClawbackPaise = Number(
        (BigInt(accrual.amountInPaise) * BigInt(cumulativeRefundCapped) +
          BigInt(Math.floor(sourceRevenuePaise / 2))) /
          BigInt(sourceRevenuePaise),
      );
      const clawbackAmountPaise = Math.min(
        Math.max(0, accrual.amountInPaise - previousClawbackPaise),
        Math.max(0, targetCumulativeClawbackPaise - previousClawbackPaise),
      );
      if (clawbackAmountPaise <= 0) continue;

      const clawback = await appendOnlyWriteBoundaryService.appendLedgerEntry(
        {
          branchId,
          staffId: accrual.staffId,
          schemeId: accrual.schemeId,
          entryType: "CLAWBACK",
          settlementEventId: accrual.settlementEventId,
          invoiceId: invoice._id,
          lineItemId,
          reversesLedgerId: accrual._id,
          refundAmountInPaise: refundPaise,
          fulfillmentStatus: "corrected",
          sourceRevenueInPaise: accrual.sourceRevenueInPaise,
          attributedRevenueInPaise: accrual.attributedRevenueInPaise,
          amountInPaise: clawbackAmountPaise,
          idempotencyKey: clawbackKey,
        },
        organizationId,
        { session }
      );

      // Create separate recovery obligation document
      const existingObligation = await IncentiveRecoveryObligation.findOne(
        { organizationId, clawbackLedgerId: clawback._id },
        null,
        { session },
      );
      if (!existingObligation) {
        await IncentiveRecoveryObligation.create(
          [{
            organizationId,
            branchId,
            staffId: accrual.staffId,
            clawbackLedgerId: clawback._id,
            originalClawbackInPaise: clawbackAmountPaise,
            totalReservedInPaise: 0,
            totalRecoveredInPaise: 0,
            status: "pending",
          }],
          { session },
        );
      }

      clawbacks.push(clawback);
    }

    return clawbacks;
  }
}

export const settlementFulfillmentEventService = new SettlementFulfillmentEventService();
