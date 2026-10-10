import "server-only";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
 * Prompt metadata returned by the loader.
 * Tag traces with name and version; content hash can detect changes.
 */
export interface PromptMetadata {
  /** Prompt name (stage) */
  name: PipelineStage;
  /** Version identifier (e.g., "v1") */
  version: string;
  /** Full prompt text including front matter */
  text: string;
  /** SHA-256 hash of the prompt text for change detection */
  contentHash: string;
  /** Front matter metadata parsed from the prompt */
  frontMatter: Record<string, unknown>;
}

/**
 * Parse YAML-like front matter from a markdown file.
 * Front matter is delimited by `---` at the start and end.
 *
 * Example:
 * ```
 * ---
 * name: parse_intent
 * version: v1
 * model: claude-haiku-4-5
 * ---
 * # Prompt content...
 * ```
 */
function parseFrontMatter(text: string): {
  frontMatter: Record<string, unknown>;
  content: string;
} {
  const frontMatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/;
  const match = text.match(frontMatterRegex);

  if (!match) {
    return { frontMatter: {}, content: text };
  }

  const frontMatterText = match[1];
  const content = text.slice(match[0].length);

  const frontMatter: Record<string, unknown> = {};
  for (const line of frontMatterText.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    // Basic type coercion
    if (value === "true") frontMatter[key] = true;
    else if (value === "false") frontMatter[key] = false;
    else if (/^\d+$/.test(value)) frontMatter[key] = parseInt(value, 10);
    else if (/^\d+\.\d+$/.test(value)) frontMatter[key] = parseFloat(value);
    else frontMatter[key] = value;
  }

  return { frontMatter, content };
}

/**
 * Compute SHA-256 hash of text for content-based versioning.
 */
function computeHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/**
 * Load a versioned prompt from the filesystem.
 *
 * In development, reads from the filesystem.
 * In production (Vercel), the prompts directory is included in the build
 * via Next.js outputFileTracingIncludes or bundled assets.
 *
 * @param stage - Pipeline stage name (parse_intent, plan_itineraries, etc.)
 * @param version - Version identifier (e.g., "v1")
 * @returns Prompt metadata including text, version, and content hash
 * @throws Error if the prompt file is not found or cannot be read
 */
export function loadPrompt(
  stage: PipelineStage,
  version: string
): PromptMetadata {
  // Resolve path relative to the workspace root
  // In Next.js, process.cwd() is the workspace root
  const promptPath = resolve(
    process.cwd(),
    "prompts",
    stage,
    `${version}.md`
  );

  let text: string;
  try {
    text = readFileSync(promptPath, "utf-8");
  } catch (error) {
    throw new Error(
      `Failed to load prompt: ${stage}/${version}.md - ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const { frontMatter } = parseFrontMatter(text);
  const contentHash = computeHash(text);

  return {
    name: stage,
    version,
    text,
    contentHash,
    frontMatter,
  };
}

/**
 * Get trace tags for a loaded prompt.
 * Use these to tag Datadog traces for version comparison.
 *
 * @param prompt - Loaded prompt metadata
 * @returns Object with prompt_name, prompt_version, and prompt_hash tags
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
