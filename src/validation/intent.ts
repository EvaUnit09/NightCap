import { z } from "zod";

import { isBefore, isoDateTimeSchema, stopTypeSchema } from "./common";

/**
 * `parse_intent` output.
 * Area, window, budget, dietary needs, vibe tags, and the stop sequence.
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
    dietary: z.array(z.string().trim().min(1).max(40)).max(8),
    vibeTags: z.array(z.string().trim().min(1).max(40)).max(8),
    stopTypes: z.array(stopTypeSchema).min(2).max(4),
  })
  .strict();

export type Intent = z.infer<typeof intentSchema>;
