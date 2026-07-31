import { BaseRepository } from "../../shared/repositories/base.repository.js";
import { Service } from "../../models/services/service.model.js";

export class ServiceRepository extends BaseRepository {
  constructor() {
    super(Service);
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

    doc.isDeleted = true;
    doc.status = "inactive";
    doc.deletedAt = new Date();
    if (userId) {
      doc.updatedBy = userId;
    }
    return doc.save();
  }

  async find(filter = {}, options = {}, organizationId) {
    const queryFilter = { ...filter };
    if (organizationId !== undefined) {
      queryFilter.organizationId = organizationId;
    }
    return super.find(queryFilter, options);
  }

  async count(filter = {}, organizationId) {
    const queryFilter = { ...filter };
    if (organizationId !== undefined) {
      queryFilter.organizationId = organizationId;
    }
    return super.count(queryFilter);
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
