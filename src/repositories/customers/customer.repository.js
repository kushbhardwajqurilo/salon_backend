import { BaseRepository } from "../../shared/repositories/base.repository.js";
import { Customer } from "../../models/customers/customer.model.js";

export class CustomerRepository extends BaseRepository {
  constructor() {
    super(Customer);
  }

  async findByIdAndBranches(id, allowedBranches = [], bypass = false) {
    const filter = { _id: id };
    if (!bypass && allowedBranches.length > 0) {
      filter.branchId = { $in: allowedBranches };
    }
    return this.findOne(filter);
  }

  async findByPhoneAndBranches(phone, allowedBranches = [], bypass = false) {
    const filter = { phone };
    if (!bypass && allowedBranches.length > 0) {
      filter.branchId = { $in: allowedBranches };
    }
    return this.findOne(filter);
  }

  async addNote(id, noteText, userId) {
    return this.model.findByIdAndUpdate(
      id,
      {
        $push: { notes: { text: noteText, createdBy: userId } },
      },
      { new: true }
    );
  }

  async updatePreferences(id, preferences) {
    return this.model.findByIdAndUpdate(
      id,
      {
        $set: { preferences },
      },
      { new: true }
    );
  }

  async addActivity(id, action, description, userId) {
    return this.model.findByIdAndUpdate(
      id,
      {
        $push: {
          activityTimeline: {
            action,
            description,
            performedBy: userId,
            date: new Date(),
          },
        },
      },
      { new: true }
    );
  }

  async addVisit(id, visitDetails) {
    return this.model.findByIdAndUpdate(
      id,
      {
        $push: { visits: visitDetails },
      },
      { new: true }
    );
  }

  async addServiceHistory(id, serviceDetails) {
    return this.model.findByIdAndUpdate(
      id,
      {
        $push: { services: serviceDetails },
      },
      { new: true }
    );
  }

  async addMembershipHistory(id, membershipDetails) {
    return this.model.findByIdAndUpdate(
      id,
      {
        $push: { memberships: membershipDetails },
      },
      { new: true }
    );
  }

  async adjustLoyaltyPoints(id, points) {
    return this.model.findByIdAndUpdate(
      id,
      {
        $inc: { loyaltyPoints: points },
      },
      { new: true }
    );
  }
}
