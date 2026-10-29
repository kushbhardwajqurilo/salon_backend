import { BaseRepository } from "../../shared/repositories/base.repository.js";
import { Subscription } from "../../models/subscriptions/subscription.model.js";

export class SubscriptionRepository extends BaseRepository {
  constructor() {
    super(Subscription);
  }

  /**
   * Find active or pending_payment (redeemable) subscription by ID and organization
   */
  async findActiveById(id, organizationId, session = null) {
    let query = this.model.findOne({
      _id: id,
      organizationId,
      status: { $in: ["active", "pending_payment"] },
      isDeleted: false,
    });
    if (session) {
      query = query.session(session);
    }
    return query.exec();
  }

  /**
   * Find subscriptions where customer is either payer or an enrolled member
   */
  async findByCustomerId(customerId, organizationId, options = {}) {
    const filter = {
      organizationId,
      isDeleted: false,
      $or: [
        { customerId },
        { payerCustomerId: customerId },
        { "members.customerId": customerId },
      ],
      ...(options.status ? { status: options.status } : {}),
    };
    return this.model.find(filter).sort({ createdAt: -1 }).exec();
  }

  /**
   * Atomic decrement targeting exact member and exact service entitlement
   * uses synchronized document-level $elemMatch and element-level arrayFilters $[mem] and $[ent]
   */
  async atomicDecrementMemberEntitlement(
    subscriptionId,
    organizationId,
    memberCustomerId,
    serviceId,
    quantity,
    session = null
  ) {
    const query = {
      _id: subscriptionId,
      organizationId,
      status: { $in: ["active", "pending_payment"] },
      isDeleted: false,
      members: {
        $elemMatch: {
          customerId: memberCustomerId,
          status: { $in: ["active", "pending_payment"] },
          entitlements: {
            $elemMatch: {
              serviceId: serviceId,
              remainingQuantity: { $gte: quantity },
            },
          },
        },
      },
    };

    const update = {
      $inc: {
        "members.$[mem].entitlements.$[ent].usedQuantity": quantity,
        "members.$[mem].entitlements.$[ent].remainingQuantity": -quantity,
      },
    };

    const options = {
      arrayFilters: [
        { "mem.customerId": memberCustomerId, "mem.status": { $in: ["active", "pending_payment"] } },
        { "ent.serviceId": serviceId, "ent.remainingQuantity": { $gte: quantity } },
      ],
      new: true,
    };
    if (session) {
      options.session = session;
    }

    return this.model.findOneAndUpdate(query, update, options);
  }

  /**
   * Atomic restore for aborted standalone transactions / compensation
   */
  async atomicRestoreMemberEntitlement(
    subscriptionId,
    organizationId,
    memberCustomerId,
    serviceId,
    quantity,
    session = null
  ) {
    const query = {
      _id: subscriptionId,
      organizationId,
      isDeleted: false,
      "members.customerId": memberCustomerId,
      "members.entitlements.serviceId": serviceId,
    };

    const update = {
      $inc: {
        "members.$[mem].entitlements.$[ent].usedQuantity": -quantity,
        "members.$[mem].entitlements.$[ent].remainingQuantity": quantity,
      },
    };

    const options = {
      arrayFilters: [
        { "mem.customerId": memberCustomerId },
        { "ent.serviceId": serviceId },
      ],
      new: true,
    };
    if (session) {
      options.session = session;
    }

    return this.model.findOneAndUpdate(query, update, options);
  }

  /**
   * Legacy atomic decrement supporting single-customer subscriptions or fallback
   */
  async atomicDecrementEntitlement(
    subscriptionId,
    organizationId,
    serviceId,
    quantity,
    session = null
  ) {
    // Try updating members first if members array exists
    const sub = await this.model.findById(subscriptionId).session(session);
    if (sub && Array.isArray(sub.members) && sub.members.length > 0) {
      const targetMember = sub.members.find((m) =>
        m.entitlements.some(
          (e) => e.serviceId.toString() === serviceId.toString() && e.remainingQuantity >= quantity
        )
      );
      if (targetMember) {
        return this.atomicDecrementMemberEntitlement(
          subscriptionId,
          organizationId,
          targetMember.customerId,
          serviceId,
          quantity,
          session
        );
      }
    }

    // Fallback for legacy documents
    const query = {
      _id: subscriptionId,
      organizationId,
      status: { $in: ["active", "pending_payment"] },
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
