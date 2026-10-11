import "server-only";
import { z } from "zod";

import { MAX_TRAVEL_LEGS_PER_REQUEST_DEFAULT } from "../validation/bounds";
import {
  DEFAULT_PRICE_RANGES,
  DEFAULT_TRAVEL_BUDGET_MS,
  DEFAULT_TRAVEL_CAP_MINUTES,
  DEFAULT_TRAVEL_TOLERANCE_MINUTES,
} from "../validation/defaults";

/**
 * Preprocess an environment variable: treat empty or whitespace-only strings as undefined.
 * This ensures Zod defaults apply correctly and empty secrets don't fail at load time.
 */
function preprocessEnvVar(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Inclusive heuristic per-person USD pair. Rejects min > max.
 * Compared to estimatedCostUsd / partySize (default 2). */
const priceRangeSchema = z
  .tuple([z.number(), z.number()])
  .refine(([min, max]) => min <= max, {
    message: "Price range min must not exceed max",
  });

/** Parse `min,max` range env vars. Empty/whitespace → undefined (Zod default). */
function parseRange(value: string | undefined): [number, number] | undefined {
  const raw = preprocessEnvVar(value);
  if (!raw) return undefined;
  const parts = raw.split(",").map((part) => part.trim());
  const sides = z
    .tuple([
      z.string().min(1, "Price range side must not be empty"),
      z.string().min(1, "Price range side must not be empty"),
    ])
    .parse(parts);
  const numbers = z.tuple([z.coerce.number(), z.coerce.number()]).parse(sides);
  return priceRangeSchema.parse(numbers);
}

/** ENABLE_LIVE_ROUTES: only true/false/1/0. Unset/empty → false. */
function parseLiveRoutesFlag(value: string | undefined): boolean {
  const raw = preprocessEnvVar(value);
  if (raw === undefined) {
    return false;
  }
  const normalized = raw.toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  throw new Error(
    `ENABLE_LIVE_ROUTES must be true, false, 1, or 0 (got ${JSON.stringify(raw)})`
  );
}

/**
 * Coord TTL must be a plain decimal integer (reject 1e1, 0x1e, signs, decimals).
 */
function preprocessPlainInt(value: string | undefined): string | undefined {
  const trimmed = preprocessEnvVar(value);
  if (trimmed === undefined) return undefined;
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error(
      `Invalid PLACES_COORDS_CACHE_TTL_DAYS: expected a plain decimal integer, got ${JSON.stringify(trimmed)}`
    );
  }
  return trimmed;
}

/**
 * HMAC key used only in development and `npm test` when REQUEST_HASH_SECRET
 * is unset. Production startup rejects this value.
 */
export const DEV_TEST_REQUEST_HASH_SECRET =
  "nightcap-dev-test-request-hash-secret-not-for-production";

/**
 * Configuration schema with Zod validation.
 * Secrets must be provided; non-secrets have documented defaults.
 */
