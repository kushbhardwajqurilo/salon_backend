import mongoose from "mongoose";
import { ServiceService } from "../../services/services/service.service.js";
import { sendResponse } from "../../utils/response.js";
import { asyncHandler, AppError } from "../../utils/errors.js";

const serviceService = new ServiceService();

const getActiveBranchContext = async (req) => {
  const activeBranchId = req.headers
    ? (req.headers["x-branch-id"] || req.headers["X-Branch-Id"] || req.branchId)
    : req.branchId;
  const { hasOrgWideAccess, branchAccess, organizationId } = req.user || {};

  if (activeBranchId === "all") {
    throw new AppError("Invalid branch ID format.", 400);
  }

  if (!activeBranchId) {
    if (!hasOrgWideAccess) {
      throw new AppError("X-Branch-Id header is required for this request.", 400);
    }
    return null;
  }

  if (!mongoose.Types.ObjectId.isValid(activeBranchId)) {
    throw new AppError("Invalid branch ID format.", 400);
  }

  const branch = await mongoose.model("Branch").findOne({
    _id: activeBranchId,
    organizationId,
    isActive: true,
  });

  if (!branch) {
    throw new AppError("Resource not found", 404);
  }

  if (!hasOrgWideAccess) {
    const isAuthorized = (branchAccess || []).some(
      (b) => b.branchId.toString() === activeBranchId.toString() && b.isActive
    );
    if (!isAuthorized) {
      throw new AppError("Access denied. You do not have access to this branch.", 403);
    }
  }

  return activeBranchId;
};

export const createService = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const activeBranchId = await getActiveBranchContext(req);

  if (!activeBranchId) {
    throw new AppError("X-Branch-Id header is required to create a service.", 400);
  }

  const service = await serviceService.createService(
    { ...req.body, branchId: activeBranchId },
    organizationId,
    req.user.id
  );
  return sendResponse(res, 201, "Service created successfully", service);
});

export const getServiceById = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const activeBranchId = await getActiveBranchContext(req);

  const service = await serviceService.getServiceById(
    req.params.id,
    organizationId,
    req.user,
    activeBranchId
  );
  return sendResponse(res, 200, "Service retrieved successfully", service);
});

export const updateService = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const activeBranchId = await getActiveBranchContext(req);

  const service = await serviceService.updateService(
    req.params.id,
    req.body,
    organizationId,
    req.user.id,
    req.user,
    activeBranchId
  );
  return sendResponse(res, 200, "Service updated successfully", service);
});

export const deleteService = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const activeBranchId = await getActiveBranchContext(req);

  await serviceService.deleteService(req.params.id, organizationId, req.user.id, activeBranchId);
  return sendResponse(res, 200, "Service soft deleted successfully");
});

export const toggleServiceStatus = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const activeBranchId = await getActiveBranchContext(req);

  const service = await serviceService.updateService(
    req.params.id,
    { status: req.body.status },
    organizationId,
    req.user.id,
    req.user,
    activeBranchId
  );
  return sendResponse(res, 200, `Service status updated successfully to ${service.status}`, service);
});

export const listServices = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const activeBranchId = await getActiveBranchContext(req);

  const { page, limit, sort, search, status, categoryId } = req.query;

  const filter = { isDeleted: false };
  const andConditions = [];

  if (activeBranchId) {
    andConditions.push({ branchId: activeBranchId });
  }

  if (status) {
    andConditions.push({ status });
  }

  if (categoryId) {
    andConditions.push({ categoryId });
  }

  if (andConditions.length > 0) {
    filter.$and = andConditions;
  }

  const sortOption = {};
  if (sort) {
    const isDesc = sort.startsWith("-");
    const field = isDesc ? sort.slice(1) : sort;
    sortOption[field] = isDesc ? -1 : 1;
  }
  if (sortOption.displayOrder === undefined) {
    sortOption.displayOrder = 1;
  }
  if (sortOption.name === undefined) {
    sortOption.name = 1;
  }
  if (sortOption._id === undefined) {
    sortOption._id = 1;
  }

  const result = await serviceService.listServices(
    filter,
    {
      page,
      limit,
      sort: sortOption,
      search,
      searchFields: ["name", "description", "serviceCode"],
      populate: ["categoryId"],
    },
    organizationId
  );

  return sendResponse(res, 200, "Services listed successfully", result.data, result.meta);
});
