import Redis from "ioredis";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

let redisClient;

const getRedisConnection = () => {
  let connectionUrl = env.REDIS_URL || env.REDIS_HOST;
  
  if (connectionUrl && (connectionUrl.startsWith("redis://") || connectionUrl.startsWith("rediss://") || connectionUrl.includes("://"))) {
    // Normalize user's potential command line typos
    if (connectionUrl.includes("redis-cli-uredis://")) {
      connectionUrl = connectionUrl.replace("redis-cli-uredis://", "redis://");
    } else if (connectionUrl.includes("redis-cli -u ")) {
      connectionUrl = connectionUrl.replace("redis-cli -u ", "");
    }
    return connectionUrl;
  }
  
  return {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
  };
};

if (env.NODE_ENV !== "test") {
  const connection = getRedisConnection();
  
  if (typeof connection === "string") {
    redisClient = new Redis(connection);
  } else {
    redisClient = new Redis(connection);
  }

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
