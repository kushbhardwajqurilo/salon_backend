import { Organization } from "../../models/organizations/organization.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { OrganizationSettingsRepository } from "../../repositories/settings/organizationSettings.repository.js";
import { BranchSettingsRepository } from "../../repositories/settings/branchSettings.repository.js";
import { HolidayCalendarRepository } from "../../repositories/holidays/holidayCalendar.repository.js";
import { SettingsResolverService } from "../settings/settingsResolver.service.js";
import { getOperatingHoursForDay } from "../../utils/operatingHours.js";
import { enumerateDates } from "../../utils/date.js";

function matchesDate(entry, dateStr) {
  if (!entry || entry.isActive === false) return false;
  const start = entry.date;
  const end = entry.endDate || entry.date;
  return start <= dateStr && end >= dateStr;
}

function toEventSummary(entry) {
  if (!entry) return null;
  return {
    id: entry._id?.toString() || entry.id || null,
    name: entry.name,
    eventType: entry.eventType,
    branchId: entry.branchId ? entry.branchId.toString() : null,
    description: entry.description ?? null,
    isPaid: Boolean(entry.isPaid),
  };
}

export class CalendarResolverService {
  constructor(deps = {}) {
    this.orgSettingsRepo = deps.orgSettingsRepo || new OrganizationSettingsRepository();
    this.branchSettingsRepo = deps.branchSettingsRepo || new BranchSettingsRepository();
    this.holidayRepo = deps.holidayRepo || new HolidayCalendarRepository();
    this.settingsResolver =
      deps.settingsResolver ||
      new SettingsResolverService({
        orgSettingsRepo: this.orgSettingsRepo,
        branchSettingsRepo: this.branchSettingsRepo,
      });
  }

