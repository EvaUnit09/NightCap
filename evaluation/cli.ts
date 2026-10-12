import { parseArgs } from "node:util";

import { createPipelineDeps, type PipelineDeps } from "../src/pipeline";
import { loadEvalCasesV1, type EvalCase } from "./cases";
import { formatMetricsTable } from "./format";
import type { EvalCaseRecord } from "./record";
import { DEFAULT_RESULTS_DIR, REPORT_SCHEMA_VERSION, writeReport, type EvalReport } from "./report";
import { DEFAULT_CONCURRENCY, pipelineCaseRunner, runCases } from "./runner";
import { scoreRecords } from "./score";

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_MISSING_ENV = 2;

export const USAGE = `Usage: npm run eval -- [--limit N] [--concurrency N] [--out DIR]

Runs the pipeline over the frozen v1 eval set, writes a JSON report, and
prints the metrics. This calls Anthropic, Google Places, and Google Routes
and costs money.

  --limit N        Run only the first N cases in id order (smoke subset).
  --concurrency N  Cases in flight at once (default ${DEFAULT_CONCURRENCY}).
  --out DIR        Report directory (default evaluation/results, git-ignored).

Needs ANTHROPIC_API_KEY, GOOGLE_PLACES_API_KEY, and ENABLE_LIVE_ROUTES=true.`;

export interface EvalCliIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly now: () => Date;
  /** Test seam. When absent the CLI builds live deps, after the env check. */
  readonly createDeps?: () => PipelineDeps;
  readonly loadCases?: () => EvalCase[];
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

/**
 * Why a live run cannot start, one line per missing env var. Without
 * ENABLE_LIVE_ROUTES the validator fails every leg closed as
 * `travel_service_unavailable`, so every case would score invalid.
 */
export function missingLiveEnv(env: Readonly<Record<string, string | undefined>>): string[] {
  const missing: string[] = [];
  if (!isSet(env.ANTHROPIC_API_KEY)) {
    missing.push("ANTHROPIC_API_KEY is not set (parse, plan, and repair model calls).");
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

/** Throws with a usage message on an unknown flag or a bad value. */
export function parseEvalArgs(argv: readonly string[]): EvalArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      limit: { type: "string" },
      concurrency: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    limit: positiveInt("limit", values.limit),
    concurrency: positiveInt("concurrency", values.concurrency) ?? DEFAULT_CONCURRENCY,
    outDir: values.out ?? DEFAULT_RESULTS_DIR,
    help: values.help ?? false,
  };
}

function progressLine(record: EvalCaseRecord): string {
  const { outcome } = record;
  const status =
    outcome.kind === "failed" ? `failed ${outcome.failure.stage}/${outcome.failure.code}` : outcome.kind;
  return `${record.caseId} ${status}`;
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
  if (io.createDeps === undefined) {
    const missing = missingLiveEnv(io.env);
    if (missing.length > 0) {
      io.stderr(["Refusing to run the live eval:", ...missing.map((line) => `  - ${line}`)].join("\n"));
      return EXIT_MISSING_ENV;
    }
  }
  const deps = (io.createDeps ?? (() => createPipelineDeps()))();
  const allCases = (io.loadCases ?? loadEvalCasesV1)();
  const cases = args.limit === null ? allCases : allCases.slice(0, args.limit);

  const startedAt = io.now().toISOString();
  const records = await runCases(cases, pipelineCaseRunner(deps), {
    concurrency: args.concurrency,
    onRecord: (record) => io.stderr(progressLine(record)),
  });
  const metrics = scoreRecords(records);
  const report: EvalReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    system: "pipeline",
    caseSet: "v1",
    startedAt,
    finishedAt: io.now().toISOString(),
    limit: args.limit,
    concurrency: args.concurrency,
    promptVersions: deps.promptVersions,
    metrics,
    records,
  };
  const path = await writeReport(args.outDir, report);
  io.stdout(`${formatMetricsTable(metrics)}\n\nReport: ${path}`);
  return EXIT_OK;
}
