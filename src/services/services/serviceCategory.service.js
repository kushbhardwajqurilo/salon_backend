import mongoose from "mongoose";
import { ServiceCategoryRepository } from "../../repositories/services/serviceCategory.repository.js";
import { AuditLogRepository } from "../../repositories/audit/auditLog.repository.js";
import { AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";
import { AppError } from "../../utils/errors.js";

export class ServiceCategoryService {
  constructor(categoryRepo = null, auditRepo = null) {
    this.categoryRepo = categoryRepo || new ServiceCategoryRepository();
    this.auditRepo = auditRepo || new AuditLogRepository();
  }

  async createCategory(data, organizationId, userId) {
    // Validate branchId existence and active status
    const BranchModel = mongoose.model("Branch");
    const branch = await BranchModel.findOne({ _id: data.branchId, organizationId, isActive: true });
    if (!branch) {
      throw new AppError("branchId does not exist or does not belong to this organization.", 400);
    }

    // Duplicate check in the same branch
    const duplicate = await this.categoryRepo.findOne(
      {
        name: { $regex: new RegExp("^" + data.name.trim() + "$", "i") },
        branchId: data.branchId,
        isDeleted: false,
      },
      organizationId
    );
    if (duplicate) {
      throw new AppError("A category with this name already exists in this branch.", 400);
    }

    const category = await this.categoryRepo.create(
      {
        name: data.name.trim(),
        description: data.description || "",
        displayOrder: data.displayOrder || 0,
        branchId: data.branchId,
        status: "active",
      },
      organizationId,
      userId
    );

    // Write audit log
    await this.auditRepo.create(
      {
        branchId: data.branchId,
        action: AUDIT_ACTIONS.SERVICE_CREATED,
        entityType: "ServiceCategory",
        entityId: category._id,
        description: "Service category created successfully",
        metadata: { categoryName: category.name },
      },
      organizationId,
      userId
    );

    return category;
  }

  async getCategoryById(id, organizationId, userContext = null, activeBranchId = null) {
    const category = await this.categoryRepo.findById(id, organizationId);
    if (!category || category.isDeleted) {
      throw new AppError("Resource not found", 404);
    }

    // Branch visibility scope check
    if (activeBranchId && category.branchId.toString() !== activeBranchId.toString()) {
      throw new AppError("Access denied. Service Category is not visible within your active branch scope.", 403);
    }

    return category;
  }

  async updateCategory(id, data, organizationId, userId, userContext = null, activeBranchId = null) {
    const category = await this.getCategoryById(id, organizationId, userContext, activeBranchId);

    // If category is deactivated, block updates unless reactivation is requested
    if (category.status !== "active" && data.status !== "active") {
      throw new AppError("Cannot perform operations on a deactivated category.", 400);
    }

    // Prevent direct modification of immutable fields
    const { organizationId: _, branchId: __, isDeleted: ___, deletedAt: ____, ...updateData } = data;

    // Check duplicate name during update
    if (updateData.name) {
      const duplicate = await this.categoryRepo.findOne(
        {
          _id: { $ne: id },
          name: { $regex: new RegExp("^" + updateData.name.trim() + "$", "i") },
          branchId: category.branchId,
          isDeleted: false,
        },
        organizationId
      );
      if (duplicate) {
        throw new AppError("A category with this name already exists in this branch.", 400);
      }
      updateData.name = updateData.name.trim();
    }

    // If deactivating, reject if active services are linked to it
    if (updateData.status === "inactive" && category.status === "active") {
      const activeServicesCount = await mongoose.model("Service").countDocuments({
        categoryId: id,
        status: "active",
        isDeleted: false,
      });
      if (activeServicesCount > 0) {
        throw new AppError("Cannot deactivate category because it has active services associated with it.", 400);
      }
    }

    const updated = await this.categoryRepo.updateById(id, updateData, organizationId, userId);

    let action = AUDIT_ACTIONS.SERVICE_UPDATED;
    let description = "Service category details updated";

    if (data.status && category.status !== data.status) {
      if (data.status === "active") {
        action = AUDIT_ACTIONS.SERVICE_ACTIVATED;
        description = "Service category activated";
      } else {
        action = AUDIT_ACTIONS.SERVICE_DEACTIVATED;
        description = "Service category deactivated";
      }
    }

    await this.auditRepo.create(
      {
        branchId: category.branchId,
        action,
        entityType: "ServiceCategory",
        entityId: id,
        description,
      },
      organizationId,
      userId
    );

    return updated;
  }

  async deleteCategory(id, organizationId, userId, activeBranchId = null) {
    const category = await this.getCategoryById(id, organizationId, null, activeBranchId);

    // Reject deletion if active services still depend on it
    const activeServicesCount = await mongoose.model("Service").countDocuments({
      categoryId: id,
      status: "active",
      isDeleted: false,
    });
    if (activeServicesCount > 0) {
      throw new AppError("Cannot delete category because it has active services associated with it.", 400);
    }

    await this.auditRepo.create(
      {
        branchId: activeBranchId || category.branchId,
        action: AUDIT_ACTIONS.SERVICE_DELETED,
        entityType: "ServiceCategory",
        entityId: id,
        description: "Service category soft deleted",
      },
      organizationId,
      userId
    );

    return this.categoryRepo.deleteById(id, organizationId, userId);
  }

  async listCategories(filter = {}, options = {}, organizationId) {
    return this.categoryRepo.find(filter, options, organizationId);
  }

  async reactivateCategory(id, organizationId, userId, activeBranchId = null) {
    const category = await this.categoryRepo.findByIdIncludeDeleted(id, organizationId);
    if (!category) {
      throw new AppError("Resource not found", 404);
    }

    if (activeBranchId && category.branchId.toString() !== activeBranchId.toString()) {
      throw new AppError("Access denied. Service Category is not visible within your active branch scope.", 403);
    }

    const BranchModel = mongoose.model("Branch");
    const branch = await BranchModel.findOne({ _id: category.branchId, organizationId, isActive: true });
    if (!branch) {
      throw new AppError("Cannot activate category if parent branch is invalid or inactive.", 400);
    }

    const reactivated = await this.categoryRepo.reactivateById(id, organizationId, userId);

    await this.auditRepo.create(
      {
        branchId: category.branchId,
        action: AUDIT_ACTIONS.SERVICE_ACTIVATED,
        entityType: "ServiceCategory",
        entityId: id,
        description: "Service category reactivated successfully",
      },
      organizationId,
      userId
    );

    return reactivated;
  }
}
