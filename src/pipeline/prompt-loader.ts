import "server-only";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  getAgentMaxCostUsdPerTurn,
  getAgentMaxToolCalls,
  getRepairMaxRounds,
  getTravelCapMinutes,
} from "../models/config";

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

/** Bounds copied from the itinerary / stop Zod contracts. Do not drift. */
export const PROMPT_SCHEMA_BOUNDS = {
  minOptions: 2,
  maxOptions: 3,
  minStops: 2,
  maxStops: 4,
} as const;

const ALLOWED_FRONT_MATTER_KEYS = new Set(["name", "version"]);
const VERSION_PATTERN = /^v\d+$/;
const PLACEHOLDER_PATTERN = /\{\{([a-z_]+)\}\}/g;

/**
 * Prompt metadata returned by the loader.
 * Send `body` to models. Tag traces with name, version, and content hash.
 */
export interface PromptMetadata {
  /** Prompt name (stage) */
  name: PipelineStage;
  /** Version identifier (e.g., "v1") */
  version: string;
  /** Full source file, including front matter (pre-substitution) */
  text: string;
  /** Prompt body without front matter, after {{placeholder}} substitution */
  body: string;
  /** SHA-256 prefix of the CRLF-normalized source file */
  contentHash: string;
  /** Front matter metadata parsed from the prompt */
  frontMatter: { name: PipelineStage; version: string };
}

/** Memoization cache for loaded prompts */
const promptCache = new Map<string, PromptMetadata>();

function templateValues(): Record<string, string> {
  return {
    travel_cap_minutes: String(getTravelCapMinutes()),
    agent_max_tool_calls: String(getAgentMaxToolCalls()),
    agent_max_cost_usd: String(getAgentMaxCostUsdPerTurn()),
    repair_max_rounds: String(getRepairMaxRounds()),
    min_options: String(PROMPT_SCHEMA_BOUNDS.minOptions),
    max_options: String(PROMPT_SCHEMA_BOUNDS.maxOptions),
    min_stops: String(PROMPT_SCHEMA_BOUNDS.minStops),
    max_stops: String(PROMPT_SCHEMA_BOUNDS.maxStops),
  };
}

/**
 * Replace `{{placeholder}}` tokens from config and schema bounds.
 * Unknown or leftover placeholders fail loudly.
 */
function applyTemplate(body: string, stage: PipelineStage, version: string): string {
  const values = templateValues();
  const rendered = body.replace(PLACEHOLDER_PATTERN, (_match, key: string) => {
    if (!(key in values)) {
      throw new Error(
        `Prompt ${stage}/${version}.md: unknown placeholder {{${key}}}.`
      );
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

/**
 * Parse YAML-like front matter from a markdown file.
 * Front matter is delimited by `---` at the start and end.
 * Only `name` and `version` are allowed; both are required and must match the path.
 */
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
        `Prompt ${stage}/${version}.md: Malformed front matter at line ${i + 1}: "${line}". ` +
          `Expected "key: value" format.`
      );
    }

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    if (key === "") {
      throw new Error(
        `Prompt ${stage}/${version}.md: Empty key in front matter at line ${i + 1}.`
      );
    }
    if (!ALLOWED_FRONT_MATTER_KEYS.has(key)) {
      throw new Error(
        `Prompt ${stage}/${version}.md: Unsupported front-matter key "${key}". ` +
          `Allowed keys: name, version.`
      );
    }
    if (value === "") {
      throw new Error(
        `Prompt ${stage}/${version}.md: Empty value for front-matter key "${key}".`
      );
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
      `Prompt ${stage}/${version}.md: Front matter name "${frontMatter.name}" ` +
        `does not match stage "${stage}".`
    );
  }
  if (frontMatter.version !== version) {
    throw new Error(
      `Prompt ${stage}/${version}.md: Front matter version "${frontMatter.version}" ` +
        `does not match requested version "${version}".`
    );
  }

  return {
    frontMatter: { name: stage, version },
    body,
  };
}

/**
 * Compute SHA-256 hash of text for content-based versioning.
 * Normalizes CRLF to LF before hashing.
 */
function computeHash(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16);
}

/**
 * Validate that a stage is in the allowed list.
 * Runtime check to prevent path traversal via type-cast.
 */
function validateStage(stage: string): asserts stage is PipelineStage {
  if (!PIPELINE_STAGES.includes(stage as PipelineStage)) {
    throw new Error(
      `Invalid stage: "${stage}". Must be one of: ${PIPELINE_STAGES.join(", ")}`
    );
  }
}

/**
 * Validate that a version follows the format /^v\d+$/.
 * Prevents path traversal attacks.
 */
function validateVersion(version: string): void {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(
      `Invalid version format: "${version}". Must match /^v\\d+$/ (e.g., v1, v2).`
    );
  }
}

/**
 * Ensure the resolved path is within the prompts directory.
 * Prevents path traversal attacks.
 */
function validatePromptPath(resolvedPath: string, promptsRoot: string): void {
  const normalizedResolved = resolve(resolvedPath);
  const normalizedRoot = resolve(promptsRoot);
  const rel = relative(normalizedRoot, normalizedResolved);
  if (rel.startsWith(".." + sep) || isAbsolute(rel) || rel === "..") {
    throw new Error(
      `Path traversal detected: prompt path escapes prompts/ directory.`
    );
  }
}

function cacheKey(stage: PipelineStage, version: string): string {
  return `${stage}:${version}:${JSON.stringify(templateValues())}`;
}

/**
 * Load a versioned prompt from the filesystem.
 *
 * Security: validates stage, version format, and prevents path traversal.
 * Caching: memoizes loaded prompts for the current template values.
 *
 * @param stage - Pipeline stage name (parse_intent, plan_itineraries, etc.)
 * @param version - Version identifier (e.g., "v1")
 * @returns Prompt metadata including text, body, version, and content hash
 * @throws Error if the prompt file is not found, malformed, or path is unsafe
 */
export function loadPrompt(
  stage: PipelineStage,
  version: string
): PromptMetadata {
  validateStage(stage);
  validateVersion(version);

  const key = cacheKey(stage, version);
  const cached = promptCache.get(key);
  if (cached) {
    return cached;
  }

  const promptsRoot = resolve(process.cwd(), "prompts");
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
  const contentHash = computeHash(text);

  const metadata: PromptMetadata = {
    name: stage,
    version,
    text,
    body,
    contentHash,
    frontMatter,
  };

  promptCache.set(key, metadata);
  return metadata;
}

/**
 * Get trace tags for a loaded prompt.
 * Use these to tag Datadog traces for version comparison.
 */
export function getPromptTraceTags(
  prompt: PromptMetadata
): Record<string, string> {
  return {
    prompt_name: prompt.name,
    prompt_version: prompt.version,
    prompt_hash: prompt.contentHash,
  };
}

/**
 * Clear the prompt cache (for testing).
 * @internal
 */
export function clearPromptCache(): void {
  promptCache.clear();
}
