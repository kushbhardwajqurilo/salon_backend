import { BaseRepository } from "../../shared/repositories/base.repository.js";
import { Permission } from "../../models/permissions/permission.model.js";

export class PermissionRepository extends BaseRepository {
  constructor() {
    super(Permission);
  }

  async findByName(name) {
    return this.findOne({ name: name.toLowerCase() });
  }

  async findManyByNames(names) {
    return this.model.find({ name: { $in: names.map((n) => n.toLowerCase()) } });
  }

  async getDistinctModules() {
    const rawModules = await this.model.distinct("module", {
      module: { $exists: true, $ne: null },
    });

    if (!Array.isArray(rawModules)) return [];

    const cleaned = rawModules
      .filter((m) => typeof m === "string" && m.trim().length > 0)
      .map((m) => m.trim());

    return Array.from(new Set(cleaned)).sort((a, b) => a.localeCompare(b));
  }

  async listPermissions(options = {}) {
    const {
      page = 1,
      limit = 10,
      search = "",
      module: moduleFilter = "",
    } = options;

    const parsedPage = Math.max(1, parseInt(page, 10) || 1);
    const parsedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));

    const filter = {};

    if (moduleFilter && typeof moduleFilter === "string" && moduleFilter.trim().length > 0) {
      filter.module = moduleFilter.trim();
    }

    if (search && typeof search === "string" && search.trim().length > 0) {
      const sanitizedSearch = search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const searchRegex = new RegExp(sanitizedSearch, "i");
      filter.$or = [
        { name: searchRegex },
        { description: searchRegex },
        { module: searchRegex },
        { action: searchRegex },
      ];
    }

    const total = await this.model.countDocuments(filter);
    const skip = (parsedPage - 1) * parsedLimit;

    const data = await this.model
      .find(filter)
      .sort({ module: 1, name: 1 })
      .skip(skip)
      .limit(parsedLimit)
      .exec();

    return {
      data: data || [],
      meta: {
        total,
        page: parsedPage,
        limit: parsedLimit,
        totalPages: total === 0 ? 0 : Math.ceil(total / parsedLimit),
      },
    };
  }
}
