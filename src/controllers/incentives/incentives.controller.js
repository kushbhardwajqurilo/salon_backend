import mongoose from "mongoose";
import { IncentiveScheme } from "../../models/incentives/incentiveScheme.model.js";
import { SchemeAssignment } from "../../models/incentives/schemeAssignment.model.js";
import { IncentiveLedger } from "../../models/incentives/incentiveLedger.model.js";
import { IncentiveRecoveryObligation } from "../../models/incentives/incentiveRecoveryObligation.model.js";
import { IncentiveRecoveryPayment } from "../../models/incentives/incentiveRecoveryPayment.model.js";
import { PayrollIncentiveAllocation } from "../../models/payroll/payrollIncentiveAllocation.model.js";
import { Staff } from "../../models/staff/staff.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { schemeAssignmentService } from "../../services/incentives/schemeAssignment.service.js";
import { IncentiveCalculationEngine } from "../../services/incentives/incentiveCalculation.engine.js";
import { AuditLog } from "../../models/audit/auditLog.model.js";
import { hasUserPermission } from "../../middleware/rbac.js";
import { AppError } from "../../utils/errors.js";
import { Invoice } from "../../models/billing/invoice.model.js";
import { InvoiceSettlementEvent } from "../../models/incentives/invoiceSettlementEvent.model.js";
import { ServiceFulfillmentEvent } from "../../models/incentives/serviceFulfillmentEvent.model.js";
import { Appointment } from "../../models/appointments/appointment.model.js";
import { runInTransaction } from "../../utils/transaction.js";
import { settlementFulfillmentEventService } from "../../services/incentives/settlementFulfillmentEvent.service.js";
import { attendanceBonusService } from "../../services/incentives/attendanceBonus.service.js";
import { ManualRecoveryPaymentService } from "../../services/incentives/manualRecoveryPayment.service.js";

// Incentive data is branch-scoped for callers who do not have explicit
// organization-wide access. Authentication has already resolved branchAccess
// from the persisted user record, so never accept a broader scope from query
// parameters alone.
const branchScopeFilterFor = (user) => {
  if (user?.hasOrgWideAccess === true) return {};

  const allowedBranchIds = (user?.branchAccess || [])
    .filter((branch) => branch?.isActive !== false)
    .map((branch) => branch?.branchId || branch?._id || branch)
    .filter(Boolean);

  return { branchId: { $in: allowedBranchIds } };
};

const isBranchAuthorized = (user, branchId) =>
  user?.hasOrgWideAccess === true ||
  (user?.branchAccess || []).some(
    (branch) =>
      branch?.isActive !== false &&
      String(branch?.branchId || branch?._id || branch) === String(branchId)
  );

const applyRequestedBranchFilter = (filter, branchId) => {
  if (!branchId) return;

  if (Array.isArray(filter.branchId?.$in)) {
    filter.branchId = {
      $in: filter.branchId.$in.filter(
        (allowedBranchId) => String(allowedBranchId) === String(branchId)
      ),
    };
  } else {
    filter.branchId = branchId;
  }
};

