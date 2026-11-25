import { BaseRepository } from "../../shared/repositories/base.repository.js";
import { HolidayCalendar } from "../../models/holidays/holidayCalendar.model.js";

export class HolidayCalendarRepository extends BaseRepository {
  constructor() {
    super(HolidayCalendar);
  }

  async findOverlappingForRange(organizationId, branchId, startDate, endDate, session = null) {
    const branchFilter = branchId ? { $in: [null, branchId] } : null;
    const query = this.model.find({
      organizationId,
      branchId: branchFilter,
      isActive: true,
      date: { $lte: endDate },
      $or: [
        { endDate: null, date: { $gte: startDate } },
        { endDate: { $gte: startDate } },
      ],
    });
    if (session) query.session(session);
    return query.sort({ date: 1 }).lean().exec();
  }
}
