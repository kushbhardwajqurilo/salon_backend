import mongoose from "mongoose";
import { CustomerService } from "../../services/customers/customer.service.js";
import { sendResponse } from "../../utils/response.js";
import { asyncHandler, AppError } from "../../utils/errors.js";

const customerService = new CustomerService();

/**
 * Helper to retrieve and validate active branch context from request headers.
 */
const getActiveBranchContext = async (req) => {
  const activeBranchId = req.headers
    ? (req.headers["x-branch-id"] || req.headers["X-Branch-Id"] || req.branchId)
    : req.branchId;
  const { hasOrgWideAccess, branchAccess, organizationId } = req.user || {};

  // Reject the frontend-only UI sentinel "all"
  if (activeBranchId === "all") {
    throw new AppError("Invalid branch ID format.", 400);
  }

  // Handle case where header is omitted
  if (!activeBranchId) {
    if (!hasOrgWideAccess) {
      throw new AppError("X-Branch-Id header is required for this request.", 400);
    }
    return null; // Organization-wide scope
  }

  // Validate format
  if (!mongoose.Types.ObjectId.isValid(activeBranchId)) {
    throw new AppError("Invalid branch ID format.", 400);
  }

  // Validate active status and tenant ownership
  const branch = await mongoose.model("Branch").findOne({
    _id: activeBranchId,
    organizationId,
    isActive: true,
  });

  if (!branch) {
    throw new AppError("Resource not found", 404);
  }

  // Validate user branch authorization
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

export const createCustomer = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const activeBranchId = await getActiveBranchContext(req);

  // Creation must always operate in a specific branch context
  if (!activeBranchId) {
    throw new AppError("X-Branch-Id header is required to create a customer.", 400);
  }

  // homeBranchId is derived strictly server-side, ignore/reject client body input
  delete req.body.homeBranchId;
  delete req.body.branchId;

  const customer = await customerService.createCustomer(
    { ...req.body, homeBranchId: activeBranchId, organizationId },
    organizationId,
    req.user.id
  );
  return sendResponse(res, 201, "Customer created successfully", customer);
});

export const getCustomerById = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const activeBranchId = await getActiveBranchContext(req);

  const customer = await customerService.getCustomerById(
    req.params.id,
    organizationId,
    req.user,
    activeBranchId
  );
  return sendResponse(res, 200, "Customer retrieved successfully", customer);
});

export const updateCustomer = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const activeBranchId = await getActiveBranchContext(req);

  const customer = await customerService.updateCustomer(
    req.params.id,
    req.body,
    organizationId,
    req.user.id,
    req.user,
    activeBranchId
  );
  return sendResponse(res, 200, "Customer updated successfully", customer);
});

export const deleteCustomer = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const activeBranchId = await getActiveBranchContext(req);

  // Validate visibility before soft-deleting
  await customerService.getCustomerById(req.params.id, organizationId, req.user, activeBranchId);

  await customerService.deleteCustomer(req.params.id, organizationId, req.user.id);
  return sendResponse(res, 200, "Customer profile deleted successfully");
});

export const listCustomers = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const activeBranchId = await getActiveBranchContext(req);

  const { page, limit, sort, search } = req.query;

  const filter = {};
  if (activeBranchId) {
    // Branch-limited visibility rule
    filter.$or = [
      { homeBranchId: activeBranchId },
      { visitedBranchIds: activeBranchId }
    ];
  }

  const result = await customerService.listCustomers(
    filter,
    {
      page,
      limit,
      sort,
      search,
      searchFields: ["name", "phone", "email"],
    },
    organizationId
  );

  return sendResponse(res, 200, "Customers listed successfully", result.data, result.meta);
});

export const addNote = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const activeBranchId = await getActiveBranchContext(req);

  const customer = await customerService.addNote(
    req.params.id,
    req.body.text,
    organizationId,
    req.user.id,
    req.user,
    activeBranchId
  );
  return sendResponse(res, 200, "Note added successfully", customer);
});
