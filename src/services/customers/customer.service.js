import { CustomerRepository } from "../../repositories/customers/customer.repository.js";
import { AppError } from "../../utils/errors.js";

export class CustomerService {
  constructor(customerRepo = null) {
    this.customerRepo = customerRepo || new CustomerRepository();
  }

  async verifyBranchAccess(customer, allowedBranches, bypass) {
    if (!customer) {
      throw new AppError("Customer not found", 404);
    }
    if (!bypass && allowedBranches.length > 0) {
      const hasAccess = allowedBranches.some(
        (b) => b.toString() === customer.branchId.toString()
      );
      if (!hasAccess) {
        throw new AppError("Access denied to customer's branch profile", 403);
      }
    }
  }

  async createCustomer(data, userId) {
    const existing = await this.customerRepo.findOne({ phone: data.phone });
    if (existing) {
      throw new AppError("Customer with this phone number already exists", 400);
    }

    const customer = await this.customerRepo.create(data, userId);

    await this.customerRepo.addActivity(
      customer._id,
      "CREATED",
      "Customer profile created successfully",
      userId
    );

    return customer;
  }

  async getCustomerById(id, allowedBranches = [], bypass = false) {
    const customer = await this.customerRepo.findById(id);
    await this.verifyBranchAccess(customer, allowedBranches, bypass);
    return customer;
  }

  async updateCustomer(id, data, allowedBranches = [], bypass = false, userId) {
    const customer = await this.customerRepo.findById(id);
    await this.verifyBranchAccess(customer, allowedBranches, bypass);

    if (data.phone && data.phone !== customer.phone) {
      const existing = await this.customerRepo.findOne({ phone: data.phone });
      if (existing) {
        throw new AppError("Phone number is already in use by another customer", 400);
      }
    }

    const updated = await this.customerRepo.updateById(id, data, userId);

    await this.customerRepo.addActivity(
      id,
      "UPDATED",
      "Customer profile details updated",
      userId
    );

    return updated;
  }

  async deleteCustomer(id, allowedBranches = [], bypass = false, userId) {
    const customer = await this.customerRepo.findById(id);
    await this.verifyBranchAccess(customer, allowedBranches, bypass);

    await this.customerRepo.addActivity(
      id,
      "DELETED",
      "Customer profile soft deleted",
      userId
    );

    return this.customerRepo.deleteById(id, userId);
  }

  async listCustomers(filter = {}, options = {}, allowedBranches = [], bypass = false) {
    const queryFilter = { ...filter };
    if (!bypass && allowedBranches.length > 0) {
      queryFilter.branchId = { $in: allowedBranches };
    }
    return this.customerRepo.find(queryFilter, options);
  }

  async addNote(id, noteText, allowedBranches = [], bypass = false, userId) {
    const customer = await this.customerRepo.findById(id);
    await this.verifyBranchAccess(customer, allowedBranches, bypass);

    const updated = await this.customerRepo.addNote(id, noteText, userId);
    await this.customerRepo.addActivity(id, "ADD_NOTE", `Added note: "${noteText}"`, userId);
    return updated;
  }

  async updatePreferences(id, preferences, allowedBranches = [], bypass = false, userId) {
    const customer = await this.customerRepo.findById(id);
    await this.verifyBranchAccess(customer, allowedBranches, bypass);

    const updated = await this.customerRepo.updatePreferences(id, preferences);
    await this.customerRepo.addActivity(id, "UPDATE_PREFERENCES", "Updated customer preferences", userId);
    return updated;
  }

  async addVisit(id, visitDetails, allowedBranches = [], bypass = false, userId) {
    const customer = await this.customerRepo.findById(id);
    await this.verifyBranchAccess(customer, allowedBranches, bypass);

    const updated = await this.customerRepo.addVisit(id, visitDetails);
    await this.customerRepo.addActivity(
      id,
      "VISIT_RECORDED",
      `Visit recorded for appointment ID: ${visitDetails.appointmentId || "N/A"}`,
      userId
    );
    return updated;
  }

  async addServiceHistory(id, serviceDetails, allowedBranches = [], bypass = false, userId) {
    const customer = await this.customerRepo.findById(id);
    await this.verifyBranchAccess(customer, allowedBranches, bypass);

    const updated = await this.customerRepo.addServiceHistory(id, serviceDetails);
    await this.customerRepo.addActivity(
      id,
      "SERVICE_COMPLETED",
      `Service completed: ${serviceDetails.serviceName}`,
      userId
    );
    return updated;
  }

  async addMembershipHistory(id, membershipDetails, allowedBranches = [], bypass = false, userId) {
    const customer = await this.customerRepo.findById(id);
    await this.verifyBranchAccess(customer, allowedBranches, bypass);

    const updated = await this.customerRepo.addMembershipHistory(id, membershipDetails);
    await this.customerRepo.addActivity(
      id,
      "MEMBERSHIP_ADDED",
      `Subscribed to membership: ${membershipDetails.membershipName}`,
      userId
    );
    return updated;
  }

  async adjustLoyaltyPoints(id, points, allowedBranches = [], bypass = false, userId) {
    const customer = await this.customerRepo.findById(id);
    await this.verifyBranchAccess(customer, allowedBranches, bypass);

    const updated = await this.customerRepo.adjustLoyaltyPoints(id, points);
    await this.customerRepo.addActivity(
      id,
      "LOYALTY_ADJUSTED",
      `Adjusted loyalty points by ${points > 0 ? "+" : ""}${points} (Current: ${updated.loyaltyPoints})`,
      userId
    );
    return updated;
  }
}
