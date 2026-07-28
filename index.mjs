import crypto from "crypto";
// Polyfill global crypto for Node.js versions < 19 (e.g. Node 16)
if (!globalThis.crypto) {
  globalThis.crypto = crypto;
}

import app from "./app.mjs";
import { env } from "./src/config/env.js";
import { connectDB } from "./src/database/db.js";
import { logger } from "./src/utils/logger.js";
import mongoose from "mongoose";

let server;

const serverStart = async () => {
  try {
    // 1. Connect to MongoDB Database
    await connectDB();

    // 2. Start Express Web Server
    server = app.listen(env.PORT, () => {
      logger.info(`🚀 Unisex Parlour ERP Server running in [${env.NODE_ENV}] mode on port ${env.PORT}`);
    });

  } catch (error) {
    logger.error(`❌ Server failed to start: ${error.message}`);
    process.exit(1);
  }
};

// Graceful Shutdown Handler
const gracefulShutdown = (signal) => {
  logger.warn(`⚠️ Received ${signal}. Starting graceful shutdown...`);

  if (server) {
    server.close(async () => {
      logger.info("🛑 Express server stopped.");
      try {
        await mongoose.connection.close();
        logger.info("💾 Database connection closed safely.");
        process.exit(0);
      } catch (err) {
        logger.error(`❌ Error during database shutdown connection close: ${err.message}`);
        process.exit(1);
      }
    });
  } else {
    process.exit(0);
  }
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Start Execution
serverStart();

// "seed": "node src/seed/seed.js",
// "permissions:sync": "node src/scripts/syncPermissions.js"