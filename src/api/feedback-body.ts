import { z } from "zod";

import { placeIdSchema } from "../validation/common";

const BLOCKED_PLACE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const signalPlaceId = placeIdSchema.refine((placeId) => !BLOCKED_PLACE_KEYS.has(placeId));

export const feedbackSignalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thumbs"), thumbs: z.union([z.literal(-1), z.literal(1)]) }).strict(),
  z.object({ kind: z.literal("would_go"), wouldGo: z.boolean() }).strict(),
  z.object({ kind: z.literal("did_go"), didGo: z.boolean() }).strict(),
  z.object({ kind: z.literal("new_to_you"), placeId: signalPlaceId, value: z.boolean() }).strict(),
  z.object({ kind: z.literal("closed_venue"), placeId: signalPlaceId }).strict(),
]);

export const feedbackBodySchema = z
  .object({
    itineraryId: z.string().uuid(),
    signal: feedbackSignalSchema,
  })
  .strict();

export type FeedbackSignal = z.infer<typeof feedbackSignalSchema>;
export type FeedbackBody = z.infer<typeof feedbackBodySchema>;
