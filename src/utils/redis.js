import Redis from "ioredis";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

let redisClient;

if (env.NODE_ENV !== "test") {
  redisClient = new Redis({
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
  });

  redisClient.on("connect", () => {
    logger.info("🔌 Connected to Redis successfully");
  });

  redisClient.on("error", (err) => {
    logger.error(`🔌 Redis connection error: ${err.message}`);
  });
} else {
  // Lightweight mock for test mode to prevent connection timeouts/failures
  redisClient = {
    get: async () => null,
    set: async () => "OK",
    setex: async () => "OK",
    del: async () => 1,
    quit: async () => {},
  };
}

export const redis = redisClient;
export default redis;
