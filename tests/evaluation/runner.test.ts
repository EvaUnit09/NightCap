import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type { EvalCase } from "../../evaluation/cases";
import { EXIT_MISSING_ENV, EXIT_OK, EXIT_USAGE, missingLiveEnv, parseEvalArgs, runEvalCli } from "../../evaluation/cli";
import type { EvalCaseRecord } from "../../evaluation/record";
import type { EvalReport } from "../../evaluation/report";
import { pipelineCaseRunner, runCases, type CaseRunner } from "../../evaluation/runner";
import { createMemoryExporter } from "../../src/monitoring";
import { resetConfig } from "../../src/models";
import { createPipelineDeps, type ModelClient, type ModelResponse, type PipelineDeps } from "../../src/pipeline";
import { queryFromIntent, retrieveVenues, type Retrieval } from "../../src/retrieval";
import { DEFAULT_PRICE_RANGES } from "../../src/validation/defaults";
import { validateItinerary } from "../../src/validation/validator";
import { FULL_SCRIPT, INTENT, OPTION_A, OPTION_B, TEN_MINUTES, option } from "../pipeline/orchestrator-harness";
import { fakePlaces } from "../retrieval/fake-places";

/**
 * The runner end to end over fake PipelineDeps: real orchestrator, real
 * retrieval over fake Places HTTP, the real validator with a fixed travel
 * calculator, and a model client that answers by a marker in the query.
 */

const INVENTED = option("Made-up night", ["ChIJbar1", "Employees Only"], ["ChIJnot_a_candidate", "Imaginary Bistro"]);

/** Query marker → the area the fake parse returns, which the fake plan and retrieve key on. */
const AREA_FOR: Readonly<Record<string, string>> = {
  NOPOOL: "Nowhere",
  INVENT: "Inventia",
  BADPLAN: "Badplan",
};

function reply(text: string): ModelResponse {
  return { text, stopReason: "end_turn", inputTokens: 100, outputTokens: 20 };
}

const json = (value: unknown) => reply("```json\n" + JSON.stringify(value) + "\n```");

const fakeModels: ModelClient = {
  async complete(request) {
    if (request.stage === "parse_intent") {
      if (request.user.includes("UNPARSEABLE")) return reply("I cannot help with that.");
      const marker = Object.keys(AREA_FOR).find((key) => request.user.includes(key));
      return json({ ...INTENT, area: marker === undefined ? INTENT.area : AREA_FOR[marker] });
    }
    if (request.stage === "plan_itineraries") {
      if (request.user.includes(AREA_FOR.BADPLAN)) return reply("no plan today");
      const second = request.user.includes(AREA_FOR.INVENT) ? INVENTED : OPTION_B;
      return json({ options: [OPTION_A, second] });
    }
    return reply("still no json");
  },
};

const EMPTY_RETRIEVAL: Retrieval = {
  byStopType: new Map([
    ["drinks", { kind: "gap", reason: "no_matches" }],
    ["dinner", { kind: "gap", reason: "no_matches" }],
  ]),
  placesRequests: 1,
};

function fakeDeps(): PipelineDeps {
  return createPipelineDeps({
    models: fakeModels,
    retrieve: async (intent, signal) =>
      intent.area === AREA_FOR.NOPOOL
        ? EMPTY_RETRIEVAL
        : retrieveVenues(
            queryFromIntent(intent, { priceRanges: DEFAULT_PRICE_RANGES, partySize: 2 }),
            fakePlaces(FULL_SCRIPT).deps,
            signal,
          ),
    validate: (input) => validateItinerary(input, { travelCalculator: TEN_MINUTES }),
    exporter: createMemoryExporter(),
  });
}

function evalCase(id: string, query: string): EvalCase {
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
    },
  };
}

const CASES: readonly EvalCase[] = [
  evalCase("nc-901", "Cozy drinks then dinner in the West Village Friday"),
  evalCase("nc-902", "UNPARSEABLE request"),
  evalCase("nc-903", "NOPOOL drinks and dinner"),
  evalCase("nc-904", "INVENT drinks and dinner"),
  evalCase("nc-905", "BADPLAN drinks and dinner"),
];

function byId(records: readonly EvalCaseRecord[], id: string): EvalCaseRecord {
  const record = records.find((entry) => entry.caseId === id);
  assert.ok(record, id);
  return record;
}

