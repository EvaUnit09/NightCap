import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type { EvalCase } from "../../evaluation/cases";
import { EXIT_MISSING_ENV, EXIT_OK, EXIT_USAGE, missingLiveEnv, parseEvalArgs, runEvalCli } from "../../evaluation/cli";
import { filterOnlyCaseRunner, filterOnlyPoolOracle, type FilterOnlyDeps } from "../../evaluation/filter-only";
import { RAW_MODEL_PROMPT, rawModelCaseRunner } from "../../evaluation/raw-model";
import type { EvalCaseRecord } from "../../evaluation/record";
import { runCases, type CaseRunner } from "../../evaluation/runner";
import { isValidCase } from "../../evaluation/score";
import { createMemoryExporter } from "../../src/monitoring";
import { resetConfig } from "../../src/models";
import { createPipelineDeps, type ModelClient, type ModelResponse, type PipelineDeps } from "../../src/pipeline";
import { allCandidates, queryFromIntent, retrieveVenues, type Retrieval } from "../../src/retrieval";
import { parseSearchBody, type PlacesClient } from "../../src/retrieval/places-client";
import { DEFAULT_PRICE_RANGES } from "../../src/validation/defaults";
import type { Intent } from "../../src/validation/intent";
import type { TravelCalculator } from "../../src/validation/travel";
import { validateItinerary } from "../../src/validation/validator";
import { FULL_SCRIPT, INTENT, OPTION_A, OPTION_B, TEN_MINUTES, stop } from "../pipeline/orchestrator-harness";
import { fakePlaces } from "../retrieval/fake-places";
import { loadPlacesFixture } from "../retrieval/places-fixtures";

/**
 * Both baselines end to end over fakes: real retrieval over fake Places
 * HTTP, the real validator with a fixed travel calculator, and fake models.
 * Nothing here touches the network.
 */

function evalCase(id: string, query: string, overrides: Partial<EvalCase["constraints"]> = {}): EvalCase {
  return {
    id,
    query,
    tags: [],
    edge: false,
    constraints: {
      boroughs: ["Manhattan"],
      budget_min: 100,
      budget_max: 200,
      time_window: "evening",
      day_of_week: "Friday",
      vibes: [],
      dietary: [],
      single_stop: false,
      expected_options: 2,
      stops_per_option: "2-4",
      travel_modes: ["WALK"],
      max_travel_minutes: 25,
      ...overrides,
    },
  };
}

const CASE = evalCase("nc-901", "Cozy drinks then dinner in the West Village Friday");
const OTHER_CASE = evalCase("nc-902", "Cocktails and dinner somewhere nice");

function retrieveFromFixture(intent: Intent, signal?: AbortSignal): Promise<Retrieval> {
  return retrieveVenues(
    queryFromIntent(intent, { priceRanges: DEFAULT_PRICE_RANGES, partySize: 2 }),
    fakePlaces(FULL_SCRIPT).deps,
    signal,
  );
}

function validateWith(travelCalculator: TravelCalculator): FilterOnlyDeps["validate"] {
  return (input) => validateItinerary(input, { travelCalculator });
}

function filterDeps(overrides: Partial<FilterOnlyDeps> = {}): FilterOnlyDeps {
  return {
    retrieve: retrieveFromFixture,
    validate: validateWith(TEN_MINUTES),
    maxLegs: 6,
    travel: TEN_MINUTES,
    ...overrides,
  };
}

async function runOne(runner: CaseRunner, entry: EvalCase = CASE): Promise<EvalCaseRecord> {
  const [record] = await runCases([entry], runner);
  return record;
}

