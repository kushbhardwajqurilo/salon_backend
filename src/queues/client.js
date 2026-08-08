import { Queue } from "bullmq";
import { redisOptions } from "../config/redis.js";
import { logger } from "../utils/logger.js";

const queues = {};

const createQueue = (name) => {
  if (process.env.NODE_ENV === "test" || process.env.JEST_WORKER_ID !== undefined) {
    return {
      add: async (jobName, data) => ({ id: `mock-${name}-${Date.now()}` }),
      close: async () => {},
    };
  }

  if (queues[name]) {
    return queues[name];
  }
  try {
    const queue = new Queue(name, {
      connection: redisOptions,
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
    queues[name] = queue;
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
