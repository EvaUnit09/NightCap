import { z } from "zod";

/** NightCap v1 travel modes. #7 maps these to Routes; nothing else is accepted. */
export const TRAVEL_MODES = ["TRANSIT", "BICYCLE", "WALK"] as const;

export type TravelMode = (typeof TRAVEL_MODES)[number];

export const travelModeSchema = z.enum(TRAVEL_MODES);
