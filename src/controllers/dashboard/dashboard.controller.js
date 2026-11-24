import { DashboardOverviewService } from "../../services/dashboard/dashboardOverview.service.js";
import { DashboardOperationsService } from "../../services/dashboard/dashboardOperations.service.js";
import { DashboardAlertsService } from "../../services/dashboard/dashboardAlerts.service.js";
import { asyncHandler } from "../../utils/errors.js";

const overviewService = new DashboardOverviewService();
const operationsService = new DashboardOperationsService();
const alertsService = new DashboardAlertsService();

/**
 * Controller for GET /api/v1/dashboard/overview
 */
export const getOverview = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId; // undefined if org-wide access
  const userPermissions = req.user?.permissions || [];

  const result = await overviewService.getOverview(
    organizationId,
    branchId,
    req.query,
    userPermissions
  );

  res.status(200).json(result);
});

/**
 * Controller for GET /api/v1/dashboard/operations
 */
export const getOperations = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId;

  const result = await operationsService.getOperations(organizationId, branchId);

  res.status(200).json(result);
});

/**
 * Controller for GET /api/v1/dashboard/alerts
 */
export const getAlerts = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId;
  const userPermissions = req.user?.permissions || [];

  const result = await alertsService.getAlerts(
    organizationId,
    branchId,
    userPermissions
  );

  res.status(200).json(result);
});
