import mongoose from "mongoose";
import { Branch } from "../../models/branches/branch.model.js";
import { Appointment } from "../../models/appointments/appointment.model.js";
import { HolidayCalendar } from "../../models/holidays/holidayCalendar.model.js";
import { HolidayCalendarRepository } from "../../repositories/holidays/holidayCalendar.repository.js";
import { AuditLogService } from "../audit/auditLog.service.js";
import { runInTransaction, isTransactionSupported } from "../../utils/transaction.js";
import { enumerateDates } from "../../utils/date.js";
import { AppError } from "../../utils/errors.js";

const IMMUTABLE_FIELDS = ["organizationId", "branchId", "_id", "id", "createdAt", "updatedAt"];

export class HolidayCalendarService {
  constructor(deps = {}) {
    this.holidayRepo = deps.holidayRepo || new HolidayCalendarRepository();
    this.auditLogService = deps.auditLogService || new AuditLogService();
  }

  async executeTx(operation) {
    return runInTransaction(operation, { requireTransaction: isTransactionSupported() });
  }

  assertBranchAuthorized(user, branchId) {
    if (!mongoose.Types.ObjectId.isValid(branchId)) {
      throw new AppError("Invalid branch ID format", 400);
    }
    if (user?.hasOrgWideAccess === true) {
      return;
    }
    const allowed = (user?.branchAccess || []).some(
      (b) => b.branchId?.toString() === branchId.toString() && b.isActive
    );
    if (!allowed) {
      throw new AppError("Access denied. You do not have access to this branch.", 403);
    }
  }

  toDTO(doc) {
    return {
      id: doc._id.toString(),
      organizationId: doc.organizationId.toString(),
      branchId: doc.branchId ? doc.branchId.toString() : null,
      date: doc.date,
      endDate: doc.endDate || doc.date,
      eventType: doc.eventType,
      name: doc.name,
      description: doc.description ?? null,
      isPaid: Boolean(doc.isPaid),
      isWorkingDay: Boolean(doc.isWorkingDay),
      operatingHoursOverride: doc.operatingHoursOverride || null,
      isActive: Boolean(doc.isActive),
      createdAt: doc.createdAt ? doc.createdAt.toISOString() : null,
      updatedAt: doc.updatedAt ? doc.updatedAt.toISOString() : null,
    };
  }

  async detectAppointmentConflicts({ organizationId, branchId, startDate, endDate, isWorkingDay }) {
    if (isWorkingDay) {
      return { count: 0, dates: [], appointments: [] };
    }

    const dates = enumerateDates(startDate, endDate);
    const filter = {
      organizationId,
      isDeleted: false,
      status: { $in: ["scheduled", "in_progress"] },
      appointmentDate: { $in: dates },
    };
    if (branchId) {
      filter.branchId = branchId;
    }

    const affected = await Appointment.find(filter)
      .select("_id appointmentCode branchId appointmentDate startTime endTime status")
      .sort({ appointmentDate: 1, startTime: 1 })
      .lean();

    const affectedDates = [...new Set(affected.map((a) => a.appointmentDate))];
    return {
      count: affected.length,
      dates: affectedDates,
      appointments: affected.map((a) => ({
        id: a._id.toString(),
        appointmentCode: a.appointmentCode,
        branchId: a.branchId?.toString() || null,
        appointmentDate: a.appointmentDate,
        startTime: a.startTime,
        endTime: a.endTime,
        status: a.status,
      })),
    };
  }

  async listHolidays(organizationId, query = {}, user) {
    const filter = {
      organizationId,
      isActive: query.includeInactive === "true" ? { $in: [true, false] } : true,
    };

    if (query.branchId) {
      this.assertBranchAuthorized(user, query.branchId);
      filter.branchId = { $in: [null, query.branchId] };
    } else if (!user?.hasOrgWideAccess) {
      const accessibleBranchIds = (user?.branchAccess || [])
        .filter((b) => b.isActive)
        .map((b) => b.branchId);
      filter.branchId = { $in: [null, ...accessibleBranchIds] };
    }

    if (query.eventType) {
      filter.eventType = query.eventType;
    }
    if (query.startDate && query.endDate) {
      filter.date = { $lte: query.endDate };
      filter.$or = [
        { endDate: null, date: { $gte: query.startDate } },
        { endDate: { $gte: query.startDate } },
      ];
    }

    const docs = await HolidayCalendar.find(filter).sort({ date: 1, createdAt: 1 }).lean();
    return docs.map((d) => this.toDTO(d));
  }

