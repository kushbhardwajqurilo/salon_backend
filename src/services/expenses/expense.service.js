import crypto from "crypto";
import mongoose from "mongoose";
import { Expense } from "../../models/expenses/expense.model.js";
import { PettyCashTransaction } from "../../models/expenses/pettyCash.model.js";
import { Organization } from "../../models/organizations/organization.model.js";
import { Sequence } from "../../models/sequence/sequence.model.js";
import { AppError } from "../../utils/errors.js";
import { runInTransaction } from "../../utils/transaction.js";

export class ExpenseService {
  /**
   * Atomic sequence generator for Expense and PettyCash codes.
   */
  static async getNextSequence(organizationId, prefix) {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, "");
    const sequenceKey = `${prefix}_${organizationId.toString()}_${dateStr}`;

    const seqDoc = await Sequence.findOneAndUpdate(
      { key: sequenceKey },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );

    const paddedNumber = String(seqDoc.seq).padStart(4, "0");
    return `${prefix}-${dateStr}-${paddedNumber}`;
  }

  /**
   * Create new Expense.
   * If paymentMethod === 'petty_cash' and amount <= approvalThreshold, creates PettyCashTransaction atomically.
   */
  static async createExpense(organizationId, branchId, userId, payload) {
    const org = await Organization.findById(organizationId).lean();
    if (!org) throw new AppError("Organization not found", 404);

    const threshold = org.expenseApprovalThreshold ?? 5000;
    const approvalStatus = payload.amount <= threshold ? "approved" : "pending_approval";
    const paymentStatus =
      payload.paymentMethod === "petty_cash"
        ? approvalStatus === "approved"
          ? "settled"
          : "unpaid"
        : "settled";

    return await runInTransaction(async (session) => {
      const expenseCode = await ExpenseService.getNextSequence(organizationId, "EXP");

      const [newExpense] = await Expense.create(
        [
          {
            organizationId,
            branchId,
            expenseCode,
            category: payload.category.toLowerCase().trim(),
            amount: payload.amount,
            paymentMethod: payload.paymentMethod,
            payeeName: payload.payeeName.trim(),
            invoiceNumber: payload.invoiceNumber || null,
            receiptUrl: payload.receiptUrl || null,
            description: payload.description || "",
            sourceType: payload.sourceType || "manual",
            sourceReference: payload.sourceReference || null,
            supplierId: payload.supplierId || null,
            supplierInvoiceId: payload.supplierInvoiceId || null,
            expenseDate: payload.expenseDate ? new Date(payload.expenseDate) : new Date(),
            approvalStatus,
            paymentStatus,
            approvalThresholdAtCreation: threshold,
            recordedBy: userId,
            approvedBy: approvalStatus === "approved" ? userId : null,
            approvedAt: approvalStatus === "approved" ? new Date() : null,
          },
        ],
        { session }
      );

      let pettyCashTransaction = null;
      if (payload.paymentMethod === "petty_cash" && approvalStatus === "approved") {
        const txNumber = await ExpenseService.getNextSequence(organizationId, "PC");
        const idempotencyKey = `EXP_PAYOUT_${newExpense._id.toString()}`;

        const [payout] = await PettyCashTransaction.create(
          [
            {
              organizationId,
              branchId,
              transactionNumber: txNumber,
              type: "expense_payout",
              amount: payload.amount,
              linkedExpenseId: newExpense._id,
              description: `Payout for expense ${newExpense.expenseCode}: ${newExpense.payeeName}`,
              idempotencyKey,
              recordedBy: userId,
              transactionDate: newExpense.expenseDate,
            },
          ],
          { session }
        );
        pettyCashTransaction = payout;
      }

      const expenseJson = newExpense.toJSON();
      if (pettyCashTransaction) {
        expenseJson.pettyCashTransactionId = pettyCashTransaction._id.toString();
      }
      return expenseJson;
    }, { requireTransaction: true });
  }

  /**
   * List expenses with filters, pagination, and branch scoping.
   */
  static async listExpenses(organizationId, branchId, query) {
    const filter = { organizationId, isDeleted: false };
    if (branchId) filter.branchId = branchId;
    if (query.category) filter.category = query.category.toLowerCase().trim();
    if (query.paymentMethod) filter.paymentMethod = query.paymentMethod;
    if (query.approvalStatus) filter.approvalStatus = query.approvalStatus;
    if (query.paymentStatus) filter.paymentStatus = query.paymentStatus;

    if (query.startDate || query.endDate) {
      filter.expenseDate = {};
      if (query.startDate) filter.expenseDate.$gte = new Date(query.startDate);
      if (query.endDate) {
        const end = new Date(query.endDate);
        if (query.endDate.length === 10) end.setUTCHours(23, 59, 59, 999);
        filter.expenseDate.$lte = end;
      }
    }

    if (query.search) {
      const searchRegex = new RegExp(query.search.trim(), "i");
      filter.$or = [
        { expenseCode: searchRegex },
        { payeeName: searchRegex },
        { invoiceNumber: searchRegex },
        { description: searchRegex },
      ];
    }

    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const sortField = query.sortBy || "expenseDate";
    const sortDirection = query.sortOrder === "asc" ? 1 : -1;
    const sort = { [sortField]: sortDirection, _id: -1 };

    const [items, total] = await Promise.all([
      Expense.find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .populate("recordedBy", "name email")
        .populate("approvedBy", "name email")
        .populate("rejectedBy", "name email")
        .populate("supplierId", "name contactPerson phone")
        .populate("supplierInvoiceId", "invoiceNumber totalAmount status")
        .lean(),
      Expense.countDocuments(filter),
    ]);

    return {
      items: items.map((doc) => {
        doc.id = doc._id.toString();
        return doc;
      }),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  /**
   * Get expense by ID with branch check.
   */
  static async getExpenseById(organizationId, expenseId, branchId = null) {
    const filter = { _id: expenseId, organizationId, isDeleted: false };
    if (branchId) filter.branchId = branchId;

    const expense = await Expense.findOne(filter)
      .populate("recordedBy", "name email")
      .populate("approvedBy", "name email")
      .populate("rejectedBy", "name email")
      .populate("supplierId", "name contactPerson phone email")
      .populate("supplierInvoiceId", "invoiceNumber totalAmount amountPaid status dueDate")
      .lean();

    if (!expense) throw new AppError("Expense not found", 404);
    expense.id = expense._id.toString();
    return expense;
  }

  /**
   * Update unapproved draft details.
   */
  static async updateExpense(organizationId, expenseId, branchId, payload) {
    const expense = await Expense.findOne({
      _id: expenseId,
      organizationId,
      ...(branchId ? { branchId } : {}),
      isDeleted: false,
    });
    if (!expense) throw new AppError("Expense not found", 404);
    if (expense.approvalStatus !== "pending_approval") {
      throw new AppError("Only pending expenses can be edited", 400);
    }

    if (payload.category) expense.category = payload.category.toLowerCase().trim();
    if (payload.payeeName) expense.payeeName = payload.payeeName.trim();
    if (payload.invoiceNumber !== undefined) expense.invoiceNumber = payload.invoiceNumber;
    if (payload.receiptUrl !== undefined) expense.receiptUrl = payload.receiptUrl;
    if (payload.description !== undefined) expense.description = payload.description;
    if (payload.expenseDate) expense.expenseDate = new Date(payload.expenseDate);

    await expense.save();
    return expense.toJSON();
  }

  /**
   * Approve expense.
   * If paymentMethod === 'petty_cash', atomically disburse payout and transition paymentStatus to 'settled'.
   */
  static async approveExpense(organizationId, expenseId, branchId, userId) {
    return await runInTransaction(async (session) => {
      const expense = await Expense.findOne({
        _id: expenseId,
        organizationId,
        ...(branchId ? { branchId } : {}),
        isDeleted: false,
      }).session(session);

      if (!expense) throw new AppError("Expense not found", 404);
      if (expense.approvalStatus !== "pending_approval") {
        throw new AppError(`Expense cannot be approved from status '${expense.approvalStatus}'`, 400);
      }

      if (expense.recordedBy && expense.recordedBy.toString() === userId.toString()) {
        throw new AppError("Separation of duties: recordedBy user cannot approve their own expense voucher", 403);
      }

      expense.approvalStatus = "approved";
      expense.approvedBy = userId;
      expense.approvedAt = new Date();

      let pettyCashTransaction = null;
      if (expense.paymentMethod === "petty_cash" && expense.paymentStatus === "unpaid") {
        const txNumber = await ExpenseService.getNextSequence(organizationId, "PC");
        const idempotencyKey = `EXP_PAYOUT_${expense._id.toString()}`;

        const [payout] = await PettyCashTransaction.create(
          [
            {
              organizationId,
              branchId: expense.branchId,
              transactionNumber: txNumber,
              type: "expense_payout",
              amount: expense.amount,
              linkedExpenseId: expense._id,
              description: `Payout for approved expense ${expense.expenseCode}: ${expense.payeeName}`,
              idempotencyKey,
              recordedBy: userId,
              transactionDate: new Date(),
            },
          ],
          { session }
        );
        expense.paymentStatus = "settled";
        pettyCashTransaction = payout;
      }

      await expense.save({ session });
      const resJson = expense.toJSON();
      if (pettyCashTransaction) {
        resJson.pettyCashTransactionId = pettyCashTransaction._id.toString();
      }
      return resJson;
    }, { requireTransaction: true });
  }

  /**
   * Reject expense.
   * Settlement evidence is preserved if previously settled out-of-pocket; no petty cash is disbursed.
   */
  static async rejectExpense(organizationId, expenseId, branchId, userId, reason) {
    const expense = await Expense.findOne({
      _id: expenseId,
      organizationId,
      ...(branchId ? { branchId } : {}),
      isDeleted: false,
    });

    if (!expense) throw new AppError("Expense not found", 404);
    if (expense.approvalStatus !== "pending_approval") {
      throw new AppError(`Expense cannot be rejected from status '${expense.approvalStatus}'`, 400);
    }

    if (expense.recordedBy && expense.recordedBy.toString() === userId.toString()) {
      throw new AppError("Separation of duties: recordedBy user cannot reject their own expense voucher", 403);
    }

    expense.approvalStatus = "rejected";
    expense.rejectedBy = userId;
    expense.rejectedAt = new Date();
    expense.rejectionReason = reason.trim();

    await expense.save();
    return expense.toJSON();
  }

  /**
   * Soft-delete expense.
   * Never modifies or reverses petty cash ledger entries.
   */
  static async deleteExpense(organizationId, expenseId, branchId, userId) {
    const expense = await Expense.findOne({
      _id: expenseId,
      organizationId,
      ...(branchId ? { branchId } : {}),
      isDeleted: false,
    });

    if (!expense) throw new AppError("Expense not found", 404);

    expense.isDeleted = true;
    expense.deletedAt = new Date();
    expense.deletedBy = userId;

    await expense.save();
    return { success: true, message: "Expense deleted successfully" };
  }

  /**
   * Branch expense summary by category and period.
   */
  static async getExpenseSummary(organizationId, branchId, startDate, endDate) {
    const match = {
      organizationId: new mongoose.Types.ObjectId(organizationId),
      approvalStatus: "approved",
      isDeleted: false,
    };
    if (branchId) match.branchId = new mongoose.Types.ObjectId(branchId);

    if (startDate || endDate) {
      match.expenseDate = {};
      if (startDate) match.expenseDate.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        if (endDate.length === 10) end.setUTCHours(23, 59, 59, 999);
        match.expenseDate.$lte = end;
      }
    }

    const [categoryAggregation, pendingCount] = await Promise.all([
      Expense.aggregate([
        { $match: match },
        {
          $group: {
            _id: "$category",
            totalAmount: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
      ]),
      Expense.countDocuments({
        organizationId,
        ...(branchId ? { branchId } : {}),
        approvalStatus: "pending_approval",
        isDeleted: false,
      }),
    ]);

    const categories = {};
    let totalSpent = 0;
    for (const item of categoryAggregation) {
      categories[item._id] = item.totalAmount;
      totalSpent += item.totalAmount;
    }

    return {
      totalSpent,
      categories,
      pendingApprovalCount: pendingCount,
    };
  }

  /**
   * Derived Petty Cash balance calculation via aggregation over append-only ledger.
   */
  static async getPettyCashBalance(organizationId, branchId) {
    if (!branchId) throw new AppError("BranchId is required to calculate petty cash balance", 400);

    const match = {
      organizationId: new mongoose.Types.ObjectId(organizationId),
      branchId: new mongoose.Types.ObjectId(branchId),
    };

    const result = await PettyCashTransaction.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          totalInflow: {
            $sum: {
              $cond: [
                { $in: ["$type", ["opening_balance", "replenishment", "payout_reversal"]] },
                "$amount",
                0,
              ],
            },
          },
          totalOutflow: {
            $sum: {
              $cond: [{ $eq: ["$type", "expense_payout"] }, "$amount", 0],
            },
          },
        },
      },
    ]);

    const totalInflow = result[0]?.totalInflow || 0;
    const totalOutflow = result[0]?.totalOutflow || 0;
    const currentBalance = totalInflow - totalOutflow;

    return {
      branchId,
      currentBalance,
      totalInflow,
      totalOutflow,
    };
  }

  /**
   * Replenish petty cash drawer.
   * Requires client-supplied Idempotency-Key.
   */
  static async replenishPettyCash(organizationId, branchId, userId, payload, idempotencyKey) {
    if (!branchId) throw new AppError("BranchId is required to replenish petty cash", 400);
    if (!idempotencyKey) throw new AppError("Idempotency-Key header is required", 400);

    const requestPayloadHash = crypto
      .createHash("sha256")
      .update(JSON.stringify({ branchId, amount: payload.amount, description: payload.description }))
      .digest("hex");

    return await runInTransaction(async (session) => {
      const existing = await PettyCashTransaction.findOne({
        organizationId,
        idempotencyKey,
      }).session(session);

      if (existing) {
        if (existing.requestPayloadHash !== requestPayloadHash) {
          throw new AppError("Idempotency key reuse with differing parameters", 409);
        }
        return existing.toJSON();
      }

      const txNumber = await ExpenseService.getNextSequence(organizationId, "PC");
      const [tx] = await PettyCashTransaction.create(
        [
          {
            organizationId,
            branchId,
            transactionNumber: txNumber,
            type: "replenishment",
            amount: payload.amount,
            description: payload.description,
            idempotencyKey,
            requestPayloadHash,
            recordedBy: userId,
            transactionDate: new Date(),
          },
        ],
        { session }
      );
      return tx.toJSON();
    }, { requireTransaction: true });
  }

  /**
   * Concurrency-safe Cash Recovery.
   * Serializes recovery against original payout and caps cumulative recovery at original payout amount.
   */
  static async recoverPettyCashPayout(organizationId, branchId, userId, payload, idempotencyKey) {
    if (!branchId) throw new AppError("BranchId is required for cash recovery", 400);
    if (!idempotencyKey) throw new AppError("Idempotency-Key header is required", 400);

    const { linkedExpenseId, originalPayoutId, recoveredAmount, reason, recoveryDate } = payload;

    const requestPayloadHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          branchId,
          linkedExpenseId,
          originalPayoutId,
          recoveredAmount,
          reason,
        })
      )
      .digest("hex");

    return await runInTransaction(async (session) => {
      // 1. Idempotency check
      const existing = await PettyCashTransaction.findOne({
        organizationId,
        idempotencyKey,
      }).session(session);

      if (existing) {
        if (existing.requestPayloadHash !== requestPayloadHash) {
          throw new AppError("Idempotency key reuse with differing parameters", 409);
        }
        return existing.toJSON();
      }

      // 2. Atomic serialization and cumulative recovery limit check on original payout
      const payout = await PettyCashTransaction.findOneAndUpdate(
        {
          _id: originalPayoutId,
          organizationId,
          branchId,
          type: "expense_payout",
          $expr: {
            $lte: [{ $add: ["$recoveredAmountSoFar", recoveredAmount] }, "$amount"],
          },
        },
        { $inc: { recoveredAmountSoFar: recoveredAmount } },
        { session, new: true }
      );

      if (!payout) {
        throw new AppError(
          "Cumulative recovery exceeds original payout amount or original payout not found",
          400
        );
      }

      // 3. Insert append-only payout_reversal
      const txNumber = await ExpenseService.getNextSequence(organizationId, "PC");
      const [reversalTx] = await PettyCashTransaction.create(
        [
          {
            organizationId,
            branchId,
            transactionNumber: txNumber,
            type: "payout_reversal",
            amount: recoveredAmount,
            linkedExpenseId,
            originalPayoutId,
            description: reason,
            idempotencyKey,
            requestPayloadHash,
            recordedBy: userId,
            transactionDate: recoveryDate ? new Date(recoveryDate) : new Date(),
          },
        ],
        { session }
      );

      return reversalTx.toJSON();
    }, { requireTransaction: true });
  }

  /**
   * List petty cash transaction ledger with pagination.
   */
  static async listPettyCashTransactions(organizationId, branchId, query) {
    if (!branchId) throw new AppError("BranchId is required to list petty cash transactions", 400);

    const filter = { organizationId, branchId };
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(query.limit, 10) || 30));
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      PettyCashTransaction.find(filter)
        .sort({ transactionDate: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .populate("recordedBy", "name email")
        .populate("linkedExpenseId", "expenseCode payeeName category amount")
        .lean(),
      PettyCashTransaction.countDocuments(filter),
    ]);

    return {
      items: items.map((doc) => {
        doc.id = doc._id.toString();
        return doc;
      }),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }
}
