import { z } from "zod";

/** Same bound as `WRAP_USER_TEXT_MAX_CHARS`. This module stays free of `server-only` so the browser can build the body. */
export const PLAN_TEXT_MAX_CHARS = 8 * 1024;

const NEIGHBORHOOD_MAX = 80;

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export const planRequestSchema = z
  .object({
    text: z.string().trim().min(1).max(PLAN_TEXT_MAX_CHARS),
    date: z.string().refine(isCalendarDate, { message: "Date must be a real calendar day" }).optional(),
    budgetUsd: z.int().positive().max(100_000).optional(),
    neighborhood: z.string().trim().min(1).max(NEIGHBORHOOD_MAX).optional(),
  })
  .strict();

export type PlanRequest = z.infer<typeof planRequestSchema>;

/** Optional filters become lines in the user text so intent parsing sees them. */
export function composePlanText(input: PlanRequest): string {
  const lines = [input.text];
  if (input.date !== undefined) lines.push(`Date: ${input.date}`);
  if (input.budgetUsd !== undefined) lines.push(`Budget: $${input.budgetUsd} for the night`);
  if (input.neighborhood !== undefined) lines.push(`Neighborhood: ${input.neighborhood}`);
  return lines.join("\n");
}
