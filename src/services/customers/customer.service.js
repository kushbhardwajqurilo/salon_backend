import mongoose from "mongoose";
import { CustomerRepository } from "../../repositories/customers/customer.repository.js";
import { AppError } from "../../utils/errors.js";

export class CustomerService {
  constructor(customerRepo = null) {
    this.customerRepo = customerRepo || new CustomerRepository();
  }

  async createCustomer(data, organizationId, userId) {
    // Phone uniqueness check is deferred per business decision: DO NOT reject duplicate phone numbers.
    // Ensure homeBranchId is set and is valid
    if (!data.homeBranchId) {
      throw new AppError("homeBranchId is required to create a customer.", 400);
    }

    const customer = await this.customerRepo.create(
      {
        name: data.name,
        email: data.email || null,
        phone: data.phone,
        homeBranchId: data.homeBranchId,
        visitedBranchIds: [],
        gender: data.gender,
        dateOfBirth: data.dateOfBirth,
        address: data.address,
        preferences: data.preferences || {},
      },
      organizationId,
      userId
    );

    await this.customerRepo.addActivity(
      customer._id,
      "CREATED",
      "Customer profile created successfully",
      organizationId,
      userId
    );

    return customer;
  }

  async getCustomerById(id, organizationId, userContext = null, activeBranchId = null) {
    const customer = await this.customerRepo.findById(id, organizationId);
    if (!customer) {
      throw new AppError("Resource not found", 404);
    }

    // Strict visibility check for branch-scoped requests
    if (activeBranchId) {
      const isHomeBranch = customer.homeBranchId?.toString() === activeBranchId.toString();
      const hasVisited = (customer.visitedBranchIds || []).some(
        (bId) => bId.toString() === activeBranchId.toString()
      );

      if (!isHomeBranch && !hasVisited) {
        throw new AppError("Access denied. Customer is not visible within your active branch scope.", 403);
      }
    }

    return customer;
  }

  async updateCustomer(id, data, organizationId, userId, userContext = null, activeBranchId = null) {
    // Fetch and check visibility first
    const customer = await this.getCustomerById(id, organizationId, userContext, activeBranchId);

    // Filter out immutable fields
    const { organizationId: _, homeBranchId: __, visitedBranchIds: ___, isDeleted: ____, deletedAt: _____, ...updateData } = data;

    const updated = await this.customerRepo.updateById(id, updateData, organizationId, userId);

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

    // Soft delete via global plugin
    return this.customerRepo.deleteById(id, organizationId, userId);
  }

  async listCustomers(filter = {}, options = {}, organizationId) {
    return this.customerRepo.find(filter, options, organizationId);
  }

  async addNote(id, noteText, organizationId, userId, userContext = null, activeBranchId = null) {
    // Check visibility first
    await this.getCustomerById(id, organizationId, userContext, activeBranchId);

    const updated = await this.customerRepo.addNote(id, noteText, organizationId, userId);
    await this.customerRepo.addActivity(id, "ADD_NOTE", `Added note: "${noteText}"`, organizationId, userId);
    return updated;
  }
}
