import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { AppError } from "../../utils/errors.js";

const staffRepoFindOne = jest.fn();
const managePermissionMiddleware = jest.fn((req, res, next) => next());
const requirePermission = jest.fn(() => managePermissionMiddleware);

jest.unstable_mockModule("../../repositories/staff/staff.repository.js", () => ({
  StaffRepository: class StaffRepository {
    findOne(...args) {
      return staffRepoFindOne(...args);
    }
  },
}));

jest.unstable_mockModule("../../middleware/rbac.js", () => ({
  requirePermission,
}));

const { requireOnBehalfManage } = await import("../../middleware/leaveScope.js");

describe("requireOnBehalfManage middleware", () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    jest.clearAllMocks();
    req = {
      organizationId: "org-123",
      user: { id: "user-123" },
      body: {},
    };
    res = {};
    next = jest.fn();
  });

  it("allows self-service create when staffId is omitted", async () => {
    await requireOnBehalfManage(req, res, next);

    expect(staffRepoFindOne).not.toHaveBeenCalled();
    expect(requirePermission).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it("allows self-service create when staffId matches actor staff", async () => {
    req.body.staffId = "staff-123";
    staffRepoFindOne.mockResolvedValue({ _id: { toString: () => "staff-123" } });

    await requireOnBehalfManage(req, res, next);

    expect(staffRepoFindOne).toHaveBeenCalledWith(
      { userId: "user-123", isDeleted: false },
      "org-123"
    );
    expect(requirePermission).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it("requires manage permission for on-behalf create with different staffId", async () => {
    req.body.staffId = "staff-999";
    staffRepoFindOne.mockResolvedValue({ _id: { toString: () => "staff-123" } });

    await requireOnBehalfManage(req, res, next);

    expect(requirePermission).toHaveBeenCalledWith("employees.leaves.manage");
    expect(managePermissionMiddleware).toHaveBeenCalledWith(req, res, next);
  });

  it("requires manage permission when actor has no linked staff", async () => {
    req.body.staffId = "staff-999";
    staffRepoFindOne.mockResolvedValue(null);

    await requireOnBehalfManage(req, res, next);

    expect(requirePermission).toHaveBeenCalledWith("employees.leaves.manage");
    expect(managePermissionMiddleware).toHaveBeenCalledWith(req, res, next);
  });

  it("propagates manage-permission denial from existing RBAC middleware", async () => {
    const denial = new AppError("Access denied. You do not have the required permissions.", 403);
    req.body.staffId = "staff-999";
    staffRepoFindOne.mockResolvedValue({ _id: { toString: () => "staff-123" } });
    requirePermission.mockReturnValueOnce((innerReq, innerRes, innerNext) => innerNext(denial));

    await requireOnBehalfManage(req, res, next);

    expect(next).toHaveBeenCalledWith(denial);
  });

  it("delegates to requirePermission instead of duplicating RBAC resolution logic", async () => {
    req.body.staffId = "staff-999";
    staffRepoFindOne.mockResolvedValue({ _id: { toString: () => "staff-123" } });

    await requireOnBehalfManage(req, res, next);

    expect(requirePermission).toHaveBeenCalledTimes(1);
    expect(requirePermission).toHaveBeenCalledWith("employees.leaves.manage");
  });
});
