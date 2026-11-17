import mongoose from "mongoose";
import { AppError } from "../../utils/errors.js";

const MAX_SAFE_PAISE = 10_000_000_000_000; // 10^13 paise (₹100 Crore upper bound)

/**
 * Pure mathematical calculation engine for incentives, tier evaluations,
 * and exact Hamilton-Hare Largest Remainder multi-staff split allocations.
 */
export class IncentiveCalculationEngine {
  static supportsCommissionScheme(scheme) {
    return scheme?.schemeType === "COMMISSION" &&
      [
        "SERVICE_NET_REVENUE",
        "SUBSCRIPTION_NET_REVENUE",
        "MEMBERSHIP_NET_REVENUE",
        "PRODUCT_NET_REVENUE",
      ].includes(scheme?.calculationBasis);
  }

  static supportsAttendanceBonusScheme(scheme) {
    return scheme?.schemeType === "ATTENDANCE_BONUS" &&
      scheme?.calculationBasis === "ATTENDANCE_DAYS" &&
      Number.isInteger(scheme?.rules?.minimumAttendanceDays) &&
      scheme.rules.minimumAttendanceDays > 0 &&
      Number.isInteger(scheme?.rules?.fixedAmountPaise) &&
      scheme.rules.fixedAmountPaise > 0 &&
      (!Array.isArray(scheme.rules.tiers) || scheme.rules.tiers.length === 0);
  }

  static supportsAssignableScheme(scheme) {
    return this.supportsCommissionScheme(scheme) || this.supportsAttendanceBonusScheme(scheme);
  }

  static calculateAttendanceBonus(scheme, verifiedAttendanceDays) {
    if (!this.supportsAttendanceBonusScheme(scheme)) {
      throw new AppError("Attendance bonus scheme is invalid or unsupported", 400);
    }
    if (!Number.isFinite(verifiedAttendanceDays) || verifiedAttendanceDays < 0) {
      throw new AppError("verifiedAttendanceDays must be a non-negative number", 400);
    }
    const isTargetMet = verifiedAttendanceDays >= scheme.rules.minimumAttendanceDays;
    return {
      isTargetMet,
      bonusAwardedInPaise: isTargetMet ? scheme.rules.fixedAmountPaise : 0,
    };
  }

