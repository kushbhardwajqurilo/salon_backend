import { env } from "../config/env.js";
import { getRedisClient } from "../config/redis.js";

let redisClient;

if (env.NODE_ENV !== "test") {
  redisClient = getRedisClient();
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
