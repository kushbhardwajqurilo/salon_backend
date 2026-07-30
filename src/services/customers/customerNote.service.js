import mongoose from "mongoose";
import { CustomerNoteRepository } from "../../repositories/customers/customerNote.repository.js";
import { AuditLogRepository } from "../../repositories/audit/auditLog.repository.js";
import { AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";
import { AppError } from "../../utils/errors.js";

export class CustomerNoteService {
  constructor(noteRepo = null, auditRepo = null) {
    this.noteRepo = noteRepo || new CustomerNoteRepository();
    this.auditRepo = auditRepo || new AuditLogRepository();
  }

  async createNote(customerId, text, organizationId, branchId, userId) {
    // 1. Validate trimmed non-empty text and maximum length
    const trimmed = (text || "").trim();
    if (!trimmed) {
      throw new AppError("Note text cannot be empty", 400);
    }
    if (trimmed.length > 2000) {
      throw new AppError("Note text exceeds maximum length of 2000 characters", 400);
    }

    // 2. Verify customer existence and organization ownership
    const CustomerModel = mongoose.model("Customer");
    const customer = await CustomerModel.findOne({ _id: customerId, organizationId });
    if (!customer) {
      throw new AppError("Customer not found", 404);
    }

    // 3. Verify customer visibility for branch scope
    if (branchId) {
      const isHome = customer.homeBranchId?.toString() === branchId.toString();
      const hasVisited = (customer.visitedBranchIds || []).some(
        (bId) => bId.toString() === branchId.toString()
      );
      if (!isHome && !hasVisited) {
        throw new AppError("Access denied. Customer is not visible within your active branch scope.", 403);
      }
    }

    // 4. Create Note and AuditLog atomically/safely
    let session = null;
    try {
      if (mongoose.connection.db && typeof mongoose.connection.startSession === "function") {
        session = await mongoose.connection.startSession();
        session.startTransaction();

        const note = await this.noteRepo.create(
          { customerId, text: trimmed, branchId },
          organizationId,
          userId,
          session
        );

        await this.auditRepo.create(
          {
            branchId,
            action: AUDIT_ACTIONS.NOTE_ADDED,
            entityType: "Customer",
            entityId: customerId,
            description: `Added note: "${trimmed.slice(0, 50)}${trimmed.length > 50 ? "..." : ""}"`,
            metadata: { noteId: note._id },
          },
          organizationId,
          userId,
          session
        );

        await session.commitTransaction();
        session.endSession();
        return note;
      }
    } catch (err) {
      if (session) {
        try {
          await session.abortTransaction();
          session.endSession();
        } catch (_) {}
      }

      // Check if this error is due to missing transaction/replica set support
      const isSessionError =
        err.message.includes("Transaction numbers") ||
        err.message.includes("does not support retryable writes") ||
        err.message.includes("replica set") ||
        err.message.includes("IllegalOperation");

      if (!isSessionError) {
        throw err;
      }
    }

    // Fallback if replica sets/transactions are not supported (e.g. standalone MongoDB deployment)
    const note = await this.noteRepo.create(
      { customerId, text: trimmed, branchId },
      organizationId,
      userId
    );

    await this.auditRepo.create(
      {
        branchId,
        action: AUDIT_ACTIONS.NOTE_ADDED,
        entityType: "Customer",
        entityId: customerId,
        description: `Added note: "${trimmed.slice(0, 50)}${trimmed.length > 50 ? "..." : ""}"`,
        metadata: { noteId: note._id },
      },
      organizationId,
      userId
    );

    return note;
  }

  async getNotes(customerId, organizationId, branchId, options = {}) {
    // 1. Verify customer existence and organization ownership
    const CustomerModel = mongoose.model("Customer");
    const customer = await CustomerModel.findOne({ _id: customerId, organizationId });
    if (!customer) {
      throw new AppError("Customer not found", 404);
    }

    // 2. Verify branch visibility scope
    if (branchId) {
      const isHome = customer.homeBranchId?.toString() === branchId.toString();
      const hasVisited = (customer.visitedBranchIds || []).some(
        (bId) => bId.toString() === branchId.toString()
      );
      if (!isHome && !hasVisited) {
        throw new AppError("Access denied. Customer is not visible within your active branch scope.", 403);
      }
    }

    // Force newest first sort
    const findOptions = {
      ...options,
      sort: { createdAt: -1, _id: -1 },
      populate: [{ path: "createdBy", select: "name" }],
    };

    return this.noteRepo.findByCustomer(customerId, organizationId, findOptions);
  }
}
