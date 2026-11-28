/**
 * Auto-Mark Absent After Cutoff — Scheduled Job
 *
 * For every active organization and branch where `autoMarkAbsentAfterCutoff`
 * is enabled, marks active staff as "absent" for the current business day when
 * the branch's configured cutoff time (operating-hours closeTime +
 * attendanceGraceMinutes buffer) has passed and the staff member has no
 * attendance record for the day.
 *
 * Design principles:
 * - Idempotent: safe to run on every interval; already-marked records are skipped.
 * - Branch-scoped: honours branch-level override, falls back to org default.
 * - Working-day only: skips holidays, weekly offs, and branch closures.
 * - Leave-aware: skips staff with approved leave for the day.
 * - Audit-every-write: every absence mark is written to the audit log with a
 *   stable idempotency key so retries cannot duplicate entries.
 */

import { Organization } from "../models/organizations/organization.model.js";
import { Branch } from "../models/branches/branch.model.js";
import { StaffBranch } from "../models/staff/staffBranch.model.js";
import { Staff } from "../models/staff/staff.model.js";
import { Leave } from "../models/leaves/leave.model.js";
import { Attendance } from "../models/attendance/attendance.model.js";
import { AuditLog } from "../models/audit/auditLog.model.js";
import { CalendarResolverService } from "../services/holidays/calendarResolver.service.js";
import { SettingsResolverService } from "../services/settings/settingsResolver.service.js";
import { deriveBusinessDate } from "../services/attendance/attendance.service.js";
import { getOperatingHoursForDay } from "../utils/operatingHours.js";
import { logger } from "../utils/logger.js";

const AUDIT_ACTION = "ATTENDANCE_AUTO_MARKED_ABSENT";
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let jobTimer = null;

function weekdayIndexToCanonical(dayIndex) {
  return [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ][dayIndex];
}

function hhmmToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(timeStr.trim());
  if (!match) return null;
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

function cutoffDateTime(cutoffDateStr, cutoffMinutes) {
  const [year, month, day] = cutoffDateStr.split("-").map(Number);
  const hh = Math.floor(cutoffMinutes / 60);
  const mm = cutoffMinutes % 60;
  return new Date(Date.UTC(year, month - 1, day, hh, mm, 0, 0));
}

async function isWorkingDay(resolver, organizationId, branch, orgSettings, branchSettings, dateStr) {
  const resolved = resolver.resolveDateFromData({
    dateStr,
    branch,
    orgSettings: orgSettings?.toObject ? orgSettings.toObject() : orgSettings,
    branchSettings: branchSettings?.toObject ? branchSettings.toObject() : branchSettings,
    entries: [],
  });
  return resolved.isWorkingDay === true;
}
async function resolveCutoffMinutes({
  organizationId,
  branch,
  branchSettings,
  orgSettings,
  dateStr,
  dayIndex,
}) {
  const resolver = new SettingsResolverService();
  const effective = resolver.resolveFromDocuments({
    organization: null,
    orgSettings,
    branch,
    branchSettings,
  });

  const autoMark = effective.attendance.autoMarkAbsentAfterCutoff.value === true;
  if (!autoMark) return { enabled: false, cutoffMinutes: null };

  const graceMinutes =
    effective.attendance.graceMinutes.value !== undefined
      ? effective.attendance.graceMinutes.value
      : 15;

  const canonicalDay = weekdayIndexToCanonical(dayIndex);
  const dayHours = branch?.operatingHours
    ? getOperatingHoursForDay(branch.operatingHours, canonicalDay)
    : null;

  if (!dayHours || !dayHours.isConfigured || dayHours.isOpen !== true) {
    return { enabled: true, cutoffMinutes: null };
  }

  const closeMinutes = hhmmToMinutes(dayHours.closeTime);
  if (closeMinutes === null) return { enabled: true, cutoffMinutes: null };

  return {
    enabled: true,
    cutoffMinutes: closeMinutes + graceMinutes,
  };
}

