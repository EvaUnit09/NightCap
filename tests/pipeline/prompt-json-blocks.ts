import type { ZodType } from "zod";

import { candidateSchema } from "../../src/validation/candidate";
import { intentSchema } from "../../src/validation/intent";
import {
  itineraryOptionSchema,
  itineraryOptionSchemaFor,
  itinerarySchema,
} from "../../src/validation/itinerary";
import { toolInputSchema } from "../../src/validation/tool-input";
import { validationErrorSchema } from "../../src/validation/validation-error";

/**
 * Every fenced JSON-like block in a prompt must declare a known schema:
 *
 *   ```json schema=intent
 *   ```json schema=itinerary
 *   ```json schema=itineraryOption
 *   ```json schema=candidate
 *   ```json schema=validationError
 *   ```json schema=toolInput
 *
 * Any line starting with 3+ backticks or tildes opens or closes a fence.
 * A space before the info string is allowed. Unclosed fences fail.
 * Any block that parses as JSON is treated as JSON, whatever its language tag.
 * json / JSON / jsonc / json* fences without a known schema annotation fail.
 * `schema=none` is banned. `schema=itineraryOption singleStop` uses the 1-stop option schema.
 */
export const SCHEMA_BY_NAME = {
  intent: intentSchema,
  itinerary: itinerarySchema,
  itineraryOption: itineraryOptionSchema,
  candidate: candidateSchema,
  validationError: validationErrorSchema,
  toolInput: toolInputSchema,
} as const;

export type SchemaName = keyof typeof SCHEMA_BY_NAME;

export interface JsonFenceBlock {
  blockText: string;
  lineNumber: number;
  language: string;
  schemaName: string | null;
  singleStop: boolean;
}

const FENCE_LINE = /^([`~]{3,})(.*)$/;

function parseFenceInfo(info: string): {
  language: string;
  schemaName: string | null;
  singleStop: boolean;
} {
  const trimmed = info.trimStart();
  const firstToken = trimmed.split(/\s+/, 1)[0] ?? "";
  const language = firstToken === "" || firstToken.startsWith("schema=") ? "" : firstToken;
  const schemaMatch = trimmed.match(/\bschema=([A-Za-z0-9_-]+)/);
  return {
    language,
    schemaName: schemaMatch?.[1] ?? null,
    singleStop: /\bsingleStop\b/.test(trimmed),
  };
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (parseError) {
    return {
      ok: false,
      error: parseError instanceof Error ? parseError.message : String(parseError),
    };
  }
}

export function extractFences(markdown: string): {
  blocks: JsonFenceBlock[];
  unclosedLine: number | null;
} {
  const blocks: JsonFenceBlock[] = [];
  const lines = markdown.split(/\r?\n/);
  let inBlock = false;
  let closer = "";
  let blockLines: string[] = [];
  let blockStart = 0;
  let language = "";
  let schemaName: string | null = null;
  let singleStop = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const fence = trimmed.match(FENCE_LINE);

    if (!inBlock && fence) {
      inBlock = true;
      closer = fence[1] ?? "```";
      const info = parseFenceInfo(fence[2] ?? "");
      language = info.language;
      schemaName = info.schemaName;
      singleStop = info.singleStop;
      blockStart = i + 1;
      blockLines = [];
      continue;
    }

    if (inBlock && fence && fence[1] === closer && (fence[2] ?? "").trim() === "") {
      inBlock = false;
      blocks.push({
        blockText: blockLines.join("\n"),
        lineNumber: blockStart,
        language,
        schemaName,
        singleStop,
      });
      continue;
    }

    if (inBlock) {
      blockLines.push(lines[i]);
    }
  }

  return { blocks, unclosedLine: inBlock ? blockStart : null };
}

export function extractFencedBlocks(markdown: string): JsonFenceBlock[] {
  return extractFences(markdown).blocks;
}

function isJsonLikeLanguage(language: string): boolean {
  return /^(json|jsonc|json[a-z0-9]*)$/i.test(language);
}

