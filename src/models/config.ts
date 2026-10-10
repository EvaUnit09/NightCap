import "server-only";
import { z } from "zod";

import { MAX_TRAVEL_LEGS_PER_REQUEST_DEFAULT } from "../validation/bounds";

/**
 * Preprocess an environment variable: treat empty or whitespace-only strings as undefined.
 * This ensures Zod defaults apply correctly and empty secrets don't fail at load time.
 */
function preprocessEnvVar(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Configuration schema with Zod validation.
 * Secrets must be provided; non-secrets have documented defaults.
 */
const configSchema = z.object({
  // API Keys - required secrets, fail at runtime when accessed if missing
  anthropicApiKey: z.string().min(1).optional(),
  googlePlacesApiKey: z.string().min(1).optional(),
  datadogApiKey: z.string().min(1).optional(),
  turnstileSecretKey: z.string().min(1).optional(),

  // Model IDs - defaults from architecture (Haiku 4-5 for parse, Sonnet 5 for others)
  parseModelId: z.string().min(1).default("claude-haiku-4-5"),
  planModelId: z.string().min(1).default("claude-sonnet-5"),
  repairModelId: z.string().min(1).default("claude-sonnet-5"),
  agentModelId: z.string().min(1).default("claude-sonnet-5"),

  // Cache TTL - 24 hours from architecture
  placesCacheTtlHours: z.coerce.number().int().positive().default(24),

  // Rate Limits - from architecture: 5 plans/hour/IP
  rateLimitRequestsPerHour: z.coerce.number().int().positive().default(5),
  // Daily spend cap in USD across all requests
  rateLimitDailySpendUsd: z.coerce.number().positive().default(5),

  // Validation Caps - from architecture
  travelCapMinutes: z.coerce.number().int().positive().default(25),
  agentMaxToolCalls: z.coerce.number().int().positive().default(6),
  agentMaxCostUsdPerTurn: z.coerce.number().positive().default(0.03),
  repairMaxRounds: z.coerce.number().int().positive().default(2),
  maxTravelLegsPerRequest: z.coerce
    .number()
    .int()
    .positive()
    .default(MAX_TRAVEL_LEGS_PER_REQUEST_DEFAULT),
});

type Config = z.infer<typeof configSchema>;

/** Parsed and validated configuration. */
let config: Config | null = null;

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
    datadogApiKey: preprocessEnvVar(process.env.DATADOG_API_KEY),
    turnstileSecretKey: preprocessEnvVar(process.env.TURNSTILE_SECRET_KEY),

    // Model IDs
    parseModelId: preprocessEnvVar(process.env.PARSE_MODEL_ID),
    planModelId: preprocessEnvVar(process.env.PLAN_MODEL_ID),
    repairModelId: preprocessEnvVar(process.env.REPAIR_MODEL_ID),
    agentModelId: preprocessEnvVar(process.env.AGENT_MODEL_ID),

    // Cache TTL
    placesCacheTtlHours: preprocessEnvVar(process.env.PLACES_CACHE_TTL_HOURS),

    // Rate Limits
    rateLimitRequestsPerHour: preprocessEnvVar(process.env.RATE_LIMIT_REQUESTS_PER_HOUR),
    rateLimitDailySpendUsd: preprocessEnvVar(process.env.RATE_LIMIT_DAILY_SPEND_USD),

    // Validation Caps
    travelCapMinutes: preprocessEnvVar(process.env.TRAVEL_CAP_MINUTES),
    agentMaxToolCalls: preprocessEnvVar(process.env.AGENT_MAX_TOOL_CALLS),
    agentMaxCostUsdPerTurn: preprocessEnvVar(process.env.AGENT_MAX_COST_USD_PER_TURN),
    repairMaxRounds: preprocessEnvVar(process.env.REPAIR_MAX_ROUNDS),
    maxTravelLegsPerRequest: preprocessEnvVar(process.env.MAX_TRAVEL_LEGS_PER_REQUEST),
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
  return requireSecret("DATADOG_API_KEY", cfg.datadogApiKey);
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

/** Get Places cache TTL in hours (24 by default). */
export function getPlacesCacheTtlHours(): number {
  return getConfig().placesCacheTtlHours;
}

/** Get rate limit: requests per hour per IP (5 by default). */
export function getRateLimitRequestsPerHour(): number {
  return getConfig().rateLimitRequestsPerHour;
}

/** Get rate limit: daily spend cap in USD (100 by default). */
export function getRateLimitDailySpendUsd(): number {
  return getConfig().rateLimitDailySpendUsd;
}

/** Get travel cap in minutes (25 by default). */
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

/** Reset config for testing. */
export function resetConfig(): void {
  config = null;
}
