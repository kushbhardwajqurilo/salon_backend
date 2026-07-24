import { BaseRepository } from "../../shared/repositories/base.repository.js";
import { Session } from "../../models/auth/session.model.js";

export class SessionRepository extends BaseRepository {
  constructor() {
    super(Session);
  }

  async findByToken(token) {
    return this.model.findOne({ refreshToken: token, isValid: true }).populate({
      path: "user",
      populate: { path: "role" },
    });
  }

  async invalidateAllUserSessions(userId) {
    return this.model.updateMany({ user: userId, isValid: true }, { isValid: false });
  }

  async invalidateSession(token) {
    return this.model.updateOne({ refreshToken: token }, { isValid: false });
  }
}
