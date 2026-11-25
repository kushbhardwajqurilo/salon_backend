import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { DashboardOverviewService } from "../../services/dashboard/dashboardOverview.service.js";
import { DashboardOperationsService } from "../../services/dashboard/dashboardOperations.service.js";
import { DashboardAlertsService } from "../../services/dashboard/dashboardAlerts.service.js";
import { Invoice } from "../../models/billing/invoice.model.js";
import { Payment } from "../../models/billing/payment.model.js";
import { Appointment } from "../../models/appointments/appointment.model.js";
import { Customer } from "../../models/customers/customer.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Expense } from "../../models/expenses/expense.model.js";
import { CustomerMembership } from "../../models/memberships/customerMembership.model.js";
import { Subscription } from "../../models/subscriptions/subscription.model.js";
import { SubscriptionUsage } from "../../models/subscriptions/subscriptionUsage.model.js";
import { Attendance } from "../../models/attendance/attendance.model.js";
import { AttendancePunch } from "../../models/attendance/attendancePunch.model.js";
import { Leave } from "../../models/leaves/leave.model.js";
import { StaffBranch } from "../../models/staff/staffBranch.model.js";

describe("Dashboard Accuracy & Permission Regression Tests (Unit)", () => {
  const orgId = new mongoose.Types.ObjectId().toString();
  const branchA = new mongoose.Types.ObjectId().toString();

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(Branch, "findOne").mockReturnValue({
      select: jest.fn().mockResolvedValue({ name: "Branch A" }),
    });
    jest.spyOn(Branch, "find").mockReturnValue({
      select: jest.fn().mockResolvedValue([{ _id: new mongoose.Types.ObjectId(branchA), name: "Branch A" }]),
    });
  });

  test("Subscription redemptions query uses createdAt, branchId, and excludes reversed/deleted", async () => {
    const usageSpy = jest.spyOn(SubscriptionUsage, "countDocuments").mockResolvedValue(4);
    jest.spyOn(Subscription, "countDocuments").mockResolvedValue(2);
    jest.spyOn(Invoice, "aggregate").mockResolvedValue([]);
    jest.spyOn(Payment, "aggregate").mockResolvedValue([]);
    jest.spyOn(Appointment, "aggregate").mockResolvedValue([]);
    jest.spyOn(Customer, "countDocuments").mockResolvedValue(0);
    jest.spyOn(Customer, "aggregate").mockResolvedValue([]);

    const service = new DashboardOverviewService();
    const res = await service.getOverview(
      orgId,
      branchA,
      { startDate: "2026-11-01", endDate: "2026-11-25", compareWith: "none" },
      ["dashboard.view", "subscriptions.view"]
    );

    expect(usageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: new mongoose.Types.ObjectId(orgId),
        branchId: new mongoose.Types.ObjectId(branchA),
        isReversed: { $ne: true },
        isDeleted: { $ne: true },
        createdAt: expect.objectContaining({ $gte: expect.any(Date), $lte: expect.any(Date) }),
      })
    );
    expect(res.subscriptions.redemptionsInPeriod).toBe(4);
  });

  test("Active memberships and subscriptions require startDate <= now and endDate >= now", async () => {
    const memCountSpy = jest.spyOn(CustomerMembership, "countDocuments").mockResolvedValue(3);
    const subCountSpy = jest.spyOn(Subscription, "countDocuments").mockResolvedValue(5);
    jest.spyOn(SubscriptionUsage, "countDocuments").mockResolvedValue(0);
    jest.spyOn(Invoice, "aggregate").mockResolvedValue([]);
    jest.spyOn(Payment, "aggregate").mockResolvedValue([]);
    jest.spyOn(Appointment, "aggregate").mockResolvedValue([]);
    jest.spyOn(Customer, "countDocuments").mockResolvedValue(0);
    jest.spyOn(Customer, "aggregate").mockResolvedValue([]);

    const service = new DashboardOverviewService();
    await service.getOverview(
      orgId,
      branchA,
      { startDate: "2026-11-01", endDate: "2026-11-25", compareWith: "none" },
      ["dashboard.view", "memberships.view", "subscriptions.view"]
    );

    expect(memCountSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        status: { $in: ["active", "pending_payment"] },
        startDate: { $lte: expect.any(Date) },
        endDate: { $gte: expect.any(Date) },
      })
    );
    expect(subCountSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        status: { $in: ["active", "pending_payment"] },
        startDate: { $lte: expect.any(Date) },
        endDate: { $gte: expect.any(Date) },
      })
    );
  });

  test("expenses.view without finance.view omits operatingCashMargin", async () => {
    jest.spyOn(Invoice, "aggregate").mockResolvedValue([]);
    jest.spyOn(Payment, "aggregate").mockResolvedValue([]);
    jest.spyOn(Appointment, "aggregate").mockResolvedValue([]);
    jest.spyOn(Customer, "countDocuments").mockResolvedValue(0);
    jest.spyOn(Customer, "aggregate").mockResolvedValue([]);
    jest.spyOn(Expense, "aggregate").mockResolvedValue([{ _id: "rent", amount: 1000 }]);

    const service = new DashboardOverviewService();
    const res = await service.getOverview(
      orgId,
      branchA,
      { startDate: "2026-11-01", endDate: "2026-11-25", compareWith: "none" },
      ["dashboard.view", "expenses.view", "payments.view"]
    );

    expect(res.finance.totalExpenses).toBe(1000);
    expect(res.finance.operatingCashMargin).toBeUndefined();
  });

  test("Operations service scopes ongoing appointments, pending leaves, and attendance conflicts to branch", async () => {
    const staffId = new mongoose.Types.ObjectId();
    jest.spyOn(StaffBranch, "find").mockReturnValue({
      populate: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          { staffId: { _id: staffId, name: "Alice", staffCode: "S1", designation: "Stylist", status: "active" } },
        ]),
      }),
    });
    const apptFindSpy = jest.spyOn(Appointment, "find").mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      populate: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    });
    const attFindSpy = jest.spyOn(Attendance, "find").mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    });
    const leaveFindSpy = jest.spyOn(Leave, "find").mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    });
    jest.spyOn(AttendancePunch, "find").mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    });
    const leaveCountSpy = jest.spyOn(Leave, "countDocuments").mockResolvedValue(0);
    const attCountSpy = jest.spyOn(Attendance, "countDocuments").mockResolvedValue(0);

    const opsService = new DashboardOperationsService();
    await opsService.getOperations(orgId, branchA);

    expect(apptFindSpy).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: new mongoose.Types.ObjectId(branchA) })
    );
    expect(leaveCountSpy).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: { $in: [staffId] } })
    );
    expect(attCountSpy).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: new mongoose.Types.ObjectId(branchA) })
    );
    expect(attFindSpy).toHaveBeenCalled();
    expect(leaveFindSpy).toHaveBeenCalled();
  });
});