describe("pipelineCaseRunner", () => {
  beforeEach(() => {
    resetConfig();
    delete process.env.REPAIR_MAX_ROUNDS;
  });

  it("turns each pipeline outcome into a record with its pool and audit", async () => {
    const records = await runCases(CASES, pipelineCaseRunner(fakeDeps()), { concurrency: 2 });

    assert.deepEqual(records.map((record) => record.caseId), CASES.map((entry) => entry.id), "case order is kept");
    const ok = byId(records, "nc-901");
    assert.deepEqual(ok.outcome, { kind: "completed" });
    assert.deepEqual(ok.options.map((entry) => entry.placeIds), [
      ["ChIJbar0", "ChIJdin0"],
      ["ChIJbar1", "ChIJdin1"],
    ]);
    assert.equal(ok.pool.length, 8);
    assert.deepEqual(ok.intent, { budgetUsd: 200, stopTypes: ["drinks", "dinner"], singleStop: false });

    assert.deepEqual(byId(records, "nc-902").outcome, { kind: "failed", failure: { stage: "parse", code: "no_json" } });
    assert.equal(byId(records, "nc-902").intent, null);
    assert.deepEqual(byId(records, "nc-903").outcome, {
      kind: "failed",
      failure: { stage: "retrieve", code: "no_candidates" },
    });

    const invent = byId(records, "nc-904");
    assert.deepEqual(invent.outcome, { kind: "completed" });
    assert.deepEqual(invent.options.map((entry) => entry.optionIndex), [0]);
    assert.deepEqual(invent.audit?.inventedPlaceIds.map((entry) => entry.placeId), ["ChIJnot_a_candidate"]);

    assert.deepEqual(byId(records, "nc-905").outcome, { kind: "failed", failure: { stage: "plan", code: "no_json" } });
    assert.ok(records.every((record) => record.poolOracle === null), "no oracle, no verdict");
    assert.ok(!JSON.stringify(records).includes("West Village"), "records carry no request or intent text");
  });

  it("asks the pool oracle only about a failed case that has a pool", async () => {
    const asked: string[] = [];
    const runner = pipelineCaseRunner(fakeDeps(), {
      poolOracle: async (intent) => {
        asked.push(intent.area);
        return false;
      },
    });

    const records = await runCases(CASES, runner, { concurrency: 1 });

    assert.deepEqual(asked, [AREA_FOR.BADPLAN]);
    assert.equal(byId(records, "nc-905").poolOracle, false);
  });

  it("records a pipeline that throws as an error and keeps the pool it saw", async () => {
    const deps = { ...fakeDeps(), validate: async () => Promise.reject(new Error("validator bug")) };

    const [record] = await runCases(CASES.slice(0, 1), pipelineCaseRunner(deps));

    assert.equal(record.outcome.kind, "error");
    assert.match(record.outcome.kind === "error" ? record.outcome.message : "", /validator bug/);
    assert.equal(record.pool.length, 8);
    assert.equal(record.audit, null);
  });
});

describe("runCases", () => {
  it("keeps at most `concurrency` cases in flight and returns them in case order", async () => {
    let inFlight = 0;
    let peak = 0;
    const finished: string[] = [];
    const runner: CaseRunner = async (entry) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, entry.id === "nc-901" ? 20 : 1));
      inFlight -= 1;
      return { ...errorRecord(entry.id), outcome: { kind: "completed" } };
    };

    const records = await runCases(CASES, runner, { concurrency: 2, onRecord: (record) => finished.push(record.caseId) });

    assert.equal(peak, 2);
    assert.deepEqual(records.map((record) => record.caseId), CASES.map((entry) => entry.id));
    assert.notEqual(finished[0], "nc-901", "the slow first case finishes after others");
  });

  it("turns a thrown runner and a per-case timeout into error records without stopping the run", async () => {
    const runner: CaseRunner = (entry, signal) => {
      if (entry.id === "nc-901") return Promise.reject(new Error("boom"));
      if (entry.id === "nc-902") {
        return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
      }
      return Promise.resolve({ ...errorRecord(entry.id), outcome: { kind: "completed" } });
    };

    const records = await runCases(CASES.slice(0, 3), runner, { caseTimeoutMs: 10 });

    assert.deepEqual(records.map((record) => record.outcome.kind), ["error", "error", "completed"]);
    assert.match(JSON.stringify(records[1].outcome), /TimeoutError/);
  });
});

function errorRecord(caseId: string): EvalCaseRecord {
  return {
    caseId,
    outcome: { kind: "error", message: "" },
    intent: null,
    options: [],
    dropped: [],
    retrievalGaps: [],
    pool: [],
    poolOracle: null,
    audit: null,
  };
}

