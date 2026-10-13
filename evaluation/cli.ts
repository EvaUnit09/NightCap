import { parseArgs } from "node:util";

import { getModelFor } from "../src/models/router";
import {
  PROMPT_VERSIONS,
  createPipelineDeps,
  type ModelClient,
  type ModelStage,
  type PipelineDeps,
  type PipelineFailure,
} from "../src/pipeline";
import { createRetrievalDeps } from "../src/retrieval";
import type { PlacesClient } from "../src/retrieval";
import type { TravelCalculator } from "../src/validation/travel";
import { createRoutesTravelCalculator } from "../src/validation/validator-server";
import { loadEvalCasesV1, type EvalCase } from "./cases";
import {
  EVAL_EXPERIMENT_PUSH_SKIPPED,
  createDatadogExperimentsClient,
  createMemoryExperimentsClient,
  evalProjectName,
  planExperimentPush,
  pushEvalReport,
  type ExperimentsClient,
} from "./datadog-experiments";
import { COMPARED_SYSTEMS, formatComparisonTable, loadLatestReports } from "./compare";
import { FILTER_ONLY_SYSTEM, filterOnlyCaseRunner, filterOnlyPoolOracle, type FilterOnlyDeps } from "./filter-only";
import { formatMetricsTable } from "./format";
import { RAW_MODEL_PROMPT_VERSION, rawModelCaseRunner } from "./raw-model";
import { recordFromError, type EvalCaseRecord } from "./record";
import { DEFAULT_RESULTS_DIR, REPORT_SCHEMA_VERSION, writeReport, type EvalReport } from "./report";
import { DEFAULT_CONCURRENCY, pipelineCaseRunner, runCases, type CaseRunner } from "./runner";
import { partyBudgetsById } from "./party-budget";
import { scoreRecords } from "./score";

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_MISSING_ENV = 2;

type RunnableSystem = (typeof COMPARED_SYSTEMS)[number];
export const SYSTEM_CHOICES = [...COMPARED_SYSTEMS, "all"] as const;
export type SystemChoice = (typeof SYSTEM_CHOICES)[number];

export const USAGE = `Usage: npm run eval -- [--system ${SYSTEM_CHOICES.join("|")}] [--limit N] [--concurrency N] [--out DIR]
       npm run eval -- --compare [--out DIR]

Runs a system over the frozen v1 eval set, writes a JSON report, and prints
the metrics. This calls paid APIs and costs money.

  --system S       pipeline (default), filter-only (retrieval, no model),
                   raw-model (one model call, no retrieval), or all three
                   in turn followed by the comparison table.
  --limit N        Run only the first N cases in id order (smoke subset).
  --concurrency N  Cases in flight at once (default ${DEFAULT_CONCURRENCY}).
  --out DIR        Report directory (default evaluation/results, git-ignored).
  --compare        Print one table from the newest report of each system in
                   --out. Runs nothing and needs no keys.

Needs GOOGLE_PLACES_API_KEY and ENABLE_LIVE_ROUTES=true for every system,
plus ANTHROPIC_API_KEY for pipeline and raw-model.

With DD_API_KEY and DD_APP_KEY the local report is also pushed to a Datadog
experiment. Without either key the push is skipped. DD_EVAL_PUSH=mock records
the push in-process. DD_EVAL_PUSH=0 turns the push off.`;

export interface EvalCliIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly now: () => Date;
  /** Test seam. When absent the CLI builds live deps, after the env check. */
  readonly createDeps?: () => PipelineDeps;
  /** Test seam for the legs the filter-only baseline claims. Default: live Routes. */
  readonly createTravel?: () => TravelCalculator;
  /** Test seam for the raw-model id lookup. Default: live Places Text Search. */
  readonly createPlaces?: () => PlacesClient;
  readonly loadCases?: () => EvalCase[];
  /** Test seam. When absent, the CLI builds a client from env after the run. */
  readonly experiments?: ExperimentsClient;
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

/**
 * Why a live run cannot start, one line per missing env var. Without
 * ENABLE_LIVE_ROUTES the validator fails every leg closed as
 * `travel_service_unavailable`, so every case would score invalid.
 * Filter-only makes no model call, so it does not need the Anthropic key.
 */
export function missingLiveEnv(
  env: Readonly<Record<string, string | undefined>>,
  system: SystemChoice = "pipeline",
): string[] {
  const missing: string[] = [];
  if (system !== FILTER_ONLY_SYSTEM && !isSet(env.ANTHROPIC_API_KEY)) {
    missing.push("ANTHROPIC_API_KEY is not set (model calls).");
  }
  if (!isSet(env.GOOGLE_PLACES_API_KEY)) {
    missing.push("GOOGLE_PLACES_API_KEY is not set (Places Text Search and Routes travel times).");
  }
  const routes = env.ENABLE_LIVE_ROUTES?.trim().toLowerCase();
  if (routes !== "true" && routes !== "1") {
    missing.push("ENABLE_LIVE_ROUTES is not true (without it every travel leg fails closed and every case is invalid).");
  }
  return missing;
}

