import mongoose from "mongoose";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { auditPlugin } from "./plugins/audit.js";

// Register global plugins
mongoose.plugin(auditPlugin);

export const connectDB = async () => {
  try {
    const conn = await mongoose.connect(env.MONGO_URI);
    logger.info(`💾 MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    logger.error(`❌ MongoDB connection error: ${error.message}`);
    process.exit(1);
  }
};

mongoose.connection.on("disconnected", () => {
  logger.warn("💾 MongoDB disconnected! Attempting to reconnect...");
});

mongoose.connection.on("error", (err) => {
  logger.error(`💾 MongoDB connection error event: ${err.message}`);
});