describe("filterOnlyCaseRunner", () => {
  it("assembles disjoint top-ranked options from the real pool and the real validator accepts them", async () => {
    const record = await runOne(filterOnlyCaseRunner(filterDeps()));

    assert.deepEqual(record.outcome, { kind: "completed" });
    assert.equal(record.options.length, 2);
    const ids = record.options.flatMap((option) => option.placeIds);
    assert.equal(new Set(ids).size, ids.length, "no venue is shared between options");
    const poolIds = new Set(record.pool.map((venue) => venue.placeId));
    assert.ok(ids.every((id) => poolIds.has(id)), "every stop is a retrieved candidate");
    assert.deepEqual(record.intent?.stopTypes, ["dinner", "drinks"]);
    const stopTypes = new Map(record.pool.map((venue) => [venue.placeId, venue.stopType]));
    for (const option of record.options) {
      assert.deepEqual(option.placeIds.map((id) => stopTypes.get(id)), ["dinner", "drinks"]);
    }
    assert.deepEqual(record.audit?.modelCalls, []);
    assert.equal(record.audit?.totalCostUsd, 0);
    assert.equal(record.audit?.plannedOptionCount, 2);
    assert.equal(record.poolOracle, true);
    assert.equal(isValidCase(record), true);
  });

  it("uses the best-ranked venue per stop type first", async () => {
    const retrieval = await retrieveFromFixture({ ...INTENT, stopTypes: ["dinner", "drinks"] });
    const ranked = (type: "dinner" | "drinks") => {
      const outcome = retrieval.byStopType.get(type);
      return outcome?.kind === "ranked" ? outcome.candidates.map((candidate) => candidate.placeId) : [];
    };

    const record = await runOne(filterOnlyCaseRunner(filterDeps()));

    assert.deepEqual(record.options[0].placeIds, [ranked("dinner")[0], ranked("drinks")[0]]);
    assert.deepEqual(record.options[1].placeIds, [ranked("dinner")[1], ranked("drinks")[1]]);
  });

  it("records a validator finding as a dropped option and keeps the clean one", async () => {
    const validate: FilterOnlyDeps["validate"] = async () => [
      { code: "over_budget", message: "too much", optionIndex: 1 },
    ];

    const record = await runOne(filterOnlyCaseRunner(filterDeps({ validate })));

    assert.deepEqual(record.outcome, { kind: "completed" });
    assert.deepEqual(record.options.map((option) => option.optionIndex), [0]);
    assert.deepEqual(record.dropped, [{ optionIndex: 1, reason: "unrepairable", repairRounds: 0, lastCodes: ["over_budget"] }]);
  });

  it("fails validate when every option has a finding", async () => {
    const validate: FilterOnlyDeps["validate"] = async () => [{ code: "closed", message: "closed" }];

    const record = await runOne(filterOnlyCaseRunner(filterDeps({ validate })));

    assert.deepEqual(record.outcome, { kind: "failed", failure: { stage: "validate", code: "no_valid_options" } });
    assert.equal(record.dropped.length, 2);
    assert.equal(record.poolOracle, false);
  });

  it("builds nothing when a leg cannot be timed, and does not call the validator", async () => {
    let validations = 0;
    const record = await runOne(
      filterOnlyCaseRunner(
        filterDeps({
          travel: { calculateMinutes: (legs) => legs.map(() => null) },
          validate: async () => {
            validations += 1;
            return [];
          },
        }),
      ),
    );

    assert.deepEqual(record.outcome, { kind: "failed", failure: { stage: "validate", code: "no_valid_options" } });
    assert.equal(record.audit?.plannedOptionCount, 0);
    assert.equal(validations, 0);
  });

  it("ends as a retrieval failure on a retrieval error or an empty pool", async () => {
    const thrown = await runOne(
      filterOnlyCaseRunner(filterDeps({ retrieve: async () => Promise.reject(new Error("places down")) })),
    );
    assert.deepEqual(thrown.outcome, { kind: "failed", failure: { stage: "retrieve", code: "retrieval_error" } });

    const empty: Retrieval = {
      byStopType: new Map([
        ["dinner", { kind: "gap", reason: "no_matches" }],
        ["drinks", { kind: "gap", reason: "no_matches" }],
      ]),
      placesRequests: 1,
    };
    const none = await runOne(filterOnlyCaseRunner(filterDeps({ retrieve: async () => empty })));
    assert.deepEqual(none.outcome, { kind: "failed", failure: { stage: "retrieve", code: "no_candidates" } });
    assert.equal(none.retrievalGaps.length, 2);
  });
});

describe("filterOnlyPoolOracle", () => {
  it("says a full pool admits a valid itinerary and a one-sided pool does not", async () => {
    const oracle = filterOnlyPoolOracle(filterDeps());
    const signal = AbortSignal.timeout(5_000);
    const intent = { ...INTENT, window: { start: "2026-10-23T19:00:00-04:00", end: "2026-10-23T23:30:00-04:00" } };
    const pool = allCandidates(await retrieveFromFixture(intent));

    assert.equal(await oracle(intent, pool, signal), true);
    assert.equal(await oracle(intent, pool.filter((candidate) => candidate.stopType === "drinks"), signal), false);
  });
});

