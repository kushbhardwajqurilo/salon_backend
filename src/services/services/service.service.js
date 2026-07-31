import mongoose from "mongoose";
import { ServiceRepository } from "../../repositories/services/service.repository.js";
import { ServiceCategoryRepository } from "../../repositories/services/serviceCategory.repository.js";
import { AuditLogRepository } from "../../repositories/audit/auditLog.repository.js";
import { AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";
import { AppError } from "../../utils/errors.js";

export class ServiceService {
  constructor(serviceRepo = null, categoryRepo = null, auditRepo = null) {
    this.serviceRepo = serviceRepo || new ServiceRepository();
    this.categoryRepo = categoryRepo || new ServiceCategoryRepository();
    this.auditRepo = auditRepo || new AuditLogRepository();
  }

  async createService(data, organizationId, userId) {
    // Validate branchId existence and active status
    const BranchModel = mongoose.model("Branch");
    const branch = await BranchModel.findOne({ _id: data.branchId, organizationId, isActive: true });
    if (!branch) {
      throw new AppError("branchId does not exist or does not belong to this organization.", 400);
    }

    // Validate categoryId existence, organization scope, branch scope, active status and deleted status
    const category = await this.categoryRepo.findById(data.categoryId, organizationId);
    if (!category || category.isDeleted) {
      throw new AppError("Category not found.", 400);
    }
    if (category.status !== "active") {
      throw new AppError("Cannot associate a service with an inactive category.", 400);
    }
    if (category.branchId.toString() !== data.branchId.toString()) {
      throw new AppError("Category branch must match service branch.", 400);
    }

    // Name duplicate check in the branch
    const nameDuplicate = await this.serviceRepo.findOne(
      {
        name: { $regex: new RegExp("^" + data.name.trim() + "$", "i") },
        branchId: data.branchId,
        isDeleted: false,
      },
      organizationId
    );
    if (nameDuplicate) {
      throw new AppError("A service with this name already exists in this branch.", 400);
    }

    // Generate service code if not provided
    if (!data.serviceCode) {
      const prefix = data.name.replace(/[^a-zA-Z]/g, "").slice(0, 4).toUpperCase() || "SRV";
      const suffix = Math.random().toString(36).substring(2, 6).toUpperCase();
      data.serviceCode = `${prefix}${suffix}`;
    }

    // Code duplicate check in the branch
    const codeDuplicate = await this.serviceRepo.findOne(
      {
        serviceCode: data.serviceCode.toUpperCase(),
        branchId: data.branchId,
        isDeleted: false,
      },
      organizationId
    );
    if (codeDuplicate) {
      throw new AppError("A service with this service code already exists in this branch.", 400);
    }

    const service = await this.serviceRepo.create(
      {
        name: data.name.trim(),
        serviceCode: data.serviceCode.toUpperCase(),
        description: data.description || "",
        categoryId: data.categoryId,
        duration: data.duration,
        pricing: data.pricing,
        taxConfiguration: data.taxConfiguration || { taxable: false, taxRate: 0 },
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
        entityType: "Service",
        entityId: service._id,
        description: "Service created successfully",
        metadata: { serviceName: service.name, serviceCode: service.serviceCode },
      },
      organizationId,
      userId
    );

    return service;
  }

  async getServiceById(id, organizationId, userContext = null, activeBranchId = null) {
    const service = await this.serviceRepo.findById(id, organizationId);
    if (!service || service.isDeleted) {
      throw new AppError("Resource not found", 404);
    }

    // Branch visibility scope check
    if (activeBranchId && service.branchId.toString() !== activeBranchId.toString()) {
      throw new AppError("Access denied. Service is not visible within your active branch scope.", 403);
    }

    return service;
  }

  async updateService(id, data, organizationId, userId, userContext = null, activeBranchId = null) {
    const service = await this.getServiceById(id, organizationId, userContext, activeBranchId);

    // Block operations on deactivated services unless reactivating
    if (service.status !== "active" && data.status !== "active") {
      throw new AppError("Cannot perform operations on a deactivated service.", 400);
    }

    // Enforce immutable fields (cannot modify organizationId, branchId, serviceCode, isDeleted, etc.)
    const { organizationId: _, branchId: __, serviceCode: ___, isDeleted: ____, deletedAt: _____, ...updateData } = data;

    // Validate category transition if provided
    if (updateData.categoryId && updateData.categoryId.toString() !== service.categoryId.toString()) {
      const category = await this.categoryRepo.findById(updateData.categoryId, organizationId);
      if (!category || category.isDeleted) {
        throw new AppError("Category not found.", 400);
      }
      if (category.status !== "active") {
        throw new AppError("Cannot associate a service with an inactive category.", 400);
      }
      if (category.branchId.toString() !== service.branchId.toString()) {
        throw new AppError("Category branch must match service branch.", 400);
      }
    }

    // Name duplicate check in the branch
    if (updateData.name) {
      const duplicate = await this.serviceRepo.findOne(
        {
          _id: { $ne: id },
          name: { $regex: new RegExp("^" + updateData.name.trim() + "$", "i") },
          branchId: service.branchId,
          isDeleted: false,
        },
        organizationId
      );
      if (duplicate) {
        throw new AppError("A service with this name already exists in this branch.", 400);
      }
      updateData.name = updateData.name.trim();
    }

    const updated = await this.serviceRepo.updateById(id, updateData, organizationId, userId);

    let action = AUDIT_ACTIONS.SERVICE_UPDATED;
    let description = "Service details updated";

    if (data.status && service.status !== data.status) {
      if (data.status === "active") {
        action = AUDIT_ACTIONS.SERVICE_ACTIVATED;
        description = "Service activated";
      } else {
        action = AUDIT_ACTIONS.SERVICE_DEACTIVATED;
        description = "Service deactivated";
      }
    }

    await this.auditRepo.create(
      {
        branchId: service.branchId,
        action,
        entityType: "Service",
        entityId: id,
        description,
      },
      organizationId,
      userId
    );

    return updated;
  }

  async deleteService(id, organizationId, userId, activeBranchId = null) {
    const service = await this.getServiceById(id, organizationId, null, activeBranchId);

    await this.auditRepo.create(
      {
        branchId: activeBranchId || service.branchId,
        action: AUDIT_ACTIONS.SERVICE_DELETED,
        entityType: "Service",
        entityId: id,
        description: "Service soft deleted",
      },
      organizationId,
      userId
    );

    return this.serviceRepo.deleteById(id, organizationId, userId);
  }

  async listServices(filter = {}, options = {}, organizationId) {
    return this.serviceRepo.find(filter, options, organizationId);
  }
}
