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
import { apiLimiter, speedLimiter, sanitizeData } from "./src/middleware/security.js";
import { globalErrorHandler } from "./src/utils/errors.js";
//
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

// block common attack paths(.env)
app.use((req, res, next) => {
    if (req.url.includes(".env")) {
        return res.status(403).send("Forbidden");
    }
    next();
});

// CORS
const allowOrigins = [
    process.env.NODE_ENV === "production" ? "https://theglamup.in" : "http://localhost:3000",
    process.env.NODE_ENV === "production" ? "https://theglamup.in" : "https://l3zz8htl-3000.inc1.devtunnels.ms"
];

const corsOptions = {
    origin: function (origin, callback) {
        if (!origin || allowOrigins.includes(origin)) {
            callback(null, true);
        } else {
            console.warn(`Cors Blocked: ${origin}`);
            callback(new Error("Not allowed by CORS"));
        }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Branch-Id", "x-branch-id"]
};

app.use(cors(corsOptions));

// Speed limiter & API rate limiter for standard routes
app.use(speedLimiter);
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