const countPendingServiceFulfillment = async ({
  organizationId,
  branchScope,
  staffId,
}) => {
  const paidInvoices = await Invoice.find({
    organizationId,
    paymentStatus: "paid",
    status: "finalized",
    isDeleted: false,
    ...branchScope,
  }).select("_id appointmentId").lean();

  if (paidInvoices.length === 0) return 0;

  const invoiceIds = paidInvoices.map((invoice) => invoice._id);
  const settlementEvents = await InvoiceSettlementEvent.find({
    organizationId,
    invoiceId: { $in: invoiceIds },
    eventType: "SETTLED",
  }).sort({ settlementCycle: -1 }).lean();
  const latestSettlements = new Map();
  for (const event of settlementEvents) {
    const invoiceKey = event.invoiceId.toString();
    if (!latestSettlements.has(invoiceKey)) latestSettlements.set(invoiceKey, event);
  }

  const appointmentIds = paidInvoices
    .map((invoice) => invoice.appointmentId)
    .filter(Boolean);
  const appointments = appointmentIds.length > 0
    ? await Appointment.find({
        organizationId,
        _id: { $in: appointmentIds },
      }).select("_id status").lean()
    : [];
  const completedAppointments = new Set(
    appointments.filter((appointment) => appointment.status === "completed")
      .map((appointment) => appointment._id.toString()),
  );

  const pendingWalkInLines = [];
  let pendingCount = 0;
  for (const invoice of paidInvoices) {
    const settlement = latestSettlements.get(invoice._id.toString());
    if (!settlement) continue;
    const serviceLines = (settlement.lineItems || []).filter(
      (line) =>
        (line.itemType === "service" || line.itemType === "custom_service") &&
        Array.isArray(line.staffAttributions) &&
        line.staffAttributions.some(
          (attribution) =>
            attribution.staffId &&
            (!staffId || attribution.staffId.toString() === staffId.toString()),
        ),
    );
    if (serviceLines.length === 0) continue;

    if (invoice.appointmentId) {
      if (!completedAppointments.has(invoice.appointmentId.toString())) {
        pendingCount += serviceLines.length;
      }
    } else {
      pendingWalkInLines.push(
        ...serviceLines.map((line) => ({
          invoiceId: invoice._id,
          lineItemId: line.itemId,
        })),
      );
    }
  }

  if (pendingWalkInLines.length === 0) return pendingCount;
  const fulfilledWalkInLines = await ServiceFulfillmentEvent.find({
    organizationId,
    $or: pendingWalkInLines,
  }).select("invoiceId lineItemId").lean();
  const fulfilledKeys = new Set(
    fulfilledWalkInLines.map(
      (event) => `${event.invoiceId.toString()}:${event.lineItemId.toString()}`,
    ),
  );

  return pendingCount + pendingWalkInLines.filter(
    (line) => !fulfilledKeys.has(`${line.invoiceId.toString()}:${line.lineItemId.toString()}`),
  ).length;
};

/**
 * Controller managing Incentive Schemes, Scheme Assignments,
 * and live calculation preview endpoints.
 */

// 1. CREATE SCHEME
export const createScheme = async (req, res, next) => {
  try {
    const organizationId = req.user.organizationId;
    const userId = req.user.id;
    const { name, code, description, schemeType, calculationBasis, rules } = req.body;

    const existing = await IncentiveScheme.findOne({
      organizationId,
      code: code.toUpperCase(),
    });
    if (existing) {
      throw new AppError(`Scheme with code '${code}' already exists`, 409);
    }

    const session = await mongoose.startSession();
    let scheme;
    try {
      session.startTransaction();
      [scheme] = await IncentiveScheme.create(
        [{
          organizationId,
          name,
          code: code.toUpperCase(),
          description,
          schemeType,
          calculationBasis,
          rules,
          status: "draft",
          createdBy: userId,
          updatedBy: userId,
        }],
        { session }
      );
      await AuditLog.create(
        [{
          organizationId,
          actorId: userId,
          action: "INCENTIVE_SCHEME_CREATED",
          entityType: "IncentiveScheme",
          entityId: scheme._id,
          description: `Incentive scheme '${scheme.code}' created.`,
          metadata: { schemeCode: scheme.code },
        }],
        { session }
      );
      await session.commitTransaction();
    } catch (err) {
      if (session.inTransaction()) await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }

    res.status(201).json({
      success: true,
      data: scheme,
      message: "Incentive scheme created in draft status",
    });
  } catch (err) {
    next(err);
  }
};

