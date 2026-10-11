/**
 * Places retrieval: the one path the pipeline, the agent's search_venues,
 * and eval call. Code outside src/retrieval imports only this file.
 */
export { createRetrievalDeps, retrieveForIntent, retrieveForTool } from "./server";
export { allCandidates, retrieveVenues } from "./retrieve";
export type { GapReason, Retrieval, RetrievalDeps, RetrievalSettings, StopOutcome } from "./retrieve";
export { queryFromIntent, queryFromSearchVenues } from "./query";
export type { SearchVenuesInput, TimeSlot, VenueQuery } from "./query";
export type { StopType } from "./stop-types";
export { PlacesError } from "./places-client";
export type { PlacesErrorCode } from "./places-client";
export { coordsTtlDays, createMemoryCoordsCache, isLive, planCoordsWrite } from "./coords-cache";
export type { CoordsCache, CoordsEntry, CoordsObservation, CoordsTtlDays, CoordsWrite, LatLng } from "./coords-cache";