  async createHoliday(organizationId, data, user) {
    const branchId = data.branchId || null;
    if (branchId) {
      this.assertBranchAuthorized(user, branchId);
      const branch = await Branch.findOne({ _id: branchId, organizationId, isActive: true }).lean();
      if (!branch) {
        throw new AppError("Active branch not found in organization", 404);
      }
    } else if (!user?.hasOrgWideAccess) {
      throw new AppError("Organization-wide access is required to create organization calendar entries", 403);
    }

    const isWorkingDay = data.eventType === "special_working_day";
    const startDate = data.date;
    const endDate = data.endDate || data.date;

    try {
      return await this.executeTx(async (session) => {
        const created = await HolidayCalendar.create(
          [
            {
              organizationId,
              branchId,
              date: startDate,
              endDate,
              eventType: data.eventType,
              name: data.name.trim(),
              description: data.description?.trim() || null,
              isPaid: Boolean(data.isPaid),
              isWorkingDay,
              operatingHoursOverride: isWorkingDay ? data.operatingHoursOverride || null : null,
              isActive: true,
              createdBy: user.id,
              updatedBy: user.id,
            },
          ],
          { session }
        );
        const doc = created[0];

        const conflicts = await this.detectAppointmentConflicts({
          organizationId,
          branchId,
          startDate,
          endDate,
          isWorkingDay,
        });

        await this.auditLogService.createAuditLog(
          {
            entityType: "HolidayCalendar",
            entityId: doc._id,
            action: "HOLIDAY_CREATED",
            description: `Calendar entry '${doc.name}' (${doc.eventType}) created for ${startDate}`,
            metadata: {
              eventType: doc.eventType,
              date: startDate,
              endDate,
              branchId: branchId ? branchId.toString() : null,
              conflictCount: conflicts.count,
            },
            branchId,
            actorId: user.id,
          },
          organizationId,
          user.id,
          session
        );

        return {
          holiday: this.toDTO(doc),
          conflicts,
        };
      });
    } catch (error) {
      if (error?.code === 11000) {
        throw new AppError("An active calendar entry of this type already exists for this date and scope", 409);
      }
      throw error;
    }
  }

  async updateHoliday(organizationId, id, data, user) {
    for (const key of IMMUTABLE_FIELDS) {
      if (key in data) {
        throw new AppError(`Immutable field '${key}' cannot be modified`, 400);
      }
    }

    const existing = await HolidayCalendar.findOne({ _id: id, organizationId });
    if (!existing) {
      throw new AppError("Calendar entry not found", 404);
    }

    if (existing.branchId) {
      this.assertBranchAuthorized(user, existing.branchId.toString());
    } else if (!user?.hasOrgWideAccess) {
      throw new AppError("Organization-wide access is required to update organization calendar entries", 403);
    }

    const nextEventType = data.eventType ?? existing.eventType;
    const isWorkingDay = nextEventType === "special_working_day";
    const startDate = data.date ?? existing.date;
    const endDate = data.endDate !== undefined ? data.endDate || startDate : existing.endDate || startDate;

    try {
      return await this.executeTx(async (session) => {
        existing.date = startDate;
        existing.endDate = endDate;
        existing.eventType = nextEventType;
        if (data.name !== undefined) existing.name = data.name.trim();
        if (data.description !== undefined) existing.description = data.description?.trim() || null;
        if (data.isPaid !== undefined) existing.isPaid = Boolean(data.isPaid);
        existing.isWorkingDay = isWorkingDay;
        if (data.operatingHoursOverride !== undefined) {
          existing.operatingHoursOverride = isWorkingDay ? data.operatingHoursOverride : null;
        }
        existing.updatedBy = user.id;

        await existing.save({ session });

        const conflicts = await this.detectAppointmentConflicts({
          organizationId,
          branchId: existing.branchId,
          startDate,
          endDate,
          isWorkingDay,
        });

        await this.auditLogService.createAuditLog(
          {
            entityType: "HolidayCalendar",
            entityId: existing._id,
            action: "HOLIDAY_UPDATED",
            description: `Calendar entry '${existing.name}' updated`,
            metadata: {
              eventType: existing.eventType,
              date: startDate,
              endDate,
              conflictCount: conflicts.count,
            },
            branchId: existing.branchId,
            actorId: user.id,
          },
          organizationId,
          user.id,
          session
        );

        return {
          holiday: this.toDTO(existing),
          conflicts,
        };
      });
    } catch (error) {
      if (error?.code === 11000) {
        throw new AppError("An active calendar entry of this type already exists for this date and scope", 409);
      }
      throw error;
    }
  }

  async deleteHoliday(organizationId, id, user) {
    const existing = await HolidayCalendar.findOne({ _id: id, organizationId });
    if (!existing) {
      throw new AppError("Calendar entry not found", 404);
    }

    if (existing.branchId) {
      this.assertBranchAuthorized(user, existing.branchId.toString());
    } else if (!user?.hasOrgWideAccess) {
      throw new AppError("Organization-wide access is required to delete organization calendar entries", 403);
    }

    return this.executeTx(async (session) => {
      existing.isActive = false;
      existing.updatedBy = user.id;
      await existing.save({ session });

      await this.auditLogService.createAuditLog(
        {
          entityType: "HolidayCalendar",
          entityId: existing._id,
          action: "HOLIDAY_DELETED",
          description: `Calendar entry '${existing.name}' deactivated`,
          metadata: {
            eventType: existing.eventType,
            date: existing.date,
          },
          branchId: existing.branchId,
          actorId: user.id,
        },
        organizationId,
        user.id,
        session
      );

      return this.toDTO(existing);
    });
  }
}
