import crypto from "crypto";
import mongoose from "mongoose";
import { Invoice } from "../../models/billing/invoice.model.js";
import { Payment } from "../../models/billing/payment.model.js";
import { RefundCase } from "../../models/billing/refundCase.model.js";
import { Appointment } from "../../models/appointments/appointment.model.js";
import { CustomerMembership } from "../../models/memberships/customerMembership.model.js";
import { ScopeLock } from "../../models/incentives/scopeLock.model.js";
import { inventoryService } from "../inventory/inventory.service.js";
import { loyaltyService } from "../loyalty/loyalty.service.js";
import { subscriptionService } from "../subscriptions/subscription.service.js";
import { settlementFulfillmentEventService } from "../incentives/settlementFulfillmentEvent.service.js";
import { computeBenefitAccountingForInvoice } from "./benefitAccounting.service.js";
import { AppError } from "../../utils/errors.js";

const SUPPORTED_REFUND_METHODS = ["cash", "card", "upi", "other"];
const ACTIVE_RESERVATION_STATUSES = ["pending", "processing"];

const toPaise = (amount) => {
  const num = Number(amount || 0);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100);
};

/**
 * Deterministic proportional paise allocation using Hamilton (largest-remainder) method.
 * Ties are broken deterministically by item.lineId string order.
 */
const allocatePaiseProportionally = (totalPaise, weightedItems) => {
  if (
    !Number.isInteger(totalPaise) ||
    totalPaise <= 0 ||
    weightedItems.length === 0
  ) {
    return weightedItems.map((item) => ({ ...item, allocatedPaise: 0 }));
  }

  const totalWeight = weightedItems.reduce(
    (sum, item) => sum + Math.max(0, item.weight),
    0,
  );
  if (totalWeight <= 0) {
    return weightedItems.map((item) => ({ ...item, allocatedPaise: 0 }));
  }

  const withShares = weightedItems.map((item) => {
    const weight = Math.max(0, item.weight);
    const exactNumerator = BigInt(totalPaise) * BigInt(weight);
    const floorShare = Number(exactNumerator / BigInt(totalWeight));
    const remainder = Number(exactNumerator % BigInt(totalWeight));
    return {
      ...item,
      allocatedPaise: floorShare,
      remainder,
    };
  });

  const allocatedSum = withShares.reduce(
    (sum, item) => sum + item.allocatedPaise,
    0,
  );
  let remaining = totalPaise - allocatedSum;

  const sortedForRemainder = [...withShares].sort((a, b) => {
    if (b.remainder !== a.remainder) return b.remainder - a.remainder;
    return String(a.lineId).localeCompare(String(b.lineId));
  });

  for (let i = 0; i < sortedForRemainder.length && remaining > 0; i += 1) {
    sortedForRemainder[i].allocatedPaise += 1;
    remaining -= 1;
  }

  return withShares.map(({ remainder, ...rest }) => rest);
};

class RefundService {
  async getRefundContext(invoiceId, organizationId, branchId, session = null) {
    const invoice = await Invoice.findOne({
      _id: invoiceId,
      organizationId,
      isDeleted: false,
    })
      .session(session)
      .lean();

    if (!invoice) {
      throw new AppError("Invoice not found", 404);
    }

    if (
      branchId &&
      branchId !== "all" &&
      invoice.branchId.toString() !== branchId.toString()
    ) {
      throw new AppError(
        "Access denied. Invoice belongs to another branch.",
        403,
      );
    }

    const [payments, refundCases] = await Promise.all([
      Payment.find({
        organizationId,
        invoiceId: invoice._id,
        isDeleted: false,
        status: "completed",
      })
        .select("amount type method status paymentNumber paymentDate")
        .session(session)
        .lean(),
      RefundCase.find({
        organizationId,
        invoiceId: invoice._id,
        isDeleted: false,
      })
        .sort({ createdAt: -1 })
        .select(
          "refundNumber refundMode requestedAmountPaise pendingAmountPaise settledAmountPaise refundMethod settlementType status paymentSettlementStatus allocations domainReversals reason createdAt",
        )
        .session(session)
        .lean(),
    ]);

    const completedPaymentsPaise = payments
      .filter((p) => p.type === "payment" && Number(p.amount) > 0)
      .reduce((sum, p) => sum + toPaise(p.amount), 0);

    const completedRefundsPaise = payments
      .filter((p) => p.type === "refund")
      .reduce((sum, p) => sum + Math.abs(toPaise(p.amount)), 0);

    const pendingReservedPaise = refundCases
      .filter((rc) => ACTIVE_RESERVATION_STATUSES.includes(rc.status))
      .reduce(
        (sum, rc) =>
          sum + Number(rc.pendingAmountPaise || rc.requestedAmountPaise || 0),
        0,
      );

    const refundableBalancePaise = Math.max(
      0,
      completedPaymentsPaise - completedRefundsPaise - pendingReservedPaise,
    );

    const eligibility = this._evaluateEligibility({
      invoice,
      completedPaymentsPaise,
      completedRefundsPaise,
      pendingReservedPaise,
      refundableBalancePaise,
    });

    const effectivePaymentStatus = this._deriveEffectivePaymentStatus({
      invoice,
      completedPaymentsPaise,
      completedRefundsPaise,
      refundableBalancePaise,
    });

    const derivedRefundStatus = this._deriveRefundStatus({
      invoice,
      completedPaymentsPaise,
      completedRefundsPaise,
      pendingReservedPaise,
      refundableBalancePaise,
    });

    const {
      refundableItems,
      netLinePaidByLineId,
      benefitAccounting,
      reconciliationRequired,
      reconciliationReasons,
    } = await this._buildRefundableItemsWithBenefits({
      invoice,
      organizationId,
      refundableBalancePaise,
      refundCases,
      session,
    });

    return {
      invoiceId: invoice._id.toString(),
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.createdAt,
      invoiceStatus: invoice.status,
      invoicePaymentStatus: effectivePaymentStatus,
      eligibility,
      summary: {
        originalPayablePaise: toPaise(invoice.payableAmount),
        completedPaymentsPaise,
        completedRefundsPaise,
        pendingReservedPaise,
        refundableBalancePaise,
        netRetainedPaise: Math.max(
          0,
          completedPaymentsPaise - completedRefundsPaise,
        ),
        effectivePaymentStatus,
        derivedRefundStatus,
      },
      originalPayments: payments.map((p) => ({
        id: String(p._id),
        paymentNumber: p.paymentNumber,
        type: p.type,
        method: p.method,
        amountPaise: toPaise(p.amount),
        paymentDate: p.paymentDate,
      })),
      refundableItems,
      benefitAccounting,
      reconciliationRequired,
      reconciliationReasons,
      supportedRefundMethods: SUPPORTED_REFUND_METHODS,
      refundHistory: refundCases.map((rc) => ({
        _id: rc._id.toString(),
        id: rc._id.toString(),
        refundNumber: rc.refundNumber,
        refundMode: rc.refundMode,
        requestedAmountPaise: rc.requestedAmountPaise,
        pendingAmountPaise: rc.pendingAmountPaise,
        settledAmountPaise: rc.settledAmountPaise,
        refundMethod: rc.refundMethod,
        settlementType: rc.settlementType,
        status: rc.status,
        paymentSettlementStatus: rc.paymentSettlementStatus,
        domainReversals: rc.domainReversals || {},
        reason: rc.reason,
        createdAt: rc.createdAt,
      })),
    };
  }

