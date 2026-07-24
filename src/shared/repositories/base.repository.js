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
  async find(filter = {}, options = {}) {
    const {
      page = 1,
      limit = 10,
      sort = "-createdAt",
      search = "",
      searchFields = [],
      populate = [],
      select = null,
    } = options;

    const queryFilter = { ...filter };

    // Apply search filters
    if (search && searchFields.length > 0) {
      queryFilter.$or = searchFields.map((field) => ({
        [field]: { $regex: search, $options: "i" },
      }));
    }

    const skip = (page - 1) * limit;

    let query = this.model.find(queryFilter);

    if (populate.length > 0) {
      query = query.populate(populate);
    }

    if (select) {
      query = query.select(select);
    }

    query = query.sort(sort).skip(skip).limit(limit);

    const data = await query.exec();
    const total = await this.count(queryFilter);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}