export interface EvalArgs {
  readonly system: SystemChoice;
  readonly compare: boolean;
  readonly limit: number | null;
  readonly concurrency: number;
  readonly outDir: string;
  readonly help: boolean;
}

function positiveInt(name: string, raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(`--${name} must be a positive integer (got ${JSON.stringify(raw)})`);
  }
  return Number(raw);
}

function isSystemChoice(value: string): value is SystemChoice {
  return (SYSTEM_CHOICES as readonly string[]).includes(value);
}

/** Throws with a usage message on an unknown flag or a bad value. */
export function parseEvalArgs(argv: readonly string[]): EvalArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      system: { type: "string" },
      compare: { type: "boolean" },
      limit: { type: "string" },
      concurrency: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  const system = values.system ?? "pipeline";
  if (!isSystemChoice(system)) {
    throw new Error(`--system must be one of ${SYSTEM_CHOICES.join(", ")} (got ${JSON.stringify(system)})`);
  }
  if (values.compare && values.system !== undefined) {
    throw new Error("--compare reads saved reports and runs nothing; drop --system");
  }
  return {
    system,
    compare: values.compare ?? false,
    limit: positiveInt("limit", values.limit),
    concurrency: positiveInt("concurrency", values.concurrency) ?? DEFAULT_CONCURRENCY,
    outDir: values.out ?? DEFAULT_RESULTS_DIR,
    help: values.help ?? false,
  };
}

/** The model call whose lack of a reply can end a case at each failure stage. */
const FAILING_CALL_STAGE: Partial<Record<PipelineFailure["stage"], ModelStage>> = {
  parse: "parse_intent",
  plan: "plan_itineraries",
};

/** ` (timeout)` and the like when the failed stage's own call got no reply. */
function errorCodeSuffix(failure: PipelineFailure, record: EvalCaseRecord): string {
  const last = record.audit?.modelCalls.at(-1);
  return last?.kind === "errored" && last.stage === FAILING_CALL_STAGE[failure.stage] ? ` (${last.errorCode})` : "";
}

export function progressLine(system: RunnableSystem, record: EvalCaseRecord): string {
  const { outcome } = record;
  const status =
    outcome.kind === "failed"
      ? `failed ${outcome.failure.stage}/${outcome.failure.code}${errorCodeSuffix(outcome.failure, record)}`
      : outcome.kind;
  return `[${system}] ${record.caseId} ${status}`;
}

/** Stands in for the model on filter-only, so a stray model call fails loudly instead of billing. */
const NO_MODEL: ModelClient = {
  async complete() {
    throw new Error("filter-only makes no model calls");
  },
};

interface RunContext {
  readonly args: EvalArgs;
  readonly io: EvalCliIo;
  readonly cases: readonly EvalCase[];
  readonly offline: boolean;
}

function filterOnlyDepsFor(deps: PipelineDeps, io: EvalCliIo): FilterOnlyDeps {
  return {
    retrieve: deps.retrieve,
    validate: deps.validate,
    maxLegs: deps.maxLegs,
    travel: (io.createTravel ?? (() => createRoutesTravelCalculator()))(),
  };
}

function runnerFor(system: RunnableSystem, deps: PipelineDeps, io: EvalCliIo): CaseRunner {
  switch (system) {
    case "pipeline":
      return pipelineCaseRunner(deps, { poolOracle: filterOnlyPoolOracle(filterOnlyDepsFor(deps, io)) });
    case "filter-only":
      return filterOnlyCaseRunner(filterOnlyDepsFor(deps, io));
    case "raw-model":
      return rawModelCaseRunner({
        models: deps.models,
        validate: deps.validate,
        maxLegs: deps.maxLegs,
        model: getModelFor("plan_itineraries"),
        places: (io.createPlaces ?? (() => createRetrievalDeps().places))(),
      });
  }
}

function promptVersionsFor(
  system: RunnableSystem,
  pipelineVersions: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  switch (system) {
    case "pipeline":
      return pipelineVersions;
    case "filter-only":
      return {};
    case "raw-model":
      return { plan_itineraries: RAW_MODEL_PROMPT_VERSION };
    default: {
      const exhaustive: never = system;
      return exhaustive;
    }
  }
}

function runOffline(env: EvalCliIo["env"], system: SystemChoice, hasDeps: boolean): boolean {
  if (hasDeps) {
    return false;
  }
  if (env.NIGHTCAP_EVAL_OFFLINE === "1") {
    return true;
  }
  return env.DD_EVAL_PUSH?.trim().toLowerCase() === "mock" && missingLiveEnv(env, system).length > 0;
}

interface SystemRun {
  readonly report: EvalReport;
  readonly path: string;
}

