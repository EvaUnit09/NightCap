import "server-only";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  getAgentMaxCostUsdPerTurn,
  getAgentMaxToolCalls,
  getMaxTravelLegsPerRequest,
  getRepairMaxRounds,
  getTravelCapMinutes,
} from "../models/config";
import { TRAVEL_MODES, stopTypeSchema } from "../validation/common";
import {
  INTENT_TAG_MAX,
  STOP_TYPES_MAX,
  STOP_TYPES_MIN,
} from "../validation/intent";
import {
  MAX_TRAVEL_LEGS_PER_REQUEST_DEFAULT,
  STOPS_MAX,
  STOPS_MIN,
  STOPS_MIN_SINGLE,
} from "../validation/bounds";
import {
  ITINERARY_OPTIONS_MAX,
  ITINERARY_OPTIONS_MIN,
} from "../validation/itinerary";

/**
 * Supported pipeline stages that have versioned prompts.
 * Shared with the model router for type safety.
 */
export const PIPELINE_STAGES = [
  "parse_intent",
  "plan_itineraries",
  "repair_itinerary",
  "refine_agent",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/**
 * Prompt template bounds derived from the intent/itinerary Zod contracts.
 */
export const PROMPT_SCHEMA_BOUNDS = {
  minOptions: ITINERARY_OPTIONS_MIN,
  maxOptions: ITINERARY_OPTIONS_MAX,
  minStops: STOPS_MIN,
  minStopsSingle: STOPS_MIN_SINGLE,
  maxStops: STOPS_MAX,
  minStopTypes: STOP_TYPES_MIN,
  maxStopTypes: STOP_TYPES_MAX,
  tagMax: INTENT_TAG_MAX,
  stopTypes: stopTypeSchema.options as readonly string[],
  travelModes: TRAVEL_MODES,
  maxTravelLegs: MAX_TRAVEL_LEGS_PER_REQUEST_DEFAULT,
} as const;

const ALLOWED_FRONT_MATTER_KEYS = new Set(["name", "version"]);
const VERSION_PATTERN = /^v[1-9]\d{0,2}$/;
const PLACEHOLDER_PATTERN = /\{\{([a-z_]+)\}\}/g;

export interface LoadPromptOptions {
  /** Test-only. Override the prompts/ root; tests write fixtures under a tmp dir. */
  promptsRoot?: string;
}

/**
 * Prompt metadata returned by the loader.
 * Send `body` to models. Tag traces with name, version, and hashes.
 */
export interface PromptMetadata {
  name: PipelineStage;
  version: string;
  /** Full source file, including front matter (pre-substitution) */
  text: string;
  /** Prompt body without front matter, after {{placeholder}} substitution */
  body: string;
  /** SHA-256 prefix of the CRLF-normalized source file */
  contentHash: string;
  /** SHA-256 prefix of the rendered body (includes template values) */
  renderedHash: string;
  frontMatter: { name: PipelineStage; version: string };
}

const promptCache = new Map<string, PromptMetadata>();

function templateValues(): Record<string, string> {
  return {
    travel_cap_minutes: String(getTravelCapMinutes()),
    max_travel_legs: String(getMaxTravelLegsPerRequest()),
    agent_max_tool_calls: String(getAgentMaxToolCalls()),
    agent_max_cost_usd: String(getAgentMaxCostUsdPerTurn()),
    repair_max_rounds: String(getRepairMaxRounds()),
    min_options: String(PROMPT_SCHEMA_BOUNDS.minOptions),
    max_options: String(PROMPT_SCHEMA_BOUNDS.maxOptions),
    min_stops: String(PROMPT_SCHEMA_BOUNDS.minStops),
    min_stops_single: String(PROMPT_SCHEMA_BOUNDS.minStopsSingle),
    max_stops: String(PROMPT_SCHEMA_BOUNDS.maxStops),
    tag_max: String(PROMPT_SCHEMA_BOUNDS.tagMax),
    stop_types: PROMPT_SCHEMA_BOUNDS.stopTypes.join(", "),
    travel_modes: PROMPT_SCHEMA_BOUNDS.travelModes.join(", "),
  };
}

function applyTemplate(body: string, stage: PipelineStage, version: string): string {
  const values = templateValues();
  const rendered = body.replace(PLACEHOLDER_PATTERN, (_match, key: string) => {
    if (!Object.hasOwn(values, key)) {
      throw new Error(`Prompt ${stage}/${version}.md: unknown placeholder.`);
    }
    return values[key];
  });

  if (rendered.includes("{{")) {
    throw new Error(
      `Prompt ${stage}/${version}.md: unresolved placeholder remaining after substitution.`
    );
  }

  return rendered;
}

function parseFrontMatter(
  text: string,
  stage: PipelineStage,
  version: string
): {
  frontMatter: { name: PipelineStage; version: string };
  body: string;
} {
  const frontMatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
  const match = text.match(frontMatterRegex);

  if (!match) {
    throw new Error(
      `Prompt ${stage}/${version}.md: Missing or malformed front matter. ` +
        `Expected --- at start and end.`
    );
  }

  const frontMatterText = match[1];
  const body = match[2];
  const frontMatter: Record<string, string> = {};
  const lines = frontMatterText.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) {
      throw new Error(
        `Prompt ${stage}/${version}.md: Malformed front matter at line ${i + 1}. ` +
          `Expected "key: value" format.`
      );
    }

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    if (key === "") {
      throw new Error(`Prompt ${stage}/${version}.md: Empty front-matter key at line ${i + 1}.`);
    }
    if (Object.hasOwn(frontMatter, key)) {
      throw new Error(`Prompt ${stage}/${version}.md: Duplicate front-matter key.`);
    }
    if (!ALLOWED_FRONT_MATTER_KEYS.has(key)) {
      throw new Error(
        `Prompt ${stage}/${version}.md: Unsupported front-matter key. ` +
          `Allowed keys: name, version.`
      );
    }
    if (value === "") {
      throw new Error(`Prompt ${stage}/${version}.md: Empty front-matter value.`);
    }

    frontMatter[key] = value;
  }

  if (frontMatter.name === undefined || frontMatter.version === undefined) {
    throw new Error(
      `Prompt ${stage}/${version}.md: Front matter must include name and version.`
    );
  }
  if (frontMatter.name !== stage) {
    throw new Error(
      `Prompt ${stage}/${version}.md: Front matter name does not match stage.`
    );
  }
  if (frontMatter.version !== version) {
    throw new Error(
      `Prompt ${stage}/${version}.md: Front matter version does not match requested version.`
    );
  }

  return {
    frontMatter: { name: stage, version },
    body,
  };
}

