import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import mongoose from "mongoose";
import { LeavePolicyService } from "../../services/leavePolicies/leavePolicy.service.js";
import { LeavePolicy } from "../../models/leavePolicies/leavePolicy.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { AppError } from "../../utils/errors.js";

describe("LeavePolicyService", () => {
  const orgId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();
  const otherBranchId = new mongoose.Types.ObjectId();
  const actorId = new mongoose.Types.ObjectId();

  let auditLogService;
  let service;

  beforeEach(() => {
    jest.restoreAllMocks();
    auditLogService = {
      createAuditLog: jest.fn().mockResolvedValue({}),
    };
    service = new LeavePolicyService({ auditLogService });
    service.executeTx = jest.fn(async (op) => op(null));
  });

  it("creates an organization-wide leave policy and emits LEAVE_POLICY_CREATED", async () => {
    const createdId = new mongoose.Types.ObjectId();
    jest.spyOn(LeavePolicy, "create").mockResolvedValue([
      {
        _id: createdId,
        organizationId: orgId,
        branchId: null,
        code: "CASUAL",
        name: "Casual Leave",
        isPaid: true,
        annualEntitlement: 12,
        carryForwardLimit: 2,
        allowHalfDay: true,
        excludeHolidays: true,
        excludeWeeklyOffs: true,
        excessBehavior: "convert_to_unpaid",
        allowNegativeBalance: false,
        negativeBalancePayrollTreatment: "unpaid_deduction",
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const user = { id: actorId, hasOrgWideAccess: true, branchAccess: [] };
    const dto = await service.createPolicy(
      orgId,
      {
        code: "casual",
        name: "Casual Leave",
        isPaid: true,
        annualEntitlement: 12,
        excessBehavior: "convert_to_unpaid",
      },
      user
    );

    expect(dto.id).toBe(createdId.toString());
    expect(dto.code).toBe("CASUAL");
    expect(dto.excessBehavior).toBe("convert_to_unpaid");
    expect(auditLogService.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "LEAVE_POLICY_CREATED", entityType: "LeavePolicy" }),
      orgId,
      actorId,
      null
    );
  });

  it("rejects cross-branch policy creation for branch-limited users", async () => {
    const user = {
      id: actorId,
      hasOrgWideAccess: false,
      branchAccess: [{ branchId: otherBranchId, isActive: true }],
    };

    await expect(
      service.createPolicy(
        orgId,
        { branchId: branchId.toString(), code: "SICK", name: "Sick Leave", isPaid: true, annualEntitlement: 6 },
        user
      )
    ).rejects.toThrow("Access denied");
  });

  it("rejects immutable organizationId/branchId/code updates", async () => {
    await expect(
      service.updatePolicy(
        orgId,
        new mongoose.Types.ObjectId().toString(),
        { code: "NEWCODE" },
        { id: actorId, hasOrgWideAccess: true }
      )
    ).rejects.toThrow(AppError);
  });

  it("soft-deactivates policy without deleting historical record and emits LEAVE_POLICY_DEACTIVATED", async () => {
    const policyDoc = {
      _id: new mongoose.Types.ObjectId(),
      organizationId: orgId,
      branchId: null,
      code: "CASUAL",
      name: "Casual Leave",
      isPaid: true,
      annualEntitlement: 12,
      isActive: true,
      save: jest.fn().mockResolvedValue(true),
    };
    jest.spyOn(LeavePolicy, "findOne").mockResolvedValue(policyDoc);

    const dto = await service.deactivatePolicy(orgId, policyDoc._id.toString(), {
      id: actorId,
      hasOrgWideAccess: true,
    });

    expect(dto.isActive).toBe(false);
    expect(policyDoc.save).toHaveBeenCalled();
    expect(auditLogService.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "LEAVE_POLICY_DEACTIVATED" }),
      orgId,
      actorId,
      null
    );
  });

  it("maps duplicate code error to 409 Conflict", async () => {
    jest.spyOn(Branch, "findOne").mockReturnValue({
      lean: jest.fn().mockResolvedValue({ _id: branchId, organizationId: orgId, isActive: true }),
    });
    jest.spyOn(LeavePolicy, "create").mockRejectedValue({ code: 11000 });

    await expect(
      service.createPolicy(
        orgId,
        { branchId: branchId.toString(), code: "CASUAL", name: "Casual", isPaid: true, annualEntitlement: 10 },
        { id: actorId, hasOrgWideAccess: true }
      )
    ).rejects.toThrow("already exists");
  });
});
