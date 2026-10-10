import { z } from "zod";

import { isBefore, isoDateTimeSchema, stopTypeSchema } from "./common";

export const INTENT_TAG_MAX = 8;
export const STOP_TYPES_MIN = 2;
export const STOP_TYPES_MIN_SINGLE = 1;
export const STOP_TYPES_MAX = 4;

/**
 * `parse_intent` output.
 * Area, window, budget, dietary needs, vibe tags, and the stop sequence.
 * `singleStop` is true only when the user explicitly asked for one place.
 */
export const intentSchema = z
  .object({
    area: z.string().trim().min(1).max(120),
    window: z
      .object({
        start: isoDateTimeSchema,
        end: isoDateTimeSchema,
      })
      .refine((window) => isBefore(window.start, window.end), {
        message: "Window start must be before window end",
        path: ["end"],
      }),
    budgetUsd: z.int().positive().max(100_000),
    dietary: z.array(z.string().trim().min(1).max(40)).max(INTENT_TAG_MAX),
    vibeTags: z.array(z.string().trim().min(1).max(40)).max(INTENT_TAG_MAX),
    stopTypes: z.array(stopTypeSchema).min(STOP_TYPES_MIN_SINGLE).max(STOP_TYPES_MAX),
    singleStop: z.boolean().default(false),
  })
  .strict()
  .superRefine((intent, ctx) => {
    if (!intent.singleStop && intent.stopTypes.length < STOP_TYPES_MIN) {
      ctx.addIssue({
        code: "custom",
        message: "stopTypes needs at least 2 values unless singleStop is true",
        path: ["stopTypes"],
      });
    }
  });

export type Intent = z.infer<typeof intentSchema>;
