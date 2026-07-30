import { BaseRepository } from "../../shared/repositories/base.repository.js";
import { CustomerNote } from "../../models/customers/customerNote.model.js";

export class CustomerNoteRepository extends BaseRepository {
  constructor() {
    super(CustomerNote);
  }

  async create(data, organizationId, userId = null, session = null) {
    const doc = new this.model({
      ...data,
      organizationId,
      createdBy: userId,
    });
    return doc.save({ session });
  }

  async findByCustomer(customerId, organizationId, options = {}) {
    const filter = { customerId, organizationId };
    return this.find(filter, options);
  }
}