const configSchema = z.object({
  // API Keys - required secrets, fail at runtime when accessed if missing
  anthropicApiKey: z.string().min(1).optional(),
  googlePlacesApiKey: z.string().min(1).optional(),
  /** Datadog key. `DD_API_KEY` is the only name dd-trace reads. */
  ddApiKey: z.string().min(1).optional(),
  turnstileSecretKey: z.string().min(1).optional(),
  /**
   * HMAC-SHA256 key for the request hash attached to Datadog spans.
   * Required in production. Dev/test fall back to DEV_TEST_REQUEST_HASH_SECRET.
   */
  requestHashSecret: z.string().min(1).optional(),

  // Model IDs - defaults from architecture (Haiku 4-5 for parse, Sonnet 5 for others)
  parseModelId: z.string().min(1).default("claude-haiku-4-5"),
  planModelId: z.string().min(1).default("claude-sonnet-5"),
  repairModelId: z.string().min(1).default("claude-sonnet-5"),
  agentModelId: z.string().min(1).default("claude-sonnet-5"),

  // Coord cache TTL — Google allows lat/lng for at most 30 days; details are live
  placesCoordsCacheTtlDays: z.coerce.number().int().positive().max(30).default(30),

  // Rate Limits - from architecture: 5 plans/hour/IP
  rateLimitRequestsPerHour: z.coerce.number().int().positive().default(5),
  // Daily spend cap in USD across all requests
  rateLimitDailySpendUsd: z.coerce.number().positive().default(5),

  // Validation Caps - from architecture
  travelCapMinutes: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_TRAVEL_CAP_MINUTES),
  agentMaxToolCalls: z.coerce.number().int().positive().default(6),
  agentMaxCostUsdPerTurn: z.coerce.number().positive().default(0.03),
  repairMaxRounds: z.coerce.number().int().positive().default(2),
  maxTravelLegsPerRequest: z.coerce
    .number()
    .refine(
      (value) => Number.isInteger(value) && value >= 2 && value <= 9,
      { message: "MAX_TRAVEL_LEGS_PER_REQUEST must be an integer from 2 to 9" },
    )
    .default(MAX_TRAVEL_LEGS_PER_REQUEST_DEFAULT),

  // Routes API
  routesApiTimeoutMs: z.coerce.number().int().positive().default(5000),
  travelClaimToleranceMinutes: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(DEFAULT_TRAVEL_TOLERANCE_MINUTES),
  travelBudgetMs: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_TRAVEL_BUDGET_MS),
  enableLiveRoutes: z.boolean().default(false),

  // Places retrieval (decision-log #33). Retry count is not a knob: step 14 says "once".
  placesTimeoutMs: z.coerce.number().int().min(100).max(30_000).default(5000),
  placesRetryDelayMs: z.coerce.number().int().min(0).max(5000).default(300),
  placesMaxSearchesPerRequest: z.coerce.number().int().min(1).max(4).default(2),
  retrievalTopK: z.coerce.number().int().min(1).max(20).default(5),
  retrievalMinPerStop: z.coerce.number().int().min(1).max(20).default(3),
  retrievalMinOpenMinutes: z.coerce.number().int().min(15).max(240).default(60),
  rerankVibeWeight: z.coerce.number().min(0).max(10).default(1),
  rerankPopularityWeight: z.coerce.number().min(0).max(10).default(0.5),
  rerankReviewSoftCap: z.coerce.number().int().positive().default(2000),

  // Heuristic per-person USD ranges (not from Google). Format "min,max".
  // Validator compares estimatedCostUsd / partySize (default 2) to these.
  priceRangeFree: priceRangeSchema.default([
    ...DEFAULT_PRICE_RANGES.PRICE_LEVEL_FREE,
  ]),
  priceRangeInexpensive: priceRangeSchema.default([
    ...DEFAULT_PRICE_RANGES.PRICE_LEVEL_INEXPENSIVE,
  ]),
  priceRangeModerate: priceRangeSchema.default([
    ...DEFAULT_PRICE_RANGES.PRICE_LEVEL_MODERATE,
  ]),
  priceRangeExpensive: priceRangeSchema.default([
    ...DEFAULT_PRICE_RANGES.PRICE_LEVEL_EXPENSIVE,
  ]),
  priceRangeVeryExpensive: priceRangeSchema.default([
    ...DEFAULT_PRICE_RANGES.PRICE_LEVEL_VERY_EXPENSIVE,
  ]),
}).refine((cfg) => cfg.retrievalMinPerStop <= cfg.retrievalTopK, {
  message: "RETRIEVAL_MIN_PER_STOP must not exceed RETRIEVAL_TOP_K",
  path: ["retrievalMinPerStop"],
});

type Config = z.infer<typeof configSchema>;

/** Parsed and validated configuration. */
let config: Config | null = null;

/**
 * dd-trace reads only `DD_API_KEY`. A key left under the old alias would
 * select the Datadog exporter while the SDK sends nothing.
 */
function readDdApiKey(): string | undefined {
  const ddApiKey = preprocessEnvVar(process.env.DD_API_KEY);
  if (ddApiKey === undefined && preprocessEnvVar(process.env.DATADOG_API_KEY) !== undefined) {
    throw new Error(
      "DATADOG_API_KEY is set but DD_API_KEY is not: rename it to DD_API_KEY. dd-trace reads only DD_API_KEY.",
    );
  }
  return ddApiKey;
}

/**
 * Load and validate configuration from environment variables.
 * Non-secrets use sensible defaults; secrets are optional here but fail when accessed if missing.
 */
