import { jest } from "@jest/globals";
import mongoose from "mongoose";

const mockCreateOutboxEvent = jest.fn();
const mockRunInTransaction = jest.fn();
const mockSeqFindOneAndUpdate = jest.fn();
const mockUserFindById = jest.fn();
const mockStaffCreate = jest.fn();
const mockStaffBranchAssign = jest.fn();
const mockAuditLog = jest.fn();

jest.unstable_mockModule("../../services/notifications/outbox.service.js", () => ({
  createOutboxEvent: mockCreateOutboxEvent,
}));

jest.unstable_mockModule("../../utils/transaction.js", () => ({
  runInTransaction: mockRunInTransaction,
}));

jest.unstable_mockModule("../../models/sequence/sequence.model.js", () => ({
  Sequence: {
    findOneAndUpdate: mockSeqFindOneAndUpdate,
  },
}));

jest.unstable_mockModule("../../repositories/users/user.repository.js", () => ({
  UserRepository: jest.fn().mockImplementation(() => ({
    findById: mockUserFindById,
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
  })),
}));

jest.unstable_mockModule("../../repositories/staff/staff.repository.js", () => ({
  StaffRepository: jest.fn().mockImplementation(() => ({
    create: mockStaffCreate,
    findOne: jest.fn().mockResolvedValue(null),
    findByEmail: jest.fn().mockResolvedValue(null),
    findByPhone: jest.fn().mockResolvedValue(null),
  })),
}));

jest.unstable_mockModule("../../repositories/staff/staffBranch.repository.js", () => ({
  StaffBranchRepository: jest.fn().mockImplementation(() => ({
    assignBranch: mockStaffBranchAssign,
    create: mockStaffBranchAssign,
  })),
}));

jest.unstable_mockModule("../../repositories/staff/staffService.repository.js", () => ({
  StaffServiceRepository: jest.fn().mockImplementation(() => ({
    assignServices: jest.fn().mockResolvedValue([]),
  })),
}));

jest.unstable_mockModule("../../services/audit/auditLog.service.js", () => ({
  AuditLogService: jest.fn().mockImplementation(() => ({
    log: mockAuditLog,
    createAuditLog: mockAuditLog,
  })),
}));

jest.unstable_mockModule("../../services/cloudinary.service.js", () => ({
  deleteFromCloudinary: jest.fn(),
  commitAsset: jest.fn().mockResolvedValue({}),
  confirmAsset: jest.fn().mockResolvedValue({}),
}));

const { StaffService } = await import(
  "../../services/staff/staff.service.js"
);
const staffService = new StaffService();

describe("Staff Onboarding Notification Producer", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const fakeSession = { id: "staff-session" };
    mockRunInTransaction.mockImplementation(async (fn) => fn(fakeSession));
    mockSeqFindOneAndUpdate.mockResolvedValue({ seq: 1 });
    mockStaffBranchAssign.mockResolvedValue({});
    mockAuditLog.mockResolvedValue({});
    mockCreateOutboxEvent.mockResolvedValue({ _id: new mongoose.Types.ObjectId() });
    jest.spyOn(mongoose, "model").mockReturnValue({
      findOne: jest.fn().mockResolvedValue({ _id: new mongoose.Types.ObjectId(), isActive: true }),
      find: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          session: jest.fn().mockResolvedValue([]),
        }),
      }),
    });
  });

  it("createStaff emits user.welcome_credentials without secrets when userId is linked", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const actorId = new mongoose.Types.ObjectId();
    const staffId = new mongoose.Types.ObjectId();

    mockUserFindById.mockResolvedValue({
      _id: userId,
      organizationId: orgId,
      status: "active",
      staffId: null,
    });
    mockStaffCreate.mockResolvedValue({
      _id: staffId,
      userId,
      staffCode: "STF-0001",
      firstName: "Asha",
      lastName: "Rao",
    });

    await staffService.createStaff(
      {
        firstName: "Asha",
        lastName: "Rao",
        userId: String(userId),
        branchId,
      },
      orgId,
      actorId,
    );

    expect(mockCreateOutboxEvent).toHaveBeenCalledTimes(1);
    const call = mockCreateOutboxEvent.mock.calls[0][0];
    expect(call).toEqual(
      expect.objectContaining({
        organizationId: orgId,
        branchId,
        eventType: "user.welcome_credentials",
        idempotencyKey: `user-welcome:${staffId}`,
        payload: {
          userId: String(userId),
          staffId: String(staffId),
          staffName: "Asha Rao",
        },
        session: { id: "staff-session" },
      }),
    );
    expect(call.payload).not.toHaveProperty("password");
    expect(call.payload).not.toHaveProperty("token");
  });

  it("createStaff skips user.welcome_credentials when no userId is linked", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    const actorId = new mongoose.Types.ObjectId();

    mockStaffCreate.mockResolvedValue({
      _id: new mongoose.Types.ObjectId(),
      userId: null,
      staffCode: "STF-0002",
      firstName: "Ravi",
      lastName: "Kumar",
    });

    await staffService.createStaff(
      {
        firstName: "Ravi",
        lastName: "Kumar",
        branchId,
      },
      orgId,
      actorId,
    );

    expect(mockCreateOutboxEvent).not.toHaveBeenCalled();
  });
});