  /**
   * Evaluates earned commission in integer paise for a single staff revenue slice.
   * Supports:
   * 1. Fixed fee rules (`rules.fixedAmountPaise`).
   * 2. Graduated/tiered percentage and fixed rules (`rules.tiers`).
   * 3. Hybrid fixed + tiered rules.
   *
   * @param {Object} scheme - IncentiveScheme document or rules payload
   * @param {number} attributedRevenueInPaise - Attributed revenue in integer paise
   * @returns {{ earnedCommissionInPaise: number, snapshot: Object }}
   */
  static calculateCommission(scheme, attributedRevenueInPaise) {
    if (
      (scheme.schemeType !== undefined && scheme.schemeType !== "COMMISSION") ||
      (scheme.calculationBasis !== undefined &&
        ![
          "SERVICE_NET_REVENUE",
          "SUBSCRIPTION_NET_REVENUE",
          "MEMBERSHIP_NET_REVENUE",
          "PRODUCT_NET_REVENUE",
        ].includes(scheme.calculationBasis))
    ) {
      throw new AppError("Commission calculation supports only service, subscription-sale, membership-sale, or retail-sale net revenue schemes", 400);
    }

    if (!Number.isInteger(attributedRevenueInPaise) || attributedRevenueInPaise < 0) {
      throw new AppError("attributedRevenueInPaise must be a non-negative integer", 400);
    }
    if (attributedRevenueInPaise > MAX_SAFE_PAISE) {
      throw new AppError("attributedRevenueInPaise exceeds maximum safe financial limit", 400);
    }

    const rules = scheme.rules || {};
    let totalCommissionInPaise = 0;
    let appliedRate = 0;
    let tierMinPaise = null;
    let tierMaxPaise = null;

    // 1. Add baseline fixed commission if configured
    const baseFixedPaise = Number(rules.fixedAmountPaise || 0);
    if (baseFixedPaise > 0) {
      totalCommissionInPaise += baseFixedPaise;
    }

    // 2. Evaluate tiers if configured
    const tiers = Array.isArray(rules.tiers) ? rules.tiers : [];
    if (tiers.length > 0) {
      // Find matching tier based on attributed revenue
      const matchingTier = tiers.find((tier) => {
        const meetsMin = attributedRevenueInPaise >= tier.minPaise;
        const meetsMax = tier.maxPaise === null || tier.maxPaise === undefined || attributedRevenueInPaise <= tier.maxPaise;
        return meetsMin && meetsMax;
      });

      if (matchingTier) {
        appliedRate = matchingTier.percentage || 0;
        tierMinPaise = matchingTier.minPaise;
        tierMaxPaise = matchingTier.maxPaise ?? null;

        // Calculate percentage component in integer paise using exact BigInt rounding
        if (appliedRate > 0 && attributedRevenueInPaise > 0) {
          // (revenue * rate * 100) / 10000 = (revenue * rate) / 100
          // Multiply by 10000 for 4 decimal place precision before rounding
          const rateBasisPoints = BigInt(Math.round(appliedRate * 100)); // e.g. 10.5% -> 1050 basis points
          const revenueBig = BigInt(attributedRevenueInPaise);
          // (revenueBig * rateBasisPoints + 5000n) / 10000n for half-up rounding
          const percentageEarning = (revenueBig * rateBasisPoints + 5000n) / 10000n;
          totalCommissionInPaise += Number(percentageEarning);
        }

        // Add tier fixed paise component if configured
        if (matchingTier.fixedPaise && matchingTier.fixedPaise > 0) {
          totalCommissionInPaise += matchingTier.fixedPaise;
        }
      }
    }

    return {
      earnedCommissionInPaise: Math.min(totalCommissionInPaise, MAX_SAFE_PAISE),
      snapshot: {
        calculationBasis: scheme.calculationBasis || "SERVICE_NET_REVENUE",
        schemeCode: scheme.code || null,
        appliedRate,
        fixedAmountPaise: baseFixedPaise,
        tierMinPaise,
        tierMaxPaise,
      },
    };
  }