  async previewRefund(
    invoiceId,
    payload,
    organizationId,
    branchId,
    session = null,
  ) {
    const context = await this.getRefundContext(
      invoiceId,
      organizationId,
      branchId,
      session,
    );

    if (!context.eligibility.isEligible) {
      throw new AppError(context.eligibility.message, 400);
    }

    const { refundMode } = payload;
    const { refundableBalancePaise } = context.summary;

    if (refundMode === "financial_only") {
      const requestedAmountPaise = Number(payload.requestedAmountPaise);
      if (
        !Number.isInteger(requestedAmountPaise) ||
        requestedAmountPaise <= 0
      ) {
        throw new AppError(
          "requestedAmountPaise must be a positive integer",
          400,
        );
      }
      if (requestedAmountPaise > refundableBalancePaise) {
        throw new AppError(
          `Requested refund (${requestedAmountPaise} paise) exceeds remaining refundable balance (${refundableBalancePaise} paise)`,
          400,
        );
      }

      return {
        refundMode: "financial_only",
        totalRefundAmountPaise: requestedAmountPaise,
        remainingRefundableBalancePaise:
          refundableBalancePaise - requestedAmountPaise,
        allocations: [],
        consequences: [
          "Financial-only compensation: no inventory restock, membership/subscription cancellation, loyalty reversal, or incentive clawback will occur.",
        ],
        warnings: context.reconciliationRequired ? context.reconciliationReasons : [],
        benefitAccounting: context.benefitAccounting || [],
        reconciliationRequired: context.reconciliationRequired || false,
        reconciliationReasons: context.reconciliationReasons || [],
        customerExplanation: `Financial-only refund of ₹${(requestedAmountPaise / 100).toFixed(2)} for invoice ${context.invoiceNumber}. No entitlements or inventory items were reversed.`,
      };
    }

    if (refundMode === "item_linked") {
      if (context.reconciliationRequired) {
        throw new AppError(
          `Reconciliation required before item-linked refund: ${(context.reconciliationReasons || []).join("; ")}`,
          409,
        );
      }

      const items = Array.isArray(payload.items) ? payload.items : [];
      if (items.length === 0) {
        throw new AppError(
          "At least one invoice item must be selected for item_linked refund",
          400,
        );
      }

      const seenLineIds = new Set();
      const itemMap = new Map(
        context.refundableItems.map((item) => [item.lineId, item]),
      );
      const allocations = [];
      const consequences = [];
      const warnings = [];
      let totalRefundAmountPaise = 0;

      for (const reqItem of items) {
        const lineId = String(reqItem.lineId);
        if (seenLineIds.has(lineId)) {
          throw new AppError(
            `Duplicate lineId in refund preview: ${lineId}`,
            400,
          );
        }
        seenLineIds.add(lineId);

        const itemInfo = itemMap.get(lineId);
        if (!itemInfo) {
          throw new AppError(`Invoice line not found: ${lineId}`, 404);
        }
        if (!itemInfo.isEligible) {
          throw new AppError(
            `Line '${itemInfo.name}' is not eligible for refund: ${itemInfo.ineligibilityReason}`,
            400,
          );
        }

        const qty = Number(reqItem.quantity);
        if (
          !Number.isFinite(qty) ||
          qty <= 0 ||
          qty > itemInfo.remainingQuantity
        ) {
          throw new AppError(
            `Requested quantity (${qty}) exceeds remaining refundable quantity (${itemInfo.remainingQuantity}) for '${itemInfo.name}'`,
            400,
          );
        }

        const lineAllocatedPaise = Math.round(
          (itemInfo.lineNetRemainingPaise * qty) / itemInfo.remainingQuantity,
        );

        totalRefundAmountPaise += lineAllocatedPaise;
        allocations.push({
          lineId,
          lineType: itemInfo.lineType,
          name: itemInfo.name,
          quantity: qty,
          allocatedAmountPaise: lineAllocatedPaise,
          loyaltyAllocatedPaise: itemInfo.loyaltyAllocatedPaise,
        });

        if (itemInfo.lineType === "product") {
          consequences.push(
            reqItem.acceptPhysicalRestock
              ? `Product '${itemInfo.name}' (qty ${qty}) will be restocked into inventory.`
              : `Product '${itemInfo.name}' (qty ${qty}) will be refunded without physical restock.`,
          );
        } else if (itemInfo.lineType === "membership") {
          consequences.push(
            `Membership '${itemInfo.name}' will be cancelled if unused.`,
          );
        } else if (itemInfo.lineType === "subscription") {
          consequences.push(
            `Subscription '${itemInfo.name}' will be cancelled if unused.`,
          );
        }
      }

      if (totalRefundAmountPaise <= 0) {
        throw new AppError(
          "Calculated refund amount must be greater than zero",
          400,
        );
      }
      if (totalRefundAmountPaise > refundableBalancePaise) {
        throw new AppError(
          `Calculated refund (${totalRefundAmountPaise} paise) exceeds remaining refundable balance (${refundableBalancePaise} paise)`,
          400,
        );
      }

      const benefitSummaryLines = (context.benefitAccounting || []).map(
        (b) =>
          `${b.name}: Paid ₹${(b.originalNetPaidPaise / 100).toFixed(2)}, Consumed ₹${(b.lifetimeConsumedPaise / 100).toFixed(2)}, Prior/Pending Refunds ₹${((b.previouslySettledRefundsPaise + b.pendingRefundReservationsPaise) / 100).toFixed(2)}, Remaining ₹${(b.remainingRefundablePaise / 100).toFixed(2)}.`,
      );

      return {
        refundMode: "item_linked",
        totalRefundAmountPaise,
        remainingRefundableBalancePaise:
          refundableBalancePaise - totalRefundAmountPaise,
        allocations,
        consequences,
        warnings,
        benefitAccounting: context.benefitAccounting || [],
        reconciliationRequired: context.reconciliationRequired || false,
        reconciliationReasons: context.reconciliationReasons || [],
        customerExplanation: [
          `Refund of ₹${(totalRefundAmountPaise / 100).toFixed(2)} for invoice ${context.invoiceNumber}.`,
          ...benefitSummaryLines,
        ].join(" "),
      };
    }

    throw new AppError("Invalid refundMode", 400);
  }