function loadConfig(): Config {
  if (config !== null) {
    return config;
  }

  const parsed = configSchema.parse({
    // API Keys - preprocess to handle empty strings
    anthropicApiKey: preprocessEnvVar(process.env.ANTHROPIC_API_KEY),
    googlePlacesApiKey: preprocessEnvVar(process.env.GOOGLE_PLACES_API_KEY),
    ddApiKey: readDdApiKey(),
    turnstileSecretKey: preprocessEnvVar(process.env.TURNSTILE_SECRET_KEY),
    requestHashSecret: preprocessEnvVar(process.env.REQUEST_HASH_SECRET),

    // Model IDs
    parseModelId: preprocessEnvVar(process.env.PARSE_MODEL_ID),
    planModelId: preprocessEnvVar(process.env.PLAN_MODEL_ID),
    repairModelId: preprocessEnvVar(process.env.REPAIR_MODEL_ID),
    agentModelId: preprocessEnvVar(process.env.AGENT_MODEL_ID),

    // Coord cache TTL
    placesCoordsCacheTtlDays: preprocessPlainInt(process.env.PLACES_COORDS_CACHE_TTL_DAYS),

    // Rate Limits
    rateLimitRequestsPerHour: preprocessEnvVar(process.env.RATE_LIMIT_REQUESTS_PER_HOUR),
    rateLimitDailySpendUsd: preprocessEnvVar(process.env.RATE_LIMIT_DAILY_SPEND_USD),

    // Validation Caps
    travelCapMinutes: preprocessEnvVar(process.env.TRAVEL_CAP_MINUTES),
    agentMaxToolCalls: preprocessEnvVar(process.env.AGENT_MAX_TOOL_CALLS),
    agentMaxCostUsdPerTurn: preprocessEnvVar(process.env.AGENT_MAX_COST_USD_PER_TURN),
    repairMaxRounds: preprocessEnvVar(process.env.REPAIR_MAX_ROUNDS),
    maxTravelLegsPerRequest: preprocessEnvVar(process.env.MAX_TRAVEL_LEGS_PER_REQUEST),

    routesApiTimeoutMs: preprocessEnvVar(process.env.ROUTES_API_TIMEOUT_MS),
    travelClaimToleranceMinutes: preprocessEnvVar(
      process.env.TRAVEL_CLAIM_TOLERANCE_MINUTES
    ),
    travelBudgetMs: preprocessEnvVar(process.env.TRAVEL_BUDGET_MS),
    enableLiveRoutes: parseLiveRoutesFlag(process.env.ENABLE_LIVE_ROUTES),
    placesTimeoutMs: preprocessEnvVar(process.env.PLACES_TIMEOUT_MS),
    placesRetryDelayMs: preprocessEnvVar(process.env.PLACES_RETRY_DELAY_MS),
    placesMaxSearchesPerRequest: preprocessEnvVar(process.env.PLACES_MAX_SEARCHES_PER_REQUEST),
    retrievalTopK: preprocessEnvVar(process.env.RETRIEVAL_TOP_K),
    retrievalMinPerStop: preprocessEnvVar(process.env.RETRIEVAL_MIN_PER_STOP),
    retrievalMinOpenMinutes: preprocessEnvVar(process.env.RETRIEVAL_MIN_OPEN_MINUTES),
    rerankVibeWeight: preprocessEnvVar(process.env.RERANK_VIBE_WEIGHT),
    rerankPopularityWeight: preprocessEnvVar(process.env.RERANK_POPULARITY_WEIGHT),
    rerankReviewSoftCap: preprocessEnvVar(process.env.RERANK_REVIEW_SOFT_CAP),
    priceRangeFree: parseRange(process.env.PRICE_RANGE_FREE),
    priceRangeInexpensive: parseRange(process.env.PRICE_RANGE_INEXPENSIVE),
    priceRangeModerate: parseRange(process.env.PRICE_RANGE_MODERATE),
    priceRangeExpensive: parseRange(process.env.PRICE_RANGE_EXPENSIVE),
    priceRangeVeryExpensive: parseRange(process.env.PRICE_RANGE_VERY_EXPENSIVE),
  });

  config = parsed;
  return parsed;
}

/**
 * Get a required secret, failing clearly if it's missing.
 * @param key - Name of the secret for error messages
 * @param value - The secret value (may be undefined)
 */
