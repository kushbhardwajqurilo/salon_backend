import { jest } from "@jest/globals";
import mongoose from "mongoose";

const mockExpenseCreate = jest.fn();
const mockExpenseFindOne = jest.fn();
const mockOrganizationFindById = jest.fn();
const mockEmitExpenseOutboxEvent = jest.fn();
const mockSession = { id: "expense-lifecycle-session" };

jest.unstable_mockModule("../../models/expenses/expense.model.js", () => ({
  Expense: {
    create: mockExpenseCreate,
    findOne: mockExpenseFindOne,
  },
}));

jest.unstable_mockModule("../../models/expenses/pettyCash.model.js", () => ({
  PettyCashTransaction: { create: jest.fn() },
}));

jest.unstable_mockModule("../../models/organizations/organization.model.js", () => ({
  Organization: { findById: mockOrganizationFindById },
}));

jest.unstable_mockModule("../../models/sequence/sequence.model.js", () => ({
  Sequence: { findOneAndUpdate: jest.fn() },
}));

jest.unstable_mockModule("../../utils/transaction.js", () => ({
  runInTransaction: jest.fn(async (callback) => callback(mockSession)),
}));

jest.unstable_mockModule("../../services/expenses/expenseNotificationOutbox.service.js", () => ({
  emitExpenseOutboxEvent: mockEmitExpenseOutboxEvent,
}));

const { ExpenseService } = await import("../../services/expenses/expense.service.js");

function makeExpense(data) {
  const expense = {
    ...data,
    _id: new mongoose.Types.ObjectId(),
    save: jest.fn(async () => true),
    toJSON() {
      return { ...this, save: undefined, toJSON: undefined };
    },
  };
  return expense;
}

describe("Expense service notification transition conditions", () => {
  const organizationId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();
  const recorderId = new mongoose.Types.ObjectId();
  const approverId = new mongoose.Types.ObjectId();

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(ExpenseService, "getNextSequence").mockResolvedValue("EXP-TEST-0001");
    mockOrganizationFindById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ expenseApprovalThreshold: 5000 }),
    });
    mockExpenseCreate.mockImplementation(async ([data]) => [makeExpense(data)]);
    mockEmitExpenseOutboxEvent.mockResolvedValue({ created: true });
  });

  afterEach(() => jest.restoreAllMocks());

  it("emits only submitted for a newly pending expense and propagates the transaction session", async () => {
    const result = await ExpenseService.createExpense(
      organizationId,
      branchId,
      recorderId,
      {
        category: "maintenance",
        amount: 8000,
        paymentMethod: "bank_transfer",
        payeeName: "Vendor",
      },
    );

    expect(result.approvalStatus).toBe("pending_approval");
    expect(mockEmitExpenseOutboxEvent).toHaveBeenCalledTimes(1);
    expect(mockEmitExpenseOutboxEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "expense.submitted",
        operationId: "created",
        session: mockSession,
      }),
    );
    expect(mockEmitExpenseOutboxEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "expense.approved" }),
    );
  });

  it("emits only approved for an automatically approved expense", async () => {
    const result = await ExpenseService.createExpense(
      organizationId,
      branchId,
      recorderId,
      {
        category: "refreshments",
        amount: 5000,
        paymentMethod: "bank_transfer",
        payeeName: "Vendor",
      },
    );

    expect(result.approvalStatus).toBe("approved");
    expect(mockEmitExpenseOutboxEvent).toHaveBeenCalledTimes(1);
    expect(mockEmitExpenseOutboxEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "expense.approved",
        operationId: "auto-approved",
        session: mockSession,
      }),
    );
    expect(mockEmitExpenseOutboxEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "expense.submitted" }),
    );
  });

  it("emits approval only after transition and rejects repeat approval without another event", async () => {
    const expense = makeExpense({
      organizationId,
      branchId,
      expenseCode: "EXP-TEST-0002",
      approvalStatus: "pending_approval",
      paymentStatus: "settled",
      paymentMethod: "bank_transfer",
      amount: 8000,
      recordedBy: recorderId,
    });
    mockExpenseFindOne.mockReturnValue({
      session: jest.fn().mockResolvedValue(expense),
    });

    await ExpenseService.approveExpense(organizationId, expense._id, branchId, approverId);
    expect(expense.approvalStatus).toBe("approved");
    expect(mockEmitExpenseOutboxEvent).toHaveBeenCalledTimes(1);
    expect(mockEmitExpenseOutboxEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "expense.approved", session: mockSession }),
    );

    await expect(
      ExpenseService.approveExpense(organizationId, expense._id, branchId, approverId),
    ).rejects.toThrow(/cannot be approved/i);
    expect(mockEmitExpenseOutboxEvent).toHaveBeenCalledTimes(1);
  });

  it("emits rejection only after transition and rejects repeat rejection without another event", async () => {
    const expense = makeExpense({
      organizationId,
      branchId,
      expenseCode: "EXP-TEST-0003",
      approvalStatus: "pending_approval",
      paymentStatus: "settled",
      paymentMethod: "bank_transfer",
      amount: 8000,
      recordedBy: recorderId,
    });
    mockExpenseFindOne.mockReturnValue({
      session: jest.fn().mockResolvedValue(expense),
    });

    await ExpenseService.rejectExpense(
      organizationId,
      expense._id,
      branchId,
      approverId,
      "Not supported",
    );
    expect(expense.approvalStatus).toBe("rejected");
    expect(mockEmitExpenseOutboxEvent).toHaveBeenCalledTimes(1);
    expect(mockEmitExpenseOutboxEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "expense.rejected", session: mockSession }),
    );

    await expect(
      ExpenseService.rejectExpense(
        organizationId,
        expense._id,
        branchId,
        approverId,
        "Repeated attempt",
      ),
    ).rejects.toThrow(/cannot be rejected/i);
    expect(mockEmitExpenseOutboxEvent).toHaveBeenCalledTimes(1);
  });
});
