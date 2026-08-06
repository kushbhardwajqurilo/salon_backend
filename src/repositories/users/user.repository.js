import { BaseRepository } from "../../shared/repositories/base.repository.js";
import { User } from "../../models/users/user.model.js";

export class UserRepository extends BaseRepository {
  constructor() {
    super(User);
  }

  async findById(id, organizationId = null, populate = [], select = null) {
    const filter = { _id: id };
    if (organizationId) {
      filter.organizationId = organizationId;
    }
    let query = this.model.findOne(filter);
    if (populate.length > 0) {
      query = query.populate(populate);
    }
    if (select) {
      query = query.select(select);
    }
    return query.exec();
  }

  async findOne(filter, organizationId = null, populate = [], select = null) {
    const queryFilter = { ...filter };
    if (organizationId) {
      queryFilter.organizationId = organizationId;
    }
    let query = this.model.findOne(queryFilter);
    if (populate.length > 0) {
      query = query.populate(populate);
    }
    if (select) {
      query = query.select(select);
    }
    return query.exec();
  }

  async findByEmail(email) {
    return this.model.findOne({ email: email.toLowerCase() }).populate("role");
  }

  async findByPhone(phone) {
    return this.model.findOne({ phone }).populate("role");
  }

  async findByEmailOrPhone(email, phone) {
    return this.model.findOne({
      $or: [{ email: email.toLowerCase() }, { phone }],
    });
  }

  async findByVerificationToken(token) {
    return this.model.findOne({
      emailVerificationToken: token,
      emailVerificationExpires: { $gt: new Date() },
    });
  }

  async findByResetToken(token) {
    return this.model.findOne({
      passwordResetToken: token,
      passwordResetExpires: { $gt: new Date() },
    });
  }
}
