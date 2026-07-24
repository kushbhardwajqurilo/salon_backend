import { Queue } from "bullmq";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

const redisConnection = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
};

const queues = {};

const getQueue = (name) => {
  if (!queues[name]) {
    queues[name] = new Queue(name, {
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
  }
  return queues[name];
};

// Lazy queue proxies to avoid connecting to Redis on file import
export const emailQueue = {
  add: (name, data, opts) => getQueue("email").add(name, data, opts),
};

export const smsQueue = {
  add: (name, data, opts) => getQueue("sms").add(name, data, opts),
};

export const whatsappQueue = {
  add: (name, data, opts) => getQueue("whatsapp").add(name, data, opts),
};

export const notificationQueue = {
  add: (name, data, opts) => getQueue("notification").add(name, data, opts),
};

export const reportsQueue = {
  add: (name, data, opts) => getQueue("reports").add(name, data, opts),
};
