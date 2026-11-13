import { StockMovement } from "../../models/inventory/stockMovement.model.js";

export class StockMovementRepository {
  async create(data, session = null) {
    const movement = new StockMovement(data);
    return await movement.save({ session });
  }

  async findByIdempotencyKey(organizationId, idempotencyKey, session = null) {
    if (!idempotencyKey) return null;
    let query = StockMovement.findOne({ organizationId, idempotencyKey });
    if (session) query = query.session(session);
    return await query.exec();
  }

  async list(filter, { skip = 0, limit = 20, sort = { createdAt: -1 } } = {}) {
    const [movements, total] = await Promise.all([
      StockMovement.find(filter)
        .populate("productId", "name sku category usageType stockUnit")
        .populate("branchId", "name branchCode")
        .populate("actorId", "name email role")
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      StockMovement.countDocuments(filter)
    ]);
    return { movements, total };
  }
}

export const stockMovementRepository = new StockMovementRepository();
