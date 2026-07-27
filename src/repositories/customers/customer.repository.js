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
    return doc.softDelete ? doc.softDelete(userId) : this.model.findByIdAndDelete(id);
  }

  async find(filter = {}, options = {}, organizationId) {
    const queryFilter = { ...filter, organizationId };
    return super.find(queryFilter, options);
  }

  async count(filter = {}, organizationId) {
    const queryFilter = { ...filter, organizationId };
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
}
