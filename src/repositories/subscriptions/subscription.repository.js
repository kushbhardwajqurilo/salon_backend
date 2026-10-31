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
   * Atomic decrement targeting exact member and exact service entitlement.
   * Uses synchronized document-level $elemMatch and element-level arrayFilters $[mem] and $[ent].
   * Supports durable operation identity via operationId to prevent double decrements across crashes.
   */
  async atomicDecrementMemberEntitlement(
    subscriptionId,
    organizationId,
    memberCustomerId,
    serviceId,
    quantity,
    session = null,
    operationId = null
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

    if (operationId) {
      query.appliedOperations = { $nin: [operationId, `fence:${operationId}`] };
    }

    const update = {
      $inc: {
        "members.$[mem].entitlements.$[ent].usedQuantity": quantity,
        "members.$[mem].entitlements.$[ent].remainingQuantity": -quantity,
        "entitlements.$[legacyEnt].usedQuantity": quantity,
        "entitlements.$[legacyEnt].remainingQuantity": -quantity,
      },
    };

    if (operationId) {
      update.$push = { appliedOperations: operationId };
    }

    const options = {
      arrayFilters: [
        { "mem.customerId": memberCustomerId, "mem.status": { $in: ["active", "pending_payment"] } },
        { "ent.serviceId": serviceId, "ent.remainingQuantity": { $gte: quantity } },
        { "legacyEnt.serviceId": serviceId },
      ],
      returnDocument: "after",
    };
    if (session) {
      options.session = session;
    }

    let result;
    try {
      result = await this.model.findOneAndUpdate(query, update, options);
    } catch (err) {
      delete update.$inc["entitlements.$[legacyEnt].usedQuantity"];
      delete update.$inc["entitlements.$[legacyEnt].remainingQuantity"];
      options.arrayFilters = options.arrayFilters.slice(0, 2);
      result = await this.model.findOneAndUpdate(query, update, options);
    }

    return result;
  }

  /**
   * Atomic restore for aborted standalone transactions / compensation.
   * Supports durable restoration identity via restoreOperationId to enforce strict idempotency.
   */
  async atomicRestoreMemberEntitlement(
    subscriptionId,
    organizationId,
    memberCustomerId,
    serviceId,
    quantity,
    session = null,
    restoreOperationId = null
  ) {
    const query = {
      _id: subscriptionId,
      organizationId,
      isDeleted: false,
      "members.customerId": memberCustomerId,
      "members.entitlements.serviceId": serviceId,
    };

    if (restoreOperationId) {
      query.appliedOperations = { $ne: restoreOperationId };
    }

    const update = {
      $inc: {
        "members.$[mem].entitlements.$[ent].usedQuantity": -quantity,
        "members.$[mem].entitlements.$[ent].remainingQuantity": quantity,
        "entitlements.$[legacyEnt].usedQuantity": -quantity,
        "entitlements.$[legacyEnt].remainingQuantity": quantity,
      },
    };

    if (restoreOperationId) {
      update.$push = { appliedOperations: restoreOperationId };
    }

    const options = {
      arrayFilters: [
        { "mem.customerId": memberCustomerId },
        { "ent.serviceId": serviceId },
        { "legacyEnt.serviceId": serviceId },
      ],
      returnDocument: "after",
    };
    if (session) {
      options.session = session;
    }

    let result;
    try {
      result = await this.model.findOneAndUpdate(query, update, options);
    } catch (err) {
      delete update.$inc["entitlements.$[legacyEnt].usedQuantity"];
      delete update.$inc["entitlements.$[legacyEnt].remainingQuantity"];
      options.arrayFilters = options.arrayFilters.slice(0, 2);
      result = await this.model.findOneAndUpdate(query, update, options);
    }

    return result;
  }

  /**
   * Legacy atomic decrement supporting single-customer subscriptions or fallback
   */
  async atomicDecrementEntitlement(
    subscriptionId,
    organizationId,
    serviceId,
    quantity,
    session = null,
    operationId = null
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
          session,
          operationId
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

    if (operationId) {
      query.appliedOperations = { $nin: [operationId, `fence:${operationId}`] };
    }

    const update = {
      $inc: {
        "entitlements.$.usedQuantity": quantity,
        "entitlements.$.remainingQuantity": -quantity,
      },
    };

    if (operationId) {
      update.$push = { appliedOperations: operationId };
    }

    const options = { returnDocument: "after" };
    if (session) {
      options.session = session;
    }

    return this.model.findOneAndUpdate(query, update, options);
  }

  /**
   * Verifies if a durable operation identity was already applied on this subscription
   */
  async hasOperation(subscriptionId, operationId) {
    if (!operationId) return false;
    return !!(await this.model.exists({ _id: subscriptionId, appliedOperations: operationId }));
  }

  /**
   * Fences an operation ID on a Subscription to prevent in-flight or delayed
   * workers from executing this operation after reconciliation classified it as unapplied.
   */
  async fenceOperation(subscriptionId, operationId) {
    if (!operationId) return null;
    const fenceKey = `fence:${operationId}`;
    return this.model.updateOne(
      { _id: subscriptionId, appliedOperations: { $nin: [operationId, fenceKey] } },
      { $addToSet: { appliedOperations: fenceKey } }
    );
  }

  /**
   * Safely prunes archived operation IDs from appliedOperations once all retries,
   * challenges, and reconciliation windows have fully elapsed.
   */
  async pruneArchivedOperations(subscriptionId, operationIds) {
    if (!Array.isArray(operationIds) || operationIds.length === 0) return null;
    return this.model.findByIdAndUpdate(
      subscriptionId,
      {
        $pull: { appliedOperations: { $in: operationIds } },
        $inc: { archivedOperationsCount: operationIds.length },
      },
      { returnDocument: "after" }
    );
  }
}
