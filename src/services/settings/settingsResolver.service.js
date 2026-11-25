import { Organization } from "../../models/organizations/organization.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { OrganizationSettingsRepository } from "../../repositories/settings/organizationSettings.repository.js";
import { BranchSettingsRepository } from "../../repositories/settings/branchSettings.repository.js";
import { normalizeOperatingHours } from "../../utils/operatingHours.js";

export const SYSTEM_SETTING_DEFAULTS = Object.freeze({
  regional: Object.freeze({
    timezone: "Asia/Kolkata",
    currency: "INR",
    locale: "en-IN",
    dateFormat: "YYYY-MM-DD",
    timeFormat: "HH:mm",
    firstDayOfWeek: 1,
  }),
  appointments: Object.freeze({
    bufferMinutes: 0,
    allowWalkIns: true,
    allowAdvanceBookings: true,
    reminderDefaultOffsetMinutes: 60,
  }),
  attendance: Object.freeze({
    graceMinutes: 15,
    autoMarkAbsentAfterCutoff: false,
  }),
  leaves: Object.freeze({
    weeklyOffDays: Object.freeze([0]),
    allowHalfDay: true,
    allowBranchPolicyOverrides: false,
  }),
  exports: Object.freeze({
    retentionHours: 24,
  }),
});

/**
 * Deterministic value resolver:
 * 1. Explicit branch value (if !== undefined && !== null)
 * 2. Organization value (if !== undefined && !== null)
 * 3. System default
 *
 * Preserves explicit false, 0, and empty arrays [].
 */
export function resolveSettingValue(branchValue, orgValue, systemDefault) {
  if (branchValue !== undefined && branchValue !== null) {
    return { value: branchValue, source: "branch_override" };
  }
  if (orgValue !== undefined && orgValue !== null) {
    return { value: orgValue, source: "organization" };
  }
  return { value: systemDefault, source: "system_default" };
}

export class SettingsResolverService {
  constructor(deps = {}) {
    this.orgSettingsRepo = deps.orgSettingsRepo || new OrganizationSettingsRepository();
    this.branchSettingsRepo = deps.branchSettingsRepo || new BranchSettingsRepository();
  }

  /**
   * Pure deterministic resolution from already-fetched documents (safe for unit tests).
   */
  resolveFromDocuments({ organization = null, orgSettings = null, branch = null, branchSettings = null }) {
    const regional = {
      timezone: resolveSettingValue(branch?.timezone, orgSettings?.regional?.timezone, SYSTEM_SETTING_DEFAULTS.regional.timezone),
      currency: resolveSettingValue(null, orgSettings?.regional?.currency, SYSTEM_SETTING_DEFAULTS.regional.currency),
      locale: resolveSettingValue(null, orgSettings?.regional?.locale, SYSTEM_SETTING_DEFAULTS.regional.locale),
      dateFormat: resolveSettingValue(null, orgSettings?.regional?.dateFormat, SYSTEM_SETTING_DEFAULTS.regional.dateFormat),
      timeFormat: resolveSettingValue(null, orgSettings?.regional?.timeFormat, SYSTEM_SETTING_DEFAULTS.regional.timeFormat),
      firstDayOfWeek: resolveSettingValue(null, orgSettings?.regional?.firstDayOfWeek, SYSTEM_SETTING_DEFAULTS.regional.firstDayOfWeek),
    };

    const appointments = {
      bufferMinutes: resolveSettingValue(
        branchSettings?.appointmentOverrides?.bufferMinutes ?? branch?.bufferMinutes,
        orgSettings?.defaults?.appointmentBufferMinutes,
        SYSTEM_SETTING_DEFAULTS.appointments.bufferMinutes
      ),
      allowWalkIns: resolveSettingValue(
        branchSettings?.appointmentOverrides?.allowWalkIns,
        orgSettings?.defaults?.allowWalkIns,
        SYSTEM_SETTING_DEFAULTS.appointments.allowWalkIns
      ),
      allowAdvanceBookings: resolveSettingValue(
        branchSettings?.appointmentOverrides?.allowAdvanceBookings,
        orgSettings?.defaults?.allowAdvanceBookings,
        SYSTEM_SETTING_DEFAULTS.appointments.allowAdvanceBookings
      ),
      reminderDefaultOffsetMinutes: resolveSettingValue(
        branchSettings?.appointmentOverrides?.reminderDefaultOffsetMinutes,
        orgSettings?.defaults?.reminderDefaultOffsetMinutes,
        SYSTEM_SETTING_DEFAULTS.appointments.reminderDefaultOffsetMinutes
      ),
    };

    const attendance = {
      graceMinutes: resolveSettingValue(
        branchSettings?.attendanceOverrides?.graceMinutes,
        orgSettings?.defaults?.attendanceGraceMinutes,
        SYSTEM_SETTING_DEFAULTS.attendance.graceMinutes
      ),
      autoMarkAbsentAfterCutoff: resolveSettingValue(
        branchSettings?.attendanceOverrides?.autoMarkAbsentAfterCutoff,
        orgSettings?.defaults?.autoMarkAbsentAfterCutoff,
        SYSTEM_SETTING_DEFAULTS.attendance.autoMarkAbsentAfterCutoff
      ),
    };

    const leaves = {
      weeklyOffDays: resolveSettingValue(
        branchSettings?.weeklyOffDays,
        orgSettings?.defaults?.defaultWeeklyOffDays,
        [...SYSTEM_SETTING_DEFAULTS.leaves.weeklyOffDays]
      ),
      allowHalfDay: resolveSettingValue(
        branchSettings?.leaveOverrides?.allowHalfDay,
        orgSettings?.defaults?.defaultHalfDayEligible,
        SYSTEM_SETTING_DEFAULTS.leaves.allowHalfDay
      ),
      allowBranchPolicyOverrides: resolveSettingValue(
        branchSettings?.leaveOverrides?.allowBranchPolicyOverrides,
        null,
        SYSTEM_SETTING_DEFAULTS.leaves.allowBranchPolicyOverrides
      ),
    };

    const exportsConfig = {
      retentionHours: resolveSettingValue(
        null,
        orgSettings?.defaults?.exportRetentionHours,
        SYSTEM_SETTING_DEFAULTS.exports.retentionHours
      ),
    };

    const operatingHours = branch ? normalizeOperatingHours(branch.operatingHours) : { isConfigured: false, schedule: null };

    return {
      organizationId: organization?._id?.toString() || orgSettings?.organizationId?.toString() || null,
      branchId: branch?._id?.toString() || branchSettings?.branchId?.toString() || null,
      regional,
      appointments,
      attendance,
      leaves,
      exports: exportsConfig,
      operatingHours,
    };
  }

  async resolveEffectiveSettings(organizationId, branchId = null) {
    const [organization, orgSettings, branch, branchSettings] = await Promise.all([
      Organization.findOne({ _id: organizationId }).lean(),
      this.orgSettingsRepo.findByOrganizationId(organizationId),
      branchId ? Branch.findOne({ _id: branchId, organizationId }).lean() : Promise.resolve(null),
      branchId ? this.branchSettingsRepo.findByBranch(organizationId, branchId) : Promise.resolve(null),
    ]);

    return this.resolveFromDocuments({
      organization,
      orgSettings: orgSettings?.toObject ? orgSettings.toObject() : orgSettings,
      branch,
      branchSettings: branchSettings?.toObject ? branchSettings.toObject() : branchSettings,
    });
  }
}
