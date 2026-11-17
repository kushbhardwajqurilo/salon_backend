import { createHash } from "node:crypto";
import { IncentiveLedger } from "../../models/incentives/incentiveLedger.model.js";
import { IncentiveRecoveryObligation } from "../../models/incentives/incentiveRecoveryObligation.model.js";
import { IncentiveRecoveryPayment } from "../../models/incentives/incentiveRecoveryPayment.model.js";
import { PayrollIncentiveAllocation } from "../../models/payroll/payrollIncentiveAllocation.model.js";
import { AppError } from "../../utils/errors.js";
import { runInTransaction } from "../../utils/transaction.js";

const MAX_SAFE_PAISE = Number.MAX_SAFE_INTEGER;
const PAYMENT_METHODS = ["bank_transfer", "cash", "cheque", "upi"];

const hashRequest = (payload) =>
  createHash("sha256")
    .update(JSON.stringify({
      obligationId: String(payload.obligationId),
      amountInPaise: payload.amountInPaise,
      paymentMethod: payload.paymentMethod,
      paymentReference: payload.paymentReference.trim(),
      paymentDate: new Date(payload.paymentDate).toISOString(),
      reason: payload.reason.trim(),
    }))
    .digest("hex");

const updateObligationStatus = (obligation) => {
  const recovered = obligation.totalRecoveredInPaise || 0;
  obligation.status = recovered >= obligation.originalClawbackInPaise
    ? "recovered"
    : recovered > 0
      ? "partially_recovered"
      : "pending";
};

const getAttemptAndScope = async ({
  organizationId,
  branchId,
  obligationId,
  paymentId,
  session,
}) => {
  const options = session ? { session } : {};
  const obligation = await IncentiveRecoveryObligation.findOne({
    _id: obligationId,
    organizationId,
    branchId,
  }, null, options);
  if (!obligation) throw new AppError("Recovery obligation not found", 404);
  const payment = await IncentiveRecoveryPayment.findOne({
    _id: paymentId,
    organizationId,
    branchId,
    obligationId: obligation._id,
  }, null, options);
  if (!payment) throw new AppError("Recovery payment attempt not found", 404);
  return { obligation, payment };
};

export class ManualRecoveryPaymentService {
  static async recordPayment({
    organizationId,
    branchId,
    obligationId,
    userId,
    amountInPaise,
    paymentMethod,
    paymentReference,
    paymentDate,
    reason,
    idempotencyKey,
  }) {
    if (!Number.isSafeInteger(amountInPaise) || amountInPaise <= 0 || amountInPaise > MAX_SAFE_PAISE) {
      throw new AppError("Recovery amount must be a positive integer paise value", 400);
    }
    if (!PAYMENT_METHODS.includes(paymentMethod)) {
      throw new AppError("Unsupported recovery payment method", 400);
    }
    if (typeof paymentReference !== "string" || !paymentReference.trim()) {
      throw new AppError("A payment reference is required", 400);
    }
    if (typeof reason !== "string" || reason.trim().length < 3) {
      throw new AppError("A recovery reason of at least 3 characters is required", 400);
    }
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw new AppError("A valid idempotency key is required", 400);
    }
    const parsedDate = new Date(paymentDate);
    if (Number.isNaN(parsedDate.getTime())) {
      throw new AppError("A valid payment date is required", 400);
    }
    const payloadHash = hashRequest({
      obligationId,
      amountInPaise,
      paymentMethod,
      paymentReference,
      paymentDate: parsedDate,
      reason,
    });