function reportFor(
  system: RunnableSystem,
  context: RunContext,
  startedAt: string,
  records: readonly EvalCaseRecord[],
  promptVersions: Readonly<Record<string, string>>,
): EvalReport {
  const { args, io, cases } = context;
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    system,
    caseSet: "v1",
    startedAt,
    finishedAt: io.now().toISOString(),
    limit: args.limit,
    concurrency: args.concurrency,
    promptVersions,
    metrics: scoreRecords(records, { partyBudgets: partyBudgetsById(cases) }),
    records,
  };
}

async function runSystem(system: RunnableSystem, context: RunContext): Promise<SystemRun> {
  const { args, io, cases, offline } = context;
  const startedAt = io.now().toISOString();
  if (offline) {
    io.stderr(`offline eval: ${system} did not call models or Places`);
    const records = cases.map((evalCase) =>
      recordFromError(evalCase.id, "offline eval did not call the pipeline", { pool: [], poolOracle: null }),
    );
    const report = reportFor(system, context, startedAt, records, promptVersionsFor(system, PROMPT_VERSIONS));
    return { report, path: await writeReport(args.outDir, report) };
  }
  const deps = (io.createDeps ?? (() => createPipelineDeps(system === FILTER_ONLY_SYSTEM ? { models: NO_MODEL } : {})))();
  const records = await runCases(cases, runnerFor(system, deps, io), {
    concurrency: args.concurrency,
    onRecord: (record) => io.stderr(progressLine(system, record)),
  });
  const report = reportFor(system, context, startedAt, records, promptVersionsFor(system, deps.promptVersions));
  return { report, path: await writeReport(args.outDir, report) };
}

async function publishExperiments(reports: readonly EvalReport[], io: EvalCliIo): Promise<void> {
  const plan = planExperimentPush(io.env);
  let client = io.experiments;
  switch (plan.kind) {
    case "skip":
      io.stdout(`${EVAL_EXPERIMENT_PUSH_SKIPPED}: ${plan.reason}`);
      return;
    case "mock":
      client ??= createMemoryExperimentsClient();
      break;
    case "live":
      try {
        client ??= await createDatadogExperimentsClient();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        io.stderr(`eval experiment push failed: ${message}`);
        return;
      }
      break;
    default: {
      const exhaustive: never = plan;
      throw new Error(`Unknown experiment push plan: ${JSON.stringify(exhaustive)}`);
    }
  }
  const projectName = evalProjectName(io.env);
  for (const report of reports) {
    try {
      await pushEvalReport({ report, client, projectName, log: io.stdout });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      io.stderr(`eval experiment push failed: ${message}`);
    }
  }
}

async function compareSaved(args: EvalArgs, io: EvalCliIo): Promise<number> {
  const reports = await loadLatestReports(args.outDir);
  if (reports.length === 0) {
    io.stderr(`No reports in ${args.outDir}. Run \`npm run eval -- --system all\` first.`);
    return EXIT_USAGE;
  }
  const missing = COMPARED_SYSTEMS.filter((system) => !reports.some((report) => report.system === system));
  const note = missing.length === 0 ? "" : `\n\nNo report yet for: ${missing.join(", ")}`;
  io.stdout(`${formatComparisonTable(reports)}${note}`);
  return EXIT_OK;
}

/** `npm run eval`. Returns the process exit code. */
export async function runEvalCli(argv: readonly string[], io: EvalCliIo): Promise<number> {
  let args: EvalArgs;
  try {
    args = parseEvalArgs(argv);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (args.help) {
    io.stdout(USAGE);
    return EXIT_OK;
  }
  if (args.compare) {
    return compareSaved(args, io);
  }
  const offline = runOffline(io.env, args.system, io.createDeps !== undefined);
  if (io.createDeps === undefined && !offline) {
    const missing = missingLiveEnv(io.env, args.system);
    if (missing.length > 0) {
      io.stderr(["Refusing to run the live eval:", ...missing.map((line) => `  - ${line}`)].join("\n"));
      return EXIT_MISSING_ENV;
    }
  }
  const allCases = (io.loadCases ?? loadEvalCasesV1)();
  const cases = args.limit === null ? allCases : allCases.slice(0, args.limit);
  const systems: readonly RunnableSystem[] = args.system === "all" ? COMPARED_SYSTEMS : [args.system];

  const finished: SystemRun[] = [];
  for (const system of systems) {
    finished.push(await runSystem(system, { args, io, cases, offline }));
  }
  if (args.system === "all") {
    const reports = finished.map(({ report }) => report);
    const paths = finished.map(({ path }) => path).join("\n");
    io.stdout(`${formatComparisonTable(reports)}\n\nReports:\n${paths}`);
  } else {
    const [only] = finished;
    io.stdout(`${formatMetricsTable(only.report.metrics)}\n\nReport: ${only.path}`);
  }
  await publishExperiments(finished.map(({ report }) => report), io);
  return EXIT_OK;
}