function schemaForBlock(block: JsonFenceBlock): ZodType | null {
  if (block.schemaName === "itineraryOption") {
    return itineraryOptionSchemaFor(block.singleStop);
  }
  if (block.schemaName && block.schemaName in SCHEMA_BY_NAME) {
    return SCHEMA_BY_NAME[block.schemaName as SchemaName] as ZodType;
  }
  return null;
}

export function collectJsonFenceFailures(markdown: string): string[] {
  const failures: string[] = [];
  let validated = 0;
  const { blocks, unclosedLine } = extractFences(markdown);

  if (unclosedLine !== null) {
    failures.push(`Line ${unclosedLine}: unclosed fence.`);
  }

  for (const block of blocks) {
    const parsed = tryParseJson(block.blockText);
    const treatAsJson = parsed.ok || isJsonLikeLanguage(block.language);
    if (!treatAsJson) {
      continue;
    }

    if (block.schemaName === null) {
      failures.push(
        `Line ${block.lineNumber}: JSON-like fence (${block.language || "json"}) missing schema annotation.`
      );
      continue;
    }
    if (block.schemaName === "none") {
      failures.push(`Line ${block.lineNumber}: schema=none is banned.`);
      continue;
    }

    const schema = schemaForBlock(block);
    if (schema === null) {
      failures.push(`Line ${block.lineNumber}: unknown schema annotation.`);
      continue;
    }

    if (!parsed.ok) {
      failures.push(`Line ${block.lineNumber}: JSON parse error: ${parsed.error}`);
      continue;
    }

    const result = schema.safeParse(parsed.value);
    if (!result.success) {
      failures.push(`Line ${block.lineNumber} schema=${block.schemaName}: ${result.error.message}`);
    } else {
      validated += 1;
    }
  }

  if (validated === 0 && failures.length === 0) {
    failures.push("Expected at least one schema-validated JSON example.");
  }

  return failures;
}

export const TAXI_ITINERARY = `{
  "options": [
    {
      "theme": "Bypass attempt",
      "stops": [
        {
          "placeId": "place-a",
          "name": "place-a",
          "start": "2026-10-10T19:00:00-04:00",
          "end": "2026-10-10T20:30:00-04:00",
          "estimatedCostUsd": 40,
          "why": "Quiet room and a short walk.",
          "travelToNext": { "mode": "taxi", "minutes": 12 }
        },
        {
          "placeId": "place-b",
          "name": "place-b",
          "start": "2026-10-10T21:00:00-04:00",
          "end": "2026-10-10T22:30:00-04:00",
          "estimatedCostUsd": 40,
          "why": "Quiet room and a short walk.",
          "travelToNext": null
        }
      ]
    },
    {
      "theme": "Second option",
      "stops": [
        {
          "placeId": "place-c",
          "name": "place-c",
          "start": "2026-10-10T19:00:00-04:00",
          "end": "2026-10-10T20:30:00-04:00",
          "estimatedCostUsd": 40,
          "why": "Quiet room and a short walk.",
          "travelToNext": { "mode": "walk", "minutes": 8 }
        },
        {
          "placeId": "place-d",
          "name": "place-d",
          "start": "2026-10-10T21:00:00-04:00",
          "end": "2026-10-10T22:30:00-04:00",
          "estimatedCostUsd": 40,
          "why": "Quiet room and a short walk.",
          "travelToNext": null
        }
      ]
    }
  ]
}`;

/** Fence variants a reviewer used to bypass the previous extractor. */
export const BYPASS_FENCE_VARIANTS = [
  { name: "schema=itinerary2", open: "```json schema=itinerary2", close: "```" },
  { name: "jsonc", open: "```jsonc schema=itinerary", close: "```" },
  { name: "JSON", open: "```JSON schema=itinerary", close: "```" },
  { name: "4-backtick", open: "````json schema=itinerary", close: "````" },
  { name: "schema=none", open: "```json schema=none", close: "```" },
] as const;

export function bypassDocument(open: string, close: string): string {
  return `${open}\n${TAXI_ITINERARY}\n${close}\n`;
}
