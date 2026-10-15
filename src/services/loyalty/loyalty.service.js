import mongoose from "mongoose";
import { AppError } from "../../utils/errors.js";
import { Customer } from "../../models/customers/customer.model.js";
import { Invoice } from "../../models/billing/invoice.model.js";
import { AuditLog, AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";
import { LoyaltyProgramConfig } from "../../models/loyalty/loyaltyProgramConfig.model.js";
import { LoyaltyTransaction, LOYALTY_TRANSACTION_TYPES } from "../../models/loyalty/loyaltyTransaction.model.js";
import { loyaltyProgramConfigRepository } from "../../repositories/loyalty/loyaltyProgramConfig.repository.js";
import { loyaltyTransactionRepository } from "../../repositories/loyalty/loyaltyTransaction.repository.js";
import { runInTransaction } from "../../utils/transaction.js";

export class LoyaltyService {
  /**
   * Return effective organization loyalty config.
   * If not created yet in DB, returns safe default configuration object without duplicate inserts on reads.
   */
  async getEffectiveConfig(organizationId, session = null) {
    let config = await loyaltyProgramConfigRepository.findByOrganizationId(organizationId, session);
    if (!config) {
      return {
        organizationId,
        isEnabled: false,
        earnPointsPerUnit: 1,
        earnThresholdAmount: 100,
        redemptionRate: 1,
        minRedemptionPoints: 20,
        maxRedemptionPercentage: 20,
        isConfigured: false,
      };
    }
    const configObj = config.toObject ? config.toObject() : config;
    return {
      ...configObj,
      isConfigured: true,
    };
  }

  /**
   * Upsert organization loyalty program configuration.
   */
  async updateConfig(organizationId, payload, userId) {
    return await runInTransaction(async (session) => {
      let config = await loyaltyProgramConfigRepository.findByOrganizationId(organizationId, session);

      const oldConfigSnapshot = config ? (config.toObject ? config.toObject() : { ...config }) : null;

      if (!config) {
        config = new LoyaltyProgramConfig({
          organizationId,
          ...payload,
          updatedBy: userId,
        });
      } else {
        Object.assign(config, payload);
        config.updatedBy = userId;
      }

      await config.save({ session });

      const auditLog = new AuditLog({
        organizationId,
        actorId: userId,
        action: AUDIT_ACTIONS.LOYALTY_PROGRAM_UPDATED,
        entityType: "LoyaltyProgramConfig",
        entityId: config._id,
        description: "Loyalty program configuration updated",
        metadata: {
          previous: oldConfigSnapshot,
          updated: payload,
        },
      });
      await auditLog.save({ session });

      return config;
    });
  }

  /**
   * Calculate points earned from eligible invoice lines.
   * Rules:
   * 1. Only customerPayable amounts on uncovered service lines (after all line discounts) qualify.
   * 2. Tax is excluded (strictly NO TAX in system).
   * 3. Subscriptions coverage is excluded.
   * 4. Subscription purchase amounts are excluded in v1.
   * 5. Earning is: Math.floor(eligibleSpend / earnThresholdAmount) * earnPointsPerUnit.
   */
  calculatePointsToEarn(lines, config) {
    if (!config || !config.isEnabled) {
      return 0;
    }

    let eligibleSpend = 0;
    for (const line of lines || []) {
      if (!line.isCoveredBySubscription) {
        eligibleSpend = Number((eligibleSpend + (line.customerPayable || 0)).toFixed(2));
      }
    }

    if (eligibleSpend <= 0) {
      return 0;
    }

    const threshold = config.earnThresholdAmount || 100;
    const pointsPerUnit = config.earnPointsPerUnit || 1;
    const units = Math.floor(eligibleSpend / threshold);
    return Math.max(0, units * pointsPerUnit);
  }

  /**
   * Side-effect free preview of redemption rules.
   * Checks customer balance, organization settings, minimum points, and maximum percentage cap.
   * Derives eligible bill amount authoritatively from persisted draft invoice if invoiceId is provided.
   */
  async previewRedemption(customerId, eligibleBillAmount, requestedPoints = null, organizationId, session = null, invoiceId = null) {
    const config = await this.getEffectiveConfig(organizationId, session);

    const customer = await Customer.findOne({
      _id: customerId,
      organizationId,
      isDeleted: false,
    }).session(session);

    if (!customer) {
      throw new AppError("Customer not found", 404);
    }

    let calculatedEligibleAmount = eligibleBillAmount;
    if (invoiceId) {
      const invoice = await Invoice.findOne({
        _id: invoiceId,
        organizationId,
        isDeleted: false,
      }).session(session);

      if (!invoice) {
        throw new AppError("Invoice not found", 404);
      }
      if (invoice.customerId.toString() !== customerId.toString()) {
        throw new AppError("Invoice does not belong to specified customer", 400);
      }

      // Calculate authoritative eligible uncovered amount from line items
      let uncoveredPayable = 0;
      for (const line of invoice.lines || []) {
        if (!line.isCoveredBySubscription) {
          uncoveredPayable += (line.lineTotal || 0);
        }
      }
      const standardDiscount = Math.max(0, (invoice.discountTotal || 0) - (invoice.loyaltyDiscountAmount || 0));
      calculatedEligibleAmount = Math.max(0, Number((uncoveredPayable - standardDiscount).toFixed(2)));
    } else if (calculatedEligibleAmount === null || calculatedEligibleAmount === undefined) {
      throw new AppError("Either billAmount or invoiceId must be provided for preview", 400);
    }

    const availablePoints = Math.max(0, customer.loyaltyPoints || 0);

    if (!config.isEnabled) {
      return {
        isEligible: false,
        reason: "Loyalty program is not enabled for this organization",
        availablePoints,
        maxRedeemablePoints: 0,
        maxRedemptionDiscount: 0,
        appliedPoints: 0,
        appliedDiscount: 0,
        effectivePayable: calculatedEligibleAmount,
      };
    }

    if (availablePoints < config.minRedemptionPoints) {
      return {
        isEligible: false,
        reason: `Available points (${availablePoints}) is below minimum redemption threshold of ${config.minRedemptionPoints} points`,
        availablePoints,
        maxRedeemablePoints: 0,
        maxRedemptionDiscount: 0,
        appliedPoints: 0,
        appliedDiscount: 0,
        effectivePayable: calculatedEligibleAmount,
      };
    }

    if (calculatedEligibleAmount <= 0) {
      return {
        isEligible: false,
        reason: "Bill amount must be greater than zero to redeem loyalty points",
        availablePoints,
        maxRedeemablePoints: 0,
        maxRedemptionDiscount: 0,
        appliedPoints: 0,
        appliedDiscount: 0,
        effectivePayable: 0,
      };
    }

    // Maximum discount in currency allowed by percentage cap
    const maxDiscountAllowed = Number(
      ((calculatedEligibleAmount * config.maxRedemptionPercentage) / 100).toFixed(2)
    );

    // Maximum points corresponding to max discount (floor to integer points)
    const pointsForMaxDiscount = Math.floor(maxDiscountAllowed / config.redemptionRate);

    // Maximum points customer can redeem (cannot exceed customer's available balance)
    const maxRedeemablePoints = Math.min(availablePoints, pointsForMaxDiscount);
    const maxRedemptionDiscount = Number((maxRedeemablePoints * config.redemptionRate).toFixed(2));

    if (maxRedeemablePoints < config.minRedemptionPoints) {
      const minBillRequired = Math.ceil(
        (config.minRedemptionPoints * config.redemptionRate * 100) / config.maxRedemptionPercentage
      );
      return {
        isEligible: false,
        reason: `Bill amount of ₹${calculatedEligibleAmount} allows maximum redemption of ${pointsForMaxDiscount} points (${config.maxRedemptionPercentage}% cap), which is below the minimum redemption requirement of ${config.minRedemptionPoints} points (minimum bill amount required: ₹${minBillRequired})`,
        availablePoints,
        maxRedeemablePoints: 0,
        maxRedemptionDiscount: 0,
        appliedPoints: 0,
        appliedDiscount: 0,
        effectivePayable: calculatedEligibleAmount,
      };
    }

    // Determine applied points: if requestedPoints is provided, use min(requested, maxRedeemable)
    let appliedPoints = 0;
    if (requestedPoints !== null && requestedPoints !== undefined) {
      const requestedInt = Math.max(0, Math.floor(Number(requestedPoints)));
      if (requestedInt < config.minRedemptionPoints) {
        throw new AppError(
          `Requested redemption (${requestedInt} points) is below minimum redemption threshold of ${config.minRedemptionPoints} points`,
          400
        );
      }
      if (requestedInt > availablePoints) {
        throw new AppError(
          `Requested points (${requestedInt}) exceeds customer's available balance (${availablePoints})`,
          400
        );
      }
      if (requestedInt > maxRedeemablePoints) {
        throw new AppError(
          `Requested points (${requestedInt}) exceeds maximum allowed redemption for this bill (${maxRedeemablePoints} points / ₹${maxDiscountAllowed})`,
          400
        );
      }
      appliedPoints = requestedInt;
    } else {
      appliedPoints = maxRedeemablePoints;
    }

    const appliedDiscount = Number((appliedPoints * config.redemptionRate).toFixed(2));
    const effectivePayable = Math.max(0, Number((calculatedEligibleAmount - appliedDiscount).toFixed(2)));

    return {
      isEligible: true,
      availablePoints,
      maxRedeemablePoints,
      maxRedemptionDiscount,
      appliedPoints,
      appliedDiscount,
      effectivePayable,
    };
  }

  /**
   * Commit loyalty redemption inside a MongoDB transaction session.
   * Atomically decrements Customer.loyaltyPoints and creates a REDEEMED LoyaltyTransaction.
   */
  async commitRedemption({
    organizationId,
    customerId,
    branchId,
    invoiceId,
    points,
    discountAmount,
    actorId,
    session,
  }) {
    if (!points || points <= 0) return null;

    const sourceEventKey = `REDEEM_INV_${invoiceId.toString()}`;

    // Guard against duplicate redemption for this invoice
    const existing = await LoyaltyTransaction.findOne({
      organizationId,
      sourceEventKey,
    }).session(session);

    if (existing) {
      return existing;
    }

    // Conditional atomic update to prevent overdraft
    const updatedCustomer = await Customer.findOneAndUpdate(
      {
        _id: customerId,
        organizationId,
        loyaltyPoints: { $gte: points },
        isDeleted: false,
      },
      {
        $inc: { loyaltyPoints: -points },
      },
      {
        new: true,
        session,
      }
    );

    if (!updatedCustomer) {
      throw new AppError(
        "Insufficient loyalty points or concurrent balance change detected",
        400
      );
    }

    const balanceAfter = updatedCustomer.loyaltyPoints;
    const balanceBefore = balanceAfter + points;

    const transaction = new LoyaltyTransaction({
      organizationId,
      customerId,
      branchId,
      type: LOYALTY_TRANSACTION_TYPES.REDEEMED,
      pointsDelta: -points,
      balanceBefore,
      balanceAfter,
      invoiceId,
      sourceEventKey,
      actorId,
      reason: `Points redeemed for discount of ₹${discountAmount} on invoice`,
      rateSnapshot: {
        redemptionRate: points > 0 ? Number((discountAmount / points).toFixed(2)) : 1,
      },
    });

    await transaction.save({ session });
    return transaction;
  }

  /**
   * Award loyalty points for a qualifying fully paid invoice inside a transaction session.
   * Checks program configuration and ensures idempotency via sourceEventKey.
   */
  async awardPointsForSettledInvoice({
    invoice,
    payment,
    actorId,
    session,
  }) {
    const { organizationId, customerId, branchId, lines } = invoice;
    const sourceEventKey = `EARN_INV_${invoice._id.toString()}`;

    // Check if points were already awarded
    const existingTx = await LoyaltyTransaction.findOne({
      organizationId,
      sourceEventKey,
    }).session(session);

    if (existingTx) {
      return existingTx;
    }

    const config = await this.getEffectiveConfig(organizationId, session);
    if (!config.isEnabled) {
      return null;
    }

    const pointsToAward = this.calculatePointsToEarn(lines, config);
    if (pointsToAward <= 0) {
      return null;
    }

    const customer = await Customer.findOne({
      _id: customerId,
      organizationId,
      isDeleted: false,
    }).session(session);

    if (!customer) {
      throw new AppError("Customer record not found for loyalty award", 404);
    }

    const currentPoints = customer.loyaltyPoints || 0;
    const currentDebt = customer.loyaltyPointsDebt || 0;
    const balanceBefore = currentPoints - currentDebt;

    let newPoints = currentPoints;
    let newDebt = currentDebt;

    if (currentDebt > 0) {
      if (pointsToAward >= currentDebt) {
        const remainingToAward = pointsToAward - currentDebt;
        newDebt = 0;
        newPoints = currentPoints + remainingToAward;
      } else {
        newDebt = currentDebt - pointsToAward;
      }
    } else {
      newPoints = currentPoints + pointsToAward;
    }

    const balanceAfter = newPoints - newDebt;

    customer.loyaltyPoints = newPoints;
    customer.loyaltyPointsDebt = newDebt;
    await customer.save({ session });

    let eligibleSpend = 0;
    for (const line of lines || []) {
      if (!line.isCoveredBySubscription) {
        eligibleSpend = Number((eligibleSpend + (line.customerPayable || 0)).toFixed(2));
      }
    }

    const transaction = new LoyaltyTransaction({
      organizationId,
      customerId,
      branchId,
      type: LOYALTY_TRANSACTION_TYPES.EARNED,
      pointsDelta: pointsToAward,
      balanceBefore,
      balanceAfter,
      invoiceId: invoice._id,
      paymentId: payment ? payment._id : null,
      sourceEventKey,
      actorId,
      reason: `Points earned on settlement of invoice ${invoice.invoiceNumber}`,
      rateSnapshot: {
        earnThresholdAmount: config.earnThresholdAmount,
        earnPointsPerUnit: config.earnPointsPerUnit,
        eligibleSpendAmount: eligibleSpend,
      },
    });

    await transaction.save({ session });

    invoice.loyaltyPointsEarned = (invoice.loyaltyPointsEarned || 0) + pointsToAward;
    await invoice.save({ session });

    return transaction;
  }

  /**
   * Reverse points earned on an invoice when the settling payment is voided.
   * Reverses pointsDelta atomically inside session.
   * If points were already spent, records debt in loyaltyPointsDebt and records full economic reversal.
   */
  async reverseEarningForVoidedPayment({
    invoice,
    payment,
    actorId,
    session,
  }) {
    const { organizationId, customerId, branchId } = invoice;
    const originalEarnKey = `EARN_INV_${invoice._id.toString()}`;

    const originalEarnTx = await LoyaltyTransaction.findOne({
      organizationId,
      sourceEventKey: originalEarnKey,
    }).session(session);

    if (!originalEarnTx) {
      return null;
    }

    const reverseEventKey = `REVERSE_PAY_${payment._id.toString()}`;
    const existingReverse = await LoyaltyTransaction.findOne({
      organizationId,
      sourceEventKey: reverseEventKey,
    }).session(session);

    if (existingReverse) {
      return existingReverse;
    }

    const pointsToReverse = originalEarnTx.pointsDelta; // positive number
    if (pointsToReverse <= 0) {
      return null;
    }

    const customer = await Customer.findOne({
      _id: customerId,
      organizationId,
      isDeleted: false,
    }).session(session);

    if (!customer) {
      throw new AppError("Customer not found", 404);
    }

    const currentPoints = customer.loyaltyPoints || 0;
    const currentDebt = customer.loyaltyPointsDebt || 0;
    const balanceBefore = currentPoints - currentDebt;

    // Full economic reversal calculation
    let newPoints = currentPoints;
    let newDebt = currentDebt;

    if (currentPoints >= pointsToReverse) {
      newPoints = currentPoints - pointsToReverse;
    } else {
      const remainingUncovered = pointsToReverse - currentPoints;
      newPoints = 0;
      newDebt = currentDebt + remainingUncovered;
    }

    const balanceAfter = newPoints - newDebt;

    customer.loyaltyPoints = newPoints;
    customer.loyaltyPointsDebt = newDebt;
    await customer.save({ session });

    const reverseTx = new LoyaltyTransaction({
      organizationId,
      customerId,
      branchId,
      type: LOYALTY_TRANSACTION_TYPES.EARNING_REVERSED,
      pointsDelta: -pointsToReverse,
      balanceBefore,
      balanceAfter,
      invoiceId: invoice._id,
      paymentId: payment._id,
      originalTransactionId: originalEarnTx._id,
      sourceEventKey: reverseEventKey,
      actorId,
      reason: `Earning reversed due to voiding of payment ${payment.paymentNumber} on invoice ${invoice.invoiceNumber}`,
      rateSnapshot: originalEarnTx.rateSnapshot,
    });

    await reverseTx.save({ session });

    invoice.loyaltyPointsEarned = Math.max(0, (invoice.loyaltyPointsEarned || 0) - pointsToReverse);
    await invoice.save({ session });

    return reverseTx;
  }

  /**
   * Restore redeemed points if an invoice is cancelled.
   */
  async restoreRedemptionForCancelledInvoice({
    invoice,
    actorId,
    reason,
    session,
  }) {
    const { organizationId, customerId, branchId } = invoice;
    const originalRedeemKey = `REDEEM_INV_${invoice._id.toString()}`;

    const originalRedeemTx = await LoyaltyTransaction.findOne({
      organizationId,
      sourceEventKey: originalRedeemKey,
    }).session(session);

    if (!originalRedeemTx) {
      return null;
    }

    const restoreEventKey = `RESTORE_REDEEM_INV_${invoice._id.toString()}`;
    const existingRestore = await LoyaltyTransaction.findOne({
      organizationId,
      sourceEventKey: restoreEventKey,
    }).session(session);

    if (existingRestore) {
      return existingRestore;
    }

    const pointsToRestore = Math.abs(originalRedeemTx.pointsDelta);
    if (pointsToRestore <= 0) {
      return null;
    }

    const updatedCustomer = await Customer.findOneAndUpdate(
      {
        _id: customerId,
        organizationId,
        isDeleted: false,
      },
      {
        $inc: { loyaltyPoints: pointsToRestore },
      },
      {
        new: true,
        session,
      }
    );

    if (!updatedCustomer) {
      throw new AppError("Customer not found", 404);
    }

    const balanceAfter = updatedCustomer.loyaltyPoints;
    const balanceBefore = balanceAfter - pointsToRestore;

    const restoreTx = new LoyaltyTransaction({
      organizationId,
      customerId,
      branchId,
      type: LOYALTY_TRANSACTION_TYPES.REDEMPTION_RESTORED,
      pointsDelta: pointsToRestore,
      balanceBefore,
      balanceAfter,
      invoiceId: invoice._id,
      originalTransactionId: originalRedeemTx._id,
      sourceEventKey: restoreEventKey,
      actorId,
      reason: `Redeemed points restored due to invoice cancellation: ${reason || "Invoice cancelled"}`,
    });

    await restoreTx.save({ session });
    return restoreTx;
  }

  /**
   * Manual points adjustment (CREDIT or DEBIT).
   */
  async adjustCustomerPoints({
    customerId,
    organizationId,
    branchId,
    points,
    operation,
    reason,
    idempotencyKey,
    actorId,
  }) {
    if (idempotencyKey) {
      const existing = await LoyaltyTransaction.findOne({
        organizationId,
        idempotencyKey,
      });
      if (existing) {
        return {
          transaction: existing,
          isIdempotentReplay: true,
        };
      }
    }

    return await runInTransaction(async (session) => {
      if (idempotencyKey) {
        const raceTx = await LoyaltyTransaction.findOne({
          organizationId,
          idempotencyKey,
        }).session(session);
        if (raceTx) {
          return {
            transaction: raceTx,
            isIdempotentReplay: true,
          };
        }
      }

      const customer = await Customer.findOne({
        _id: customerId,
        organizationId,
        isDeleted: false,
      }).session(session);

      if (!customer) {
        throw new AppError("Customer not found", 404);
      }

      const balanceBefore = customer.loyaltyPoints || 0;
      let balanceAfter;
      let signedDelta;

      if (operation === "DEBIT") {
        if (points > balanceBefore) {
          throw new AppError(
            `Cannot debit ${points} points: customer only has ${balanceBefore} available points`,
            400
          );
        }
        signedDelta = -points;
        balanceAfter = balanceBefore - points;
      } else {
        signedDelta = points;
        balanceAfter = balanceBefore + points;
      }

      // Conditional atomic update
      const condition = {
        _id: customerId,
        organizationId,
        isDeleted: false,
      };
      if (operation === "DEBIT") {
        condition.loyaltyPoints = { $gte: points };
      }

      const updatedCustomer = await Customer.findOneAndUpdate(
        condition,
        { $inc: { loyaltyPoints: signedDelta } },
        { new: true, session }
      );

      if (!updatedCustomer) {
        throw new AppError(
          "Customer balance changed concurrently or debit exceeds balance",
          409
        );
      }

      const transaction = new LoyaltyTransaction({
        organizationId,
        customerId,
        branchId: branchId || null,
        type: LOYALTY_TRANSACTION_TYPES.ADJUSTED,
        pointsDelta: signedDelta,
        balanceBefore,
        balanceAfter,
        reason,
        idempotencyKey: idempotencyKey || null,
        actorId,
      });

      await transaction.save({ session });

      const auditLog = new AuditLog({
        organizationId,
        branchId: branchId || null,
        actorId,
        action: AUDIT_ACTIONS.LOYALTY_POINTS_ADJUSTED,
        entityType: "Customer",
        entityId: new mongoose.Types.ObjectId(customerId.toString()),
        description: `Manually ${operation === "CREDIT" ? "awarded" : "deducted"} ${points} loyalty points. Reason: ${reason}`,
        metadata: {
          customerId: customerId.toString(),
          points,
          operation,
          reason,
          balanceBefore,
          balanceAfter,
          idempotencyKey: idempotencyKey || null,
        },
      });
      await auditLog.save({ session });

      return {
        transaction,
        customer: updatedCustomer,
        isIdempotentReplay: false,
      };
    });
  }

  /**
   * List customer loyalty ledger transactions.
   */
  async listCustomerLedger(customerId, organizationId, filter, pagination) {
    const customer = await Customer.findOne({
      _id: customerId,
      organizationId,
      isDeleted: false,
    });

    if (!customer) {
      throw new AppError("Customer not found", 404);
    }

    return await loyaltyTransactionRepository.listCustomerLedger(
      customerId,
      organizationId,
      filter,
      pagination
    );
  }
}

export const loyaltyService = new LoyaltyService();
