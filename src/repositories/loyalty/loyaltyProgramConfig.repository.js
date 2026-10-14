import { BaseRepository } from "../../shared/repositories/base.repository.js";
import { LoyaltyProgramConfig } from "../../models/loyalty/loyaltyProgramConfig.model.js";

export class LoyaltyProgramConfigRepository extends BaseRepository {
  constructor() {
    super(LoyaltyProgramConfig);
  }

  /**
   * Find configuration for organization or return null.
   */
  async findByOrganizationId(organizationId, session = null) {
    const query = this.model.findOne({ organizationId });
    if (session) {
      query.session(session);
    }
    return await query.exec();
  }

  /**
   * Upsert program configuration safely.
   */
  async upsertConfig(organizationId, data, userId = null, session = null) {
    const updateData = { ...data, organizationId };
    if (userId) {
      updateData.updatedBy = userId;
    }

    const options = {
      new: true,
      upsert: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    };
    if (session) {
      options.session = session;
    }

    return await this.model.findOneAndUpdate(
      { organizationId },
      { $set: updateData },
      options
    );
  }
}

export const loyaltyProgramConfigRepository = new LoyaltyProgramConfigRepository();