// 2. LIST SCHEMES
export const listSchemes = async (req, res, next) => {
  try {
    const organizationId = req.user.organizationId;
    const { page = 1, limit = 20, status, schemeType, search } = req.query;

    const filter = { organizationId };
    if (status) filter.status = status;
    if (schemeType) filter.schemeType = schemeType;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { code: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [schemes, total] = await Promise.all([
      IncentiveScheme.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      IncentiveScheme.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: schemes,
      meta: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (err) {
    next(err);
  }
};

// 3. GET SCHEME BY ID
export const getSchemeById = async (req, res, next) => {
  try {
    const organizationId = req.user.organizationId;
    const { id } = req.params;

    const scheme = await IncentiveScheme.findOne({ _id: id, organizationId }).lean();
    if (!scheme) {
      throw new AppError("Incentive scheme not found", 404);
    }

    res.json({ success: true, data: scheme });
  } catch (err) {
    next(err);
  }
};

// 4. UPDATE SCHEME
export const updateScheme = async (req, res, next) => {
  try {
    const organizationId = req.user.organizationId;
    const userId = req.user.id;
    const { id } = req.params;

    const scheme = await IncentiveScheme.findOne({ _id: id, organizationId });
    if (!scheme) {
      throw new AppError("Incentive scheme not found", 404);
    }
    if (scheme.status === "archived") {
      throw new AppError("Cannot modify an archived scheme", 400);
    }

    const { name, description, calculationBasis, rules } = req.body;
    const updatedCalculationBasis = calculationBasis ?? scheme.calculationBasis;
    if (
      (scheme.schemeType === "COMMISSION" &&
        ![
          "SERVICE_NET_REVENUE",
          "SUBSCRIPTION_NET_REVENUE",
          "MEMBERSHIP_NET_REVENUE",
          "PRODUCT_NET_REVENUE",
        ].includes(updatedCalculationBasis)) ||
      (scheme.schemeType === "ATTENDANCE_BONUS" && updatedCalculationBasis !== "ATTENDANCE_DAYS")
    ) {
      throw new AppError("Calculation basis cannot change across incentive categories", 400);
    }
    if (name !== undefined) scheme.name = name;
    if (description !== undefined) scheme.description = description;
    if (calculationBasis !== undefined) scheme.calculationBasis = calculationBasis;
    if (rules !== undefined) scheme.rules = rules;
    if (
      scheme.schemeType === "ATTENDANCE_BONUS" &&
      !IncentiveCalculationEngine.supportsAttendanceBonusScheme(scheme)
    ) {
      throw new AppError("Attendance bonus rules require positive fixed paise and minimum attendance days", 400);
    }
    scheme.updatedBy = userId;

    await scheme.save();

    res.json({
      success: true,
      data: scheme,
      message: "Incentive scheme updated successfully",
    });
  } catch (err) {
    next(err);
  }
};

// 5. LIFECYCLE: ACTIVATE
export const activateScheme = async (req, res, next) => {
  try {
    const organizationId = req.user.organizationId;
    const userId = req.user.id;
    const { id } = req.params;

    const scheme = await IncentiveScheme.findOne({ _id: id, organizationId });
    if (!scheme) throw new AppError("Incentive scheme not found", 404);
    if (scheme.status === "archived") throw new AppError("Cannot activate an archived scheme", 400);
    if (!IncentiveCalculationEngine.supportsAssignableScheme(scheme)) {
      throw new AppError(
        "Only supported service, subscription-sale, membership-sale commission, and verified attendance bonus schemes can be activated",
        400
      );
    }

    scheme.status = "active";
    scheme.updatedBy = userId;
    await scheme.save();

    res.json({ success: true, data: scheme, message: "Scheme activated successfully" });
  } catch (err) {
    next(err);
  }
};

// 6. LIFECYCLE: PAUSE
export const pauseScheme = async (req, res, next) => {
  try {
    const organizationId = req.user.organizationId;
    const userId = req.user.id;
    const { id } = req.params;

    const scheme = await IncentiveScheme.findOne({ _id: id, organizationId });
    if (!scheme) throw new AppError("Incentive scheme not found", 404);

    scheme.status = "paused";
    scheme.updatedBy = userId;
    await scheme.save();

    res.json({ success: true, data: scheme, message: "Scheme paused successfully" });
  } catch (err) {
    next(err);
  }
};

// 7. LIFECYCLE: ARCHIVE
export const archiveScheme = async (req, res, next) => {
  try {
    const organizationId = req.user.organizationId;
    const userId = req.user.id;
    const { id } = req.params;

    const scheme = await IncentiveScheme.findOne({ _id: id, organizationId });
    if (!scheme) throw new AppError("Incentive scheme not found", 404);

    scheme.status = "archived";
    scheme.updatedBy = userId;
    await scheme.save();

    res.json({ success: true, data: scheme, message: "Scheme archived successfully" });
  } catch (err) {
    next(err);
  }
};

// 8. CREATE ASSIGNMENT
export const createAssignment = async (req, res, next) => {
  try {
    const organizationId = req.user.organizationId;
    const userId = req.user.id;

    const assignment = await schemeAssignmentService.createAssignment(
      req.body,
      organizationId,
      userId
    );

    res.status(201).json({
      success: true,
      data: assignment,
      message: "Scheme assigned successfully under ScopeLock serialization",
    });
  } catch (err) {
    next(err);
  }
};

// 9. LIST ASSIGNMENTS
export const listAssignments = async (req, res, next) => {
  try {
    const organizationId = req.user.organizationId;
    const { schemeId, scopeType, scopeId, status, page = 1, limit = 50 } = req.query;

    const filter = { organizationId };
    if (schemeId) filter.schemeId = schemeId;
    if (scopeType) filter.scopeType = scopeType;
    if (scopeId) filter.scopeId = scopeId;
    if (status) filter.status = status;

    const skip = (Number(page) - 1) * Number(limit);
    const [assignments, total] = await Promise.all([
      SchemeAssignment.find(filter)
        .populate("schemeId", "name code schemeType")
        .sort({ priority: -1, startDate: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      SchemeAssignment.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: assignments,
      meta: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (err) {
    next(err);
  }
};

// 10. PREVIEW CALCULATION
export const previewCalculation = async (req, res, next) => {
  try {
    const organizationId = req.user.organizationId;
    const { schemeId, revenueInPaise, staffId, branchId, date } = req.body;

    const canViewAll = await hasUserPermission(req.user, "incentives.view.all");
    if (staffId) {
      const requestedStaff = await Staff.findOne({ _id: staffId, organizationId }).select("_id");
      if (!requestedStaff) {
        throw new AppError("Staff member not found", 404);
      }
      if (!canViewAll) {
        const ownStaff = await Staff.findOne({ userId: req.user.id, organizationId }).select("_id");
        if (!ownStaff || String(ownStaff._id) !== String(requestedStaff._id)) {
          throw new AppError("Access denied. Employees may preview only their own incentives.", 403);
        }
      } else if (!req.user.hasOrgWideAccess && !branchId) {
        throw new AppError("branchId is required for branch-scoped calculation preview.", 400);
      }
    }

    if (branchId) {
      const branch = await Branch.findOne({ _id: branchId, organizationId, isActive: true }).select("_id");
      if (!branch) throw new AppError("Branch not found", 404);
      if (!isBranchAuthorized(req.user, branchId)) {
        throw new AppError("Access denied. You do not have access to this branch.", 403);
      }
    }

    let schemeDoc = null;
    if (schemeId) {
      schemeDoc = await IncentiveScheme.findOne({ _id: schemeId, organizationId });
    } else if (staffId) {
      const activeAssignment = await schemeAssignmentService.resolveActiveAssignment({
        organizationId,
        staffId,
        branchId,
        effectiveDate: date ? new Date(date) : new Date(),
      });
      if (activeAssignment) {
        schemeDoc = await IncentiveScheme.findOne({ _id: activeAssignment.schemeId, organizationId });
      }
    }

    if (!schemeDoc) {
      throw new AppError("No active scheme found for calculation preview", 404);
    }

    if (!IncentiveCalculationEngine.supportsCommissionScheme(schemeDoc)) {
      throw new AppError(
        "Calculation preview supports only service, subscription-sale, or membership-sale net revenue commission schemes",
        400
      );
    }

    const calcResult = IncentiveCalculationEngine.calculateCommission(schemeDoc, revenueInPaise);

    res.json({
      success: true,
      data: {
        scheme: {
          id: schemeDoc._id,
          name: schemeDoc.name,
          code: schemeDoc.code,
          schemeType: schemeDoc.schemeType,
        },
        inputRevenueInPaise: revenueInPaise,
        earnedCommissionInPaise: calcResult.earnedCommissionInPaise,
        snapshot: calcResult.snapshot,
      },
    });
  } catch (err) {
    next(err);
  }
};

export const computeAttendanceEvaluation = async (req, res, next) => {
  try {
    const evaluation = await attendanceBonusService.compute({
      organizationId: req.user.organizationId,
      branchId: req.branchId,
      staffId: req.body.staffId,
      schemeId: req.body.schemeId,
      monthYear: req.body.monthYear,
    });
    res.json({
      success: true,
      data: evaluation,
      message: evaluation.blockReasons?.length
        ? "Attendance evaluation is blocked pending reconciliation"
        : "Attendance evaluation computed",
    });
  } catch (err) {
    next(err);
  }
};

export const finalizeAttendanceEvaluation = async (req, res, next) => {
  try {
    const result = await attendanceBonusService.finalize({
      organizationId: req.user.organizationId,
      branchId: req.branchId,
      evaluationId: req.params.id,
      userId: req.user.id || req.user._id,
    });
    res.json({
      success: true,
      data: result,
      message: "Attendance incentive evaluation finalized",
    });
  } catch (err) {
    next(err);
  }
};

// 11. LIST INCENTIVE LEDGER ENTRIES
export const listLedgerEntries = async (req, res, next) => {
  try {
    const organizationId = req.user.organizationId;
    const { staffId, branchId, entryType, fulfillmentStatus, page = 1, limit = 20 } = req.query;

    const canViewAll = await hasUserPermission(req.user, "incentives.view.all");
    const filter = { organizationId };

    if (!canViewAll) {
      // Find staff record linked to this authenticated user
      const staffMember = await Staff.findOne({ userId: req.user.id, organizationId });
      if (!staffMember) {
        // Authenticated user is not linked to any staff member, return empty result
        return res.json({
          success: true,
          data: [],
          meta: { page: Number(page), limit: Number(limit), total: 0, totalPages: 0 },
        });
      }
      filter.staffId = staffMember._id;
    }
    Object.assign(filter, branchScopeFilterFor(req.user));

    if (canViewAll && staffId) {
      filter.staffId = staffId;
    }

    applyRequestedBranchFilter(filter, branchId);
    if (entryType) filter.entryType = entryType;
    if (fulfillmentStatus) filter.fulfillmentStatus = fulfillmentStatus;

    const skip = (Number(page) - 1) * Number(limit);
    const [entries, total] = await Promise.all([
      IncentiveLedger.find(filter)
        .populate("staffId", "name staffCode")
        .populate("branchId", "name")
        .populate("schemeId", "name code schemeType")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      IncentiveLedger.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: entries,
      meta: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (err) {
    next(err);
  }
};

// 12. LIST RECOVERY OBLIGATIONS
export const listRecoveryObligations = async (req, res, next) => {
  try {
    const organizationId = req.user.organizationId;
    const { staffId, status, page = 1, limit = 20 } = req.query;

    const canViewAll = await hasUserPermission(req.user, "incentives.view.all");
    const filter = { organizationId };

    if (!canViewAll) {
      const staffMember = await Staff.findOne({ userId: req.user.id, organizationId });
      if (!staffMember) {
        return res.json({
          success: true,
          data: [],
          meta: { page: Number(page), limit: Number(limit), total: 0, totalPages: 0 },
        });
      }
      filter.staffId = staffMember._id;
    }
    Object.assign(filter, branchScopeFilterFor(req.user));

    if (canViewAll && staffId) {
      filter.staffId = staffId;
    }
    applyRequestedBranchFilter(filter, req.branchId || req.query.branchId);

    if (status) filter.status = status;

    const skip = (Number(page) - 1) * Number(limit);
    const [obligations, total] = await Promise.all([
      IncentiveRecoveryObligation.find(filter)
        .populate("staffId", "name staffCode")
        .populate("clawbackLedgerId", "invoiceId settlementEventId reversesLedgerId")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      IncentiveRecoveryObligation.countDocuments(filter),
    ]);
    const paymentHistory = obligations.length > 0
      ? await IncentiveRecoveryPayment.find({
        organizationId,
        obligationId: { $in: obligations.map((obligation) => obligation._id) },
      })
        .populate("recordedBy", "name email")
        .populate("confirmedBy", "name email")
        .populate("failedBy", "name email")
        .populate("reversedBy", "name email")
        .sort({ createdAt: -1 })
        .lean()
      : [];
    const sourceLedgerIds = obligations
      .map((obligation) => obligation.clawbackLedgerId?.reversesLedgerId)
      .filter(Boolean);
    const paidAllocations = sourceLedgerIds.length > 0
      ? await PayrollIncentiveAllocation.find({
        organizationId,
        incentiveLedgerId: { $in: sourceLedgerIds },
        status: "paid",
      }).lean()
      : [];
    const allocationsByLedgerId = new Map(
      paidAllocations.map((allocation) => [
        allocation.incentiveLedgerId.toString(),
        allocation,
      ]),
    );
    const paymentsByObligation = new Map();
    for (const payment of paymentHistory) {
      const key = payment.obligationId.toString();
      paymentsByObligation.set(key, [
        ...(paymentsByObligation.get(key) || []),
        payment,
      ]);
    }

    res.json({
      success: true,
      data: obligations.map((obligation) => ({
        ...obligation,
        paymentHistory: paymentsByObligation.get(obligation._id.toString()) || [],
        remainingAvailableInPaise: Math.max(
          0,
          obligation.status === "written_off"
            ? 0
            : (obligation.originalClawbackInPaise || 0) -
                (obligation.totalRecoveredInPaise || 0) -
                (obligation.totalReservedInPaise || 0),
        ),
        collectibleAvailableInPaise: (() => {
          const clawback = obligation.clawbackLedgerId;
          const sourceLedgerId = clawback?.reversesLedgerId;
          if (!sourceLedgerId) return 0;
          const allocation = allocationsByLedgerId.get(sourceLedgerId.toString());
          if (!allocation) return 0;
          if ((allocation.coveredClawbackLedgerIds || []).some(
            (id) => id.toString() === obligation.clawbackLedgerId._id.toString(),
          )) return 0;
          const obligationBalance = Math.max(
            0,
            obligation.originalClawbackInPaise -
              obligation.totalRecoveredInPaise -
              obligation.totalReservedInPaise,
          );
          const sourceBalance = Math.max(
            0,
            allocation.payableAmountInPaise -
              allocation.recoveredInPaise -
              allocation.reservedRecoveryInPaise,
          );
          return Math.min(obligationBalance, sourceBalance);
        })(),
      })),
      meta: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (err) {
    next(err);
  }
};

export const recordRecoveryPayment = async (req, res, next) => {
  try {
    const result = await ManualRecoveryPaymentService.recordPayment({
      organizationId: req.user.organizationId,
      branchId: req.branchId,
      obligationId: req.params.id,
      userId: req.user.id || req.user._id,
      ...req.body,
    });
    res.status(result.isIdempotentReplay ? 200 : 201).json({
      success: true,
      data: result,
      message: result.isIdempotentReplay
        ? "Existing recovery payment attempt returned"
        : "Recovery payment attempt recorded; obligation remains unsettled until confirmation",
    });
  } catch (err) {
    next(err);
  }
};

export const confirmRecoveryPayment = async (req, res, next) => {
  try {
    const result = await ManualRecoveryPaymentService.confirmPayment({
      organizationId: req.user.organizationId,
      branchId: req.branchId,
      obligationId: req.params.id,
      paymentId: req.params.paymentId,
      userId: req.user.id || req.user._id,
    });
    res.json({
      success: true,
      data: result,
      message: result.isIdempotentReplay
        ? "Recovery payment was already confirmed"
        : "Actual recovery payment confirmed",
    });
  } catch (err) {
    next(err);
  }
};

export const failRecoveryPayment = async (req, res, next) => {
  try {
    const result = await ManualRecoveryPaymentService.failPayment({
      organizationId: req.user.organizationId,
      branchId: req.branchId,
      obligationId: req.params.id,
      paymentId: req.params.paymentId,
      userId: req.user.id || req.user._id,
      failureReason: req.body.failureReason,
    });
    res.json({
      success: true,
      data: result,
      message: result.isIdempotentReplay
        ? "Recovery payment failure was already recorded"
        : "Recovery payment failed; reserved balance was released for retry",
    });
  } catch (err) {
    next(err);
  }
};

export const reverseRecoveryPayment = async (req, res, next) => {
  try {
    const result = await ManualRecoveryPaymentService.reversePayment({
      organizationId: req.user.organizationId,
      branchId: req.branchId,
      obligationId: req.params.id,
      paymentId: req.params.paymentId,
      userId: req.user.id || req.user._id,
      reversalReason: req.body.reversalReason,
    });
    res.json({
      success: true,
      data: result,
      message: result.isIdempotentReplay
        ? "Recovery payment reversal was already recorded"
        : "Recovery payment reversal recorded",
    });
  } catch (err) {
    next(err);
  }
};

// 13. GET INCENTIVES DASHBOARD SUMMARY METRICS
export const getIncentivesSummary = async (req, res, next) => {
  try {
    const organizationId = req.user.organizationId;
    const canViewAll = await hasUserPermission(req.user, "incentives.view.all");
    let branchScope = branchScopeFilterFor(req.user);
    if (req.query.branchId) {
      if (!isBranchAuthorized(req.user, req.query.branchId)) {
        throw new AppError("Access denied for the selected branch", 403);
      }
      const branch = await Branch.findOne({
        _id: req.query.branchId,
        organizationId,
        isActive: true,
      }).select("_id").lean();
      if (!branch) throw new AppError("Active branch not found", 404);
      branchScope = { branchId: branch._id };
    }

    let ledgerStaffMatch = {};
    let obligationStaffMatch = {};

    if (!canViewAll) {
      const staffMember = await Staff.findOne({ userId: req.user.id, organizationId });
      if (!staffMember) {
        return res.json({
          success: true,
          data: {
            totalAccruedPaise: 0,
            totalClawbackPaise: 0,
            netAccruedPaise: 0,
            outstandingRecoveryPaise: 0,
            pendingFulfillmentCount: 0,
            schemes: { active: 0, draft: 0, paused: 0, archived: 0 },
          },
        });
      }
      ledgerStaffMatch = { staffId: staffMember._id, ...branchScope };
      obligationStaffMatch = { staffId: staffMember._id, ...branchScope };
    } else {
      ledgerStaffMatch = branchScope;
      obligationStaffMatch = branchScope;
    }

    const pendingStaffId = canViewAll
      ? null
      : ledgerStaffMatch.staffId;
    const [accrualsAgg, clawbacksAgg, pendingFulfillmentCount, openObligationsAgg, schemeCounts] = await Promise.all([
      // Total confirmed accruals
      IncentiveLedger.aggregate([
        { $match: { organizationId, entryType: "ACCRUAL", fulfillmentStatus: "confirmed", ...ledgerStaffMatch } },
        { $group: { _id: null, total: { $sum: "$amountInPaise" } } },
      ]),
      // Total clawbacks
      IncentiveLedger.aggregate([
        { $match: { organizationId, entryType: "CLAWBACK", ...ledgerStaffMatch } },
        { $group: { _id: null, total: { $sum: "$amountInPaise" } } },
      ]),
      countPendingServiceFulfillment({
        organizationId,
        branchScope,
        staffId: pendingStaffId,
      }),
      // Outstanding recovery obligations
      IncentiveRecoveryObligation.aggregate([
        { $match: { organizationId, status: { $in: ["pending", "partially_recovered"] }, ...obligationStaffMatch } },
        {
          $group: {
            _id: null,
            remainingPaise: {
              $sum: {
                $subtract: [
                  "$originalClawbackInPaise",
                  { $ifNull: ["$totalRecoveredInPaise", 0] },
                ],
              },
            },
          },
        },
      ]),
      // Scheme counts by status
      IncentiveScheme.aggregate([
        { $match: { organizationId } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
    ]);

    const totalAccruedPaise = accrualsAgg[0]?.total || 0;
    const totalClawbackPaise = clawbacksAgg[0]?.total || 0;
    const netAccruedPaise = Math.max(0, totalAccruedPaise - totalClawbackPaise);
    const outstandingRecoveryPaise = openObligationsAgg[0]?.remainingPaise || 0;

    const schemeStatusMap = {
      active: 0,
      draft: 0,
      paused: 0,
      archived: 0,
    };

    schemeCounts.forEach((s) => {
      if (s._id in schemeStatusMap) {
        schemeStatusMap[s._id] = s.count;
      }
    });

    res.json({
      success: true,
      data: {
        totalAccruedPaise,
        totalClawbackPaise,
        netAccruedPaise,
        outstandingRecoveryPaise,
        pendingFulfillmentCount,
        schemes: schemeStatusMap,
      },
    });
  } catch (err) {
    next(err);
  }
};

export const confirmWalkInFulfillment = async (req, res, next) => {
  try {
    const organizationId = req.user.organizationId;
    const userId = req.user.id || req.user._id;
    const { invoiceId, lineIds, reason } = req.body;

    const result = await runInTransaction(async (session) => {
      const invoice = await Invoice.findOne({
        _id: invoiceId,
        organizationId,
        branchId: req.branchId,
        isDeleted: false,
      }).session(session);

      if (!invoice) {
        throw new AppError("Invoice not found", 404);
      }

      return await settlementFulfillmentEventService.confirmWalkInServiceFulfillment({
        invoice,
        lineIds,
        reason,
        userId,
        session,
      });
    });

    res.json({
      success: true,
      data: result,
      message: "Service fulfillment confirmed",
    });
  } catch (err) {
    next(err);
  }
};

export const listWalkInFulfillment = async (req, res, next) => {
  try {
    const invoice = await Invoice.findOne({
      _id: req.query.invoiceId,
      organizationId: req.user.organizationId,
      branchId: req.branchId,
      isDeleted: false,
    }).select("_id appointmentId");

    if (!invoice) {
      throw new AppError("Invoice not found", 404);
    }

    const events = invoice.appointmentId
      ? []
      : await ServiceFulfillmentEvent.find({
          organizationId: req.user.organizationId,
          branchId: req.branchId,
          invoiceId: invoice._id,
        }).select("lineItemId").lean();

    res.json({
      success: true,
      data: { confirmedLineIds: events.map((event) => event.lineItemId.toString()) },
    });
  } catch (err) {
    next(err);
  }
};
