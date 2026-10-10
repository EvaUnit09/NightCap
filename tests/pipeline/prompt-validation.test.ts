import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ZodType } from "zod";

import { PIPELINE_STAGES } from "../../src/pipeline/prompt-loader";
import { candidateSchema } from "../../src/validation/candidate";
import { intentSchema } from "../../src/validation/intent";
import { itineraryOptionSchema, itinerarySchema } from "../../src/validation/itinerary";
import { toolInputSchema } from "../../src/validation/tool-input";
import { validationErrorSchema } from "../../src/validation/validation-error";

/**
 * Convention: every fenced JSON block must declare its schema:
 *
 *   ```json schema=intent
 *   ```json schema=itinerary
 *   ```json schema=itineraryOption
 *   ```json schema=candidate
 *   ```json schema=validationError
 *   ```json schema=toolInput
 *   ```json schema=none
 *
 * `none` is for documentation sketches that are not instances.
 * A missing or unknown annotation fails the test.
 */
const SCHEMA_BY_NAME = {
  intent: intentSchema,
  itinerary: itinerarySchema,
  itineraryOption: itineraryOptionSchema,
  candidate: candidateSchema,
  validationError: validationErrorSchema,
  toolInput: toolInputSchema,
  none: null,
} as const;

type SchemaName = keyof typeof SCHEMA_BY_NAME;

function extractJsonBlocks(markdown: string): Array<{
  blockText: string;
  lineNumber: number;
  schemaName: string | null;
}> {
  const blocks: Array<{
    blockText: string;
    lineNumber: number;
    schemaName: string | null;
  }> = [];
  const lines = markdown.split("\n");
  let inBlock = false;
  let blockLines: string[] = [];
  let blockStart = 0;
  let schemaName: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const open = line.trim().match(/^```json(?:\s+schema=([A-Za-z]+))?\s*$/);

    if (open && !inBlock) {
      inBlock = true;
      blockStart = i + 1;
      blockLines = [];
      schemaName = open[1] ?? null;
    } else if (line.trim() === "```" && inBlock) {
      inBlock = false;
      if (blockLines.length > 0) {
        blocks.push({
          blockText: blockLines.join("\n"),
          lineNumber: blockStart,
          schemaName,
        });
      }
    } else if (inBlock) {
      blockLines.push(line);
    }
  }

  return blocks;
}

describe("prompt JSON validation", () => {
  for (const stage of PIPELINE_STAGES) {
    describe(`${stage}/v1.md`, () => {
      it("parses every annotated ```json block with its mapped schema", () => {
        const promptPath = resolve(process.cwd(), "prompts", stage, "v1.md");
        const promptText = readFileSync(promptPath, "utf-8");
        const blocks = extractJsonBlocks(promptText);

        assert.ok(blocks.length > 0, `Expected at least one JSON block in ${stage}/v1.md`);

        const failures: string[] = [];
        let validated = 0;

        for (const block of blocks) {
          if (block.schemaName === null) {
            failures.push(
              `Line ${block.lineNumber}: missing schema annotation. Use \`\`\`json schema=<name>.`
            );
            continue;
          }
          if (!(block.schemaName in SCHEMA_BY_NAME)) {
            failures.push(
              `Line ${block.lineNumber}: unknown schema "${block.schemaName}".`
            );
            continue;
          }

          const schema = SCHEMA_BY_NAME[block.schemaName as SchemaName] as ZodType | null;
          if (schema === null) {
            continue;
          }

          try {
            const parsed: unknown = JSON.parse(block.blockText);
            const result = schema.safeParse(parsed);
            if (!result.success) {
              failures.push(
                `Line ${block.lineNumber} schema=${block.schemaName}: ${result.error.message}`
              );
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

        if (failures.length > 0) {
          assert.fail(
            `Found ${failures.length} invalid JSON block(s) in ${stage}/v1.md:\n\n` +
              failures.join("\n\n")
          );
        }

        assert.ok(
          validated > 0,
          `Expected at least one schema-validated example in ${stage}/v1.md`
        );
      });
    });
  }
});
