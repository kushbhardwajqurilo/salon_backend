import Redis from "ioredis";
import { env } from "./env.js";
import { logger } from "../utils/logger.js";
import { URL } from "url";

const parseRedisUrl = () => {
  let connectionUrl = env.REDIS_URL || env.REDIS_HOST;

  if (
    connectionUrl &&
    (connectionUrl.startsWith("redis://") ||
      connectionUrl.startsWith("rediss://") ||
      connectionUrl.includes("://"))
  ) {
    if (connectionUrl.includes("redis-cli-uredis://")) {
      connectionUrl = connectionUrl.replace("redis-cli-uredis://", "redis://");
    } else if (connectionUrl.includes("redis-cli -u ")) {
      connectionUrl = connectionUrl.replace("redis-cli -u ", "");
    }

    try {
      const parsed = new URL(connectionUrl);
      return {
        host: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 6379,
        password: parsed.password
          ? decodeURIComponent(parsed.password)
          : undefined,
        username: parsed.username
          ? decodeURIComponent(parsed.username)
          : undefined,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      };
    } catch (err) {
      logger.error(`Failed to parse Redis URL: ${err.message}`);
    }
  }

  return {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
};

export const redisOptions = parseRedisUrl();

let redisClient = null;

/**
 * Connects to Redis ONCE at server startup.
 */
export const connectRedis = async () => {
  if (process.env.NODE_ENV === "test" || process.env.JEST_WORKER_ID !== undefined) {
    logger.info("⚙️ Skipping Redis connection in TEST mode");
    return null;
  }

  if (!redisClient) {
    try {
      redisClient = new Redis(redisOptions);

      redisClient.on("connect", () => {
        logger.info("🔌 Redis connected successfully at server startup");
      });

      redisClient.on("error", (err) => {
        logger.warn(`⚠️ [REDIS_EVENT_WARN] ${err.message}`);
      });

      await redisClient.ping();
      logger.info("⚡ [REDIS_READY] Connection verified with PING at server startup");
    } catch (error) {
      logger.error(`❌ Failed to connect to Redis at server startup: ${error.message}`);
    }
  }
  return redisClient;
};

/**
 * Returns the single shared Redis client instance.
 */
export const getRedisClient = () => {
  if (!redisClient && process.env.NODE_ENV !== "test" && process.env.JEST_WORKER_ID === undefined) {
    redisClient = new Redis(redisOptions);
  }
  return redisClient;
};

/**
 * Cleanly disconnects the shared Redis client on server shutdown.
 */
export const disconnectRedis = async () => {
  if (redisClient) {
    try {
      await redisClient.quit();
      redisClient = null;
      logger.info("🛑 Shared Redis client disconnected safely");
    } catch (err) {
      logger.error(`❌ Error disconnecting Redis: ${err.message}`);
    }
  }
};
