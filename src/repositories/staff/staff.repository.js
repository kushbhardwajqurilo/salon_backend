import { BaseRepository } from "../../shared/repositories/base.repository.js";
import { Staff } from "../../models/staff/staff.model.js";

export class StaffRepository extends BaseRepository {
  constructor() {
    super(Staff);
  }

  async create(data, organizationId, userId = null, session = null) {
    const doc = new this.model({ ...data, organizationId });
    if (userId) {
      doc.createdBy = userId;
      doc.updatedBy = userId;
    }
    return doc.save({ session });
  }

  async findById(id, organizationId, populate = [], select = null) {
    let query = this.model.findOne({ _id: id, organizationId });
    if (populate.length > 0) {
      query = query.populate(populate);
    }
    if (select) {
      query = query.select(select);
    }
    return query.exec();
  }

  async findByIdIncludeDeleted(id, organizationId, populate = [], select = null) {
    let query = this.model.findOne({ _id: id, organizationId }).setOptions({ includeDeleted: true });
    if (populate.length > 0) {
      query = query.populate(populate);
    }
    if (select) {
      query = query.select(select);
    }
    return query.exec();
  }

  async findOne(filter, organizationId, populate = [], select = null) {
    let query = this.model.findOne({ ...filter, organizationId });
    if (populate.length > 0) {
      query = query.populate(populate);
    }
    if (select) {
      query = query.select(select);
    }
    return query.exec();
  }

  async updateById(id, data, organizationId, userId = null, session = null) {
    const doc = await this.model.findOne({ _id: id, organizationId }).session(session);
    if (!doc) return null;

    Object.assign(doc, data);
    if (userId) {
      doc.updatedBy = userId;
    }

    return doc.save({ session });
  }

  async deleteById(id, organizationId, userId = null) {
    const doc = await this.model.findOne({ _id: id, organizationId });
    if (!doc) return null;
    return doc.softDelete(userId);
  }

  async find(filter = {}, options = {}, organizationId) {
    const queryFilter = { ...filter };
    
    // Clean non-schema query parameters from the database query filter
    const nonSchemaKeys = ["page", "limit", "sort", "search", "branchId", "searchFields", "populate", "select"];
    nonSchemaKeys.forEach(key => delete queryFilter[key]);

    if (organizationId !== undefined) {
      queryFilter.organizationId = organizationId;
    }

    const queryOptions = { ...options };
    if (queryOptions.search && (!queryOptions.searchFields || queryOptions.searchFields.length === 0)) {
      queryOptions.searchFields = ["name", "email", "phone", "staffCode", "designation"];
    }

    return super.find(queryFilter, queryOptions);
  }

  async count(filter = {}, organizationId) {
    const queryFilter = { ...filter };
    if (organizationId !== undefined) {
      queryFilter.organizationId = organizationId;
    }
    return super.count(queryFilter);
  }

  async findByPhone(phone, organizationId, includeDeleted = false) {
    let query = this.model.findOne({ phone, organizationId });
    if (includeDeleted) {
      query.setOptions({ includeDeleted: true });
    }
    return query.exec();
  }

  async findByEmail(email, organizationId, includeDeleted = false) {
    let query = this.model.findOne({ email: email.toLowerCase(), organizationId });
    if (includeDeleted) {
      query.setOptions({ includeDeleted: true });
    }
    return query.exec();
  }

  async findByCode(staffCode, organizationId, includeDeleted = false) {
    let query = this.model.findOne({ staffCode, organizationId });
    if (includeDeleted) {
      query.setOptions({ includeDeleted: true });
    }
    return query.exec();
  }

  async reactivateById(id, organizationId, userId = null) {
    const update = {
      isDeleted: false,
      deletedAt: null,
      status: "active",
    };
    if (userId) {
      update.updatedBy = userId;
    }
    return this.model.findOneAndUpdate(
      { _id: id, organizationId },
      { $set: update },
      { new: true, includeDeleted: true }
    );
  }
}