import { ServiceCategoryService } from "../../services/services/serviceCategory.service.js";
import { sendResponse } from "../../utils/response.js";
import { asyncHandler } from "../../utils/errors.js";

const categoryService = new ServiceCategoryService();

export const createCategory = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;

  const category = await categoryService.createCategory(
    req.body,
    organizationId,
    req.user.id
  );
  return sendResponse(res, 201, "Service category created successfully", category);
});

export const getCategoryById = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;

  const category = await categoryService.getCategoryById(
    req.params.id,
    organizationId,
    req.user
  );
  return sendResponse(res, 200, "Service category retrieved successfully", category);
});

export const updateCategory = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;

  const category = await categoryService.updateCategory(
    req.params.id,
    req.body,
    organizationId,
    req.user.id,
    req.user
  );
  return sendResponse(res, 200, "Service category updated successfully", category);
});

export const deleteCategory = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;

  await categoryService.deleteCategory(req.params.id, organizationId, req.user.id);
  return sendResponse(res, 200, "Service category deleted successfully");
});

export const listCategories = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;

  const { page, limit, sort, search, status, all, query } = req.query;

  const isFetchAll =
    limit === "all" ||
    all === true ||
    all === "true" ||
    all === "all" ||
    query === "all";

  const filter = { isDeleted: false };
  const andConditions = [];

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
  if (sortOption.name === undefined) {
    sortOption.name = 1;
  }
  if (sortOption.displayOrder === undefined) {
    sortOption.displayOrder = 1;
  }
  if (sortOption._id === undefined) {
    sortOption._id = 1;
  }

  const result = await categoryService.listCategories(
    filter,
    {
      page,
      limit: isFetchAll ? "all" : limit,
      all: isFetchAll,
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

  const category = await categoryService.reactivateCategory(
    req.params.id,
    organizationId,
    req.user.id
  );
  return sendResponse(res, 200, "Service category reactivated successfully", category);
});