    try {
      return await runInTransaction(async (session) => {
      const options = session ? { session } : {};
      const duplicate = await IncentiveRecoveryPayment.findOne({
        organizationId,
        idempotencyKey,
      }, null, options);
      if (duplicate) {
        if (duplicate.requestPayloadHash !== payloadHash) {
          throw new AppError("Idempotency key was already used with different recovery details", 409);
        }
        const obligation = await IncentiveRecoveryObligation.findOne({
          _id: obligationId,
          organizationId,
          branchId,
        }, null, options);
        if (!obligation || duplicate.obligationId.toString() !== obligation._id.toString()) {
          throw new AppError("Idempotency key is associated with another recovery obligation", 409);
        }
        return { obligation, payment: duplicate, isIdempotentReplay: true };
      }

      const obligation = await IncentiveRecoveryObligation.findOne({
        _id: obligationId,
        organizationId,
        branchId,
        status: { $in: ["pending", "partially_recovered"] },
      }, null, options);
      if (!obligation) throw new AppError("Recovery obligation not found or is already settled", 404);

      const clawback = await IncentiveLedger.findOne({
        _id: obligation.clawbackLedgerId,
        organizationId,
        entryType: "CLAWBACK",
        reversesLedgerId: { $ne: null },
      }, null, options);
      if (!clawback) throw new AppError("Recovery source clawback was not found", 409);

      const allocation = await PayrollIncentiveAllocation.findOne({
        organizationId,
        incentiveLedgerId: clawback.reversesLedgerId,
        status: "paid",
      }, null, options);
      if (!allocation) {
        throw new AppError("Recovery is payable only after the related commission is confirmed as paid in payroll", 409);
      }
      if ((allocation.coveredClawbackLedgerIds || []).some(
        (id) => id.toString() === clawback._id.toString(),
      )) {
        throw new AppError("This clawback was already deducted from the unpaid payroll incentive and cannot be recovered again", 409);
      }

      const allocationReservation = await PayrollIncentiveAllocation.updateOne(
        {
          _id: allocation._id,
          organizationId,
          status: "paid",
          $expr: {
            $gte: [
              "$payableAmountInPaise",
              { $add: ["$recoveredInPaise", "$reservedRecoveryInPaise", amountInPaise] },
            ],
          },
        },
        { $inc: { reservedRecoveryInPaise: amountInPaise } },
        options,
      );
      if (allocationReservation.matchedCount === 0) {
        throw new AppError("Recovery amount exceeds the remaining paid commission balance", 409);
      }

      const obligationReservation = await IncentiveRecoveryObligation.updateOne(
        {
          _id: obligation._id,
          organizationId,
          branchId,
          status: { $in: ["pending", "partially_recovered"] },
          $expr: {
            $gte: [
              "$originalClawbackInPaise",
              { $add: ["$totalRecoveredInPaise", "$totalReservedInPaise", amountInPaise] },
            ],
          },
        },
        { $inc: { totalReservedInPaise: amountInPaise } },
        options,
      );
      if (obligationReservation.matchedCount === 0) {
        throw new AppError("Recovery amount exceeds the remaining obligation balance", 409);
      }

      const recordedAt = new Date();
      const [payment] = await IncentiveRecoveryPayment.create(
        [{
          organizationId,
          branchId,
          staffId: obligation.staffId,
          obligationId: obligation._id,
          clawbackLedgerId: clawback._id,
          sourceLedgerId: clawback.reversesLedgerId,
          payrollAllocationId: allocation._id,
          amountInPaise,
          paymentMethod,
          paymentReference: paymentReference.trim(),
          paymentDate: parsedDate,
          reason: reason.trim(),
          idempotencyKey,
          requestPayloadHash: payloadHash,
          status: "recorded",
          recordedBy: userId,
          recordedAt,
          history: [{ action: "recorded", actorId: userId, occurredAt: recordedAt, reason: reason.trim() }],
        }],
        options,
      );
      const updatedObligation = await IncentiveRecoveryObligation.findById(
        obligation._id,
        null,
        options,
      );
      return { obligation: updatedObligation, payment, isIdempotentReplay: false };
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const duplicate = await IncentiveRecoveryPayment.findOne({
        organizationId,
        idempotencyKey,
      });
      if (!duplicate) throw error;
      if (duplicate.requestPayloadHash !== payloadHash
        || duplicate.obligationId.toString() !== String(obligationId)) {
        throw new AppError("Idempotency key was already used with different recovery details", 409);
      }
      const obligation = await IncentiveRecoveryObligation.findOne({
        _id: obligationId,
        organizationId,
        branchId,
      });
      if (!obligation) throw new AppError("Recovery obligation not found", 404);
      return { obligation, payment: duplicate, isIdempotentReplay: true };
    }
  }

  static async confirmPayment({ organizationId, branchId, obligationId, paymentId, userId }) {
    return runInTransaction(async (session) => {
      const options = session ? { session } : {};
      const { obligation, payment } = await getAttemptAndScope({
        organizationId,
        branchId,
        obligationId,
        paymentId,
        session,
      });
      if (payment.status === "confirmed") {
        return { obligation, payment, isIdempotentReplay: true };
      }
      if (payment.status !== "recorded") {
        throw new AppError("Only a recorded recovery payment can be confirmed", 409);
      }

      const allocationUpdate = await PayrollIncentiveAllocation.updateOne(
        {
          _id: payment.payrollAllocationId,
          organizationId,
          status: "paid",
          reservedRecoveryInPaise: { $gte: payment.amountInPaise },
          $expr: {
            $gte: [
              "$payableAmountInPaise",
              { $add: ["$recoveredInPaise", payment.amountInPaise] },
            ],
          },
        },
        {
          $inc: {
            reservedRecoveryInPaise: -payment.amountInPaise,
            recoveredInPaise: payment.amountInPaise,
          },
        },
        options,
      );
      if (allocationUpdate.matchedCount === 0) {
        throw new AppError("Paid commission recovery balance changed before confirmation", 409);
      }

      const obligationUpdate = await IncentiveRecoveryObligation.updateOne(
        {
          _id: obligation._id,
          organizationId,
          branchId,
          totalReservedInPaise: { $gte: payment.amountInPaise },
          $expr: {
            $gte: [
              "$originalClawbackInPaise",
              { $add: ["$totalRecoveredInPaise", payment.amountInPaise] },
            ],
          },
        },
        {
          $inc: {
            totalReservedInPaise: -payment.amountInPaise,
            totalRecoveredInPaise: payment.amountInPaise,
          },
        },
        options,
      );
      if (obligationUpdate.matchedCount === 0) {
        throw new AppError("Recovery obligation balance changed before confirmation", 409);
      }

      const confirmedAt = new Date();
      const updatedPayment = await IncentiveRecoveryPayment.findOneAndUpdate(
        { _id: payment._id, organizationId, status: "recorded" },
        {
          $set: { status: "confirmed", confirmedBy: userId, confirmedAt },
          $push: { history: { action: "confirmed", actorId: userId, occurredAt: confirmedAt, reason: payment.reason } },
        },
        { new: true, ...options },
      );
      if (!updatedPayment) throw new AppError("Recovery payment changed before confirmation", 409);

      const updatedObligation = await IncentiveRecoveryObligation.findById(obligation._id, null, options);
      updateObligationStatus(updatedObligation);
      await updatedObligation.save(options);
      return { obligation: updatedObligation, payment: updatedPayment, isIdempotentReplay: false };
    });
  }

  static async failPayment({ organizationId, branchId, obligationId, paymentId, userId, failureReason }) {
    const reason = typeof failureReason === "string" ? failureReason.trim() : "";
    if (reason.length < 3) throw new AppError("A failure reason of at least 3 characters is required", 400);
    return runInTransaction(async (session) => {
      const options = session ? { session } : {};
      const { obligation, payment } = await getAttemptAndScope({
        organizationId,
        branchId,
        obligationId,
        paymentId,
        session,
      });
      if (payment.status === "failed") {
        if (payment.failureReason !== reason) {
          throw new AppError("Recovery payment failure was already recorded with a different reason", 409);
        }
        return { obligation, payment, isIdempotentReplay: true };
      }
      if (payment.status !== "recorded") {
        throw new AppError("Only a recorded recovery payment can be marked failed", 409);
      }

      const allocationUpdate = await PayrollIncentiveAllocation.updateOne(
        {
          _id: payment.payrollAllocationId,
          organizationId,
          status: "paid",
          reservedRecoveryInPaise: { $gte: payment.amountInPaise },
        },
        { $inc: { reservedRecoveryInPaise: -payment.amountInPaise } },
        options,
      );
      if (allocationUpdate.matchedCount === 0) {
        throw new AppError("Paid commission reservation changed before failure was recorded", 409);
      }
      const obligationUpdate = await IncentiveRecoveryObligation.updateOne(
        {
          _id: obligation._id,
          organizationId,
          branchId,
          totalReservedInPaise: { $gte: payment.amountInPaise },
        },
        { $inc: { totalReservedInPaise: -payment.amountInPaise } },
        options,
      );
      if (obligationUpdate.matchedCount === 0) {
        throw new AppError("Recovery reservation changed before failure was recorded", 409);
      }

      const failedAt = new Date();
      const updatedPayment = await IncentiveRecoveryPayment.findOneAndUpdate(
        { _id: payment._id, organizationId, status: "recorded" },
        {
          $set: { status: "failed", failedBy: userId, failedAt, failureReason: reason },
          $push: { history: { action: "failed", actorId: userId, occurredAt: failedAt, reason } },
        },
        { new: true, ...options },
      );
      if (!updatedPayment) throw new AppError("Recovery payment changed before failure was recorded", 409);
      const updatedObligation = await IncentiveRecoveryObligation.findById(obligation._id, null, options);
      return { obligation: updatedObligation, payment: updatedPayment, isIdempotentReplay: false };
    });
  }

  static async reversePayment({
    organizationId,
    branchId,
    obligationId,
    paymentId,
    userId,
    reversalReason,
  }) {
    const reason = typeof reversalReason === "string" ? reversalReason.trim() : "";
    if (reason.length < 3) throw new AppError("A reversal reason of at least 3 characters is required", 400);
    return runInTransaction(async (session) => {
      const options = session ? { session } : {};
      const { obligation, payment } = await getAttemptAndScope({
        organizationId,
        branchId,
        obligationId,
        paymentId,
        session,
      });
      if (payment.status === "reversed") {
        if (payment.reversalReason !== reason) {
          throw new AppError("Recovery payment was already reversed with a different reason", 409);
        }
        return { obligation, payment, isIdempotentReplay: true };
      }
      if (payment.status !== "confirmed") {
        throw new AppError("Only a confirmed recovery payment can be reversed", 409);
      }

      const allocationUpdate = await PayrollIncentiveAllocation.updateOne(
        {
          _id: payment.payrollAllocationId,
          organizationId,
          status: "paid",
          recoveredInPaise: { $gte: payment.amountInPaise },
        },
        { $inc: { recoveredInPaise: -payment.amountInPaise } },
        options,
      );
      if (allocationUpdate.matchedCount === 0) {
        throw new AppError("Paid commission recovery balance changed before reversal", 409);
      }
      const obligationUpdate = await IncentiveRecoveryObligation.updateOne(
        {
          _id: obligation._id,
          organizationId,
          branchId,
          totalRecoveredInPaise: { $gte: payment.amountInPaise },
        },
        { $inc: { totalRecoveredInPaise: -payment.amountInPaise } },
        options,
      );
      if (obligationUpdate.matchedCount === 0) {
        throw new AppError("Recovery balance changed before reversal", 409);
      }

      const reversedAt = new Date();
      const updatedPayment = await IncentiveRecoveryPayment.findOneAndUpdate(
        { _id: payment._id, organizationId, status: "confirmed" },
        {
          $set: { status: "reversed", reversedBy: userId, reversedAt, reversalReason: reason },
          $push: { history: { action: "reversed", actorId: userId, occurredAt: reversedAt, reason } },
        },
        { new: true, ...options },
      );
      if (!updatedPayment) throw new AppError("Recovery payment changed before reversal", 409);
      const updatedObligation = await IncentiveRecoveryObligation.findById(obligation._id, null, options);
      updateObligationStatus(updatedObligation);
      await updatedObligation.save(options);
      return { obligation: updatedObligation, payment: updatedPayment, isIdempotentReplay: false };
    });
  }
}
