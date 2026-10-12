import { createMemoryExporter, type MemoryExporter } from "../../src/monitoring";
import {
  createPipelineDeps,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
  type ModelStage,
  type PipelineDeps,
} from "../../src/pipeline";
import { queryFromIntent, retrieveVenues } from "../../src/retrieval";
import { DEFAULT_PRICE_RANGES } from "../../src/validation/defaults";
import type { Intent } from "../../src/validation/intent";
import type { ItineraryOption } from "../../src/validation/itinerary";
import type { TravelCalculator } from "../../src/validation/travel";
import { validateItinerary, type ValidatorInput } from "../../src/validation/validator";
import type { ValidationError } from "../../src/validation/validation-error";
import { fakePlaces, type FakePlaces, type Script } from "../retrieval/fake-places";
import { loadPlacesFixture } from "../retrieval/places-fixtures";

export const REQUEST_TEXT = "Cozy drinks then dinner in the West Village Friday after 7, about $200 for two";

export const INTENT: Intent = {
  area: "West Village",
  window: { start: "2026-10-16T19:00:00-04:00", end: "2026-10-16T23:30:00-04:00" },
  budgetUsd: 200,
  dietary: [],
  vibeTags: ["cozy"],
  stopTypes: ["drinks", "dinner"],
  singleStop: false,
};

export const FULL_SCRIPT: Script = { combined: [loadPlacesFixture("combined-drinks-dinner-dessert")] };

/** A model reply: a JSON value (sent fenced, as the prompts show), raw text, or a thrown error. */
export type Reply =
  | { readonly json: unknown; readonly stopReason?: ModelResponse["stopReason"] }
  | { readonly text: string }
  | { readonly error: Error };

export interface FakeModels {
  readonly client: ModelClient;
  readonly requests: () => readonly ModelRequest[];
  readonly requestsFor: (stage: ModelStage) => readonly ModelRequest[];
}

const TOKENS = { inputTokens: 1_000, outputTokens: 200 } as const;

/** Replies per stage, consumed in order. An unscripted call fails the test loudly. */
export function fakeModels(script: Partial<Record<ModelStage, readonly Reply[]>>): FakeModels {
  const used = new Map<ModelStage, number>();
  const seen: ModelRequest[] = [];
  return {
    client: {
      async complete(request) {
        seen.push(request);
        const index = used.get(request.stage) ?? 0;
        used.set(request.stage, index + 1);
        const reply = script[request.stage]?.[index];
        if (reply === undefined) throw new Error(`unscripted ${request.stage} call #${index}`);
        if ("error" in reply) throw reply.error;
        if ("text" in reply) return { text: reply.text, stopReason: "end_turn", ...TOKENS };
        const text = "```json\n" + JSON.stringify(reply.json) + "\n```";
        return { text, stopReason: reply.stopReason ?? "end_turn", ...TOKENS };
      },
    },
    requests: () => [...seen],
    requestsFor: (stage) => seen.filter((request) => request.stage === stage),
  };
}

export const TEN_MINUTES: TravelCalculator = { calculateMinutes: (legs) => legs.map(() => 10) };

export function stop(
  placeId: string,
  name: string,
  start: string,
  end: string,
  estimatedCostUsd: number,
  next: number | null,
): ItineraryOption["stops"][number] {
  return {
    placeId,
    name,
    start: `2026-10-16T${start}:00-04:00`,
    end: `2026-10-16T${end}:00-04:00`,
    estimatedCostUsd,
    why: "Fits a cozy night",
    travelToNext: next === null ? null : { mode: "WALK", minutes: next },
  };
}

export function option(theme: string, drinks: [string, string], dinner: [string, string]): ItineraryOption {
  return {
    theme,
    stops: [
      stop(drinks[0], drinks[1], "19:00", "20:00", 60, 10),
      stop(dinner[0], dinner[1], "20:15", "22:00", 120, null),
    ],
  };
}

export const OPTION_A = option("Classic cocktails and pasta", ["ChIJbar0", "Little Branch"], ["ChIJdin0", "Via Carota"]);
export const OPTION_B = option("Lively bar and trattoria", ["ChIJbar1", "Employees Only"], ["ChIJdin1", "I Sodi"]);

export interface Harness {
  readonly deps: PipelineDeps;
  readonly exporter: MemoryExporter;
  readonly models: FakeModels;
  readonly places: FakePlaces;
  readonly validations: () => number;
}

/**
 * Real retrieval over fake Places HTTP, the real validator with a fixed
 * travel calculator, and fake models. `repairMaxRounds` comes from config.
 */
export function harness(options: {
  readonly models: FakeModels;
  readonly places?: Script;
  readonly validate?: (input: ValidatorInput) => Promise<ValidationError[]>;
  readonly retrieve?: PipelineDeps["retrieve"];
}): Harness {
  const exporter = createMemoryExporter();
  const places = fakePlaces(options.places ?? FULL_SCRIPT);
  let validations = 0;
  const validate = options.validate ?? ((input) => validateItinerary(input, { travelCalculator: TEN_MINUTES }));
  const deps = createPipelineDeps({
    models: options.models.client,
    retrieve:
      options.retrieve ??
      ((intent, signal) =>
        retrieveVenues(queryFromIntent(intent, { priceRanges: DEFAULT_PRICE_RANGES, partySize: 2 }), places.deps, signal)),
    validate: (input) => {
      validations += 1;
      return validate(input);
    },
    exporter,
  });
  return { deps, exporter, models: options.models, places, validations: () => validations };
}

export function spanNames(exporter: MemoryExporter): string[] {
  return exporter.traces[0].spans.map((span) => span.name);
}

export function spansNamed(exporter: MemoryExporter, name: string) {
  return exporter.traces[0].spans.filter((span) => span.name === name);
}
