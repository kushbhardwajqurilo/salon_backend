export class BaseRepository {
  constructor(model) {
    this.model = model;
  }

  async create(data, userId = null, session = null) {
    const doc = new this.model(data);
    if (userId) {
      doc.createdBy = userId;
      doc.updatedBy = userId;
    }
    return doc.save({ session });
  }

  async findById(id, populate = [], select = null) {
    let query = this.model.findById(id);
    if (populate.length > 0) {
      query = query.populate(populate);
    }
    if (select) {
      query = query.select(select);
    }
    return query.exec();
  }

  async findOne(filter, populate = [], select = null) {
    let query = this.model.findOne(filter);
    if (populate.length > 0) {
      query = query.populate(populate);
    }
    if (select) {
      query = query.select(select);
    }
    return query.exec();
  }

  async updateById(id, data, userId = null, session = null) {
    const doc = await this.model.findById(id).session(session);
    if (!doc) return null;

    Object.assign(doc, data);
    if (userId) {
      doc.updatedBy = userId;
    }

    return doc.save({ session });
  }

  async deleteById(id, userId = null) {
    const doc = await this.model.findById(id);
    if (!doc) return null;
    return doc.softDelete(userId);
  }

  async count(filter = {}) {
    return this.model.countDocuments(filter).exec();
  }

  /**
   * Universal list query builder supporting search, filter, sort, and pagination.
   */
  async find(filter = {}, options = {}, populate = []) {
    const {
      page = 1,
      limit = 10,
      all = false,
      sort = "-createdAt",
      search = "",
      searchFields = [],
      select = null,
      populate: optionsPopulate,
    } = options;

    const queryFilter = { ...filter };

    // Apply search filters
    if (search && searchFields.length > 0) {
      queryFilter.$or = searchFields.map((field) => ({
        [field]: { $regex: search, $options: "i" },
      }));
    }

    const isFetchAll =
      limit === "all" ||
      all === true ||
      all === "true" ||
      all === "all";

    let query = this.model.find(queryFilter);

    const activePopulate = (populate && populate.length > 0) ? populate : (optionsPopulate || []);
    if (activePopulate.length > 0) {
      query = query.populate(activePopulate);
    }

    if (select) {
      query = query.select(select);
    }

    query = query.sort(sort);

    if (!isFetchAll) {
      const parsedPage = Number(page) || 1;
      const parsedLimit = Number(limit) || 10;
      const skip = (parsedPage - 1) * parsedLimit;
      query = query.skip(skip).limit(parsedLimit);
    }

    const data = await query.exec();
    const total = await this.count(queryFilter);

    const parsedLimit = isFetchAll ? total : (Number(limit) || 10);
    const parsedPage = isFetchAll ? 1 : (Number(page) || 1);

    return {
      data,
      meta: {
        total,
        page: parsedPage,
        limit: isFetchAll ? "all" : parsedLimit,
        totalPages: isFetchAll ? 1 : Math.ceil(total / parsedLimit),
      },
    };
  }
}