async function getActiveStaffIds(organizationId, branchId) {
  const links = await StaffBranch.find({
    organizationId,
    branchId,
    isActive: true,
  }).select("staffId").lean();

  const staffIds = links.map((l) => l.staffId);
  const staff = await Staff.find({
    _id: { $in: staffIds },
    organizationId,
    isDeleted: { $ne: true },
    status: "active",
  }).select("_id").lean();

  return staff.map((s) => s._id.toString());
}

async function getStaffWithExistingAttendance(organizationId, branchId, staffIds, attendanceDate) {
  if (staffIds.length === 0) return new Set();

  const records = await Attendance.find({
    organizationId,
    branchId,
    staffId: { $in: staffIds },
    attendanceDate: new Date(`${attendanceDate}T00:00:00.000Z`),
    isDeleted: { $ne: true },
  }).select("staffId status").lean();

  return new Set(records.map((r) => r.staffId.toString()));
}

async function getStaffOnApprovedLeave(organizationId, branchId, staffIds, attendanceDate) {
  if (staffIds.length === 0) return new Set();

  const start = new Date(`${attendanceDate}T00:00:00.000Z`);
  const end = new Date(Date.parse(`${attendanceDate}T00:00:00.000Z`) + 24 * 60 * 60 * 1000);

  const leaves = await Leave.find({
    organizationId,
    branchId,
    staffId: { $in: staffIds },
    status: "approved",
    isDeleted: { $ne: true },
    $or: [
      { dates: attendanceDate },
      {
        dates: { $size: 0 },
        startDate: { $lt: end },
        endDate: { $gte: start },
      },
    ],
  }).select("staffId").lean();

  return new Set(leaves.map((l) => l.staffId.toString()));
}
async function markStaffAbsent({
  organizationId,
  branchId,
  staffId,
  attendanceDate,
  actorId = null,
}) {
  const claim = await Attendance.claimAttendanceRecord({
    organizationId,
    staffId,
    branchId,
    attendanceDate: new Date(`${attendanceDate}T00:00:00.000Z`),
    punchType: "auto_mark_absent",
  });

  if (!claim.success || !claim.attendanceRecord) {
    logger.warn(
      `[AutoMarkAbsent] Skipping staff ${staffId} on ${attendanceDate}: claim failed (${
        claim.conflict?.type || "unknown"
      }).`,
    );
    return { skipped: true, reason: claim.conflict?.type || "claim_failed" };
  }

  const record = claim.attendanceRecord;
  const previousStatus = record.status;

  if (previousStatus === "absent") {
    return { skipped: true, reason: "already_absent" };
  }

  const updated = await Attendance.findOneAndUpdate(
    {
      _id: record._id,
      organizationId,
      branchId,
      isDeleted: { $ne: true },
    },
    {
      $set: {
        status: "absent",
        isReconciled: true,
        reconciliationReason:
          "Auto-marked absent after branch cutoff (no punch recorded).",
        reconciledBy: actorId,
        reconciledAt: new Date(),
      },
      $push: {
        adjustmentHistory: {
          previousStatus,
          newStatus: "absent",
          reason: "Auto-marked absent after cutoff",
          actorId,
          changedAt: new Date(),
        },
      },
    },
    { returnDocument: 'after', runValidators: true },
  ).lean();

  if (!updated) {
    return { skipped: true, reason: "update_failed" };
  }

  const idempotencyKey = `auto_mark_absent:${organizationId}:${staffId}:${attendanceDate}`;
  await AuditLog.findOneAndUpdate(
    {
      organizationId,
      branchId,
      action: AUDIT_ACTION,
      entityType: "Attendance",
      entityId: updated._id,
      "metadata.idempotencyKey": idempotencyKey,
    },
    {
      $setOnInsert: {
        organizationId,
        branchId,
        actorId,
        actorType: "background_job",
        action: AUDIT_ACTION,
        entityType: "Attendance",
        entityId: updated._id,
        description: `Staff auto-marked absent after cutoff for ${attendanceDate}.`,
        metadata: {
          staffId,
          date: attendanceDate,
          previousStatus,
          newStatus: "absent",
          reason: "auto_mark_absent_after_cutoff",
          idempotencyKey,
          source: "scheduled_job",
        },
      },
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );

  logger.info(
    `[AutoMarkAbsent] Staff ${staffId} marked absent for ${attendanceDate} at branch ${branchId}.`,
  );

  return { marked: true, attendanceId: updated._id };
}

async function runAutoMarkAbsentSweep() {
  logger.info("[AutoMarkAbsent] Sweep started.");

  const orgs = await Organization.find({}).select("_id").lean();
  if (!orgs || orgs.length === 0) {
    logger.info("[AutoMarkAbsent] No organizations found. Sweep complete.");
    return { processed: 0, marked: 0, skipped: 0 };
  }

  const calendarResolver = new CalendarResolverService();
  let totalMarked = 0;
  let totalSkipped = 0;
  let totalProcessed = 0;

  for (const org of orgs) {
    const organizationId = org._id;
    const branches = await Branch.find({
      organizationId,
      isActive: true,
    }).lean();

    for (const branch of branches) {
      const branchId = branch._id.toString();
      const branchTimezone = branch.timezone || "Asia/Kolkata";

      const attendanceDate = deriveBusinessDate(new Date(), branchTimezone);
      const dateObj = new Date(`${attendanceDate}T12:00:00.000Z`);
      const dayIndex = dateObj.getUTCDay();

      const { OrganizationSettingsRepository } = await import(
        "../repositories/settings/organizationSettings.repository.js"
      );
      const { BranchSettingsRepository } = await import(
        "../repositories/settings/branchSettings.repository.js"
      );
      const orgSettingsRepo = new OrganizationSettingsRepository();
      const branchSettingsRepo = new BranchSettingsRepository();

      const [orgSettingsDoc, branchSettingsDoc] = await Promise.all([
        orgSettingsRepo.findByOrganizationId(organizationId),
        branchSettingsRepo.findByBranch(organizationId, branchId),
      ]);

      const cutoff = await resolveCutoffMinutes({
        organizationId,
        branch,
        branchSettings: branchSettingsDoc,
        orgSettings: orgSettingsDoc,
        dateStr: attendanceDate,
        dayIndex,
      });

      if (!cutoff.enabled || cutoff.cutoffMinutes === null) {
        continue;
      }

      const working = await isWorkingDay(
        calendarResolver,
        organizationId,
        branch,
        orgSettingsDoc,
        branchSettingsDoc,
        attendanceDate,
      );
      if (!working) {
        logger.debug(
          `[AutoMarkAbsent] ${attendanceDate} is not a working day for branch ${branchId}; skipping.`,
        );
        continue;
      }

      const cutoffMoment = cutoffDateTime(attendanceDate, cutoff.cutoffMinutes);
      const now = new Date();
      if (now < cutoffMoment) {
        continue;
      }

      totalProcessed += 1;

      const staffIds = await getActiveStaffIds(organizationId, branchId);
      const [withAttendance, onLeave] = await Promise.all([
        getStaffWithExistingAttendance(organizationId, branchId, staffIds, attendanceDate),
        getStaffOnApprovedLeave(organizationId, branchId, staffIds, attendanceDate),
      ]);

      const toMark = staffIds.filter(
        (id) => !withAttendance.has(id) && !onLeave.has(id),
      );

      for (const staffId of toMark) {
        const result = await markStaffAbsent({
          organizationId,
          branchId,
          staffId,
          attendanceDate,
          actorId: null,
        });
        if (result.marked) totalMarked += 1;
        else totalSkipped += 1;
      }
    }
  }

  logger.info(
    `[AutoMarkAbsent] Sweep complete. processed=${totalProcessed} marked=${totalMarked} skipped=${totalSkipped}.`,
  );
  return { processed: totalProcessed, marked: totalMarked, skipped: totalSkipped };
}

export { runAutoMarkAbsentSweep, DEFAULT_INTERVAL_MS };