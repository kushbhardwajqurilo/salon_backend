import { BaseRepository } from "../../shared/repositories/base.repository.js";
import { SubscriptionUsage } from "../../models/subscriptions/subscriptionUsage.model.js";

export class SubscriptionUsageRepository extends BaseRepository {
  constructor() {
    super(SubscriptionUsage);
  }

  /**
   * Find usage history for a subscription
   */
  async findBySubscriptionId(subscriptionId, organizationId, options = {}) {
    const filter = {
      subscriptionId,
      organizationId,
      isDeleted: false,
    };
    return this.model
      .find(filter)
      .populate("serviceId", "name code")
      .populate("branchId", "name")
      .populate("verifiedBy", "name")
      .sort({ createdAt: -1 })
      .exec();
  }

  /**
   * Find usage history for a customer
   */
  async findByCustomerId(customerId, organizationId, options = {}) {
    const filter = {
      customerId,
      organizationId,
      isDeleted: false,
    };
    return this.model
      .find(filter)
      .populate("subscriptionId", "subscriptionCode")
      .populate("serviceId", "name code")
      .populate("branchId", "name")
      .sort({ createdAt: -1 })
      .exec();
  }
}
