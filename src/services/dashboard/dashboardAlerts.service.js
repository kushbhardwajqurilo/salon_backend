import mongoose from "mongoose";
import { StockBalance } from "../../models/inventory/stockBalance.model.js";
import { Leave } from "../../models/leaves/leave.model.js";
import { SupplierInvoice } from "../../models/procurement/supplierInvoice.model.js";
import { CustomerMembership } from "../../models/memberships/customerMembership.model.js";
import { Attendance } from "../../models/attendance/attendance.model.js";
import { logger } from "../../utils/logger.js";

export class DashboardAlertsService {
  /**
   * Generates real-time actionable business exceptions across modules, filtered by user permissions.
   */
  async getAlerts(organizationId, branchId, userPermissions = []) {
    const alerts = [];
    const now = new Date();

    const scope = {
      organizationId: new mongoose.Types.ObjectId(organizationId),
      isDeleted: { $ne: true },
    };
    if (branchId) {
      scope.branchId = new mongoose.Types.ObjectId(branchId);
    }

    // 1. Inventory Stockout & Depletion Alerts (Requires inventory.view)
    if (userPermissions.includes("inventory.view")) {
      try {
        const stockScope = {
          organizationId: new mongoose.Types.ObjectId(organizationId),
        };
        if (branchId) {
          stockScope.branchId = new mongoose.Types.ObjectId(branchId);
        }

        const outOfStockItems = await StockBalance.aggregate([
          { $match: stockScope },
          {
            $lookup: {
              from: "products",
              localField: "productId",
              foreignField: "_id",
              as: "product",
            },
          },
          { $unwind: "$product" },
          {
            $match: {
              "product.isDeleted": { $ne: true },
              "product.status": "active",
              onHand: 0,
            },
          },
          { $limit: 10 },
        ]);

        if (outOfStockItems.length > 0) {
          alerts.push({
            id: "ALERT_INV_OUT_OF_STOCK",
            category: "inventory",
            severity: "critical",
            title: `${outOfStockItems.length} Products Completely Out of Stock`,
            description: `${outOfStockItems
              .map((i) => i.product.name)
              .slice(0, 3)
              .join(
                ", ",
              )}${outOfStockItems.length > 3 ? " and others" : ""} have zero quantity on hand. Immediate replenishment required.`,
            sourceModule: "Inventory",
            targetUrl: "/inventory",
            actionLabel: "Reorder Stock",
            count: outOfStockItems.length,
            timestamp: now.toISOString(),
          });
        }

        const lowStockItems = await StockBalance.aggregate([
          { $match: stockScope },
          {
            $lookup: {
              from: "products",
              localField: "productId",
              foreignField: "_id",
              as: "product",
            },
          },
          { $unwind: "$product" },
          {
            $match: {
              "product.isDeleted": { $ne: true },
              "product.status": "active",
              $expr: {
                $and: [
                  { $gt: ["$onHand", 0] },
                  { $lte: ["$onHand", "$product.reorderLevel"] },
                ],
              },
            },
          },
          { $limit: 10 },
        ]);

        if (lowStockItems.length > 0) {
          alerts.push({
            id: "ALERT_INV_LOW_STOCK",
            category: "inventory",
            severity: "warning",
            title: `${lowStockItems.length} Products Below Reorder Level`,
            description: `${lowStockItems
              .map((i) => i.product.name)
              .slice(0, 3)
              .join(", ")} are nearing depletion.`,
            sourceModule: "Inventory",
            targetUrl: "/inventory",
            actionLabel: "View Inventory",
            count: lowStockItems.length,
            timestamp: now.toISOString(),
          });
        }
      } catch (err) {
        logger.error(`Error aggregating inventory alerts: ${err.message}`);
      }
    }

    // 2. Pending Staff Leave Requests (Requires employees.leaves.view)
    if (userPermissions.includes("employees.leaves.view")) {
      try {
        const pendingLeaves = await Leave.countDocuments({
          organizationId: new mongoose.Types.ObjectId(organizationId),
          status: "pending",
          isDeleted: { $ne: true },
        });

        if (pendingLeaves > 0) {
          alerts.push({
            id: "ALERT_HR_PENDING_LEAVES",
            category: "hr",
            severity: "warning",
            title: `${pendingLeaves} Staff Leave Requests Awaiting Approval`,
            description: `Employees have submitted leave requests requiring management review and decision.`,
            sourceModule: "Leaves",
            targetUrl: "/leaves",
            actionLabel: "Review Requests",
            count: pendingLeaves,
            timestamp: now.toISOString(),
          });
        }
      } catch (err) {
        logger.error(`Error aggregating leave alerts: ${err.message}`);
      }
    }

    // 3. Overdue Supplier Payables (Requires procurement.orders.view)
    if (userPermissions.includes("procurement.orders.view")) {
      try {
        const overdueInvoices = await SupplierInvoice.aggregate([
          {
            $match: {
              ...scope,
              status: { $in: ["unpaid", "partially_paid"] },
              dueDate: { $lt: now },
            },
          },
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              totalOverdue: {
                $sum: { $subtract: ["$totalAmount", "$amountPaid"] },
              },
            },
          },
        ]);

        if (overdueInvoices.length > 0 && overdueInvoices[0].count > 0) {
          alerts.push({
            id: "ALERT_PROC_OVERDUE_SUPPLIER_PAYMENTS",
            category: "finance",
            severity: "warning",
            title: `${overdueInvoices[0].count} Overdue Supplier Invoices`,
            description: `Total overdue supplier payables: ₹${Number(overdueInvoices[0].totalOverdue.toFixed(2))}. Settle invoices to preserve supply chains.`,
            sourceModule: "Procurement",
            targetUrl: "/procurement",
            actionLabel: "Settle Invoices",
            count: overdueInvoices[0].count,
            timestamp: now.toISOString(),
          });
        }
      } catch (err) {
        logger.error(`Error aggregating procurement alerts: ${err.message}`);
      }
    }

    // 4. Customer Memberships Expiring Soon (Requires memberships.view)
    if (userPermissions.includes("memberships.view")) {
      try {
        const sevenDaysFuture = new Date(
          now.getTime() + 7 * 24 * 60 * 60 * 1000,
        );
        const memScope = {
          organizationId: new mongoose.Types.ObjectId(organizationId),
          status: { $in: ["active", "pending_payment"] },
          startDate: { $lte: now },
          endDate: { $gte: now, $lte: sevenDaysFuture },
          isDeleted: { $ne: true },
        };
        if (branchId) {
          memScope.$or = [
            { permittedBranchIds: new mongoose.Types.ObjectId(branchId) },
            { permittedBranchIds: { $size: 0 } },
          ];
        }

        const expiringCount = await CustomerMembership.countDocuments(memScope);
        if (expiringCount > 0) {
          alerts.push({
            id: "ALERT_MEMBERSHIP_EXPIRING",
            category: "memberships",
            severity: "info",
            title: `${expiringCount} Memberships Expiring Within 7 Days`,
            description: `Reach out to members to prompt renewal and offer personalized package benefits.`,
            sourceModule: "Memberships",
            targetUrl: "/memberships",
            actionLabel: "View Memberships",
            count: expiringCount,
            timestamp: now.toISOString(),
          });
        }
      } catch (err) {
        logger.error(`Error aggregating membership alerts: ${err.message}`);
      }
    }

    // 5. Unreconciled Attendance Conflicts (Requires attendance.view)
    if (userPermissions.includes("attendance.view")) {
      try {
        const unreconciledConflicts = await Attendance.countDocuments({
          organizationId: new mongoose.Types.ObjectId(organizationId),
          ...(branchId
            ? { branchId: new mongoose.Types.ObjectId(branchId) }
            : {}),
          isReconciled: false,
          conflictType: { $ne: "none" },
          isDeleted: { $ne: true },
        });

        if (unreconciledConflicts > 0) {
          alerts.push({
            id: "ALERT_ATTENDANCE_CONFLICTS",
            category: "operations",
            severity: "warning",
            title: `${unreconciledConflicts} Attendance Conflicts Require Reconciliation`,
            description: `Discrepancies detected between punch events, shifts, and leave records.`,
            sourceModule: "Attendance",
            targetUrl: "/attendance",
            actionLabel: "Reconcile Attendance",
            count: unreconciledConflicts,
            timestamp: now.toISOString(),
          });
        }
      } catch (err) {
        logger.error(`Error aggregating attendance alerts: ${err.message}`);
      }
    }

    // Sort alerts: critical first, then warning, then info
    const priority = { critical: 1, warning: 2, info: 3 };
    alerts.sort(
      (a, b) => (priority[a.severity] || 4) - (priority[b.severity] || 4),
    );

    return {
      success: true,
      meta: {
        organizationId: organizationId.toString(),
        branchId: branchId ? branchId.toString() : null,
        totalAlerts: alerts.length,
        generatedAt: now.toISOString(),
      },
      alerts,
    };
  }
}
