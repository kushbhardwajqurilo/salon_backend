import crypto from "crypto";
import { BaseRepository } from "../../shared/repositories/base.repository.js";
import { Session } from "../../models/auth/session.model.js";

export class SessionRepository extends BaseRepository {
  constructor() {
    super(Session);
  }

  async findByToken(token) {
    const hashed = crypto.createHash("sha256").update(token).digest("hex");
    return this.model.findOne({ refreshToken: hashed, isValid: true }).populate({
      path: "user",
      populate: { path: "role" },
    });
  }

  async invalidateAllUserSessions(userId) {
    return this.model.updateMany({ user: userId, isValid: true }, { isValid: false });
  }

  async invalidateSession(token) {
    const hashed = crypto.createHash("sha256").update(token).digest("hex");
    return this.model.updateOne({ refreshToken: hashed }, { isValid: false });
  }
}

