import "server-only";

import { Redis } from "@upstash/redis";

import type { SpendRedis } from "./spend-store";

export function createUpstashSpendRedis(url: string, token: string): SpendRedis {
  const redis = new Redis({ url, token });
  return {
    get: (key) => redis.get<string | number>(key),
    incrby: (key, increment) => redis.incrby(key, increment),
    expire: async (key, seconds) => {
      await redis.expire(key, seconds);
    },
    pexpire: async (key, milliseconds) => {
      await redis.pexpire(key, milliseconds);
    },
    zremrangebyscore: async (key, min, max) => {
      await redis.zremrangebyscore(key, min, max);
    },
    zadd: async (key, score, member) => {
      await redis.zadd(key, { score, member });
    },
    zcard: (key) => redis.zcard(key),
  };
}
