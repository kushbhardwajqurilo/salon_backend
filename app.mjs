import crypto from "crypto";
// Polyfill global crypto for Node.js versions < 19
if (!globalThis.crypto) {
  globalThis.crypto = crypto;
}

import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import compression from "compression";

import authRouter from "./src/routers/auth/auth.routes.js";
import customerRouter from "./src/routers/customers/customer.routes.js";
import rbacRouter from "./src/routers/rbac/rbac.routes.js";
import branchRouter from "./src/routers/branches/branch.routes.js";
import serviceRouter from "./src/routers/services/service.routes.js";
import staffRouter from "./src/routers/staff/staff.routes.js";
import userRouter from "./src/routers/users/user.routes.js";
import leaveRouter from "./src/routers/leaves/leave.router.js";
import appointmentRouter from "./src/routers/appointments/appointment.router.js";
import auditLogRouter from "./src/routers/audit/auditLog.routes.js";
import subscriptionRouter from "./src/routers/subscriptions/subscription.routes.js";
import subscriptionPlanRouter from "./src/routers/subscriptions/subscriptionPlan.routes.js";
import billingRouter from "./src/routers/billing/billing.router.js";
import loyaltyRouter from "./src/routers/loyalty/loyalty.router.js";
import inventoryRouter from "./src/routers/inventory/inventory.routes.js";
import procurementRouter from "./src/routers/procurement/procurement.routes.js";
import attendanceRouter from "./src/routers/attendance/attendance.router.js";
import payrollRouter from "./src/routers/payroll/payroll.routes.js";
import couponRouter from "./src/routers/coupons/coupon.routes.js";
import incentivesRouter from "./src/routers/incentives/incentives.routes.js";
import membershipRouter from "./src/routers/memberships/membership.routes.js";
import expenseRouter from "./src/routers/expenses/expense.routes.js";
import financeRouter from "./src/routers/finance/finance.routes.js";
import campaignRouter from "./src/routers/marketing/campaign.routes.js";
import reportRouter from "./src/routers/reports/reports.routes.js";
import dashboardRouter from "./src/routers/dashboard/dashboard.routes.js";
import settingsRouter from "./src/routers/settings/settings.routes.js";
import uploadRouter from "./src/routers/upload.routes.js";
import {
  apiLimiter,
  speedLimiter,
  sanitizeData,
} from "./src/middleware/security.js";
import { globalErrorHandler } from "./src/utils/errors.js";

const app = express();

// for vps + nginx (1 means trust first proxy, e.g. Nginx, dev tunnels)
app.set("trust proxy", 1);

// // disable express fingerprint x-powered-by
// app.disable("x-powered-by");

// Global Security & Optimization Middlewares
app.use(helmet());
app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
// app.use(sanitizeData);

// Top-level HTTP Request Logger for debugging all incoming requests
app.use((req, res, next) => {
  console.log(
    `📥 [HTTP] ${req.method} ${req.originalUrl} | Auth: ${req.headers.authorization ? "Bearer token attached" : "NO AUTH HEADER"} | Origin: ${req.headers.origin || "no origin"}`,
  );
  next();
});

// block common attack paths(.env)
app.use((req, res, next) => {
  if (req.url.includes(".env")) {
    return res.status(403).send("Forbidden");
  }
  next();
});

// CORS
const configuredCorsOrigins = (process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const allowOrigins = [
  "https://theglamup.in",
  "https://www.theglamup.in",
  ...configuredCorsOrigins,
];

const corsOptions = {
  origin: function (origin, callback) {
    // Allow non-browser requests (e.g. curl, server-to-server) where origin is undefined
    if (!origin) {
      return callback(null, true);
    }

    // In development/test mode, allow localhost, 127.0.0.1, LAN private IPs, and devtunnels
    if (process.env.NODE_ENV !== "production") {
      const isLocalhost =
        origin.startsWith("http://localhost:") ||
        origin.startsWith("http://127.0.0.1:") ||
        origin.startsWith("http://192.168.") ||
        origin.startsWith("http://10.") ||
        origin.startsWith("http://172.16.") ||
        origin.endsWith(".devtunnels.ms");

      if (isLocalhost || allowOrigins.includes(origin)) {
        return callback(null, true);
      }
    }

    if (allowOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`Cors Blocked: ${origin}`);
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Branch-Id",
    "x-branch-id",
    "Idempotency-Key",
    "X-Idempotency-Key",
  ],
  exposedHeaders: ["Idempotency-Key", "X-Idempotency-Key"],
};

app.use(cors(corsOptions));
// Make preflight handling explicit so every mounted API router, including
// lifecycle action routes such as /incentives/schemes/:id/activate, receives
// the same CORS response before authentication/authorization middleware.
app.options(/.*/, cors(corsOptions));

// Speed limiter & API rate limiter for standard routes
// app.use(speedLimiter); 
app.use("/api", apiLimiter);

// DEBUG Logger for non-production
if (process.env.NODE_ENV !== "production") {
  app.use((req, res, next) => {
    console.log("🔥", req.method, req.url);
    next();
  });
}

// Routes
app.use("/api/v1/auth", authRouter);
app.use("/api/v1/customers", customerRouter);
app.use("/api/v1/rbac", rbacRouter);
app.use("/api/v1/branches", branchRouter);
app.use("/api/v1/services", serviceRouter);
app.use("/api/v1/staff", staffRouter);
app.use("/api/v1/users", userRouter);
app.use("/api/v1/leaves", leaveRouter);
app.use("/api/v1/appointments", appointmentRouter);
app.use("/api/v1/audit-logs", auditLogRouter);
app.use("/api/v1/subscriptions", subscriptionRouter);
app.use("/api/v1/subscription-plans", subscriptionPlanRouter);
app.use("/api/v1/billing", billingRouter);
app.use("/api/v1/loyalty", loyaltyRouter);
app.use("/api/v1/inventory", inventoryRouter);
app.use("/api/v1/procurement", procurementRouter);
app.use("/api/v1/attendance", attendanceRouter);
app.use("/api/v1/payroll", payrollRouter);
app.use("/api/v1/coupons", couponRouter);
app.use("/api/v1/incentives", incentivesRouter);
app.use("/api/v1/memberships", membershipRouter);
app.use("/api/v1/expenses", expenseRouter);
app.use("/api/v1/finance", financeRouter);
app.use("/api/v1/marketing/campaigns", campaignRouter);
app.use("/api/v1/reports", reportRouter);
app.use("/api/v1/dashboard", dashboardRouter);
app.use("/api/v1/settings", settingsRouter);
app.use("/api/upload", uploadRouter);
app.use("/api/v1/upload", uploadRouter);

// health check endpoint for server
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Global Error Handler
app.use(globalErrorHandler);

export default app;
