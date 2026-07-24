import { Queue } from "bullmq";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { URL } from "url";

const getRedisConnection = () => {
  let connectionUrl = env.REDIS_URL || env.REDIS_HOST;
  
  if (connectionUrl && (connectionUrl.startsWith("redis://") || connectionUrl.startsWith("rediss://") || connectionUrl.includes("://"))) {
    // Normalize user's potential command line typos
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
        password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
        username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
        maxRetriesPerRequest: null, // Required by BullMQ
      };
    } catch (err) {
      logger.error(`Failed to parse Redis URL: ${err.message}. Falling back to default host/port.`);
    }
  }
  
  return {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    maxRetriesPerRequest: null,
  };
};

const redisConnection = getRedisConnection();

const queues = {};

const createQueue = (name) => {
  try {
    const queue = new Queue(name, {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 1000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    });
    logger.info(`🚀 Queue initialized: ${name}`);
    return queue;
  } catch (error) {
    logger.error(`❌ Failed to initialize queue ${name}: ${error.message}`);
    throw error;
  }
};

// Lazy queue proxies to avoid connecting to Redis on file import
export const emailQueue = {
  add: (name, data, opts) => createQueue("email").add(name, data, opts),
};

export const smsQueue = {
  add: (name, data, opts) => createQueue("sms").add(name, data, opts),
};

export const whatsappQueue = {
  add: (name, data, opts) => createQueue("whatsapp").add(name, data, opts),
};

export const notificationQueue = {
  add: (name, data, opts) => createQueue("notification").add(name, data, opts),
};

export const reportsQueue = {
  add: (name, data, opts) => createQueue("reports").add(name, data, opts),
};
