import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { travelModeSchema } from "../src/validation/common";

export const EVAL_V1_FILE = join(import.meta.dirname, "nightcap_eval_cases_v1.json");
export const EVAL_V1_CASE_COUNT = 60;

const caseIdSchema = z.string().regex(/^nc-\d{3}$/);

export const evalConstraintsSchema = z
  .object({
    boroughs: z.array(z.string().min(1)).min(1),
    budget_min: z.number().nonnegative(),
    budget_max: z.number().positive(),
    time_window: z.string().min(1),
    day_of_week: z.string().min(1),
    vibes: z.array(z.string().min(1)),
    dietary: z.array(z.string().min(1)),
    single_stop: z.boolean(),
    expected_options: z.int().positive(),
    stops_per_option: z.string().regex(/^\d(-\d)?$/),
    travel_modes: z.array(travelModeSchema).min(1),
    max_travel_minutes: z.int().positive(),
  })
  .strict()
  .refine((c) => c.budget_min <= c.budget_max, {
    message: "budget_min must not exceed budget_max",
    path: ["budget_min"],
  });

export const evalCaseSchema = z
  .object({
    id: caseIdSchema,
    query: z.string().trim().min(1),
    tags: z.array(z.string().min(1)),
    constraints: evalConstraintsSchema,
    edge: z.boolean(),
  })
  .strict();

export const evalCasesSchema = z.array(evalCaseSchema);

export type EvalCase = z.infer<typeof evalCaseSchema>;

/** Parse raw JSON text of a case file. Throws a ZodError on any shape drift. */
export function parseEvalCases(json: string): EvalCase[] {
  return evalCasesSchema.parse(JSON.parse(json));
}

export function loadEvalCasesV1(): EvalCase[] {
  return parseEvalCases(readFileSync(EVAL_V1_FILE, "utf8"));
}
