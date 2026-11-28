import { Supplier } from "../../models/procurement/supplier.model.js";

export class SupplierRepository {
  async findById(id, organizationId) {
    return await Supplier.findOne({ _id: id, organizationId, isDeleted: false });
  }

  async create(data) {
    return await Supplier.create(data);
  }

  async update(id, organizationId, updateData) {
    return await Supplier.findOneAndUpdate(
      { _id: id, organizationId, isDeleted: false },
      { $set: updateData },
      { returnDocument: 'after', runValidators: true }
    );
  }

  async list(filter, { skip = 0, limit = 20, sort = { createdAt: -1 } } = {}) {
    const [suppliers, total] = await Promise.all([
      Supplier.find(filter).sort(sort).skip(skip).limit(limit).lean(),
      Supplier.countDocuments(filter),
    ]);
    return { suppliers, total };
  }
}

export const supplierRepository = new SupplierRepository();

