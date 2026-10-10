import type { ZodType } from "zod";

import { candidateSchema } from "../../src/validation/candidate";
import { intentSchema } from "../../src/validation/intent";
import { itineraryOptionSchema, itinerarySchema } from "../../src/validation/itinerary";
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
 * Any line starting with 3+ backticks opens or closes a fence.
 * json / JSON / jsonc / json* fences without a known schema annotation fail.
 * `schema=none` is banned.
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
}

const FENCE_OPEN = /^(`{3,})([^\s`]*)?(.*)$/;

export function extractFencedBlocks(markdown: string): JsonFenceBlock[] {
  const blocks: JsonFenceBlock[] = [];
  const lines = markdown.split(/\r?\n/);
  let inBlock = false;
  let closer = "";
  let blockLines: string[] = [];
  let blockStart = 0;
  let language = "";
  let schemaName: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const open = trimmed.match(FENCE_OPEN);

    if (!inBlock && open && (open[1]?.length ?? 0) >= 3) {
      inBlock = true;
      closer = open[1] ?? "```";
      language = open[2] ?? "";
      blockStart = i + 1;
      blockLines = [];
      const schemaMatch = (open[3] ?? "").match(/\bschema=([A-Za-z0-9_-]+)/);
      schemaName = schemaMatch?.[1] ?? null;
      continue;
    }

    if (inBlock && trimmed === closer) {
      inBlock = false;
      blocks.push({
        blockText: blockLines.join("\n"),
        lineNumber: blockStart,
        language,
        schemaName,
      });
      continue;
    }

    if (inBlock) {
      blockLines.push(line);
    }
  }

  return blocks;
}

function isJsonLikeLanguage(language: string): boolean {
  return /^(json|jsonc|json[a-z0-9]*)$/i.test(language);
}

export function collectJsonFenceFailures(markdown: string): string[] {
  const failures: string[] = [];
  let validated = 0;

  for (const block of extractFencedBlocks(markdown)) {
    if (!isJsonLikeLanguage(block.language)) {
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
    if (!(block.schemaName in SCHEMA_BY_NAME)) {
      failures.push(`Line ${block.lineNumber}: unknown schema annotation.`);
      continue;
    }

    const schema = SCHEMA_BY_NAME[block.schemaName as SchemaName] as ZodType;
    try {
      const parsed: unknown = JSON.parse(block.blockText);
      const result = schema.safeParse(parsed);
      if (!result.success) {
        failures.push(`Line ${block.lineNumber} schema=${block.schemaName}: ${result.error.message}`);
      } else {
        validated += 1;
      }
    } catch (parseError) {
      failures.push(
        `Line ${block.lineNumber}: JSON parse error: ${
          parseError instanceof Error ? parseError.message : String(parseError)
        }`
      );
    }
  }

  if (validated === 0 && failures.length === 0) {
    failures.push("Expected at least one schema-validated JSON example.");
  }

  return failures;
}

const TAXI_ITINERARY = `{
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