function computeHash(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16);
}

function validateStage(stage: string): asserts stage is PipelineStage {
  if (!PIPELINE_STAGES.includes(stage as PipelineStage)) {
    throw new Error(`Invalid stage.`);
  }
}

function validateVersion(version: string): void {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid version format.`);
  }
}

function validatePromptPath(resolvedPath: string, promptsRoot: string): void {
  const normalizedResolved = resolve(resolvedPath);
  const normalizedRoot = resolve(promptsRoot);
  const rel = relative(normalizedRoot, normalizedResolved);
  if (rel.startsWith(".." + sep) || isAbsolute(rel) || rel === "..") {
    throw new Error(`Path traversal detected: prompt path escapes prompts/ directory.`);
  }
}

function cacheKey(stage: PipelineStage, version: string, promptsRoot: string): string {
  return `${promptsRoot}:${stage}:${version}:${JSON.stringify(templateValues())}`;
}

/**
 * Load a versioned prompt from the filesystem.
 *
 * Security: validates stage, version format, and prevents path traversal.
 * Caching: memoizes loaded prompts for the current template values.
 *
 * @param stage - Pipeline stage name (parse_intent, plan_itineraries, etc.)
 * @param version - Version identifier (e.g., "v1")
 * @param options - Optional loader overrides. `promptsRoot` is test-only.
 * @returns Prompt metadata including text, body, version, and content hash
 * @throws Error if the prompt file is not found, malformed, or path is unsafe
 */
export function loadPrompt(
  stage: PipelineStage,
  version: string,
  options?: LoadPromptOptions
): PromptMetadata {
  validateStage(stage);
  validateVersion(version);

  const promptsRoot = resolve(options?.promptsRoot ?? joinCwdPrompts());
  const key = cacheKey(stage, version, promptsRoot);
  const cached = promptCache.get(key);
  if (cached) {
    return cached;
  }

  const promptPath = resolve(promptsRoot, stage, `${version}.md`);
  validatePromptPath(promptPath, promptsRoot);

  let text: string;
  try {
    text = readFileSync(promptPath, "utf-8");
  } catch {
    throw new Error(`Failed to load prompt: ${stage}/${version}.md not found`);
  }

  const { frontMatter, body: rawBody } = parseFrontMatter(text, stage, version);
  const body = applyTemplate(rawBody, stage, version);

  const metadata: PromptMetadata = {
    name: stage,
    version,
    text,
    body,
    contentHash: computeHash(text),
    renderedHash: computeHash(body),
    frontMatter,
  };

  promptCache.set(key, metadata);
  return metadata;
}

function joinCwdPrompts(): string {
  return resolve(process.cwd(), "prompts");
}

/**
 * Get trace tags for a loaded prompt.
 */
export function getPromptTraceTags(
  prompt: PromptMetadata
): Record<string, string> {
  return {
    prompt_name: prompt.name,
    prompt_version: prompt.version,
    prompt_hash: prompt.contentHash,
    prompt_rendered_hash: prompt.renderedHash,
  };
}

/** Clear the prompt cache (for testing). */
export function clearPromptCache(): void {
  promptCache.clear();
}