function requireSecret(key: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing required secret: ${key}. Set it in your environment or .env.local file.`
    );
  }
  return value;
}

/** Get configuration, loading it lazily on first access. */
export function getConfig(): Config {
  return loadConfig();
}

/** Get Anthropic API key, failing if not configured. */
export function getAnthropicApiKey(): string {
  const cfg = getConfig();
  return requireSecret("ANTHROPIC_API_KEY", cfg.anthropicApiKey);
}

/** Get Google Places API key, failing if not configured. */
export function getGooglePlacesApiKey(): string {
  const cfg = getConfig();
  return requireSecret("GOOGLE_PLACES_API_KEY", cfg.googlePlacesApiKey);
}

/** Get Datadog API key, failing if not configured. */
export function getDatadogApiKey(): string {
  const cfg = getConfig();
  return requireSecret("DD_API_KEY", cfg.ddApiKey);
}

/** Optional `DD_API_KEY` for the LLM Obs exporter. Missing is a no-op exporter, not a throw. */
export function getOptionalDdApiKey(): string | undefined {
  return getConfig().ddApiKey;
}

/**
 * HMAC key for request hashes. Dev and test use a marked fallback when
 * REQUEST_HASH_SECRET is unset. Production must set a real secret.
 */
export function getRequestHashSecret(): string {
  const configured = getConfig().requestHashSecret;
  if (configured) {
    return configured;
  }
  if (process.env.NODE_ENV === "production" && !isNextBuildPhase(process.env.NEXT_PHASE)) {
    throw new Error(
      "Missing required secret: REQUEST_HASH_SECRET. Production cannot use the marked dev/test HMAC key.",
    );
  }
  return DEV_TEST_REQUEST_HASH_SECRET;
}

/** Get Turnstile secret key, failing if not configured. */
export function getTurnstileSecretKey(): string {
  const cfg = getConfig();
  return requireSecret("TURNSTILE_SECRET_KEY", cfg.turnstileSecretKey);
}

/** Get parse model ID (Haiku 4-5 by default). */
export function getParseModelId(): string {
  return getConfig().parseModelId;
}

/** Get plan model ID (Sonnet 5 by default). */
export function getPlanModelId(): string {
  return getConfig().planModelId;
}

/** Get repair model ID (Sonnet 5 by default). */
export function getRepairModelId(): string {
  return getConfig().repairModelId;
}

/** Get agent model ID (Sonnet 5 by default). */
export function getAgentModelId(): string {
  return getConfig().agentModelId;
}

/** Get Places coordinate cache TTL in days (30 by default, max 30). */
export function getPlacesCoordsCacheTtlDays(): number {
  return getConfig().placesCoordsCacheTtlDays;
}

/** Get rate limit: requests per hour per IP (5 by default). */
export function getRateLimitRequestsPerHour(): number {
  return getConfig().rateLimitRequestsPerHour;
}

/** Get rate limit: daily spend cap in USD (100 by default). */
export function getRateLimitDailySpendUsd(): number {
  return getConfig().rateLimitDailySpendUsd;
}

/** Get travel cap in minutes (DEFAULT_TRAVEL_CAP_MINUTES by default). */
export function getTravelCapMinutes(): number {
  return getConfig().travelCapMinutes;
}

/** Get agent max tool calls per turn (6 by default). */
export function getAgentMaxToolCalls(): number {
  return getConfig().agentMaxToolCalls;
}

/** Get agent max cost in USD per turn (0.03 by default). */
export function getAgentMaxCostUsdPerTurn(): number {
  return getConfig().agentMaxCostUsdPerTurn;
}

/** Get repair max rounds (2 by default). */
export function getRepairMaxRounds(): number {
  return getConfig().repairMaxRounds;
}

/** Get max travel legs per request, summed across options (4 by default). */
export function getMaxTravelLegsPerRequest(): number {
  return getConfig().maxTravelLegsPerRequest;
}

/** Get Routes API timeout in milliseconds (5000 by default). */
export function getRoutesApiTimeoutMs(): number {
  return getConfig().routesApiTimeoutMs;
}

/** Get claimed-vs-computed travel tolerance in minutes. */
export function getTravelClaimToleranceMinutes(): number {
  return getConfig().travelClaimToleranceMinutes;
}

/** Wall-clock budget for one validation's travel calls (default 6000). */
export function getTravelBudgetMs(): number {
  return getConfig().travelBudgetMs;
}

/**
 * Live Google Routes is off unless ENABLE_LIVE_ROUTES is true/1.
 * Only true/false/1/0 are accepted; any other value throws.
 * Tests and eval use a fake or recorded calculator by default.
 */
export function getEnableLiveRoutes(): boolean {
  return getConfig().enableLiveRoutes;
}

/**
 * Heuristic per-person USD ranges for PRICE_LEVEL_* checks.
 * Not from Google. Overridable via PRICE_RANGE_* env vars.
 * Compared to estimatedCostUsd / partySize (default 2).
 */
export function getPriceRanges(): {
  free: [number, number];
  inexpensive: [number, number];
  moderate: [number, number];
  expensive: [number, number];
  veryExpensive: [number, number];
} {
  const cfg = getConfig();
  return {
    free: cfg.priceRangeFree,
    inexpensive: cfg.priceRangeInexpensive,
    moderate: cfg.priceRangeModerate,
    expensive: cfg.priceRangeExpensive,
    veryExpensive: cfg.priceRangeVeryExpensive,
  };
}

/** Places retrieval knobs (decision-log #33), grouped like getPriceRanges(). */
export interface RetrievalConfig {
  readonly placesTimeoutMs: number;
  readonly retryDelayMs: number;
  readonly maxSearches: number;
  readonly topK: number;
  readonly minPerStop: number;
  readonly minOpenMinutes: number;
  readonly vibeWeight: number;
  readonly popularityWeight: number;
  readonly reviewSoftCap: number;
}

export function getRetrievalSettings(): RetrievalConfig {
  const cfg = getConfig();
  return {
    placesTimeoutMs: cfg.placesTimeoutMs,
    retryDelayMs: cfg.placesRetryDelayMs,
    maxSearches: cfg.placesMaxSearchesPerRequest,
    topK: cfg.retrievalTopK,
    minPerStop: cfg.retrievalMinPerStop,
    minOpenMinutes: cfg.retrievalMinOpenMinutes,
    vibeWeight: cfg.rerankVibeWeight,
    popularityWeight: cfg.rerankPopularityWeight,
    reviewSoftCap: cfg.rerankReviewSoftCap,
  };
}

/**
 * Prod-only startup gate (#31). `next build` sets NODE_ENV=production, so this
 * must not run during a build phase — only when a production server starts.
 * Dev and test stay mock-friendly. Runtime Routes failures stay
 * `travel_service_unavailable`.
 */
function isNextBuildPhase(phase: string | undefined): boolean {
  if (phase && (phase.includes("build") || phase.includes("export"))) {
    return true;
  }
  return process.env.npm_lifecycle_event === "build";
}

export function assertProductionLiveRoutes(): void {
  if (process.env.NODE_ENV !== "production") {
    return;
  }
  if (isNextBuildPhase(process.env.NEXT_PHASE)) {
    return;
  }
  const cfg = getConfig();
  if (cfg.enableLiveRoutes && cfg.googlePlacesApiKey) {
    return;
  }
  throw new Error(
    "Production refuses to start without ENABLE_LIVE_ROUTES=true and GOOGLE_PLACES_API_KEY. Runtime Routes outages use travel_service_unavailable."
  );
}

/**
 * Prod-only startup gate for the request-hash HMAC key (#32).
 * `next build` sets NODE_ENV=production, so this must not run during a
 * build phase — only when a production server starts. The marked
 * DEV_TEST_REQUEST_HASH_SECRET is never valid in production.
 */
export function assertProductionRequestHashSecret(): void {
  if (process.env.NODE_ENV !== "production") {
    return;
  }
  if (isNextBuildPhase(process.env.NEXT_PHASE)) {
    return;
  }
  const configured = getConfig().requestHashSecret;
  if (configured && configured !== DEV_TEST_REQUEST_HASH_SECRET) {
    return;
  }
  throw new Error(
    "Production refuses to start without REQUEST_HASH_SECRET (a server-only HMAC key). The marked dev/test key is not allowed.",
  );
}

/** Reset config for testing. */
export function resetConfig(): void {
  config = null;
}
