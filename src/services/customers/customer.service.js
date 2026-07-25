import { CustomerRepository } from "../../repositories/customers/customer.repository.js";
import { AppError } from "../../utils/errors.js";

export class CustomerService {
  constructor(customerRepo = null) {
    this.customerRepo = customerRepo || new CustomerRepository();
  }

  async createCustomer(data, organizationId, userId) {
    const existing = await this.customerRepo.findOne({ phone: data.phone }, organizationId);
    if (existing) {
      throw new AppError("Customer with this phone number already exists", 400);
    }

    const customer = await this.customerRepo.create(data, organizationId, userId);

    await this.customerRepo.addActivity(
      customer._id,
      "CREATED",
      "Customer profile created successfully",
      organizationId,
      userId
    );

    return customer;
  }

  async getCustomerById(id, organizationId) {
    const customer = await this.customerRepo.findById(id, organizationId);
    if (!customer) {
      throw new AppError("Resource not found", 404);
    }
    return customer;
  }

  async updateCustomer(id, data, organizationId, userId) {
    const customer = await this.customerRepo.findById(id, organizationId);
    if (!customer) {
      throw new AppError("Resource not found", 404);
    }

    if (data.phone && data.phone !== customer.phone) {
      const existing = await this.customerRepo.findOne({ phone: data.phone }, organizationId);
      if (existing) {
        throw new AppError("Phone number is already in use by another customer", 400);
      }
    }

    const updated = await this.customerRepo.updateById(id, data, organizationId, userId);

    await this.customerRepo.addActivity(
      id,
      "UPDATED",
      "Customer profile details updated",
      organizationId,
      userId
    );

    return updated;
  }

  async deleteCustomer(id, organizationId, userId) {
    const customer = await this.customerRepo.findById(id, organizationId);
    if (!customer) {
      throw new AppError("Resource not found", 404);
    }

    await this.customerRepo.addActivity(
      id,
      "DELETED",
      "Customer profile soft deleted",
      organizationId,
      userId
    );

    return this.customerRepo.deleteById(id, organizationId, userId);
  }

  async listCustomers(filter = {}, options = {}, organizationId) {
    return this.customerRepo.find(filter, options, organizationId);
  }

  async addNote(id, noteText, organizationId, userId) {
    const customer = await this.customerRepo.findById(id, organizationId);
    if (!customer) {
      throw new AppError("Resource not found", 404);
    }

    const updated = await this.customerRepo.addNote(id, noteText, organizationId, userId);
    await this.customerRepo.addActivity(id, "ADD_NOTE", `Added note: "${noteText}"`, organizationId, userId);
    return updated;
  }

  async updatePreferences(id, preferences, organizationId, userId) {
    const customer = await this.customerRepo.findById(id, organizationId);
    if (!customer) {
      throw new AppError("Resource not found", 404);
    }

    const updated = await this.customerRepo.updatePreferences(id, preferences, organizationId);
    await this.customerRepo.addActivity(id, "UPDATE_PREFERENCES", "Updated customer preferences", organizationId, userId);
    return updated;
  }

  async addVisit(id, visitDetails, organizationId, userId) {
    const customer = await this.customerRepo.findById(id, organizationId);
    if (!customer) {
      throw new AppError("Resource not found", 404);
    }

    const updated = await this.customerRepo.addVisit(id, visitDetails, organizationId);
    await this.customerRepo.addActivity(
      id,
      "VISIT_RECORDED",
      `Visit recorded for appointment ID: ${visitDetails.appointmentId || "N/A"}`,
      organizationId,
      userId
    );
    return updated;
  }

  async addServiceHistory(id, serviceDetails, organizationId, userId) {
    const customer = await this.customerRepo.findById(id, organizationId);
    if (!customer) {
      throw new AppError("Resource not found", 404);
    }

    const updated = await this.customerRepo.addServiceHistory(id, serviceDetails, organizationId);
    await this.customerRepo.addActivity(
      id,
      "SERVICE_COMPLETED",
      `Service completed: ${serviceDetails.serviceName}`,
      organizationId,
      userId
    );
    return updated;
  }

  async addMembershipHistory(id, membershipDetails, organizationId, userId) {
    const customer = await this.customerRepo.findById(id, organizationId);
    if (!customer) {
      throw new AppError("Resource not found", 404);
    }

    const updated = await this.customerRepo.addMembershipHistory(id, membershipDetails, organizationId);
    await this.customerRepo.addActivity(
      id,
      "MEMBERSHIP_ADDED",
      `Subscribed to membership: ${membershipDetails.membershipName}`,
      organizationId,
      userId
    );
    return updated;
  }

  async adjustLoyaltyPoints(id, points, organizationId, userId) {
    const customer = await this.customerRepo.findById(id, organizationId);
    if (!customer) {
      throw new AppError("Resource not found", 404);
    }

    const updated = await this.customerRepo.adjustLoyaltyPoints(id, points, organizationId);
    await this.customerRepo.addActivity(
      id,
      "LOYALTY_ADJUSTED",
      `Adjusted loyalty points by ${points > 0 ? "+" : ""}${points} (Current: ${updated.loyaltyPoints})`,
      organizationId,
      userId
    );
    return updated;
  }
}
