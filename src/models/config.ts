import { z } from "zod";

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

  // Model IDs - defaults from architecture (Haiku 4.5 for parse, Sonnet 5 for others)
  parseModelId: z.string().min(1).default("claude-haiku-4.5"),
  planModelId: z.string().min(1).default("claude-sonnet-5"),
  repairModelId: z.string().min(1).default("claude-sonnet-5"),
  agentModelId: z.string().min(1).default("claude-sonnet-5"),

  // Cache TTL - 24 hours from architecture
  placesCacheTtlHours: z.coerce.number().int().positive().default(24),

  // Rate Limits - from architecture: 5 plans/hour/IP, plus daily spend cap
  rateLimitRequestsPerHour: z.coerce.number().int().positive().default(5),
  rateLimitDailySpendUsd: z.coerce.number().positive().default(100),

  // Validation Caps - from architecture
  travelCapMinutes: z.coerce.number().int().positive().default(25),
  agentMaxToolCalls: z.coerce.number().int().positive().default(6),
  agentMaxCostUsdPerTurn: z.coerce.number().positive().default(0.03),
  repairMaxRounds: z.coerce.number().int().positive().default(2),
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
    // API Keys
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    googlePlacesApiKey: process.env.GOOGLE_PLACES_API_KEY,
    datadogApiKey: process.env.DATADOG_API_KEY,
    turnstileSecretKey: process.env.TURNSTILE_SECRET_KEY,

    // Model IDs
    parseModelId: process.env.PARSE_MODEL_ID,
    planModelId: process.env.PLAN_MODEL_ID,
    repairModelId: process.env.REPAIR_MODEL_ID,
    agentModelId: process.env.AGENT_MODEL_ID,

    // Cache TTL
    placesCacheTtlHours: process.env.PLACES_CACHE_TTL_HOURS,

    // Rate Limits
    rateLimitRequestsPerHour: process.env.RATE_LIMIT_REQUESTS_PER_HOUR,
    rateLimitDailySpendUsd: process.env.RATE_LIMIT_DAILY_SPEND_USD,

    // Validation Caps
    travelCapMinutes: process.env.TRAVEL_CAP_MINUTES,
    agentMaxToolCalls: process.env.AGENT_MAX_TOOL_CALLS,
    agentMaxCostUsdPerTurn: process.env.AGENT_MAX_COST_USD_PER_TURN,
    repairMaxRounds: process.env.REPAIR_MAX_ROUNDS,
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

/** Get parse model ID (Haiku 4.5 by default). */
export function getParsedModelId(): string {
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

/** Reset config for testing. */
export function resetConfig(): void {
  config = null;
}