  /**
   * Pure deterministic calendar resolution for a single local date ("YYYY-MM-DD").
   * Precedence:
   * 1. Branch special_working_day
   * 2. Organization special_working_day
   * 3. Branch branch_closure
   * 4. Branch branch_holiday
   * 5. Organization org_holiday or public_holiday
   * 6. Resolved weeklyOffDays (or Branch.operatingHours closed-day fallback)
   * 7. Normal working_day
   */
  resolveDateFromData({
    dateStr,
    branch = null,
    orgSettings = null,
    branchSettings = null,
    entries = [],
  }) {
    const applicable = entries.filter((e) => matchesDate(e, dateStr));
    const branchIdStr = branch?._id?.toString() || null;

    const isBranchEntry = (e) => e.branchId && branchIdStr && e.branchId.toString() === branchIdStr;
    const isOrgEntry = (e) => !e.branchId;

    // 1. Branch special_working_day
    const branchSpecial = applicable.find((e) => isBranchEntry(e) && e.eventType === "special_working_day");
    if (branchSpecial) {
      return {
        date: dateStr,
        status: "special_working_day",
        isWorkingDay: true,
        isPaid: Boolean(branchSpecial.isPaid),
        source: "branch_special_working_day",
        event: toEventSummary(branchSpecial),
        operatingHoursOverride: branchSpecial.operatingHoursOverride || null,
      };
    }

    // 2. Organization special_working_day
    const orgSpecial = applicable.find((e) => isOrgEntry(e) && e.eventType === "special_working_day");
    if (orgSpecial) {
      return {
        date: dateStr,
        status: "special_working_day",
        isWorkingDay: true,
        isPaid: Boolean(orgSpecial.isPaid),
        source: "org_special_working_day",
        event: toEventSummary(orgSpecial),
        operatingHoursOverride: orgSpecial.operatingHoursOverride || null,
      };
    }

    // 3. Branch closure
    const branchClosure = applicable.find((e) => isBranchEntry(e) && e.eventType === "branch_closure");
    if (branchClosure) {
      return {
        date: dateStr,
        status: "branch_closure",
        isWorkingDay: false,
        isPaid: Boolean(branchClosure.isPaid),
        source: "branch_closure",
        event: toEventSummary(branchClosure),
        operatingHoursOverride: null,
      };
    }

    // 4. Branch holiday
    const branchHoliday = applicable.find((e) => isBranchEntry(e) && e.eventType === "branch_holiday");
    if (branchHoliday) {
      return {
        date: dateStr,
        status: "holiday",
        isWorkingDay: false,
        isPaid: Boolean(branchHoliday.isPaid),
        source: "branch_holiday",
        event: toEventSummary(branchHoliday),
        operatingHoursOverride: null,
      };
    }

    // 5. Organization org_holiday or public_holiday
    const orgHoliday = applicable.find(
      (e) => isOrgEntry(e) && (e.eventType === "org_holiday" || e.eventType === "public_holiday")
    );
    if (orgHoliday) {
      return {
        date: dateStr,
        status: "holiday",
        isWorkingDay: false,
        isPaid: Boolean(orgHoliday.isPaid),
        source: orgHoliday.eventType,
        event: toEventSummary(orgHoliday),
        operatingHoursOverride: null,
      };
    }

    // 6. Resolved weekly off / Branch.operatingHours closed-day fallback
    const effective = this.settingsResolver.resolveFromDocuments({
      orgSettings,
      branch,
      branchSettings,
    });
    const dayOfWeek = new Date(`${dateStr}T12:00:00.000Z`).getUTCDay();
    const weeklyOffDays = effective.leaves.weeklyOffDays.value || [];
    const dayHours = branch?.operatingHours ? getOperatingHoursForDay(branch.operatingHours, dayOfWeek) : null;

    // If weeklyOffDays is only the system_default ([0]) and Branch.operatingHours explicitly configures this day as open,
    // respect Branch.operatingHours for backward compatibility with legacy branches.
    const isExplicitWeeklyOffSource = effective.leaves.weeklyOffDays.source !== "system_default";
    const isBranchHoursExplicitlyOpen = Boolean(dayHours?.isConfigured && dayHours?.isOpen === true);

    if (weeklyOffDays.includes(dayOfWeek) && (isExplicitWeeklyOffSource || !isBranchHoursExplicitlyOpen)) {
      return {
        date: dateStr,
        status: "weekly_off",
        isWorkingDay: false,
        isPaid: false,
        source: "weekly_off",
        event: null,
        operatingHoursOverride: null,
      };
    }

    if (dayHours?.isConfigured && dayHours.isOpen === false) {
      return {
        date: dateStr,
        status: "weekly_off",
        isWorkingDay: false,
        isPaid: false,
        source: "operating_hours",
        event: null,
        operatingHoursOverride: null,
      };
    }

    // 7. Normal working day
    return {
      date: dateStr,
      status: "working_day",
      isWorkingDay: true,
      isPaid: false,
      source: "default",
      event: null,
      operatingHoursOverride: null,
    };
  }

  async resolveCalendarRange({ organizationId, branchId, startDate, endDate }) {
    const [organization, orgSettings, branch, branchSettings, entries] = await Promise.all([
      Organization.findOne({ _id: organizationId }).lean(),
      this.orgSettingsRepo.findByOrganizationId(organizationId),
      branchId ? Branch.findOne({ _id: branchId, organizationId }).lean() : Promise.resolve(null),
      branchId ? this.branchSettingsRepo.findByBranch(organizationId, branchId) : Promise.resolve(null),
      this.holidayRepo.findOverlappingForRange(organizationId, branchId, startDate, endDate),
    ]);

    const dates = enumerateDates(startDate, endDate);
    const resolved = dates.map((dateStr) =>
      this.resolveDateFromData({
        dateStr,
        branch,
        orgSettings: orgSettings?.toObject ? orgSettings.toObject() : orgSettings,
        branchSettings: branchSettings?.toObject ? branchSettings.toObject() : branchSettings,
        entries,
      })
    );

    return {
      organizationId: organizationId.toString(),
      branchId: branchId ? branchId.toString() : null,
      timezone: branch?.timezone || orgSettings?.regional?.timezone || "Asia/Kolkata",
      startDate,
      endDate,
      days: resolved,
    };
  }
}
