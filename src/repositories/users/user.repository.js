import { BaseRepository } from "../../shared/repositories/base.repository.js";
import { User } from "../../models/users/user.model.js";

export class UserRepository extends BaseRepository {
  constructor() {
    super(User);
  }

  async findById(
    id,
    organizationId = null,
    populate = [],
    select = null,
    session = null,
  ) {
    const filter = { _id: id };
    if (organizationId) {
      filter.organizationId = organizationId;
    }
    let query = this.model.findOne(filter);
    if (session) {
      query = query.session(session);
    }
    if (populate.length > 0) {
      query = query.populate(populate);
    }
    if (select) {
      query = query.select(select);
    }
    return query.exec();
  }

  async findOne(
    filter,
    organizationId = null,
    populate = [],
    select = null,
    session = null,
  ) {
    const queryFilter = { ...filter };
    if (organizationId) {
      queryFilter.organizationId = organizationId;
    }
    let query = this.model.findOne(queryFilter);
    if (session) {
      query = query.session(session);
    }
    if (populate.length > 0) {
      query = query.populate(populate);
    }
    if (select) {
      query = query.select(select);
    }
    return query.exec();
  }

  async find(filter = {}, options = {}, organizationId = null, populate = []) {
    const queryFilter = { ...filter };
    if (organizationId) {
      queryFilter.organizationId = organizationId;
    }
    if (populate && populate.length > 0) {
      return super.find(queryFilter, options, populate);
    }
    return super.find(queryFilter, options);
  }

  async count(filter = {}, organizationId = null) {
    const queryFilter = { ...filter };
    if (organizationId) {
      queryFilter.organizationId = organizationId;
    }
    return super.count(queryFilter);
  }

  async updateById(
    id,
    data,
    organizationId = null,
    userId = null,
    session = null,
  ) {
    const filter = { _id: id };
    if (organizationId) {
      filter.organizationId = organizationId;
    }
    const doc = await this.model.findOne(filter).session(session).exec();
    if (!doc) return null;

    Object.assign(doc, data);
    if (userId) {
      doc.updatedBy = userId;
    }

    return doc.save({ session });
  }

  async deleteById(id, organizationId = null, userId = null) {
    const filter = { _id: id };
    if (organizationId) {
      filter.organizationId = organizationId;
    }
    const doc = await this.model.findOne(filter).exec();
    if (!doc) return null;
    return doc.softDelete(userId);
  }

  async findByEmail(email, organizationId = null) {
    const filter = { email: email.toLowerCase() };
    if (organizationId) {
      filter.organizationId = organizationId;
    }
    return this.model.findOne(filter).populate("role");
  }

  async findByUsername(username, organizationId = null) {
    const filter = { username: username.toLowerCase() };
    if (organizationId) {
      filter.organizationId = organizationId;
    }
    return this.model.findOne(filter).populate("role");
  }

  async findByEmailOrUsername(identifier, organizationId = null) {
    const normalized = identifier.toLowerCase();
    const filter = {
      $or: [{ email: normalized }, { username: normalized }],
    };
    if (organizationId) {
      filter.organizationId = organizationId;
    }
    return this.model.findOne(filter).populate("role");
  }

  async findByPhone(phone, organizationId = null) {
    const filter = { phone };
    if (organizationId) {
      filter.organizationId = organizationId;
    }
    return this.model.findOne(filter).populate("role");
  }

  async findByEmailOrPhone(email, phone, organizationId = null) {
    const filter = {
      $or: [{ email: email.toLowerCase() }, { phone }],
    };
    if (organizationId) {
      filter.organizationId = organizationId;
    }
    return this.model.findOne(filter);
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
