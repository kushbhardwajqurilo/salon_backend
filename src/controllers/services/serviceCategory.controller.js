import mongoose from "mongoose";
import { ServiceCategoryService } from "../../services/services/serviceCategory.service.js";
import { sendResponse } from "../../utils/response.js";
import { asyncHandler, AppError } from "../../utils/errors.js";

const categoryService = new ServiceCategoryService();

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

export const createCategory = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const activeBranchId = await getActiveBranchContext(req);

  if (!activeBranchId) {
    throw new AppError("X-Branch-Id header is required to create a category.", 400);
  }

  const category = await categoryService.createCategory(
    { ...req.body, branchId: activeBranchId },
    organizationId,
    req.user.id
  );
  return sendResponse(res, 201, "Service category created successfully", category);
});

export const getCategoryById = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const activeBranchId = await getActiveBranchContext(req);

  const category = await categoryService.getCategoryById(
    req.params.id,
    organizationId,
    req.user,
    activeBranchId
  );
  return sendResponse(res, 200, "Service category retrieved successfully", category);
});

export const updateCategory = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const activeBranchId = await getActiveBranchContext(req);

  const category = await categoryService.updateCategory(
    req.params.id,
    req.body,
    organizationId,
    req.user.id,
    req.user,
    activeBranchId
  );
  return sendResponse(res, 200, "Service category updated successfully", category);
});

export const deleteCategory = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const activeBranchId = await getActiveBranchContext(req);

  await categoryService.deleteCategory(req.params.id, organizationId, req.user.id, activeBranchId);
  return sendResponse(res, 200, "Service category deleted successfully");
});

export const listCategories = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const activeBranchId = await getActiveBranchContext(req);

  const { page, limit, sort, search, status } = req.query;

  const filter = { isDeleted: false };
  const andConditions = [];

  if (activeBranchId) {
    andConditions.push({ branchId: activeBranchId });
  }

  if (status) {
    andConditions.push({ status });
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

  const result = await categoryService.listCategories(
    filter,
    {
      page,
      limit,
      sort: sortOption,
      search,
      searchFields: ["name", "description"],
    },
    organizationId
  );

  return sendResponse(res, 200, "Service categories listed successfully", result.data, result.meta);
});

export const reactivateCategory = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const activeBranchId = await getActiveBranchContext(req);

  const category = await categoryService.reactivateCategory(
    req.params.id,
    organizationId,
    req.user.id,
    activeBranchId
  );
  return sendResponse(res, 200, "Service category reactivated successfully", category);
});
