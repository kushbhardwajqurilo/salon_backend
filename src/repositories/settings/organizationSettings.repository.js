import { BaseRepository } from "../../shared/repositories/base.repository.js";
import { OrganizationSettings } from "../../models/settings/organizationSettings.model.js";

export class OrganizationSettingsRepository extends BaseRepository {
  constructor() {
    super(OrganizationSettings);
  }

  async findByOrganizationId(organizationId, session = null) {
    let query = this.model.findOne({ organizationId });
    if (session) query = query.session(session);
    return query.exec();
  }

  async upsertByOrganizationId(organizationId, updateData, userId = null, session = null) {
    const payload = { ...updateData };
    if (userId) payload.updatedBy = userId;
    return this.model.findOneAndUpdate(
      { organizationId },
      { $set: payload, $setOnInsert: { organizationId } },
      { returnDocument: 'after', upsert: true, runValidators: true, setDefaultsOnInsert: true, session }
    );
  }
}
