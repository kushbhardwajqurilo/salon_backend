import { BaseRepository } from "../../shared/repositories/base.repository.js";
import { BranchSettings } from "../../models/settings/branchSettings.model.js";

export class BranchSettingsRepository extends BaseRepository {
  constructor() {
    super(BranchSettings);
  }

  async findByBranch(organizationId, branchId, session = null) {
    let query = this.model.findOne({ organizationId, branchId });
    if (session) query = query.session(session);
    return query.exec();
  }

  async upsertByBranch(organizationId, branchId, updateData, userId = null, session = null) {
    const payload = { ...updateData };
    if (userId) payload.updatedBy = userId;
    return this.model.findOneAndUpdate(
      { organizationId, branchId },
      { $set: payload, $setOnInsert: { organizationId, branchId } },
      { returnDocument: 'after', upsert: true, runValidators: true, setDefaultsOnInsert: true, session }
    );
  }
}