describe("eval CLI", () => {
  let outDir: string;
  before(async () => {
    outDir = await mkdtemp(join(tmpdir(), "nightcap-eval-"));
  });
  after(async () => {
    await rm(outDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    resetConfig();
    delete process.env.REPAIR_MAX_ROUNDS;
  });

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
        createTravel: () => TEN_MINUTES,
        ...overrides,
      },
    };
  }

  it("refuses a live run and names every missing env var, before building deps", async () => {
    const harness = io();

    const code = await runEvalCli(["--limit", "1", "--out", outDir], harness.io);

    assert.equal(code, EXIT_MISSING_ENV);
    const message = harness.err.join("\n");
    for (const name of ["ANTHROPIC_API_KEY", "GOOGLE_PLACES_API_KEY", "ENABLE_LIVE_ROUTES"]) {
      assert.match(message, new RegExp(name));
    }
    assert.deepEqual(harness.out, []);
  });

  it("missingLiveEnv names only what is missing", () => {
    assert.deepEqual(
      missingLiveEnv({ ANTHROPIC_API_KEY: "k", GOOGLE_PLACES_API_KEY: "k", ENABLE_LIVE_ROUTES: "1" }),
      [],
    );
    const missing = missingLiveEnv({ ANTHROPIC_API_KEY: "k", GOOGLE_PLACES_API_KEY: " ", ENABLE_LIVE_ROUTES: "false" });
    assert.equal(missing.length, 2);
    assert.match(missing[0], /GOOGLE_PLACES_API_KEY/);
    assert.match(missing[1], /ENABLE_LIVE_ROUTES/);
  });

  it("parses --limit and --concurrency and rejects bad values", () => {
    assert.deepEqual(
      { ...parseEvalArgs(["--limit", "5", "--concurrency", "2", "--out", "x"]) },
      { system: "pipeline", compare: false, limit: 5, concurrency: 2, outDir: "x", help: false },
    );
    assert.equal(parseEvalArgs([]).limit, null);
    assert.throws(() => parseEvalArgs(["--limit", "0"]), /positive integer/);
    assert.throws(() => parseEvalArgs(["--limit", "2.5"]), /positive integer/);
    assert.throws(() => parseEvalArgs(["--bogus"]));
  });

  it("exits with usage on a bad flag", async () => {
    const harness = io();
    assert.equal(await runEvalCli(["--limit", "abc"], harness.io), EXIT_USAGE);
    assert.match(harness.err.join("\n"), /Usage: npm run eval/);
  });

  it("runs --limit cases, writes a JSON report, and prints the metrics table", async () => {
    const harness = io({ createDeps: fakeDeps, loadCases: () => [...CASES] });

    const code = await runEvalCli(["--limit", "4", "--concurrency", "2", "--out", outDir], harness.io);

    assert.equal(code, EXIT_OK, harness.err.join("\n"));
    const printed = harness.out.join("\n");
    const reportPath = /Report: (.+\.json)/.exec(printed)?.[1];
    assert.ok(reportPath !== undefined && reportPath.startsWith(outDir), printed);
    const report = JSON.parse(await readFile(reportPath, "utf8")) as EvalReport;
    assert.equal(report.system, "pipeline");
    assert.equal(report.limit, 4);
    assert.deepEqual(report.records.map((record) => record.caseId), ["nc-901", "nc-902", "nc-903", "nc-904"]);
    assert.deepEqual(report.promptVersions, { parse_intent: "v1", plan_itineraries: "v1", repair_itinerary: "v1" });

    const { metrics } = report;
    assert.deepEqual(metrics.validity.cases, { numerator: 1, denominator: 4, rate: 0.25 });
    assert.deepEqual(metrics.inventedVenue.cases, { numerator: 1, denominator: 2, rate: 0.5 });
    assert.equal(metrics.gates.inventedVenue.pass, false);
    assert.deepEqual(metrics.formatCompliance.byStage.parse_intent, { numerator: 3, denominator: 4, rate: 0.75 });
    assert.deepEqual(metrics.formatCompliance.byStage.plan_itineraries, { numerator: 2, denominator: 2, rate: 1 });
    assert.equal(metrics.formatCompliance.byStage.repair_itinerary.numerator, 0);
    assert.deepEqual(
      [metrics.candidateRecall.hit, metrics.candidateRecall.miss, metrics.candidateRecall.notApplicable],
      [2, 1, 1],
    );
    assert.deepEqual(metrics.planValidityGivenPool, { numerator: 1, denominator: 2, rate: 0.5 });

    for (const label of ["Validity (cases)", "Invented venue (cases)", "Format compliance", "Distinct venues", "Candidate recall"]) {
      assert.match(printed, new RegExp(label.replace(/[()]/g, "\\$&")));
    }
    assert.match(printed, /25\.0% \(1\/4\)  gate ≥ 90%: FAIL/);
    assert.deepEqual(harness.err.length, 4, "one progress line per case");
  });

  it("loads the frozen v1 set when no cases are injected", async () => {
    const harness = io({ createDeps: fakeDeps });

    assert.equal(await runEvalCli(["--limit", "2", "--out", outDir], harness.io), EXIT_OK);

    assert.deepEqual(harness.err.map((line) => line.split(" ")[1]).sort(), ["nc-001", "nc-002"]);
  });
});
