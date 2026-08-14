import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { AppError } from "../../utils/errors.js";
import {
  assertCanManageBranches,
  assertStaffBranchSubsetOfUserAccess,
} from "../../utils/branchAuthorization.js";
import { createUser, updateUser } from "../../controllers/users/user.controller.js";
import { assignBranch } from "../../controllers/staff/staff.controller.js";
import { requireBranchScope } from "../../middleware/branchScope.js";
import { UserRepository } from "../../repositories/users/user.repository.js";
import { StaffService } from "../../services/staff/staff.service.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Role } from "../../models/roles/role.model.js";
import { Staff } from "../../models/staff/staff.model.js";
import { StaffBranch } from "../../models/staff/staffBranch.model.js";

// Mock dependencies
UserRepository.prototype.find = jest.fn();
UserRepository.prototype.findById = jest.fn();
UserRepository.prototype.create = jest.fn();
UserRepository.prototype.updateById = jest.fn();
UserRepository.prototype.findByEmailOrPhone = jest.fn();
UserRepository.prototype.findByUsername = jest.fn();

StaffService.prototype.assignBranch = jest.fn();

Branch.find = jest.fn();
Branch.findOne = jest.fn();
Role.findById = jest.fn();
Staff.findOne = jest.fn();
StaffBranch.find = jest.fn();