  async createPendingRefundCase(
    invoiceId,
    payload,
    organizationId,
    branchId,
    userId,
    idempotencyKey,
  ) {
    if (
      !idempotencyKey ||
      typeof idempotencyKey !== "string" ||
      idempotencyKey.trim().length === 0 ||
      idempotencyKey.length > 200
    ) {
      throw new AppError("A valid Idempotency-Key header is required", 400);
    }
    const cleanKey = idempotencyKey.trim();

    const normalizedItems = Array.isArray(payload.items)
      ? payload.items
          .map((item) => ({
            lineId: String(item.lineId),
            quantity: Number(item.quantity),
            acceptPhysicalRestock: item.acceptPhysicalRestock === true,
          }))
          .sort((a, b) => a.lineId.localeCompare(b.lineId))
      : [];

    const requestPayloadHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          invoiceId: String(invoiceId),
          refundMode: payload.refundMode,
          refundMethod: payload.refundMethod,
          requestedAmountPaise: payload.requestedAmountPaise ?? null,
          items: normalizedItems,
          reason: String(payload.reason || "").trim(),
        }),
      )
      .digest("hex");

    const session = await mongoose.startSession();
    try {
      let result = null;
      await session.withTransaction(async () => {
        const existingCase = await RefundCase.findOne({
          organizationId,
          idempotencyKey: cleanKey,
          isDeleted: false,
        }).session(session);

        if (existingCase) {
          if (
            existingCase.requestPayloadHash !== requestPayloadHash ||
            existingCase.invoiceId.toString() !== String(invoiceId)
          ) {
            throw new AppError(
              "Idempotency key was already used for a different refund request",
              409,
            );
          }
          result = { refundCase: existingCase, idempotentReplay: true };
          return;
        }

        // Acquire write lock on ScopeLock (never mutating Invoice) to serialize concurrent refund reservations
        await ScopeLock.findOneAndUpdate(
          {
            organizationId,
            scopeType: "BRANCH",
            scopeKey: `REFUND_RESERVE:${invoiceId}`,
          },
          {
            $set: {
              lockedAt: new Date(),
              lockOwner: String(userId),
            },
          },
          { upsert: true, session, returnDocument: "after" },
        );

        const lockedInvoice = await Invoice.findOne({
          _id: invoiceId,
          organizationId,
          isDeleted: false,
        })
          .session(session)
          .lean();
        if (!lockedInvoice) {
          throw new AppError("Invoice not found", 404);
        }

        const preview = await this.previewRefund(
          invoiceId,
          payload,
          organizationId,
          branchId,
          session,
        );

        const refundNumber = `REF-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${crypto
          .randomBytes(3)
          .toString("hex")
          .toUpperCase()}`;

        const [created] = await RefundCase.create(
          [
            {
              organizationId,
              branchId: lockedInvoice.branchId,
              invoiceId: lockedInvoice._id,
              customerId: lockedInvoice.customerId,
              refundNumber,
              refundMode: payload.refundMode,
              requestedAmountPaise: preview.totalRefundAmountPaise,
              pendingAmountPaise: preview.totalRefundAmountPaise,
              settledAmountPaise: 0,
              refundMethod: payload.refundMethod,
              settlementType: "manual_record",
              status: "pending",
              paymentSettlementStatus: "pending",
              allocations: preview.allocations.map((a) => ({
                lineId: a.lineId,
                lineType: a.lineType,
                quantity: a.quantity,
                allocatedAmountPaise: a.allocatedAmountPaise,
                loyaltyAllocatedPaise: a.loyaltyAllocatedPaise,
                domainReversalStatus: "pending",
              })),
              reason: String(payload.reason).trim(),
              initiatedBy: userId,
              idempotencyKey: cleanKey,
              requestPayloadHash,
            },
          ],
          { session },
        );

        result = { refundCase: created, idempotentReplay: false };
      });

      return result;
    } catch (error) {
      if (error?.code === 11000) {
        const existingCase = await RefundCase.findOne({
          organizationId,
          idempotencyKey: cleanKey,
          isDeleted: false,
        });
        if (existingCase) {
          if (
            existingCase.requestPayloadHash !== requestPayloadHash ||
            existingCase.invoiceId.toString() !== String(invoiceId)
          ) {
            throw new AppError(
              "Idempotency key was already used for a different refund request",
              409,
            );
          }
          return { refundCase: existingCase, idempotentReplay: true };
        }
      }
      throw error;
    } finally {
      await session.endSession();
    }
  }

  async settleRefundCase(
    invoiceId,
    refundCaseId,
    payload,
    organizationId,
    branchId,
    userId,
    idempotencyKey,
  ) {
    if (
      !idempotencyKey ||
      typeof idempotencyKey !== "string" ||
      idempotencyKey.trim().length === 0 ||
      idempotencyKey.length > 200
    ) {
      throw new AppError("A valid Idempotency-Key header is required", 400);
    }

    const session = await mongoose.startSession();
    try {
      let result = null;
      await session.withTransaction(async () => {
        await ScopeLock.findOneAndUpdate(
          {
            organizationId,
            scopeType: "BRANCH",
            scopeKey: `REFUND_SETTLE:${refundCaseId}`,
          },
          {
            $set: {
              lockedAt: new Date(),
              lockOwner: String(userId),
            },
          },
          { upsert: true, session, returnDocument: "after" },
        );

        const refundCase = await RefundCase.findOne({
          _id: refundCaseId,
          invoiceId,
          organizationId,
          isDeleted: false,
        }).session(session);

        if (!refundCase) {
          throw new AppError("RefundCase not found", 404);
        }

        if (
          branchId &&
          branchId !== "all" &&
          refundCase.branchId.toString() !== branchId.toString()
        ) {
          throw new AppError(
            "Access denied. RefundCase belongs to another branch.",
            403,
          );
        }

        if (
          refundCase.paymentSettlementStatus === "settled" &&
          refundCase.paymentId
        ) {
          if (
            payload?.amountPaise !== undefined &&
            Number(payload.amountPaise) !==
              Number(refundCase.settledAmountPaise)
          ) {
            throw new AppError(
              "RefundCase is already settled for a different amount",
              409,
            );
          }
          const existingPayment = await Payment.findOne({
            _id: refundCase.paymentId,
            organizationId,
            isDeleted: false,
          }).session(session);
          if (existingPayment) {
            result = {
              refundCase,
              refundPayment: existingPayment,
              idempotentReplay: true,
            };
            return;
          }
        }

        if (!["pending", "processing"].includes(refundCase.status)) {
          throw new AppError(
            `RefundCase with status '${refundCase.status}' cannot be settled`,
            409,
          );
        }
        if (refundCase.paymentSettlementStatus !== "pending") {
          throw new AppError(
            `RefundCase paymentSettlementStatus '${refundCase.paymentSettlementStatus}' is not eligible for settlement`,
            409,
          );
        }

        const settleAmountPaise =
          payload?.amountPaise !== undefined
            ? Number(payload.amountPaise)
            : Number(refundCase.pendingAmountPaise);

        if (!Number.isInteger(settleAmountPaise) || settleAmountPaise <= 0) {
          throw new AppError(
            "Settlement amount must be a positive integer in paise",
            400,
          );
        }
        if (settleAmountPaise !== Number(refundCase.pendingAmountPaise)) {
          throw new AppError(
            `Settlement amount (${settleAmountPaise} paise) must match the authorized pending RefundCase amount (${refundCase.pendingAmountPaise} paise)`,
            400,
          );
        }

        const paymentNumber = `PAY-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${crypto
          .randomBytes(3)
          .toString("hex")
          .toUpperCase()}`;

        const [refundPayment] = await Payment.create(
          [
            {
              organizationId,
              branchId: refundCase.branchId,
              invoiceId: refundCase.invoiceId,
              customerId: refundCase.customerId,
              paymentNumber,
              amount: -(settleAmountPaise / 100),
              type: "refund",
              method: payload?.refundMethod || refundCase.refundMethod,
              referenceNote:
                payload?.referenceNote ||
                `Manual refund settlement for ${refundCase.refundNumber}`,
              status: "completed",
              recordedBy: userId,
              paymentDate: new Date(),
              idempotencyKey: `REFUND_CASE_SETTLE:${refundCase._id}`,
              isManualRefundRecord: true,
              refundCaseId: refundCase._id,
            },
          ],
          { session },
        );

        refundCase.paymentId = refundPayment._id;
        refundCase.paymentSettlementStatus = "settled";
        refundCase.settledAmountPaise = settleAmountPaise;
        refundCase.pendingAmountPaise = 0;

        // Synchronize invoice.paymentStatus from authoritative completed payments & refunds
        const allInvoicePayments = await Payment.find({
          organizationId,
          invoiceId: refundCase.invoiceId,
          isDeleted: false,
          status: "completed",
        })
          .select("amount type")
          .session(session)
          .lean();
        const totalPaidPaise = allInvoicePayments
          .filter((p) => p.type === "payment" && Number(p.amount) > 0)
          .reduce((sum, p) => sum + toPaise(p.amount), 0);
        const totalRefundedPaise = allInvoicePayments
          .filter((p) => p.type === "refund")
          .reduce((sum, p) => sum + Math.abs(toPaise(p.amount)), 0);
        const remainingRefundablePaise = Math.max(
          0,
          totalPaidPaise - totalRefundedPaise,
        );
        const nextPaymentStatus =
          totalPaidPaise <= 0
            ? "unpaid"
            : totalRefundedPaise > 0 && remainingRefundablePaise === 0
              ? "refunded"
              : totalRefundedPaise > 0
                ? "partially_refunded"
                : "paid";
        await Invoice.updateOne(
          { _id: refundCase.invoiceId, organizationId, isDeleted: false },
          { $set: { paymentStatus: nextPaymentStatus } },
          { session },
        );
        if (refundCase.refundMode === "financial_only") {
          refundCase.status = "completed";
        } else {
          refundCase.status = "processing";
        }
        await refundCase.save({ session });

        result = { refundCase, refundPayment, idempotentReplay: false };
      });

      return result;
    } catch (error) {
      if (error?.code === 11000) {
        const existingPayment = await Payment.findOne({
          organizationId,
          refundCaseId,
          type: "refund",
          isDeleted: false,
        });
        const refundCase = await RefundCase.findOne({
          _id: refundCaseId,
          invoiceId,
          organizationId,
          isDeleted: false,
        });
        if (existingPayment && refundCase) {
          return {
            refundCase,
            refundPayment: existingPayment,
            idempotentReplay: true,
          };
        }
      }
      throw error;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Reverse earned incentives for a settled item-linked RefundCase.
   * Caller owns the MongoDB transaction and must supply `session`.
   */
  async reverseIncentivesForRefundCase({
    invoice,
    refundCase,
    refundPayment,
    userId,
    session,
  }) {
    if (!session) {
      throw new AppError(
        "MongoDB session is required for incentive refund reversal",
        400,
      );
    }

    const organizationId = invoice.organizationId;
    const freshRefundCase = await RefundCase.findOne({
      _id: refundCase._id,
      organizationId,
      isDeleted: false,
    }).session(session);

    if (!freshRefundCase) {
      throw new AppError("RefundCase not found", 404);
    }

    if (freshRefundCase.domainReversals?.incentives?.status === "completed") {
      return {
        status: "completed",
        alreadyReversed: true,
        referenceIds:
          freshRefundCase.domainReversals.incentives.referenceIds || [],
        clawbacks: [],
        unsupportedLineIds: [],
      };
    }

    if (
      freshRefundCase.refundMode === "financial_only" ||
      freshRefundCase.refundKind === "financial_only"
    ) {
      freshRefundCase.domainReversals = freshRefundCase.domainReversals || {};
      freshRefundCase.domainReversals.incentives = {
        status: "skipped",
        referenceIds: [],
      };
      await freshRefundCase.save({ session });
      return {
        status: "skipped",
        referenceIds: [],
        clawbacks: [],
        unsupportedLineIds: [],
      };
    }

    if (
      freshRefundCase.paymentSettlementStatus !== "settled" ||
      !refundPayment ||
      refundPayment.type !== "refund" ||
      refundPayment.amount >= 0
    ) {
      throw new AppError(
        "Incentive reversal requires a settled refund payment",
        400,
      );
    }

    const allocations = freshRefundCase.allocations || [];
    const purchaseAllocations = [];
    const productAllocations = [];
    const unsupportedLineIds = [];

    for (const alloc of allocations) {
      const amountPaise = Number(alloc.allocatedAmountPaise || 0);
      if (amountPaise <= 0) continue;

      if (
        alloc.lineType === "membership" ||
        alloc.lineType === "subscription"
      ) {
        purchaseAllocations.push({
          lineItemId: alloc.lineId,
          refundAmountInPaise: amountPaise,
        });
      } else if (alloc.lineType === "product") {
        productAllocations.push({
          lineItemId: alloc.lineId,
          returnQty: Number(alloc.quantity || 0),
          refundPaise: amountPaise,
        });
      } else {
        unsupportedLineIds.push(alloc.lineId);
      }
    }

    const clawbacks = [];

    if (purchaseAllocations.length > 0) {
      const { clawbacks: purchaseClawbacks } =
        await settlementFulfillmentEventService.handlePurchaseRefundProcessed({
          invoice,
          refundPayment,
          refundAllocations: purchaseAllocations,
          reason:
            freshRefundCase.reason ||
            `Incentive reversal for refund case ${freshRefundCase.refundNumber || freshRefundCase._id}`,
          session,
          userId,
        });
      clawbacks.push(...(purchaseClawbacks || []));
    }

    if (productAllocations.length > 0) {
      const productClawbacks =
        await settlementFulfillmentEventService.handleProductReturnProcessed({
          invoice,
          returnedItems: productAllocations,
          returnOperationId: freshRefundCase._id.toString(),
          session,
          userId,
        });
      clawbacks.push(...(productClawbacks || []));
    }

    const referenceIds = clawbacks.map((c) => c._id);
    const status =
      unsupportedLineIds.length === 0
        ? "completed"
        : clawbacks.length > 0 ||
            purchaseAllocations.length > 0 ||
            productAllocations.length > 0
          ? "partially_completed"
          : "pending";

    freshRefundCase.domainReversals = freshRefundCase.domainReversals || {};
    freshRefundCase.domainReversals.incentives = {
      status,
      referenceIds,
    };
    await freshRefundCase.save({ session });

    return {
      status,
      referenceIds,
      clawbacks,
      unsupportedLineIds,
    };
  }

  /**
   * Orchestrate all required domain reversals (inventory, loyalty, incentives) for a settled RefundCase.
   * Caller owns the MongoDB transaction and must supply `session`.
   */
  async orchestrateDomainReversals({
    invoice,
    refundCase,
    refundPayment,
    userId,
    session,
  }) {
    if (!session) {
      throw new AppError(
        "MongoDB session is required for domain reversal orchestration",
        400,
      );
    }

    const organizationId = invoice.organizationId;
    const freshRefundCase = await RefundCase.findOne({
      _id: refundCase._id,
      organizationId,
      isDeleted: false,
    }).session(session);

    if (!freshRefundCase) {
      throw new AppError("RefundCase not found", 404);
    }

    freshRefundCase.domainReversals = freshRefundCase.domainReversals || {};

    if (
      freshRefundCase.refundMode === "financial_only" ||
      freshRefundCase.refundKind === "financial_only"
    ) {
      for (const domain of [
        "inventory",
        "membership",
        "subscription",
        "appointment",
        "loyalty",
        "incentives",
      ]) {
        freshRefundCase.domainReversals[domain] = {
          status: "skipped",
          referenceIds: [],
        };
      }
      if (freshRefundCase.paymentSettlementStatus === "settled") {
        freshRefundCase.status = "completed";
      }
      await freshRefundCase.save({ session });
      return {
        status: freshRefundCase.status,
        skipped: true,
        domainResults: {
          inventory: { status: "skipped" },
          membership: { status: "skipped" },
          subscription: { status: "skipped" },
          appointment: { status: "skipped" },
          loyalty: { status: "skipped" },
          incentives: { status: "skipped" },
        },
      };
    }

    if (
      freshRefundCase.paymentSettlementStatus !== "settled" ||
      !refundPayment ||
      refundPayment.type !== "refund" ||
      refundPayment.amount >= 0
    ) {
      throw new AppError(
        "Domain reversals require a settled refund payment",
        400,
      );
    }

    const isDone = (status) =>
      status === "completed" ||
      status === "skipped";
    const hasLineType = (type) =>
      (freshRefundCase.allocations || []).some(
        (a) => a.lineType === type && Number(a.allocatedAmountPaise || 0) > 0,
      );

    const domainResults = {};

    const invStatus = freshRefundCase.domainReversals.inventory?.status;
    if (!isDone(invStatus)) {
      if (!hasLineType("product")) {
        freshRefundCase.domainReversals.inventory = {
          status: "not_applicable",
          referenceIds: [],
        };
        await freshRefundCase.save({ session });
        domainResults.inventory = { status: "not_applicable", referenceIds: [] };
      } else {
        domainResults.inventory = await inventoryService.reverseSaleForRefund({
          invoice,
          refundCase: freshRefundCase,
          allocations: (freshRefundCase.allocations || []).filter(
            (a) => a.lineType === "product",
          ),
          session,
        });
      }
    } else {
      domainResults.inventory = { status: invStatus, alreadyCompleted: true };
    }

    const memStatus = freshRefundCase.domainReversals.membership?.status;
    if (!isDone(memStatus)) {
      domainResults.membership = await this.reverseMembershipForRefundCase({
        invoice,
        refundCase: freshRefundCase,
        userId,
        session,
      });
    } else {
      domainResults.membership = { status: memStatus, alreadyCompleted: true };
    }

    const subStatus = freshRefundCase.domainReversals.subscription?.status;
    if (!isDone(subStatus)) {
      domainResults.subscription = await this.reverseSubscriptionForRefundCase({
        invoice,
        refundCase: freshRefundCase,
        userId,
        session,
      });
    } else {
      domainResults.subscription = {
        status: subStatus,
        alreadyCompleted: true,
      };
    }

    const apptStatus = freshRefundCase.domainReversals.appointment?.status;
    if (!isDone(apptStatus)) {
      domainResults.appointment = await this.reverseAppointmentForRefundCase({
        invoice,
        refundCase: freshRefundCase,
        userId,
        session,
      });
    } else {
      domainResults.appointment = {
        status: apptStatus,
        alreadyCompleted: true,
      };
    }

    const loyStatus = freshRefundCase.domainReversals.loyalty?.status;
    if (!isDone(loyStatus)) {
      domainResults.loyalty = await loyaltyService.reverseForRefund({
        invoice,
        refundCase: freshRefundCase,
        allocations: freshRefundCase.allocations,
        session,
      });
    } else {
      domainResults.loyalty = { status: loyStatus, alreadyCompleted: true };
    }

    const incStatus = freshRefundCase.domainReversals.incentives?.status;
    if (!isDone(incStatus)) {
      domainResults.incentives = await this.reverseIncentivesForRefundCase({
        invoice,
        refundCase: freshRefundCase,
        refundPayment,
        userId,
        session,
      });
    } else {
      domainResults.incentives = { status: incStatus, alreadyCompleted: true };
    }

    const updatedRefundCase = await RefundCase.findOne({
      _id: freshRefundCase._id,
      organizationId,
      isDeleted: false,
    }).session(session);

    const finalStatuses = [
      "inventory",
      "membership",
      "subscription",
      "appointment",
      "loyalty",
      "incentives",
    ].map(
      (d) =>
        domainResults[d]?.status ||
        updatedRefundCase?.domainReversals?.[d]?.status,
    );
    const isTerminal = (s) =>
      s === "completed" || s === "skipped" || s === "not_applicable";
    const allDone = finalStatuses.every((s) => isTerminal(s));
    const finalStatus = allDone ? "completed" : "processing";

    await RefundCase.updateOne(
      { _id: freshRefundCase._id, organizationId },
      { $set: { status: finalStatus } },
      { session },
    );

    return {
      status: finalStatus,
      domainResults,
    };
  }

  /**
   * Reverse unused membership entitlement(s) for a settled item-linked RefundCase.
   * Caller owns the MongoDB transaction and must supply `session`.
   */
  async reverseMembershipForRefundCase({
    invoice,
    refundCase,
    userId,
    session,
  }) {
    if (!session) {
      throw new AppError(
        "MongoDB session is required for membership refund reversal",
        400,
      );
    }

    const organizationId = invoice.organizationId;
    const freshRefundCase = await RefundCase.findOne({
      _id: refundCase._id,
      organizationId,
      isDeleted: false,
    }).session(session);

    if (!freshRefundCase) {
      throw new AppError("RefundCase not found", 404);
    }

    const existingStatus = freshRefundCase.domainReversals?.membership?.status;
    if (
      existingStatus === "completed" ||
      existingStatus === "skipped"
    ) {
      return {
        status: existingStatus,
        alreadyReversed: true,
        referenceIds:
          freshRefundCase.domainReversals.membership.referenceIds || [],
      };
    }

    if (
      freshRefundCase.refundMode === "financial_only" ||
      freshRefundCase.refundKind === "financial_only"
    ) {
      freshRefundCase.domainReversals = freshRefundCase.domainReversals || {};
      freshRefundCase.domainReversals.membership = {
        status: "skipped",
        referenceIds: [],
      };
      await freshRefundCase.save({ session });
      return { status: "skipped", referenceIds: [] };
    }

    const membershipAllocations = (freshRefundCase.allocations || []).filter(
      (a) =>
        a.lineType === "membership" && Number(a.allocatedAmountPaise || 0) > 0,
    );

    if (membershipAllocations.length === 0) {
      freshRefundCase.domainReversals = freshRefundCase.domainReversals || {};
      freshRefundCase.domainReversals.membership = {
        status: "not_applicable",
        referenceIds: [],
      };
      await freshRefundCase.save({ session });
      return { status: "not_applicable", referenceIds: [] };
    }

    const referenceIds = [];
    for (const alloc of membershipAllocations) {
      const line = (invoice.lines || []).find(
        (item) => item._id?.toString() === String(alloc.lineId),
      );
      if (!line || !line.customerMembershipId) {
        throw new AppError(
          "Membership issuance record is missing for this invoice line",
          409,
        );
      }

      const membership = await CustomerMembership.findOne({
        _id: line.customerMembershipId,
        organizationId,
        invoiceId: invoice._id,
        isDeleted: false,
      }).session(session);

      if (!membership) {
        throw new AppError(
          "Membership is not eligible for an unused-membership refund",
          409,
        );
      }

      if (membership.status === "cancelled") {
        referenceIds.push(membership._id);
        continue;
      }

      if (!["active", "expired"].includes(membership.status)) {
        throw new AppError(
          "Membership is not eligible for an unused-membership refund",
          409,
        );
      }

      const benefitUse = await Invoice.exists({
        organizationId,
        isDeleted: false,
        status: { $ne: "cancelled" },
        $or: [
          { "lines.appliedCustomerMembershipId": membership._id },
          { "lines.membershipBenefitSourceLineId": line._id },
        ],
      }).session(session);

      if (benefitUse) {
        throw new AppError(
          "Membership has been used or reserved on another invoice and cannot be refunded",
          409,
        );
      }

      membership.status = "cancelled";
      membership.cancelledAt = new Date();
      membership.cancelledBy = userId;
      membership.cancellationReason =
        freshRefundCase.reason ||
        `Refunded via ${freshRefundCase.refundNumber || freshRefundCase._id}`;
      await membership.save({ session });
      referenceIds.push(membership._id);
    }

    freshRefundCase.domainReversals = freshRefundCase.domainReversals || {};
    freshRefundCase.domainReversals.membership = {
      status: "completed",
      referenceIds,
    };
    await freshRefundCase.save({ session });

    return {
      status: "completed",
      referenceIds,
    };
  }

  /**
   * Reverse eligible unperformed service/appointment entitlement for a settled item-linked RefundCase.
   * Blocks completed-service item-linked refunds under current policy.
   */
  async reverseAppointmentForRefundCase({
    invoice,
    refundCase,
    userId,
    session,
  }) {
    if (!session) {
      throw new AppError(
        "MongoDB session is required for appointment refund reversal",
        400,
      );
    }

    const organizationId = invoice.organizationId;
    const freshRefundCase = await RefundCase.findOne({
      _id: refundCase._id,
      organizationId,
      isDeleted: false,
    }).session(session);

    if (!freshRefundCase) {
      throw new AppError("RefundCase not found", 404);
    }

    const existingStatus = freshRefundCase.domainReversals?.appointment?.status;
    if (
      existingStatus === "completed" ||
      existingStatus === "skipped"
    ) {
      return {
        status: existingStatus,
        alreadyReversed: true,
        referenceIds:
          freshRefundCase.domainReversals.appointment.referenceIds || [],
      };
    }

    if (
      freshRefundCase.refundMode === "financial_only" ||
      freshRefundCase.refundKind === "financial_only"
    ) {
      freshRefundCase.domainReversals = freshRefundCase.domainReversals || {};
      freshRefundCase.domainReversals.appointment = {
        status: "skipped",
        referenceIds: [],
      };
      await freshRefundCase.save({ session });
      return { status: "skipped", referenceIds: [] };
    }

    const serviceAllocations = (freshRefundCase.allocations || []).filter(
      (a) =>
        (a.lineType === "service" || a.lineType === "custom_service") &&
        Number(a.allocatedAmountPaise || 0) > 0,
    );

    if (serviceAllocations.length === 0) {
      freshRefundCase.domainReversals = freshRefundCase.domainReversals || {};
      freshRefundCase.domainReversals.appointment = {
        status: "not_applicable",
        referenceIds: [],
      };
      await freshRefundCase.save({ session });
      return { status: "not_applicable", referenceIds: [] };
    }

    if (!invoice.appointmentId) {
      throw new AppError(
        "Service line refund is not linked to an appointment",
        409,
      );
    }

    const appointment = await Appointment.findOne({
      _id: invoice.appointmentId,
      organizationId,
      ...(invoice.branchId ? { branchId: invoice.branchId } : {}),
      isDeleted: false,
    }).session(session);

    if (!appointment) {
      throw new AppError("Appointment not found", 404);
    }

    if (appointment.status === "completed") {
      throw new AppError(
        "Completed service item-linked refunds are blocked under current policy",
        409,
      );
    }

    if (appointment.status !== "cancelled") {
      appointment.status = "cancelled";
      appointment.cancelledAt = new Date();
      appointment.cancelledBy = userId;
      appointment.cancellationReason =
        freshRefundCase.reason ||
        `Refunded via ${freshRefundCase.refundNumber || freshRefundCase._id}`;
      await appointment.save({ session });
    }

    freshRefundCase.domainReversals = freshRefundCase.domainReversals || {};
    freshRefundCase.domainReversals.appointment = {
      status: "completed",
      referenceIds: [appointment._id],
    };
    await freshRefundCase.save({ session });

    return {
      status: "completed",
      referenceIds: [appointment._id],
    };
  }

  /**
   * Reverse subscription entitlement(s) for a settled item-linked RefundCase.
   * Delegates cancellation & eligibility checks to subscriptionService.cancelSubscription.
   */
  async reverseSubscriptionForRefundCase({
    invoice,
    refundCase,
    userId,
    session,
  }) {
    if (!session) {
      throw new AppError(
        "MongoDB session is required for subscription refund reversal",
        400,
      );
    }

    const organizationId = invoice.organizationId;
    const freshRefundCase = await RefundCase.findOne({
      _id: refundCase._id,
      organizationId,
      isDeleted: false,
    }).session(session);

    if (!freshRefundCase) {
      throw new AppError("RefundCase not found", 404);
    }

    const existingStatus =
      freshRefundCase.domainReversals?.subscription?.status;
    if (
      existingStatus === "completed" ||
      existingStatus === "skipped"
    ) {
      return {
        status: existingStatus,
        alreadyReversed: true,
        referenceIds:
          freshRefundCase.domainReversals.subscription.referenceIds || [],
      };
    }

    if (
      freshRefundCase.refundMode === "financial_only" ||
      freshRefundCase.refundKind === "financial_only"
    ) {
      freshRefundCase.domainReversals = freshRefundCase.domainReversals || {};
      freshRefundCase.domainReversals.subscription = {
        status: "skipped",
        referenceIds: [],
      };
      await freshRefundCase.save({ session });
      return { status: "skipped", referenceIds: [] };
    }

    const subscriptionAllocations = (freshRefundCase.allocations || []).filter(
      (a) =>
        a.lineType === "subscription" &&
        Number(a.allocatedAmountPaise || 0) > 0,
    );

    if (subscriptionAllocations.length === 0) {
      freshRefundCase.domainReversals = freshRefundCase.domainReversals || {};
      freshRefundCase.domainReversals.subscription = {
        status: "not_applicable",
        referenceIds: [],
      };
      await freshRefundCase.save({ session });
      return { status: "not_applicable", referenceIds: [] };
    }

    const referenceIds = [];
    for (const alloc of subscriptionAllocations) {
      const line = (invoice.lines || []).find(
        (item) => item._id?.toString() === String(alloc.lineId),
      );
      const subscriptionId =
        line?.subscriptionId ||
        line?.customerSubscriptionId ||
        invoice.subscriptionId;

      if (!subscriptionId) {
        throw new AppError(
          "Subscription issuance record is missing for this invoice line",
          409,
        );
      }

      await subscriptionService.cancelSubscription(
        subscriptionId,
        organizationId,
        userId,
        freshRefundCase.reason ||
          `Refunded via ${freshRefundCase.refundNumber || freshRefundCase._id}`,
        {
          idempotencyKey: `REFUND_CASE_SUB:${freshRefundCase._id}:${subscriptionId}`,
          session,
        },
      );
      referenceIds.push(subscriptionId);
    }

    freshRefundCase.domainReversals = freshRefundCase.domainReversals || {};
    freshRefundCase.domainReversals.subscription = {
      status: "completed",
      referenceIds,
    };
    await freshRefundCase.save({ session });

    return {
      status: "completed",
      referenceIds,
    };
  }

  /**
   * Reverse eligible unperformed service/appointment entitlement for a settled item-linked RefundCase.
   * Blocks completed-service item-linked refunds under current policy.
   */
  async reverseAppointmentForRefundCase({
    invoice,
    refundCase,
    userId,
    session,
  }) {
    if (!session) {
      throw new AppError(
        "MongoDB session is required for appointment refund reversal",
        400,
      );
    }

    const organizationId = invoice.organizationId;
    const freshRefundCase = await RefundCase.findOne({
      _id: refundCase._id,
      organizationId,
      isDeleted: false,
    }).session(session);

    if (!freshRefundCase) {
      throw new AppError("RefundCase not found", 404);
    }

    const existingStatus = freshRefundCase.domainReversals?.appointment?.status;
    if (
      existingStatus === "completed" ||
      existingStatus === "skipped"
    ) {
      return {
        status: existingStatus,
        alreadyReversed: true,
        referenceIds:
          freshRefundCase.domainReversals.appointment.referenceIds || [],
      };
    }

    if (
      freshRefundCase.refundMode === "financial_only" ||
      freshRefundCase.refundKind === "financial_only"
    ) {
      freshRefundCase.domainReversals = freshRefundCase.domainReversals || {};
      freshRefundCase.domainReversals.appointment = {
        status: "skipped",
        referenceIds: [],
      };
      await freshRefundCase.save({ session });
      return { status: "skipped", referenceIds: [] };
    }

    const serviceAllocations = (freshRefundCase.allocations || []).filter(
      (a) =>
        (a.lineType === "service" || a.lineType === "custom_service") &&
        Number(a.allocatedAmountPaise || 0) > 0,
    );

    if (serviceAllocations.length === 0) {
      freshRefundCase.domainReversals = freshRefundCase.domainReversals || {};
      freshRefundCase.domainReversals.appointment = {
        status: "not_applicable",
        referenceIds: [],
      };
      await freshRefundCase.save({ session });
      return { status: "not_applicable", referenceIds: [] };
    }

    if (!invoice.appointmentId) {
      throw new AppError(
        "Service line refund is not linked to an appointment",
        409,
      );
    }

    const appointment = await Appointment.findOne({
      _id: invoice.appointmentId,
      organizationId,
      ...(invoice.branchId ? { branchId: invoice.branchId } : {}),
      isDeleted: false,
    }).session(session);

    if (!appointment) {
      throw new AppError("Appointment not found", 404);
    }

    if (appointment.status === "completed") {
      throw new AppError(
        "Completed service item-linked refunds are blocked under current policy",
        409,
      );
    }

    if (appointment.status !== "cancelled") {
      appointment.status = "cancelled";
      appointment.cancelledAt = new Date();
      appointment.cancelledBy = userId;
      appointment.cancellationReason =
        freshRefundCase.reason ||
        `Refunded via ${freshRefundCase.refundNumber || freshRefundCase._id}`;
      await appointment.save({ session });
    }

    freshRefundCase.domainReversals = freshRefundCase.domainReversals || {};
    freshRefundCase.domainReversals.appointment = {
      status: "completed",
      referenceIds: [appointment._id],
    };
    await freshRefundCase.save({ session });

    return {
      status: "completed",
      referenceIds: [appointment._id],
    };
  }

  /**
   * Retry domain reversals for an already-settled RefundCase inside a fresh transaction.
   * Never creates or settles another Payment.
   */
  async retryDomainReversals(
    invoiceId,
    refundCaseId,
    organizationId,
    branchId,
    userId,
  ) {
    const session = await mongoose.startSession();
    try {
      let result = null;
      await session.withTransaction(async () => {
        const invoice = await Invoice.findOne({
          _id: invoiceId,
          organizationId,
          ...(branchId ? { branchId } : {}),
          isDeleted: false,
        }).session(session);
        if (!invoice) {
          throw new AppError("Invoice not found", 404);
        }

        const refundCase = await RefundCase.findOne({
          _id: refundCaseId,
          invoiceId: invoice._id,
          organizationId,
          ...(branchId ? { branchId } : {}),
          isDeleted: false,
        }).session(session);
        if (!refundCase) {
          throw new AppError("RefundCase not found", 404);
        }

        if (
          refundCase.paymentSettlementStatus !== "settled" ||
          !refundCase.paymentId
        ) {
          throw new AppError(
            "Domain reversals require a settled refund payment",
            400,
          );
        }

        const refundPayment = await Payment.findOne({
          _id: refundCase.paymentId,
          organizationId,
          type: "refund",
          isDeleted: false,
        }).session(session);
        if (!refundPayment) {
          throw new AppError("Settled refund payment not found", 404);
        }

        const orchestration = await this.orchestrateDomainReversals({
          invoice,
          refundCase,
          refundPayment,
          userId,
          session,
        });

        const updatedRefundCase = await RefundCase.findOne({
          _id: refundCase._id,
          organizationId,
          isDeleted: false,
        }).session(session);

        result = {
          refundCase: updatedRefundCase || refundCase,
          ...orchestration,
        };
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  _evaluateEligibility({
    invoice,
    completedPaymentsPaise,
    pendingReservedPaise,
    refundableBalancePaise,
  }) {
    if (invoice.status === "draft") {
      return {
        isEligible: false,
        reasonCode: "DRAFT_INVOICE",
        message: "Draft invoices cannot be refunded.",
      };
    }
    if (invoice.status === "cancelled") {
      return {
        isEligible: false,
        reasonCode: "CANCELLED_INVOICE",
        message: "Cancelled invoices cannot be refunded.",
      };
    }
    if (invoice.paymentStatus === "unpaid") {
      return {
        isEligible: false,
        reasonCode: "UNPAID_INVOICE",
        message: "Unpaid invoices cannot be refunded.",
      };
    }
    if (invoice.paymentStatus === "partially_paid") {
      return {
        isEligible: false,
        reasonCode: "PARTIALLY_PAID_INVOICE",
        message: "Partially paid invoices cannot be refunded until fully paid.",
      };
    }
    if (invoice.paymentStatus !== "paid") {
      return {
        isEligible: false,
        reasonCode: "NOT_PAID",
        message: "Only paid invoices are eligible for refund.",
      };
    }
    if (completedPaymentsPaise <= 0) {
      return {
        isEligible: false,
        reasonCode: "NO_SETTLED_PAYMENTS",
        message: "No completed payments exist on this invoice.",
      };
    }
    if (refundableBalancePaise <= 0) {
      if (pendingReservedPaise > 0) {
        return {
          isEligible: false,
          reasonCode: "PENDING_REFUND_RESERVES_BALANCE",
          message:
            "Remaining refundable balance is reserved by pending refund requests.",
        };
      }
      return {
        isEligible: false,
        reasonCode: "FULLY_REFUNDED",
        message: "Invoice has already been fully refunded.",
      };
    }

    return {
      isEligible: true,
      reasonCode: "ELIGIBLE",
      message: "Invoice is eligible for refund.",
    };
  }

  _deriveEffectivePaymentStatus({
    invoice,
    completedPaymentsPaise,
    completedRefundsPaise,
    refundableBalancePaise,
  }) {
    if (completedPaymentsPaise <= 0) {
      return "unpaid";
    }
    if (completedRefundsPaise > 0 && refundableBalancePaise === 0) {
      return "refunded";
    }
    if (completedRefundsPaise > 0 && refundableBalancePaise > 0) {
      return "partially_refunded";
    }
    const payablePaise = toPaise(invoice.payableAmount);
    return completedPaymentsPaise >= payablePaise ? "paid" : "partially_paid";
  }

  _deriveRefundStatus({
    invoice,
    completedPaymentsPaise,
    completedRefundsPaise,
    pendingReservedPaise,
    refundableBalancePaise,
  }) {
    if (invoice.status !== "finalized" || completedPaymentsPaise <= 0) {
      return "not_eligible";
    }
    if (completedRefundsPaise > 0 && refundableBalancePaise === 0) {
      return "fully_refunded";
    }
    if (completedRefundsPaise > 0 && refundableBalancePaise > 0) {
      return "partially_refunded";
    }
    if (pendingReservedPaise > 0 && completedRefundsPaise === 0) {
      return "pending_refund";
    }
    return "none";
  }

  async _buildRefundableItemsWithBenefits({
    invoice,
    organizationId,
    refundableBalancePaise,
    refundCases = [],
    session = null,
  }) {
    const baseItems = this._buildRefundableItems(invoice, refundableBalancePaise);
    const netLinePaidByLineId = new Map(
      baseItems.map((item) => [item.lineId, item.lineNetRemainingPaise]),
    );

    const {
      benefitAccounting,
      byLineId,
      reconciliationRequired,
      reconciliationReasons,
    } = await computeBenefitAccountingForInvoice({
      invoice,
      organizationId,
      refundCases,
      netLinePaidByLineId,
      session,
    });

    const linesById = new Map(
      (invoice.lines || []).map((l) => [String(l._id), l]),
    );

    const refundableItems = baseItems.map((item) => {
      const rawLine = linesById.get(item.lineId);
      const benefit = byLineId.get(item.lineId);

      // Per-line prior settled and pending refund allocations
      let priorRefundedPaise = 0;
      let pendingReservedPaise = 0;
      for (const rc of refundCases) {
        const matching = (rc.allocations || []).filter(
          (a) => String(a.lineId) === item.lineId,
        );
        const sum = matching.reduce(
          (s, a) => s + Number(a.allocatedAmountPaise || 0),
          0,
        );
        if (["completed", "partially_completed"].includes(rc.status)) {
          priorRefundedPaise += sum;
        } else if (ACTIVE_RESERVATION_STATUSES.includes(rc.status)) {
          pendingReservedPaise += sum;
        }
      }

      let maxRefundablePaise = Math.max(
        0,
        item.maxRefundablePaise - priorRefundedPaise - pendingReservedPaise,
      );
      let isEligible = item.isEligible && maxRefundablePaise > 0;
      let ineligibilityReason = item.ineligibilityReason;

      if (rawLine?.isCoveredBySubscription && item.customerPayablePaise === 0) {
        isEligible = false;
        ineligibilityReason = "SUBSCRIPTION_COVERED_SERVICE";
        maxRefundablePaise = 0;
      } else if (benefit) {
        if (benefit.reconciliationRequired) {
          isEligible = false;
          ineligibilityReason = "RECONCILIATION_REQUIRED";
          maxRefundablePaise = 0;
        } else {
          maxRefundablePaise = Math.min(
            maxRefundablePaise,
            benefit.remainingRefundablePaise,
          );
          isEligible = item.remainingQuantity > 0 && maxRefundablePaise > 0;
          if (!isEligible && !ineligibilityReason) {
            ineligibilityReason = "ENTITLEMENT_EXHAUSTED";
          }
        }
      }

      return {
        ...item,
        priorRefundedPaise,
        pendingReservedPaise,
        maxRefundablePaise,
        lineNetRemainingPaise: benefit
          ? benefit.remainingRefundablePaise
          : Math.max(0, item.lineNetRemainingPaise - priorRefundedPaise - pendingReservedPaise),
        isEligible,
        ineligibilityReason,
        benefitSummary: benefit || null,
      };
    });

    return {
      refundableItems,
      netLinePaidByLineId,
      benefitAccounting,
      reconciliationRequired,
      reconciliationReasons,
    };
  }

  _buildRefundableItems(invoice, refundableBalancePaise) {
    const lines = invoice.lines || [];
    const totalLoyaltyPaise = toPaise(invoice.loyaltyDiscountAmount);

    const loyaltyAllocations = allocatePaiseProportionally(
      totalLoyaltyPaise,
      lines.map((line) => ({
        lineId: line._id.toString(),
        weight: Math.max(0, toPaise(line.customerPayable)),
      })),
    );
    const loyaltyByLineId = new Map(
      loyaltyAllocations.map((a) => [a.lineId, a.allocatedPaise]),
    );

    return lines.map((line) => {
      const lineId = line._id.toString();
      const quantity = Number(line.quantity || 0);
      const returnedQuantity = Number(line.returnedQuantity || 0);
      const remainingQuantity = Math.max(0, quantity - returnedQuantity);
      const customerPayablePaise = Math.max(0, toPaise(line.customerPayable));
      const loyaltyAllocatedPaise = loyaltyByLineId.get(lineId) || 0;
      const netLinePaise = Math.max(
        0,
        customerPayablePaise - loyaltyAllocatedPaise,
      );

      const lineNetRemainingPaise =
        quantity > 0 && remainingQuantity > 0
          ? Math.round((netLinePaise * remainingQuantity) / quantity)
          : 0;

      const maxRefundablePaise = Math.min(
        lineNetRemainingPaise,
        refundableBalancePaise,
      );

      let isEligible = remainingQuantity > 0 && maxRefundablePaise > 0;
      let ineligibilityReason = null;

      if (line.lineType === "service") {
        isEligible = false;
        ineligibilityReason = "COMPLETED_SERVICE_POLICY_PENDING";
      } else if (remainingQuantity <= 0) {
        isEligible = false;
        ineligibilityReason = "ALREADY_RETURNED";
      } else if (maxRefundablePaise <= 0) {
        isEligible = false;
        ineligibilityReason = "NO_REFUNDABLE_BALANCE";
      }

      return {
        lineId,
        lineType: line.lineType,
        name: line.name,
        quantity,
        returnedQuantity,
        remainingQuantity,
        customerPayablePaise,
        loyaltyAllocatedPaise,
        lineNetRemainingPaise,
        maxRefundablePaise,
        isEligible,
        ineligibilityReason,
      };
    });
  }
}

export const refundService = new RefundService();
