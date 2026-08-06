import mongoose from "mongoose";
import { UserRepository } from "../../repositories/users/user.repository.js";
import { SessionRepository } from "../../repositories/auth/session.repository.js";
import { AppError } from "../../utils/errors.js";

export class UserService {
  constructor(userRepo = null, sessionRepo = null) {
    this.userRepo = userRepo || new UserRepository();
    this.sessionRepo = sessionRepo || new SessionRepository();
  }

  async runTransaction(operation) {
    let session = null;
    if (mongoose.connection.db && typeof mongoose.connection.startSession === "function") {
      try {
        session = await mongoose.connection.startSession();
        session.startTransaction();
        const result = await operation(session);
        await session.commitTransaction();
        session.endSession();
        return result;
      } catch (error) {
        if (session) {
          await session.abortTransaction();
          session.endSession();
        }
        throw error;
      }
    }
    return operation(null);
  }

  async updateUserStatus(id, status, organizationId, actorId) {
    return this.runTransaction(async (session) => {
      const user = await this.userRepo.findById(id, organizationId);
      if (!user) {
        throw new AppError("User not found", 404);
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
