import "server-only";

import { publishDailySpend } from "./datadog-metrics";
import { hourWindowMs } from "./spend-cap";
import { createUpstashSpendRedis } from "./upstash-spend-store";

const SPEND_TTL_SECONDS = 48 * 60 * 60;

export interface SpendRedis {
  get(key: string): Promise<string | number | null>;
  incrby(key: string, increment: number): Promise<number>;
  expire(key: string, seconds: number): Promise<void>;
  zremrangebyscore(key: string, min: number, max: number): Promise<void>;
  zadd(key: string, score: number, member: string): Promise<void>;
  pexpire(key: string, milliseconds: number): Promise<void>;
  zcard(key: string): Promise<number>;
}

export interface SpendStore {
  /** Plans from this IP in the trailing hour, after recording this one. */
  recordPlan(ip: string, nowMs: number): Promise<number>;
  readDailyMicros(day: string): Promise<number>;
  addDailyMicros(day: string, micros: number): Promise<number>;
}

function planKey(ip: string): string {
  return `nightcap:v1:plans:${ip}`;
}

function spendKey(day: string): string {
  return `nightcap:v1:spend:${day}`;
}

function parseMicros(raw: string | number | null): number {
  if (raw === null) return 0;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("stored daily spend is not a non-negative integer");
  }
  return parsed;
}

export function createSpendStore(redis: SpendRedis): SpendStore {
  return {
    async recordPlan(ip, nowMs) {
      const key = planKey(ip);
      const windowMs = hourWindowMs();
      await redis.zremrangebyscore(key, 0, nowMs - windowMs);
      await redis.zadd(key, nowMs, `${nowMs}:${crypto.randomUUID()}`);
      await redis.pexpire(key, windowMs);
      return redis.zcard(key);
    },
    async readDailyMicros(day) {
      const micros = parseMicros(await redis.get(spendKey(day)));
      // This total includes Places and Routes. Model cost tags do not.
      publishDailySpend(micros);
      return micros;
    },
    async addDailyMicros(day, micros) {
      if (!Number.isSafeInteger(micros) || micros < 0) {
        throw new Error("daily spend increment must be a non-negative integer");
      }
      const key = spendKey(day);
      if (micros === 0) {
        const current = parseMicros(await redis.get(key));
        publishDailySpend(current);
        return current;
      }
      const next = await redis.incrby(key, micros);
      await redis.expire(key, SPEND_TTL_SECONDS);
      publishDailySpend(next);
      return next;
    },
  };
}

export function createMemorySpendRedis(): SpendRedis {
  const values = new Map<string, number>();
  const sets = new Map<string, Map<string, number>>();
  const deadlines = new Map<string, number>();

  function live(key: string): void {
    const deadline = deadlines.get(key);
    if (deadline !== undefined && Date.now() >= deadline) {
      values.delete(key);
      sets.delete(key);
      deadlines.delete(key);
    }
  }

  return {
    async get(key) {
      live(key);
      const value = values.get(key);
      return value === undefined ? null : value;
    },
    async incrby(key, increment) {
      live(key);
      const next = (values.get(key) ?? 0) + increment;
      values.set(key, next);
      return next;
    },
    async expire(key, seconds) {
      deadlines.set(key, Date.now() + seconds * 1000);
    },
    async pexpire(key, milliseconds) {
      deadlines.set(key, Date.now() + milliseconds);
    },
    async zremrangebyscore(key, min, max) {
      const set = sets.get(key);
      if (set === undefined) return;
      for (const [member, score] of set) {
        if (score >= min && score <= max) set.delete(member);
      }
    },
    async zadd(key, score, member) {
      const set = sets.get(key) ?? new Map<string, number>();
      set.set(member, score);
      sets.set(key, set);
    },
    async zcard(key) {
      return sets.get(key)?.size ?? 0;
    },
  };
}

function isUpstashRestUrl(url: string): boolean {
  return url.startsWith("https://");
}

export function createSpendStoreFromEnv(
  env: Record<string, string | undefined> = process.env,
  connect: (url: string, token: string) => SpendRedis = createUpstashSpendRedis,
): SpendStore {
  const url = env.UPSTASH_REDIS_REST_URL?.trim();
  const token = env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (url && token && isUpstashRestUrl(url)) return createSpendStore(connect(url, token));
  if (url && token) {
    console.warn(
      "[monitoring] UPSTASH_REDIS_REST_URL must start with https://; using in-memory spend store",
    );
  }
  return createSpendStore(createMemorySpendRedis());
}
