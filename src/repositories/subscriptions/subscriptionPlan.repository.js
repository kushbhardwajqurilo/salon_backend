import { BaseRepository } from "../../shared/repositories/base.repository.js";
import { SubscriptionPlan } from "../../models/subscriptions/subscriptionPlan.model.js";

export class SubscriptionPlanRepository extends BaseRepository {
  constructor() {
    super(SubscriptionPlan);
  }

  async findByCode(code, organizationId, session = null) {
    let query = this.model.findOne({
      code,
      organizationId,
      isDeleted: false,
    });
    if (session) {
      query = query.session(session);
    }
    return query.exec();
  }
}
