import { CustomerService } from "../../services/customers/customer.service.js";
import { sendResponse } from "../../utils/response.js";
import { asyncHandler } from "../../utils/errors.js";

const customerService = new CustomerService();

const getBypassStatus = (req) => {
  const role = req.user?.role;
  return role === "admin" || role === "superadmin";
};

export const createCustomer = asyncHandler(async (req, res) => {
  const customer = await customerService.createCustomer(req.body, req.user.id);
  return sendResponse(res, 201, "Customer created successfully", customer);
});

export const getCustomerById = asyncHandler(async (req, res) => {
  const allowedBranches = req.user?.branches || [];
  const bypass = getBypassStatus(req);

  const customer = await customerService.getCustomerById(req.params.id, allowedBranches, bypass);
  return sendResponse(res, 200, "Customer retrieved successfully", customer);
});

export const updateCustomer = asyncHandler(async (req, res) => {
  const allowedBranches = req.user?.branches || [];
  const bypass = getBypassStatus(req);

  const customer = await customerService.updateCustomer(
    req.params.id,
    req.body,
    allowedBranches,
    bypass,
    req.user.id
  );
  return sendResponse(res, 200, "Customer updated successfully", customer);
});

export const deleteCustomer = asyncHandler(async (req, res) => {
  const allowedBranches = req.user?.branches || [];
  const bypass = getBypassStatus(req);

  await customerService.deleteCustomer(req.params.id, allowedBranches, bypass, req.user.id);
  return sendResponse(res, 200, "Customer profile deleted successfully");
});

export const listCustomers = asyncHandler(async (req, res) => {
  const allowedBranches = req.user?.branches || [];
  const bypass = getBypassStatus(req);

  const { page, limit, sort, search, branchId } = req.query;

  // Filter building
  const filter = {};
  if (branchId) {
    filter.branchId = branchId;
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
    allowedBranches,
    bypass
  );

  return sendResponse(res, 200, "Customers listed successfully", result.data, result.meta);
});

export const addNote = asyncHandler(async (req, res) => {
  const allowedBranches = req.user?.branches || [];
  const bypass = getBypassStatus(req);

  const customer = await customerService.addNote(
    req.params.id,
    req.body.text,
    allowedBranches,
    bypass,
    req.user.id
  );
  return sendResponse(res, 200, "Note added successfully", customer);
});

export const updatePreferences = asyncHandler(async (req, res) => {
  const allowedBranches = req.user?.branches || [];
  const bypass = getBypassStatus(req);

  const customer = await customerService.updatePreferences(
    req.params.id,
    req.body,
    allowedBranches,
    bypass,
    req.user.id
  );
  return sendResponse(res, 200, "Preferences updated successfully", customer);
});

export const addVisit = asyncHandler(async (req, res) => {
  const allowedBranches = req.user?.branches || [];
  const bypass = getBypassStatus(req);

  const customer = await customerService.addVisit(
    req.params.id,
    req.body,
    allowedBranches,
    bypass,
    req.user.id
  );
  return sendResponse(res, 200, "Visit history recorded successfully", customer);
});

export const addService = asyncHandler(async (req, res) => {
  const allowedBranches = req.user?.branches || [];
  const bypass = getBypassStatus(req);

  const customer = await customerService.addServiceHistory(
    req.params.id,
    req.body,
    allowedBranches,
    bypass,
    req.user.id
  );
  return sendResponse(res, 200, "Service history recorded successfully", customer);
});

export const addMembership = asyncHandler(async (req, res) => {
  const allowedBranches = req.user?.branches || [];
  const bypass = getBypassStatus(req);

  const customer = await customerService.addMembershipHistory(
    req.params.id,
    req.body,
    allowedBranches,
    bypass,
    req.user.id
  );
  return sendResponse(res, 200, "Membership history recorded successfully", customer);
});

export const adjustLoyaltyPoints = asyncHandler(async (req, res) => {
  const allowedBranches = req.user?.branches || [];
  const bypass = getBypassStatus(req);

  const customer = await customerService.adjustLoyaltyPoints(
    req.params.id,
    req.body.points,
    allowedBranches,
    bypass,
    req.user.id
  );
  return sendResponse(res, 200, "Loyalty points adjusted successfully", customer);
});
