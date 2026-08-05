import { BaseRepository } from "../../shared/repositories/base.repository.js";
import { StaffBranch } from "../../models/staff/staffBranch.model.js";

export class StaffBranchRepository extends BaseRepository {
  constructor() {
    super(StaffBranch);
  }

  async create(data, organizationId, userId = null, session = null) {
    const doc = new this.model({ ...data, organizationId });
    if (userId) {
      doc.createdBy = userId;
      doc.updatedBy = userId;
    }
    return doc.save({ session });
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
}
