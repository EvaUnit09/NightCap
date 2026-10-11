import type { Candidate } from "../validation/candidate";

export type StopType = Candidate["stopType"];

/** Non-empty and duplicate-free. Built only by the query adapters. */
export type StopTypes = readonly [StopType, ...StopType[]];

/**
 * Stop type -> Places (New) types that classify a place into it, best match
 * first. The first entry is a targeted search's includedType. One table
 * drives classification and refill searches both.
 */
export const STOP_TYPE_PLACE_TYPES: Readonly<Record<StopType, readonly [string, ...string[]]>> = {
  drinks: ["cocktail_bar", "wine_bar", "bar", "pub"],
  bar: ["bar", "pub", "night_club", "cocktail_bar"],
  dinner: ["restaurant"],
  dessert: ["dessert_shop", "ice_cream_shop", "bakery", "dessert_restaurant", "cafe"],
  activity: ["tourist_attraction", "museum", "performing_arts_theater", "bowling_alley", "comedy_club"],
};

/** The words a Text Search uses for a stop type: its best-match place type. */
export function stopTypeQueryTerm(stopType: StopType): string {
  return STOP_TYPE_PLACE_TYPES[stopType][0].replaceAll("_", " ");
}
