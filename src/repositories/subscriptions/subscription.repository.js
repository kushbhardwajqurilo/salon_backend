import { BaseRepository } from "../../shared/repositories/base.repository.js";
import { Subscription } from "../../models/subscriptions/subscription.model.js";

export class SubscriptionRepository extends BaseRepository {
  constructor() {
    super(Subscription);
  }

  /**
   * Find active subscription by ID and organization
   */
  async findActiveById(id, organizationId, session = null) {
    let query = this.model.findOne({
      _id: id,
      organizationId,
      status: "active",
      isDeleted: false,
    });
    if (session) {
      query = query.session(session);
    }
    return query.exec();
  }

  /**
   * Find subscriptions by customer
   */
  async findByCustomerId(customerId, organizationId, options = {}) {
    const filter = {
      customerId,
      organizationId,
      isDeleted: false,
      ...(options.status ? { status: options.status } : {}),
    };
    return this.model.find(filter).sort({ createdAt: -1 }).exec();
  }

  /**
   * Atomic decrement of an entitlement balance with concurrency guard ($gte)
   * Prevents race conditions and double-spending
   */
  async atomicDecrementEntitlement(
    subscriptionId,
    organizationId,
    serviceId,
    quantity,
    session = null
  ) {
    const query = {
      _id: subscriptionId,
      organizationId,
      status: "active",
      isDeleted: false,
      entitlements: {
        $elemMatch: {
          serviceId: serviceId,
          remainingQuantity: { $gte: quantity },
        },
      },
    };

    const update = {
      $inc: {
        "entitlements.$.usedQuantity": quantity,
        "entitlements.$.remainingQuantity": -quantity,
      },
    };

    const options = { new: true };
    if (session) {
      options.session = session;
    }

    return this.model.findOneAndUpdate(query, update, options);
  }
}
