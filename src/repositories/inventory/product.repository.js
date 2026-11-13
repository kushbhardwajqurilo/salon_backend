import { Product } from "../../models/inventory/product.model.js";

export class ProductRepository {
  async create(data, session = null) {
    const product = new Product(data);
    return await product.save({ session });
  }

  async findById(id, organizationId, session = null) {
    let query = Product.findOne({ _id: id, organizationId, isDeleted: false });
    if (session) query = query.session(session);
    return await query.exec();
  }

  async findBySku(sku, organizationId, session = null) {
    let query = Product.findOne({
      sku: sku.trim().toUpperCase(),
      organizationId,
      isDeleted: false
    });
    if (session) query = query.session(session);
    return await query.exec();
  }

  async update(id, organizationId, updateData, session = null) {
    let query = Product.findOneAndUpdate(
      { _id: id, organizationId, isDeleted: false },
      { $set: updateData },
      { returnDocument: "after", runValidators: true }
    );
    if (session) query = query.session(session);
    return await query.exec();
  }

  async list(filter, { skip = 0, limit = 20, sort = { createdAt: -1 } } = {}) {
    const queryFilter = { ...filter, isDeleted: false };
    const [products, total] = await Promise.all([
      Product.find(queryFilter).sort(sort).skip(skip).limit(limit).lean(),
      Product.countDocuments(queryFilter)
    ]);
    return { products, total };
  }
}

export const productRepository = new ProductRepository();