  /**
   * Distributes an integer pool of paise among multiple staff members using
   * the Hamilton-Hare Largest Remainder Method with deterministic tie-breaking.
   * Guarantees:
   *   Sum(allocatedPaise) === totalPoolPaise (Exact reconciliation, 0 paise leak).
   *
   * @param {number} totalPoolPaise - Total integer paise to distribute
   * @param {Array<{ staffId: string|mongoose.Types.ObjectId, splitPercentage: number }>} splitAttributions
   * @returns {Array<{ staffId: string, allocatedPaise: number, splitPercentage: number }>}
   */
  static allocateLargestRemainder(totalPoolPaise, splitAttributions) {
    if (!Number.isInteger(totalPoolPaise) || totalPoolPaise < 0) {
      throw new AppError("totalPoolPaise must be a non-negative integer", 400);
    }
    if (!Array.isArray(splitAttributions) || splitAttributions.length === 0) {
      return [];
    }

    // Check for duplicate staff IDs and validate individual percentage entries
    const seenStaffIds = new Set();
    for (const recipient of splitAttributions) {
      if (!recipient || !recipient.staffId) {
        throw new AppError("Every split attribution must specify a valid staffId", 400);
      }
      const staffIdStr = recipient.staffId.toString();
      if (seenStaffIds.has(staffIdStr)) {
        throw new AppError(`Duplicate staffId '${staffIdStr}' in split attribution`, 400);
      }
      seenStaffIds.add(staffIdStr);

      if (
        typeof recipient.splitPercentage !== "number" ||
        recipient.splitPercentage < 0 ||
        recipient.splitPercentage > 100
      ) {
        throw new AppError(`Invalid split percentage for staffId ${staffIdStr}: must be between 0 and 100`, 400);
      }
    }

    if (totalPoolPaise === 0) {
      return splitAttributions.map((s) => ({
        staffId: s.staffId.toString(),
        allocatedPaise: 0,
        splitPercentage: s.splitPercentage,
      }));
    }

    // Verify split percentages sum to 100 (allow standard rounding tolerance of 0.01)
    const totalPercentage = splitAttributions.reduce((acc, cur) => acc + cur.splitPercentage, 0);
    if (Math.abs(totalPercentage - 100) > 0.05) {
      throw new AppError(`Split percentages must sum to 100, but received ${totalPercentage}`, 400);
    }

    const totalPoolBig = BigInt(totalPoolPaise);
    let distributedSum = 0n;

    // Step 1: Compute integer floor quotient and exact remainder for each recipient
    const recipientCalculations = splitAttributions.map((recipient, idx) => {
      // splitPercentage in basis points (e.g. 33.33% -> 3333 basis points)
      const basisPoints = BigInt(Math.round(recipient.splitPercentage * 100));
      // Raw exact share = (totalPoolBig * basisPoints) / 10000n
      const rawExactUnits = totalPoolBig * basisPoints;
      const floorPaise = rawExactUnits / 10000n;
      const fractionalRemainder = rawExactUnits % 10000n;

      distributedSum += floorPaise;

      return {
        originalIndex: idx,
        staffId: recipient.staffId.toString(),
        splitPercentage: recipient.splitPercentage,
        allocatedPaise: Number(floorPaise),
        fractionalRemainder: Number(fractionalRemainder),
      };
    });

    // Step 2: Determine remaining undistributed paise
    let undistributedPaise = Number(totalPoolBig - distributedSum);

    // Step 3: Sort descending by fractional remainder; break ties by staffId string ASC
    const sortedForRemainder = [...recipientCalculations].sort((a, b) => {
      if (b.fractionalRemainder !== a.fractionalRemainder) {
        return b.fractionalRemainder - a.fractionalRemainder;
      }
      return a.staffId.localeCompare(b.staffId);
    });

    // Step 4: Allocate +1 paise to top recipients until remainder is zero
    for (let i = 0; i < undistributedPaise; i++) {
      const luckyRecipient = sortedForRemainder[i % sortedForRemainder.length];
      luckyRecipient.allocatedPaise += 1;
    }

    // Step 5: Restore original ordering and clean up metadata
    const finalAllocations = recipientCalculations.map((r) => {
      const updated = sortedForRemainder.find((s) => s.originalIndex === r.originalIndex);
      return {
        staffId: updated.staffId,
        allocatedPaise: updated.allocatedPaise,
        splitPercentage: updated.splitPercentage,
      };
    });

    // Final Sanity Invariant Check: Sum === totalPoolPaise
    const finalSum = finalAllocations.reduce((sum, item) => sum + item.allocatedPaise, 0);
    if (finalSum !== totalPoolPaise) {
      throw new AppError(
        `Critical mathematical invariant violation: split allocation sum (${finalSum}) does not match pool (${totalPoolPaise})`,
        500
      );
    }

    return finalAllocations;
  }

  /**
   * Evaluates monthly target and attendance bonuses for a staff member.
   *
   * @param {Object} params
   * @param {Object} params.scheme - IncentiveScheme document
   * @param {number} params.achievedRevenueInPaise - Staff monthly revenue achieved in integer paise
   * @param {number} params.attendedDaysCount - Number of attended days in the month
   * @returns {{ isTargetMet: boolean, bonusAwardedInPaise: number }}
   */
  static evaluateMonthlyBonus({
    scheme,
    achievedRevenueInPaise,
    attendedDaysCount,
  }) {
    if (scheme.schemeType === "ATTENDANCE_BONUS" || scheme.schemeType === "HYBRID") {
      throw new AppError(
        "Attendance bonus evaluation must use verified Attendance records",
        400
      );
    }

    const rules = scheme.rules || {};
    let isTargetMet = false;
    let bonusAwardedInPaise = 0;

    if (scheme.schemeType === "TARGET_BONUS" || scheme.schemeType === "HYBRID") {
      const threshold = rules.targetThresholdPaise || 0;
      if (threshold > 0 && achievedRevenueInPaise >= threshold) {
        isTargetMet = true;
        bonusAwardedInPaise += rules.fixedAmountPaise || 0;
      }
    }

    return {
      isTargetMet,
      bonusAwardedInPaise: Math.min(bonusAwardedInPaise, MAX_SAFE_PAISE),
    };
  }
}
