import mongoose from "mongoose";
import { CustomerRepository } from "../../repositories/customers/customer.repository.js";
import { AuditLogRepository } from "../../repositories/audit/auditLog.repository.js";
import { AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";
import { AppError } from "../../utils/errors.js";
import { normalizePhone } from "../../utils/phone.js";

export class CustomerService {
  constructor(customerRepo = null, auditRepo = null) {
    this.customerRepo = customerRepo || new CustomerRepository();
    this.auditRepo = auditRepo || new AuditLogRepository();
  }

  async createCustomer(data, organizationId, userId) {
    // 1. Normalize phones
    if (data.phone) {
      data.phone = normalizePhone(data.phone);
    }
    if (data.alternatePhone) {
      data.alternatePhone = normalizePhone(data.alternatePhone);
    }

    // 2. Duplicate checking
    const existing = await this.customerRepo.findByPhone(data.phone, organizationId, true);
    if (existing) {
      if (existing.isDeleted) {
        // Soft-deleted customer -> reactivate instead of duplicate
        return this.reactivateCustomer(existing._id, organizationId, userId, null, data.homeBranchId);
      }
      if (existing.status === "inactive" || existing.status === "blocked") {
        return existing;
      }
      throw new AppError("A customer with this phone number already exists.", 400);
    }

    // 3. Validate homeBranchId and visitedBranchIds
    const BranchModel = mongoose.model("Branch");
    if (!data.homeBranchId) {
      throw new AppError("homeBranchId is required to create a customer.", 400);
    }
    const homeBranch = await BranchModel.findOne({ _id: data.homeBranchId, organizationId, isActive: true });
    if (!homeBranch) {
      throw new AppError("homeBranchId does not exist or does not belong to this organization.", 400);
    }

    if (data.visitedBranchIds && data.visitedBranchIds.length > 0) {
      const uniqueVisitedIds = [...new Set(data.visitedBranchIds.map(id => id.toString()))];
      const branches = await BranchModel.find({
        _id: { $in: uniqueVisitedIds },
        organizationId,
        isActive: true
      });
      if (branches.length !== uniqueVisitedIds.length) {
        throw new AppError("One or more visitedBranchIds do not exist or do not belong to this organization.", 400);
      }
      data.visitedBranchIds = uniqueVisitedIds;
    }

    // 4. Automatically add homeBranchId to visitedBranchIds for first interaction tracking
    if (!data.visitedBranchIds) {
      data.visitedBranchIds = [];
    }
    if (!data.visitedBranchIds.map(id => id.toString()).includes(data.homeBranchId.toString())) {
      data.visitedBranchIds.push(data.homeBranchId);
    }

    // 5. Validate referenced users/staff belong to same organization
    if (data.preferences?.preferredStaff && data.preferences.preferredStaff.length > 0) {
      const UserModel = mongoose.model("User");
      const staffIds = [...new Set(data.preferences.preferredStaff.map(id => id.toString()))];
      const staff = await UserModel.find({
        _id: { $in: staffIds },
        organizationId
      });
      if (staff.length !== staffIds.length) {
        throw new AppError("One or more preferredStaff do not exist or do not belong to this organization.", 400);
      }
    }

    // 6. Validate referenced preferredServices belong to same organization
    if (mongoose.models.Service && data.preferences?.preferredServices && data.preferences.preferredServices.length > 0) {
      const serviceIds = [...new Set(data.preferences.preferredServices.map(id => id.toString()))];
      const services = await mongoose.model("Service").find({
        _id: { $in: serviceIds },
        organizationId
      });
      if (services.length !== serviceIds.length) {
        throw new AppError("One or more preferredServices do not exist or do not belong to this organization.", 400);
      }
    }

    // 7. Validate referenced referredByCustomerId
    if (data.referredByCustomerId) {
      const referrer = await this.customerRepo.findById(data.referredByCustomerId, organizationId);
      if (!referrer) {
        throw new AppError("Referrer customer not found in the same organization.", 400);
      }
    }

    // 8. Validate referenced tags if model exists
    if (mongoose.models.Tag && data.tags && data.tags.length > 0) {
      const tagIds = [...new Set(data.tags.map(id => id.toString()))];
      const tags = await mongoose.model("Tag").find({
        _id: { $in: tagIds },
        organizationId
      });
      if (tags.length !== tagIds.length) {
        throw new AppError("One or more tags do not exist or do not belong to this organization.", 400);
      }
    }

    const customer = await this.customerRepo.create(
      {
        name: data.name,
        email: data.email || null,
        phone: data.phone,
        homeBranchId: data.homeBranchId,
        visitedBranchIds: data.visitedBranchIds,
        gender: data.gender,
        dateOfBirth: data.dateOfBirth,
        alternatePhone: data.alternatePhone,
        address: data.address || {},
        preferences: data.preferences || {},
        marketingPreferences: data.marketingPreferences || {},
        doNotContact: data.doNotContact || false,
        acquisitionSource: data.acquisitionSource || "walk_in",
        referredByCustomerId: data.referredByCustomerId || null,
        tags: data.tags || [],
        allergies: data.allergies || [],
        sensitivities: data.sensitivities || [],
        status: data.status || "active",
      },
      organizationId,
      userId
    );

    // Create Audit Log
    await this.auditRepo.create(
      {
        branchId: data.homeBranchId,
        action: AUDIT_ACTIONS.CUSTOMER_CREATED,
        entityType: "Customer",
        entityId: customer._id,
        description: "Customer profile created successfully",
        metadata: { customerName: customer.name },
      },
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

    // If customer is deactivated (inactive/blocked), block edits unless it is a reactivation
    if (customer.status !== "active" && data.status !== "active") {
      throw new AppError("Cannot perform operations on a deactivated customer profile.", 400);
    }

    // Filter out immutable fields
    const { organizationId: _, homeBranchId: __, visitedBranchIds: ___, isDeleted: ____, deletedAt: _______, ...updateData } = data;

    // 1. Phone normalization & duplicate checks
    if (updateData.phone) {
      updateData.phone = normalizePhone(updateData.phone);
      const existing = await this.customerRepo.findByPhone(updateData.phone, organizationId, true);
      if (existing && existing._id.toString() !== id) {
        throw new AppError("A customer with this phone number already exists.", 400);
      }
    }
    if (updateData.alternatePhone) {
      updateData.alternatePhone = normalizePhone(updateData.alternatePhone);
    }

    // 2. Validate referral ID
    if (updateData.referredByCustomerId) {
      if (updateData.referredByCustomerId.toString() === id) {
        throw new AppError("A customer cannot refer themselves.", 400);
      }
      const referrer = await this.customerRepo.findById(updateData.referredByCustomerId, organizationId);
      if (!referrer) {
        throw new AppError("Referrer customer not found in the same organization.", 400);
      }
    }

    // 3. Handle homeBranchId transition directly on the customer document
    let recordedTransition = false;
    if (data.homeBranchId && mongoose.Types.ObjectId.isValid(data.homeBranchId) && data.homeBranchId.toString() !== customer.homeBranchId.toString()) {
      const BranchModel = mongoose.model("Branch");
      const homeBranch = await BranchModel.findOne({ _id: data.homeBranchId, organizationId, isActive: true });
      if (!homeBranch) {
        throw new AppError("homeBranchId does not exist or does not belong to this organization.", 400);
      }

      // Record transition activity
      await this.auditRepo.create(
        {
          branchId: activeBranchId || customer.homeBranchId,
          action: AUDIT_ACTIONS.CUSTOMER_UPDATED,
          entityType: "Customer",
          entityId: id,
          description: `Home branch changed from ${customer.homeBranchId} to ${data.homeBranchId}`,
          metadata: { fromBranchId: customer.homeBranchId, toBranchId: data.homeBranchId },
        },
        organizationId,
        userId
      );
      recordedTransition = true;

      // Add old branch to visitedBranchIds directly on document if not already there
      if (!customer.visitedBranchIds.map(b => b.toString()).includes(customer.homeBranchId.toString())) {
        customer.visitedBranchIds.push(customer.homeBranchId);
      }
      customer.homeBranchId = data.homeBranchId;
      await customer.save();
    }

    // 4. Validate referenced users/staff belong to same organization
    if (updateData.preferences?.preferredStaff && updateData.preferences.preferredStaff.length > 0) {
      const UserModel = mongoose.model("User");
      const staffIds = [...new Set(updateData.preferences.preferredStaff.map(id => id.toString()))];
      const staff = await UserModel.find({
        _id: { $in: staffIds },
        organizationId
      });
      if (staff.length !== staffIds.length) {
        throw new AppError("One or more preferredStaff do not exist or do not belong to this organization.", 400);
      }
    }

    // 5. Validate referenced preferredServices belong to same organization
    if (mongoose.models.Service && updateData.preferences?.preferredServices && updateData.preferences.preferredServices.length > 0) {
      const serviceIds = [...new Set(updateData.preferences.preferredServices.map(id => id.toString()))];
      const services = await mongoose.model("Service").find({
        _id: { $in: serviceIds },
        organizationId
      });
      if (services.length !== serviceIds.length) {
        throw new AppError("One or more preferredServices do not exist or do not belong to this organization.", 400);
      }
    }

    // 6. Validate referenced tags if model exists
    if (mongoose.models.Tag && updateData.tags && updateData.tags.length > 0) {
      const tagIds = [...new Set(updateData.tags.map(id => id.toString()))];
      const tags = await mongoose.model("Tag").find({
        _id: { $in: tagIds },
        organizationId
      });
      if (tags.length !== tagIds.length) {
        throw new AppError("One or more tags do not exist or do not belong to this organization.", 400);
      }
    }

    const updated = await this.customerRepo.updateById(id, updateData, organizationId, userId);

    // Determine audit action and log it
    let action = AUDIT_ACTIONS.CUSTOMER_UPDATED;
    let actionDescription = "Customer profile details updated";

    if (data.status && customer.status !== data.status) {
      if (data.status === "active") {
        action = AUDIT_ACTIONS.CUSTOMER_REACTIVATED;
        actionDescription = "Customer profile activated";
      } else {
        action = AUDIT_ACTIONS.CUSTOMER_DEACTIVATED;
        actionDescription = `Customer profile deactivated (status: ${data.status})`;
      }
    }

    if (!recordedTransition || action !== AUDIT_ACTIONS.CUSTOMER_UPDATED) {
      await this.auditRepo.create(
        {
          branchId: activeBranchId || customer.homeBranchId,
          action,
          entityType: "Customer",
          entityId: id,
          description: actionDescription,
        },
        organizationId,
        userId
      );
    }

    return updated;
  }

  async deleteCustomer(id, organizationId, userId, activeBranchId = null) {
    const customer = await this.customerRepo.findById(id, organizationId);
    if (!customer) {
      throw new AppError("Resource not found", 404);
    }

    await this.auditRepo.create(
      {
        branchId: activeBranchId || customer.homeBranchId,
        action: AUDIT_ACTIONS.CUSTOMER_DELETED,
        entityType: "Customer",
        entityId: id,
        description: "Customer profile soft deleted",
      },
      organizationId,
      userId
    );

    return this.customerRepo.deleteById(id, organizationId, userId);
  }

  async customerStatusChangeById(id, organizationId, userId, activeBranchId = null) {
    const customer = await this.customerRepo.findById(id, organizationId);
    if (!customer) {
      throw new AppError("Resource not found", 404);
    }

    const updated = await this.customerRepo.statusUpdateById(id, organizationId);

    const isReactivated = updated.status === "active";
    await this.auditRepo.create(
      {
        branchId: activeBranchId || customer.homeBranchId,
        action: isReactivated ? AUDIT_ACTIONS.CUSTOMER_REACTIVATED : AUDIT_ACTIONS.CUSTOMER_DEACTIVATED,
        entityType: "Customer",
        entityId: id,
        description: `Customer profile status updated to ${updated.status}`,
      },
      organizationId,
      userId
    );

    return updated;
  }

  async listCustomers(filter = {}, options = {}, organizationId) {
    return this.customerRepo.find(filter, options, organizationId);
  }

  async reactivateCustomer(id, organizationId, userId, userContext = null, activeBranchId = null) {
    const customer = await this.customerRepo.findByIdIncludeDeleted(id, organizationId);
    if (!customer) {
      throw new AppError("Resource not found", 404);
    }

    // Branch visibility scope check if activeBranchId is passed
    if (activeBranchId) {
      const isHomeBranch = customer.homeBranchId?.toString() === activeBranchId.toString();
      const hasVisited = (customer.visitedBranchIds || []).some(
        (bId) => bId.toString() === activeBranchId.toString()
      );
      if (!isHomeBranch && !hasVisited) {
        throw new AppError("Access denied. Customer is not visible within your active branch scope.", 403);
      }
    }

    const reactivated = await this.customerRepo.reactivateById(id, organizationId, userId);

    await this.auditRepo.create(
      {
        branchId: activeBranchId || customer.homeBranchId,
        action: AUDIT_ACTIONS.CUSTOMER_REACTIVATED,
        entityType: "Customer",
        entityId: id,
        description: "Customer profile reactivated successfully",
      },
      organizationId,
      userId
    );

    return reactivated;
  }
}
