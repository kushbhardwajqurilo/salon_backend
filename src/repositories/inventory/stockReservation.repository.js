import { StockReservation } from "../../models/inventory/stockReservation.model.js";

export class StockReservationRepository {
  async create(data, session = null) {
    const doc = new StockReservation(data);
    return await doc.save({ session });
  }

  async findActiveByInvoice(invoiceId, organizationId, session = null) {
    let query = StockReservation.find({
      invoiceId,
      organizationId,
      status: "active",
    });
    if (session) query = query.session(session);
    return await query;
  }

  async findActiveByProductAndBranch(productId, branchId, organizationId, session = null) {
    let query = StockReservation.find({
      productId,
      branchId,
      organizationId,
      status: "active",
    });
    if (session) query = query.session(session);
    return await query;
  }

  async updateStatusByInvoice(invoiceId, organizationId, status, session = null) {
    return await StockReservation.updateMany(
      {
        invoiceId,
        organizationId,
        status: "active",
      },
      {
        $set: { status },
      },
      { session }
    );
  }

  async findExpiredActiveReservations(limit = 100) {
    return await StockReservation.find({
      status: "active",
      expiresAt: { $lte: new Date() },
    })
      .limit(limit)
      .lean();
  }

  async atomicallyExpireReservation(reservationId, session = null) {
    let query = StockReservation.findOneAndUpdate(
      {
        _id: reservationId,
        status: "active",
      },
      {
        $set: { status: "expired" },
      },
      { returnDocument: "after" }
    );
    if (session) query = query.session(session);
    return await query;
  }
}

export const stockReservationRepository = new StockReservationRepository();

