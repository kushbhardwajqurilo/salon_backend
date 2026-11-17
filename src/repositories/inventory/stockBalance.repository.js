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
        onHandConsumables: 0,
        onHandRetail: 0,
        allocated: 0,
        allocatedConsumables: 0,
        allocatedRetail: 0,
        lastMovementAt: new Date()
      });
      await balance.save({ session });
    }
    return balance;
  }

  async list(filter, { skip = 0, limit = 20, sort = { updatedAt: -1 } } = {}) {
    const [rawBalances, total] = await Promise.all([
      StockBalance.find(filter)
        .populate("productId", "name sku category usageType stockUnit costPrice sellingPrice reorderLevel status")
        .populate("branchId", "name branchCode")
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      StockBalance.countDocuments(filter)
    ]);

    // Backward compatibility normalization for legacy records without domain fields:
    // If a document was stored prior to domain fields existing:
    // onHandRetail defaults to 0, onHandConsumables defaults to 0,
    // and for 'both' or untyped usage, onHandUnallocated defaults to onHand.
    const balances = rawBalances.map((b) => {
      const onHandRetail = b.onHandRetail ?? 0;
      const onHandConsumables = b.onHandConsumables ?? 0;
      const onHandUnallocated =
        b.onHandUnallocated !== undefined
          ? b.onHandUnallocated
          : Math.max(0, (b.onHand || 0) - (onHandRetail + onHandConsumables));

      return {
        ...b,
        onHandRetail,
        onHandConsumables,
        onHandUnallocated,
        allocatedRetail: b.allocatedRetail ?? 0,
        allocatedConsumables: b.allocatedConsumables ?? 0,
      };
    });

    return { balances, total };
  }
}

export const stockBalanceRepository = new StockBalanceRepository();
