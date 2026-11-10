import dns from "dns";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { auditPlugin } from "./plugins/audit.js";

// Ensure public DNS fallback for MongoDB Atlas SRV lookups on local environments
try {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch (_) {}

// Register global plugins
mongoose.plugin(auditPlugin);

export const connectDB = async () => {
  try {
    if (!env.MONGO_URI || !env.MONGO_URI.startsWith("mongodb+srv://")) {
      throw new Error("Atlas-only policy: MONGO_URI must be a valid Atlas SRV connection string (mongodb+srv://... targeting *.mongodb.net).");
    }
    const hostPart = env.MONGO_URI.replace("mongodb+srv://", "").split("/")[0].split("?")[0];
    const hostWithoutAuth = hostPart.includes("@") ? hostPart.split("@")[1] : hostPart;
    const cleanHost = hostWithoutAuth.split(":")[0].toLowerCase();
    if (!cleanHost.endsWith(".mongodb.net")) {
      throw new Error(`Atlas-only policy: Host '${cleanHost}' is not a valid MongoDB Atlas domain (*.mongodb.net).`);
    }
    const conn = await mongoose.connect(env.MONGO_URI);
    await mongoose.connection.syncIndexes();
    logger.info(`💾 MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.log("Databse Error", error);
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