/** The fixture's real places, as a Places client that returns all of them for any search. */
function fixturePlaces(): { client: PlacesClient; searches: () => string[] } {
  const searched: string[] = [];
  const records = parseSearchBody(loadPlacesFixture("combined-drinks-dinner-dessert"));
  return {
    client: {
      async searchText(request) {
        searched.push(request.textQuery);
        return records;
      },
    },
    searches: () => searched,
  };
}

const RAW_RESPONSE = {
  stopReason: "end_turn",
  inputTokens: 1_000,
  outputTokens: 400,
} as const;

function rawStop(placeId: string, name: string, start: string, end: string, cost: number, next: number | null) {
  return { ...stop(placeId, name, start, end, cost, next), start: `2026-10-23T${start}:00-04:00`, end: `2026-10-23T${end}:00-04:00` };
}

function rawOption(theme: string, bar: [string, string], dinner: [string, string]) {
  return {
    theme,
    stops: [
      rawStop(bar[0], bar[1], "19:00", "20:00", 60, 10),
      rawStop(dinner[0], dinner[1], "20:15", "22:00", 120, null),
    ],
  };
}

function rawModels(reply: (user: string) => ModelResponse | Error, seen: string[] = []): ModelClient {
  return {
    async complete(request) {
      assert.equal(request.system, RAW_MODEL_PROMPT);
      seen.push(request.user);
      const response = reply(request.user);
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

const json = (value: unknown): ModelResponse => ({ text: "```json\n" + JSON.stringify(value) + "\n```", ...RAW_RESPONSE });

describe("rawModelCaseRunner", () => {
  function runner(models: ModelClient, places: PlacesClient) {
    return rawModelCaseRunner({
      models,
      places,
      model: "claude-sonnet-5",
      validate: validateWith(TEN_MINUTES),
      maxLegs: 6,
    });
  }

  it("looks up every id it emits, counts the unknown one as invented, and validates the rest", async () => {
    const places = fixturePlaces();
    const prompts: string[] = [];
    const plan = {
      options: [
        rawOption("Classic", ["ChIJbar0", "Little Branch"], ["ChIJdin0", "Via Carota"]),
        rawOption("Made up", ["ChIJbar1", "Employees Only"], ["ChIJmade_up", "Imaginary Bistro"]),
      ],
    };

    const record = await runOne(runner(rawModels(() => json(plan), prompts), places.client));

    assert.equal(places.searches().length, 4, "one lookup per distinct id");
    assert.ok(places.searches()[0].startsWith("Little Branch"), "searched by the stop's own name");
    assert.deepEqual(record.outcome, { kind: "completed" });
    assert.deepEqual(record.options, [{ optionIndex: 0, repairRounds: 0, placeIds: ["ChIJbar0", "ChIJdin0"] }]);
    assert.deepEqual(record.audit?.inventedPlaceIds, [
      { stage: "plan", round: 0, optionIndex: 1, placeId: "ChIJmade_up" },
    ]);
    assert.equal(record.audit?.plannedOptionCount, 2);
    assert.deepEqual(record.dropped.map((entry) => entry.optionIndex), [1]);
    assert.ok(record.dropped[0].lastCodes.includes("invented_venue"), "the validator flags the same id");
    assert.equal(isValidCase(record), false, "an invented id fails the case even when another option is clean");
    assert.deepEqual(record.pool, []);
    assert.equal(record.audit?.modelCalls.length, 1);
    assert.equal(record.audit?.modelCalls[0].formatValid, true);
    assert.ok((record.audit?.totalCostUsd ?? 0) > 0);
    assert.ok(prompts[0].includes("Cozy drinks then dinner"), "the request reaches the model");
    assert.ok(prompts[0].includes("$200"), "the budget reaches the model");
  });

  it("is valid when every id is real and the validator passes", async () => {
    const plan = {
      options: [
        rawOption("A", ["ChIJbar0", "Little Branch"], ["ChIJdin0", "Via Carota"]),
        rawOption("B", ["ChIJbar1", "Employees Only"], ["ChIJdin1", "I Sodi"]),
      ],
    };

    const record = await runOne(runner(rawModels(() => json(plan)), fixturePlaces().client));

    assert.equal(record.options.length, 2);
    assert.deepEqual(record.audit?.inventedPlaceIds, []);
    assert.equal(isValidCase(record), true);
  });

  it("fails the plan stage on unusable output, with the call recorded as a format miss", async () => {
    const places = fixturePlaces();

    const noJson = await runOne(
      runner(rawModels(() => ({ text: "Try Via Carota!", ...RAW_RESPONSE })), places.client),
    );
    assert.deepEqual(noJson.outcome, { kind: "failed", failure: { stage: "plan", code: "no_json" } });
    assert.equal(noJson.audit?.modelCalls[0].formatValid, false);

    const refused = await runOne(
      runner(rawModels(() => ({ text: "", ...RAW_RESPONSE, stopReason: "refusal" })), places.client),
    );
    assert.deepEqual(refused.outcome, { kind: "failed", failure: { stage: "plan", code: "refusal" } });

    const oneOption = await runOne(
      runner(
        rawModels(() => json({ options: [rawOption("A", ["ChIJbar0", "Little Branch"], ["ChIJdin0", "Via Carota"])] })),
        places.client,
      ),
    );
    assert.deepEqual(oneOption.outcome, { kind: "failed", failure: { stage: "plan", code: "schema_invalid" } });
    assert.equal(places.searches().length, 0, "nothing is looked up for a plan that did not parse");
  });

  it("records a model transport failure as a plan failure with no call", async () => {
    const record = await runOne(runner(rawModels(() => new Error("503")), fixturePlaces().client));

    assert.deepEqual(record.outcome, { kind: "failed", failure: { stage: "plan", code: "model_error" } });
    assert.deepEqual(record.audit?.modelCalls, []);
  });

  it("turns a Places outage during the lookup into an error record instead of guessing", async () => {
    const down: PlacesClient = { searchText: async () => Promise.reject(new Error("places down")) };
    const plan = {
      options: [
        rawOption("A", ["ChIJbar0", "Little Branch"], ["ChIJdin0", "Via Carota"]),
        rawOption("B", ["ChIJbar1", "Employees Only"], ["ChIJdin1", "I Sodi"]),
      ],
    };

    const record = await runOne(runner(rawModels(() => json(plan)), down));

    assert.equal(record.outcome.kind, "error");
  });
});

describe("eval CLI with baselines", () => {
  let outDir: string;
  before(async () => {
    outDir = await mkdtemp(join(tmpdir(), "nightcap-eval-baselines-"));
  });
  after(async () => {
    await rm(outDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    resetConfig();
    delete process.env.REPAIR_MAX_ROUNDS;
  });

  const rawPlan = {
    options: [
      rawOption("A", ["ChIJbar0", "Little Branch"], ["ChIJdin0", "Via Carota"]),
      rawOption("B", ["ChIJbar1", "Employees Only"], ["ChIJmade_up", "Imaginary Bistro"]),
    ],
  };

  /** Pipeline replies by stage; the raw baseline is told apart by its own system prompt. */
  const models: ModelClient = {
    async complete(request) {
      if (request.system === RAW_MODEL_PROMPT) return json(rawPlan);
      if (request.stage === "parse_intent") return json(INTENT);
      return json({ options: [OPTION_A, OPTION_B] });
    },
  };

  function fakeDeps(): PipelineDeps {
    return createPipelineDeps({
      models,
      retrieve: retrieveFromFixture,
      validate: validateWith(TEN_MINUTES),
      exporter: createMemoryExporter(),
    });
  }

  function io(overrides: Partial<Parameters<typeof runEvalCli>[1]> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    let tick = 0;
    return {
      out,
      err,
      io: {
        env: {},
        stdout: (text: string) => out.push(text),
        stderr: (text: string) => err.push(text),
        now: () => new Date(Date.UTC(2026, 9, 12, 12, 0, tick++)),
        createDeps: fakeDeps,
        createTravel: () => TEN_MINUTES,
        createPlaces: () => fixturePlaces().client,
        loadCases: () => [CASE, OTHER_CASE],
        ...overrides,
      },
    };
  }

  it("--system all runs the three systems on the same cases and prints one comparison table", async () => {
    const harness = io();

    const code = await runEvalCli(["--system", "all", "--out", outDir, "--concurrency", "1"], harness.io);

    assert.equal(code, EXIT_OK, harness.err.join("\n"));
    const rows = harness.out.join("\n").split("\n").filter((line) => line.startsWith("| "));
    assert.equal(rows.length, 5, "header, rule, and one row per system");
    const [pipeline, filterOnly, rawModel] = rows.slice(2).map((row) => row.split(" | ").map((cell) => cell.replace(/^\| | \|$/g, "")));
    assert.deepEqual([pipeline[0], filterOnly[0], rawModel[0]], ["pipeline", "filter-only", "raw-model"]);
    assert.deepEqual([pipeline[1], filterOnly[1], rawModel[1]], ["2", "2", "2"], "same cases for every system");
    assert.equal(filterOnly[2], "100.0% (2/2)", "validity");
    assert.equal(filterOnly[3], "0.0% (0/2)", "invented venue");
    assert.equal(filterOnly[4], "n/a (0/0)", "no model calls, no format compliance");
    assert.equal(rawModel[3], "100.0% (2/2)", "the raw model invented a venue in both cases");
    assert.equal(rawModel[2], "0.0% (0/2)", "so neither case is valid");
    assert.equal(rawModel[8], "n/a", "no retrieval, no candidate recall");
    assert.equal(pipeline[3], "0.0% (0/2)");
    assert.equal(harness.err.filter((line) => line.startsWith("[raw-model]")).length, 2);
    assert.equal((await readdir(outDir)).length, 3, "one report per system");
  });

  it("--compare prints the table from saved reports without keys, deps, or cases", async () => {
    const harness = io({ createDeps: undefined, loadCases: undefined });

    const code = await runEvalCli(["--compare", "--out", outDir], harness.io);

    assert.equal(code, EXIT_OK, harness.err.join("\n"));
    const printed = harness.out.join("\n");
    for (const system of ["pipeline", "filter-only", "raw-model"]) {
      assert.match(printed, new RegExp(`\\| ${system} \\|`));
    }
    assert.ok(!printed.includes("No report yet"));
  });

  it("--compare says so when there is nothing to compare", async () => {
    const empty = await mkdtemp(join(tmpdir(), "nightcap-eval-empty-"));
    try {
      const harness = io();
      assert.equal(await runEvalCli(["--compare", "--out", empty], harness.io), EXIT_USAGE);
      assert.match(harness.err.join("\n"), /No reports/);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("reports budget fit as n/a for a baseline and as a number for the pipeline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nightcap-eval-budget-"));
    try {
      const baseline = io();
      assert.equal(await runEvalCli(["--system", "filter-only", "--out", dir], baseline.io), EXIT_OK, baseline.err.join("\n"));
      assert.match(baseline.out.join("\n"), /Budget fit \(party\)\s+n\/a \(0\/0\)/);

      const pipeline = io();
      assert.equal(await runEvalCli(["--system", "pipeline", "--out", dir], pipeline.io), EXIT_OK, pipeline.err.join("\n"));
      assert.match(pipeline.out.join("\n"), /Budget fit \(party\)\s+\d+\.\d% \(\d+\/2\)/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("--system filter-only writes its own report and prints that system's metrics", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nightcap-eval-one-"));
    try {
      const harness = io();
      const code = await runEvalCli(["--system", "filter-only", "--out", dir], harness.io);

      assert.equal(code, EXIT_OK, harness.err.join("\n"));
      assert.match(harness.out.join("\n"), /Validity \(cases\)\s+100\.0% \(2\/2\)/);
      assert.deepEqual((await readdir(dir)).map((name) => name.split("-v1-")[0]), ["filter-only"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a live baseline run per system: filter-only does not need the Anthropic key", async () => {
    const live = { createDeps: undefined, createTravel: undefined, createPlaces: undefined };
    const raw = io(live);
    assert.equal(await runEvalCli(["--system", "raw-model", "--out", outDir], raw.io), EXIT_MISSING_ENV);
    assert.match(raw.err.join("\n"), /ANTHROPIC_API_KEY/);

    const filter = io(live);
    assert.equal(await runEvalCli(["--system", "filter-only", "--out", outDir], filter.io), EXIT_MISSING_ENV);
    assert.ok(!filter.err.join("\n").includes("ANTHROPIC_API_KEY"));
    assert.deepEqual(
      missingLiveEnv({ GOOGLE_PLACES_API_KEY: "k", ENABLE_LIVE_ROUTES: "true" }, "filter-only"),
      [],
    );
  });

  it("parses --system and --compare and rejects bad combinations", () => {
    assert.equal(parseEvalArgs([]).system, "pipeline");
    assert.equal(parseEvalArgs(["--system", "raw-model"]).system, "raw-model");
    assert.equal(parseEvalArgs(["--compare"]).compare, true);
    assert.throws(() => parseEvalArgs(["--system", "gpt"]), /--system must be one of/);
    assert.throws(() => parseEvalArgs(["--compare", "--system", "all"]), /drop --system/);
  });
});