describe("Branch Authorization Scope Integration & Policy Verification", () => {
  let orgAId;
  let orgBId;
  let branchAId; // Mumbai
  let branchBId; // Delhi
  let branchCId; // Noida
  let roleId;
  let req;
  let res;
  let next;

  beforeEach(() => {
    jest.clearAllMocks();

    orgAId = new mongoose.Types.ObjectId().toString();
    orgBId = new mongoose.Types.ObjectId().toString();

    branchAId = new mongoose.Types.ObjectId().toString();
    branchBId = new mongoose.Types.ObjectId().toString();
    branchCId = new mongoose.Types.ObjectId().toString();
    roleId = new mongoose.Types.ObjectId().toString();

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    next = jest.fn();

    // Default mock setup for Branch.find to match provided branch IDs
    Branch.find.mockImplementation(({ _id, organizationId }) => {
      const ids = _id.$in.map((id) => id.toString());
      return Promise.resolve(
        ids
          .filter((id) => [branchAId, branchBId, branchCId].includes(id))
          .map((id) => ({
            _id: new mongoose.Types.ObjectId(id),
            name: `Branch ${id}`,
            organizationId,
            isActive: true,
          }))
      );
    });

    // Mock Role.findById to support chainable .populate()
    Role.findById.mockReturnValue({
      populate: jest.fn().mockResolvedValue({
        _id: roleId,
        name: "staff",
        permissions: [{ name: "users.create" }],
      }),
    });

    Role.findOne = jest.fn().mockReturnValue({
      populate: jest.fn().mockReturnValue({
        permissions: [{ name: "users.create" }, { name: "users.view" }],
      }),
    });

    StaffBranch.find.mockResolvedValue([]);
    Staff.findOne.mockResolvedValue(null);
  });

  // A. Caller [A,B], current=A, creates User with [A,B] -> ALLOW
  it("A. Should ALLOW caller with branchAccess [A,B] and active context A to create User with [A,B]", async () => {
    req = {
      organizationId: orgAId,
      user: {
        id: "caller-1",
        role: "admin",
        hasOrgWideAccess: false,
        branchAccess: [
          { branchId: branchAId, isActive: true },
          { branchId: branchBId, isActive: true },
        ],
      },
      headers: { "x-branch-id": branchAId },
      branchId: branchAId,
      body: {
        name: "Test User",
        email: "testab@example.com",
        phone: "+12345678901",
        roleId,
        branchAccess: [{ branchId: branchAId }, { branchId: branchBId }],
      },
    };

    UserRepository.prototype.findByEmailOrPhone.mockResolvedValue(null);
    UserRepository.prototype.findByUsername.mockResolvedValue(null);
    UserRepository.prototype.create.mockResolvedValue({
      _id: new mongoose.Types.ObjectId(),
      name: "Test User",
      organizationId: orgAId,
      branchAccess: [
        { branchId: branchAId, branchName: `Branch ${branchAId}`, isActive: true },
        { branchId: branchBId, branchName: `Branch ${branchBId}`, isActive: true },
      ],
      isFirstLogin: true,
      status: "active",
    });

    await createUser(req, res, next);

    expect(res.status).toHaveBeenCalledWith(201);
  });

  // B. Caller [A,B], current=A, creates User with [B] -> ALLOW
  it("B. Should ALLOW caller with branchAccess [A,B] and active context A to create User with [B]", async () => {
    req = {
      organizationId: orgAId,
      user: {
        id: "caller-1",
        role: "admin",
        hasOrgWideAccess: false,
        branchAccess: [
          { branchId: branchAId, isActive: true },
          { branchId: branchBId, isActive: true },
        ],
      },
      headers: { "x-branch-id": branchAId },
      branchId: branchAId,
      body: {
        name: "Test User B",
        email: "testb@example.com",
        phone: "+12345678902",
        roleId,
        branchAccess: [{ branchId: branchBId }],
      },
    };

    UserRepository.prototype.findByEmailOrPhone.mockResolvedValue(null);
    UserRepository.prototype.findByUsername.mockResolvedValue(null);
    UserRepository.prototype.create.mockResolvedValue({
      _id: new mongoose.Types.ObjectId(),
      name: "Test User B",
      organizationId: orgAId,
      branchAccess: [{ branchId: branchBId, branchName: `Branch ${branchBId}`, isActive: true }],
      isFirstLogin: true,
      status: "active",
    });

    await createUser(req, res, next);

    expect(res.status).toHaveBeenCalledWith(201);
  });

  // C. Caller [A,B], current=A, creates User with [A,C] -> DENY
  it("C. Should DENY caller with branchAccess [A,B] from creating User with [A,C] (where C is unauthorized)", async () => {
    req = {
      organizationId: orgAId,
      user: {
        id: "caller-1",
        role: "admin",
        hasOrgWideAccess: false,
        branchAccess: [{ branchId: branchAId, isActive: true }, { branchId: branchBId, isActive: true }],
      },
      headers: { "x-branch-id": branchAId },
      branchId: branchAId,
      body: {
        name: "Test User AC",
        email: "testac@example.com",
        phone: "+12345678903",
        roleId,
        branchAccess: [{ branchId: branchAId }, { branchId: branchCId }],
      },
    };

    UserRepository.prototype.findByEmailOrPhone.mockResolvedValue(null);
    UserRepository.prototype.findByUsername.mockResolvedValue(null);

    await createUser(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    expect(next.mock.calls[0][0].statusCode).toBe(403);
  });

  // D. Caller [A,B], current=A, assigns Staff -> B -> ALLOW
  it("D. Should ALLOW caller with total authority [A,B] active in A to assign Staff to Branch B", async () => {
    const staffId = new mongoose.Types.ObjectId().toString();
    req = {
      organizationId: orgAId,
      user: {
        id: "caller-1",
        role: "admin",
        hasOrgWideAccess: false,
        branchAccess: [{ branchId: branchAId, isActive: true }, { branchId: branchBId, isActive: true }],
      },
      params: { id: staffId },
      body: { branchId: branchBId, isPrimary: false },
    };

    StaffService.prototype.assignBranch.mockResolvedValue({
      staffId,
      branchId: branchBId,
      isPrimary: false,
    });

    await assignBranch(req, res, next);

    expect(res.status).toHaveBeenCalledWith(201);
  });

  // E. Caller [A,B], current=A, assigns Staff -> C -> DENY
  it("E. Should DENY caller with authority [A,B] from assigning Staff to Branch C", async () => {
    const staffId = new mongoose.Types.ObjectId().toString();
    req = {
      organizationId: orgAId,
      user: {
        id: "caller-1",
        role: "admin",
        hasOrgWideAccess: false,
        branchAccess: [{ branchId: branchAId, isActive: true }, { branchId: branchBId, isActive: true }],
      },
      params: { id: staffId },
      body: { branchId: branchCId, isPrimary: false },
    };

    await assignBranch(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    expect(next.mock.calls[0][0].statusCode).toBe(403);
  });

  // F. Org-wide caller manages A/B/C -> ALLOW
  it("F. Should ALLOW org-wide caller to assign staff to any active organization branch", async () => {
    const staffId = new mongoose.Types.ObjectId().toString();
    req = {
      organizationId: orgAId,
      user: {
        id: "super-admin",
        role: "admin",
        hasOrgWideAccess: true,
        branchAccess: [],
      },
      params: { id: staffId },
      body: { branchId: branchCId, isPrimary: true },
    };

    StaffService.prototype.assignBranch.mockResolvedValue({
      staffId,
      branchId: branchCId,
      isPrimary: true,
    });

    await assignBranch(req, res, next);

    expect(res.status).toHaveBeenCalledWith(201);
  });

  // G. Empty/missing branchAccess + non-org-wide -> DENY
  it("G. Should DENY branch management when caller has empty branchAccess and no org-wide access", async () => {
    const user = {
      id: "restricted-user",
      hasOrgWideAccess: false,
      branchAccess: [],
    };

    await expect(assertCanManageBranches(user, [branchAId], orgAId)).rejects.toThrow(
      "Access denied. You do not have permission to manage branch access."
    );
  });

  // H. StaffBranch assignment does not grant User system access
  it("H. StaffBranch assignment must not automatically update or populate User.branchAccess", async () => {
    const staffId = new mongoose.Types.ObjectId().toString();
    req = {
      organizationId: orgAId,
      user: {
        id: "admin-1",
        hasOrgWideAccess: true,
      },
      params: { id: staffId },
      body: { branchId: branchAId },
    };

    StaffService.prototype.assignBranch.mockResolvedValue({
      staffId,
      branchId: branchAId,
      isActive: true,
    });

    await assignBranch(req, res, next);
    expect(UserRepository.prototype.updateById).not.toHaveBeenCalled();
  });

  // I. User.branchAccess remains independent from StaffBranch
  it("I. Updating User.branchAccess should not mutate StaffBranch entries", async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    req = {
      organizationId: orgAId,
      user: {
        id: "admin-1",
        hasOrgWideAccess: true,
      },
      params: { id: userId },
      body: {
        branchAccess: [{ branchId: branchAId }],
      },
    };

    UserRepository.prototype.findById.mockResolvedValue({
      _id: userId,
      organizationId: orgAId,
    });
    UserRepository.prototype.updateById.mockResolvedValue({
      _id: userId,
      branchAccess: [{ branchId: branchAId, branchName: `Branch ${branchAId}` }],
    });

    await updateUser(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(StaffService.prototype.assignBranch).not.toHaveBeenCalled();
  });

  // J. Cross-organization branch IDs -> DENY
  it("J. Should DENY target branch belonging to another organization", async () => {
    const foreignBranchId = new mongoose.Types.ObjectId().toString();
    Branch.find.mockResolvedValue([]); // Branch not found under caller's organizationId

    const user = {
      id: "admin-1",
      hasOrgWideAccess: true,
    };

    await expect(assertCanManageBranches(user, [foreignBranchId], orgAId)).rejects.toThrow(
      "Invalid branch reference(s) for organization context"
    );
  });

  // K. X-Branch-Id=all behavior remains unchanged
  it("K. Should preserve X-Branch-Id=all behavior in branchScope middleware", async () => {
    const reqScope = {
      headers: { "x-branch-id": "all" },
      user: {
        organizationId: orgAId,
        hasOrgWideAccess: true,
      },
    };

    Branch.findOne.mockResolvedValue(null);

    await requireBranchScope(reqScope, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    expect(next.mock.calls[0][0].statusCode).toBe(400);
  });

  describe("StaffBranch ⊆ User.branchAccess Invariant Enforcement", () => {
    const staffId = new mongoose.Types.ObjectId().toString();
    const userId = new mongoose.Types.ObjectId().toString();

    it("1. User Mumbai + linked Staff Mumbai assignment -> ALLOWED", async () => {
      const user = {
        _id: userId,
        hasOrgWideAccess: false,
        branchAccess: [{ branchId: branchAId }],
      };

      await expect(
        assertStaffBranchSubsetOfUserAccess(user, staffId, orgAId, branchAId)
      ).resolves.not.toThrow();
    });

    it("2. User Mumbai + linked Staff Delhi assignment -> REJECTED (422)", async () => {
      const user = {
        _id: userId,
        hasOrgWideAccess: false,
        branchAccess: [{ branchId: branchAId }],
      };

      await expect(
        assertStaffBranchSubsetOfUserAccess(user, staffId, orgAId, branchBId)
      ).rejects.toThrow(
        "Cannot assign staff to a branch where the linked user account lacks system authorization."
      );
    });

    it("3. User Mumbai+Delhi + Staff Mumbai assignment -> ALLOWED", async () => {
      const user = {
        _id: userId,
        hasOrgWideAccess: false,
        branchAccess: [{ branchId: branchAId }, { branchId: branchBId }],
      };

      await expect(
        assertStaffBranchSubsetOfUserAccess(user, staffId, orgAId, branchAId)
      ).resolves.not.toThrow();
    });

    it("4. User Mumbai+Delhi + Staff Mumbai+Delhi -> ALLOWED", async () => {
      const user = {
        _id: userId,
        hasOrgWideAccess: false,
        branchAccess: [{ branchId: branchAId }, { branchId: branchBId }],
      };

      await expect(
        assertStaffBranchSubsetOfUserAccess(user, staffId, orgAId, branchBId)
      ).resolves.not.toThrow();
    });

    it("5. Updating User Mumbai+Delhi -> Mumbai while Staff assigned Mumbai+Delhi -> REJECTED (422)", async () => {
      // Mock existing active StaffBranch assignments for Staff (Mumbai + Delhi)
      StaffBranch.find.mockResolvedValue([
        { branchId: branchAId, isActive: true },
        { branchId: branchBId, isActive: true },
      ]);

      const updatedUser = {
        _id: userId,
        hasOrgWideAccess: false,
        branchAccess: [{ branchId: branchAId }], // Proposed update removes Delhi
      };

      await expect(
        assertStaffBranchSubsetOfUserAccess(updatedUser, staffId, orgAId)
      ).rejects.toThrow(
        "Linked user account lacks system authorization for one or more branches assigned to this staff member."
      );
    });

    it("6. Linking User Mumbai to Staff assigned Delhi -> REJECTED (422)", async () => {
      StaffBranch.find.mockResolvedValue([{ branchId: branchBId, isActive: true }]);

      const user = {
        _id: userId,
        hasOrgWideAccess: false,
        branchAccess: [{ branchId: branchAId }],
      };

      await expect(
        assertStaffBranchSubsetOfUserAccess(user, staffId, orgAId)
      ).rejects.toThrow(
        "Linked user account lacks system authorization for one or more branches assigned to this staff member."
      );
    });

    // 7. Staff with no User can be assigned independently
    it("7. Staff with no User can be assigned branch independently", async () => {
      await expect(
        assertStaffBranchSubsetOfUserAccess(null, staffId, orgAId, branchBId)
      ).resolves.not.toThrow();
    });

    // 8. User with no Staff can have branchAccess updated independently
    it("8. User with no Staff can have branchAccess modified independently", async () => {
      Staff.findOne.mockResolvedValue(null);

      req = {
        organizationId: orgAId,
        user: { id: "admin-1", hasOrgWideAccess: true },
        params: { id: userId },
        body: { branchAccess: [{ branchId: branchAId }] },
      };

      UserRepository.prototype.findById.mockResolvedValue({
        _id: userId,
        organizationId: orgAId,
      });
      UserRepository.prototype.updateById.mockResolvedValue({
        _id: userId,
        branchAccess: [{ branchId: branchAId }],
      });

      await updateUser(req, res, next);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    // 9. Org-wide User can have Staff assignments across all organization branches
    it("9. Org-wide User permits Staff assignments across all organization branches", async () => {
      const user = {
        _id: userId,
        hasOrgWideAccess: true,
        branchAccess: [],
      };

      await expect(
        assertStaffBranchSubsetOfUserAccess(user, staffId, orgAId, branchBId)
      ).resolves.not.toThrow();
    });
  });
});
