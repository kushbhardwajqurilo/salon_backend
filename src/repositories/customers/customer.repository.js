import { BaseRepository } from "../../shared/repositories/base.repository.js";
import { Customer } from "../../models/customers/customer.model.js";

export class CustomerRepository extends BaseRepository {
  constructor() {
    super(Customer);
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
    if (typeof doc.softDelete === "function") {
      return doc.softDelete(userId);
    }
    // Manual soft delete fallback to prevent permanent deletion
    doc.isDeleted = true;
    doc.isActive = false;
    doc.deletedAt = new Date();
    if (userId) {
      doc.deletedBy = userId;
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

  async addNote(id, noteText, organizationId, userId) {
    return this.model.findOneAndUpdate(
      { _id: id, organizationId },
      {
        $push: { notes: { text: noteText, createdBy: userId } },
      },
      { new: true }
    );
  }

  async addActivity(id, action, description, organizationId, userId) {
    return this.model.findOneAndUpdate(
      { _id: id, organizationId },
      {
        $push: {
          activityTimeline: {
            action,
            description,
            performedBy: userId,
            date: new Date(),
          },
        },
      },
      { new: true }
    );
  }

  async statusUpdateById(id, organizationId) {
    const customer = await this.model.findOne({ _id: id, organizationId });
    if (!customer) return null;
    return this.model.findOneAndUpdate(
      { _id: id, organizationId },
      { $set: { isActive: !customer.isActive } },
      { new: true }
    );
  }
}

