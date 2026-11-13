import { StockBalance } from "../../models/inventory/stockBalance.model.js";

export class StockBalanceRepository {
  async findByBranchAndProduct(organizationId, branchId, productId, session = null) {
    let query = StockBalance.findOne({ organizationId, branchId, productId });
    if (session) query = query.session(session);
    return await query.exec();
  }

  async findOrCreate(organizationId, branchId, productId, session = null) {
    let balance = await this.findByBranchAndProduct(organizationId, branchId, productId, session);
    if (!balance) {
      balance = new StockBalance({
        organizationId,
        branchId,
        productId,
        onHand: 0,
        allocated: 0,
        lastMovementAt: new Date()
      });
      await balance.save({ session });
    }
    return balance;
  }

  async list(filter, { skip = 0, limit = 20, sort = { updatedAt: -1 } } = {}) {
    const [balances, total] = await Promise.all([
      StockBalance.find(filter)
        .populate("productId", "name sku category usageType stockUnit costPrice sellingPrice reorderLevel status")
        .populate("branchId", "name branchCode")
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      StockBalance.countDocuments(filter)
    ]);
    return { balances, total };
  }
}

export const stockBalanceRepository = new StockBalanceRepository();
