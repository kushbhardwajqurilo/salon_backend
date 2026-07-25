import { CustomerService } from "../../services/customers/customer.service.js";
import { sendResponse } from "../../utils/response.js";
import { asyncHandler, AppError } from "../../utils/errors.js";

const customerService = new CustomerService();

export const createCustomer = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId;

  if (!branchId) {
    throw new AppError("X-Branch-Id header is required to create a customer.", 400);
  }

  if (req.body.branchId && req.body.branchId !== branchId) {
    throw new AppError("Branch ID in request body does not match X-Branch-Id header.", 400);
  }

  // Derive branchId server-side from header context
  req.body.branchId = branchId;

  const customer = await customerService.createCustomer(
    { ...req.body, organizationId },
    organizationId,
    req.user.id
  );
  return sendResponse(res, 201, "Customer created successfully", customer);
});

export const getCustomerById = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const customer = await customerService.getCustomerById(req.params.id, organizationId);
  return sendResponse(res, 200, "Customer retrieved successfully", customer);
});

export const updateCustomer = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const customer = await customerService.updateCustomer(
    req.params.id,
    req.body,
    organizationId,
    req.user.id,
    req.user
  );
  return sendResponse(res, 200, "Customer updated successfully", customer);
});

export const deleteCustomer = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  await customerService.deleteCustomer(req.params.id, organizationId, req.user.id);
  return sendResponse(res, 200, "Customer profile deleted successfully");
});

export const listCustomers = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId;

  // Enforce header and query parameter branch alignment
  if (req.query.branchId && branchId && req.query.branchId !== branchId) {
    throw new AppError("Branch ID in query parameters does not match X-Branch-Id header.", 400);
  }

  // Enforce access authorization if query parameter specifies a branch but header was omitted
  if (req.query.branchId && !branchId && !req.user.hasOrgWideAccess) {
    throw new AppError("Access denied. You do not have access to this branch.", 403);
  }

  if (!branchId && !req.user.hasOrgWideAccess) {
    throw new AppError("X-Branch-Id header is required for this request.", 400);
  }

  const { page, limit, sort, search } = req.query;

  // Filter building
  const filter = {};
  const finalBranchId = branchId || req.query.branchId;
  if (finalBranchId) {
    filter.branchId = finalBranchId;
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
  const customer = await customerService.addNote(
    req.params.id,
    req.body.text,
    organizationId,
    req.user.id
  );
  return sendResponse(res, 200, "Note added successfully", customer);
});

export const updatePreferences = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const customer = await customerService.updatePreferences(
    req.params.id,
    req.body,
    organizationId,
    req.user.id
  );
  return sendResponse(res, 200, "Preferences updated successfully", customer);
});

export const addVisit = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const customer = await customerService.addVisit(
    req.params.id,
    req.body,
    organizationId,
    req.user.id
  );
  return sendResponse(res, 200, "Visit history recorded successfully", customer);
});

export const addService = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const customer = await customerService.addServiceHistory(
    req.params.id,
    req.body,
    organizationId,
    req.user.id
  );
  return sendResponse(res, 200, "Service history recorded successfully", customer);
});

export const addMembership = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const customer = await customerService.addMembershipHistory(
    req.params.id,
    req.body,
    organizationId,
    req.user.id
  );
  return sendResponse(res, 200, "Membership history recorded successfully", customer);
});

export const adjustLoyaltyPoints = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const customer = await customerService.adjustLoyaltyPoints(
    req.params.id,
    req.body.points,
    organizationId,
    req.user.id
  );
  return sendResponse(res, 200, "Loyalty points adjusted successfully", customer);
});
