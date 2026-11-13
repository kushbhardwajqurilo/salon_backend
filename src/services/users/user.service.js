import mongoose from "mongoose";
import { runInTransaction } from "../../utils/transaction.js";
import { UserRepository } from "../../repositories/users/user.repository.js";
import { SessionRepository } from "../../repositories/auth/session.repository.js";
import { AppError } from "../../utils/errors.js";

export class UserService {
  constructor(userRepo = null, sessionRepo = null) {
    this.userRepo = userRepo || new UserRepository();
    this.sessionRepo = sessionRepo || new SessionRepository();
  }

  async runTransaction(operation) {
    return await runInTransaction(operation, { requireTransaction: true });
  }

  async updateUserStatus(id, status, organizationId, actorId) {
    return this.runTransaction(async (session) => {
      const user = await this.userRepo.findById(id, organizationId, ["role"], null, session);
      if (!user) {
        throw new AppError("User not found", 404);
      }

      // Owner protection: cannot deactivate or suspend organization owner
      if (user.role && user.role.name === "owner") {
        if (["inactive", "suspended"].includes(status)) {
          throw new AppError("Organization owner cannot be deactivated or suspended.", 400);
        }
      }

      const prevStatus = user.status;

      // Update status
      user.status = status;

      // Handle administrative unlock
      if (prevStatus === "locked" && status === "active") {
        user.failedLoginAttempts = 0;
        user.lockUntil = null;
      }

      await user.save({ session });

      // Session Invalidation
      if (["inactive", "suspended", "locked"].includes(status)) {
        await this.sessionRepo.model.updateMany(
          { user: id, isValid: true },
          { $set: { isValid: false } }
        ).session(session);
      }

      return user;
    });
  }
}
