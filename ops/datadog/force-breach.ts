import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  planOutcomeSamples,
  spendFractionSample,
  type MetricSample,
  type PlanOutcome,
} from "../../src/monitoring/metrics";
import { loadMonitors, type MonitorDefinition } from "./create-monitors";
import { evaluateMonitor, parseMonitorQuery, type MonitorQuery, type MonitorStatus } from "./monitor-eval";

const PROD_ENV = { DD_ENV: "prod" };
const T0 = Date.UTC(2026, 9, 13, 12, 0, 0);
const FIVE_MINUTES_MS = 5 * 60_000;

export interface SimulatedStep {
  readonly monitor: "spend" | "error";
  readonly state: MonitorStatus;
  readonly value: number;
  readonly threshold: number;
  readonly metric: string;
}

export interface SimulatedBreach {
  readonly mode: "SIMULATED";
  readonly spendAlert: SimulatedStep;
  readonly spendRecover: SimulatedStep;
  readonly errorAlert: SimulatedStep;
  readonly errorRecover: SimulatedStep;
}

export function simulateBreach(monitors: readonly MonitorDefinition[]): SimulatedBreach {
  const spend = requireQuery(monitors, "spend");
  const error = requireQuery(monitors, "error_rate");
  const spendPoints = [
    spendFractionSample(4_250_000, 5, T0, PROD_ENV),
    spendFractionSample(500_000, 5, T0 + FIVE_MINUTES_MS + 60_000, PROD_ENV),
  ];
  const firstHour: MetricSample[] = [];
  for (let index = 0; index < 3; index += 1) {
    firstHour.push(...planOutcomeSamples(failedParse(), T0, PROD_ENV));
  }
  for (let index = 0; index < 7; index += 1) {
    firstHour.push(...planOutcomeSamples({ kind: "completed" }, T0, PROD_ENV));
  }
  const recoveredHour = [...firstHour];
  for (let index = 0; index < 30; index += 1) {
    recoveredHour.push(...planOutcomeSamples({ kind: "completed" }, T0 + 30 * 60_000, PROD_ENV));
  }
  return {
    mode: "SIMULATED",
    spendAlert: step("spend", spend, spendPoints, T0, "OK"),
    spendRecover: step("spend", spend, spendPoints, T0 + FIVE_MINUTES_MS + 60_000, "Alert"),
    errorAlert: step("error", error, firstHour, T0, "OK"),
    errorRecover: step("error", error, recoveredHour, T0 + 30 * 60_000, "Alert"),
  };
}

function step(
  monitor: SimulatedStep["monitor"],
  query: MonitorQuery,
  points: readonly MetricSample[],
  nowMs: number,
  previous: MonitorStatus,
): SimulatedStep {
  const result = evaluateMonitor(query, points, nowMs, previous);
  if (result.value === null) throw new Error(`${monitor} simulation had an empty window`);
  return {
    monitor,
    state: result.state,
    value: result.value,
    threshold: query.threshold,
    metric: query.metric,
  };
}

function requireQuery(monitors: readonly MonitorDefinition[], kind: MonitorQuery["kind"]): MonitorQuery {
  for (const monitor of monitors) {
    const query = parseMonitorQuery(monitor.query);
    if (query.kind === kind) return query;
  }
  throw new Error(`missing ${kind} monitor`);
}

function failedParse(): PlanOutcome {
  return { kind: "failed", failure: { stage: "parse", code: "no_json" } };
}

function line(item: SimulatedStep): string {
  return `SIMULATED ${item.monitor} state=${item.state} value=${item.value} threshold=${item.threshold} metric=${item.metric}`;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

async function main(): Promise<number> {
  const simulate = process.argv.includes("--simulate");
  if (!simulate || process.argv.length !== 3) {
    process.stderr.write("usage: force-breach.ts --simulate\n");
    return 1;
  }
  const report = simulateBreach(loadMonitors());
  const expected: readonly MonitorStatus[] = ["Alert", "OK", "Alert", "OK"];
  const actual = [report.spendAlert.state, report.spendRecover.state, report.errorAlert.state, report.errorRecover.state];
  if (actual.some((state, index) => state !== expected[index])) return 1;
  const dir = process.env.NIGHTCAP_MONITOR_RECEIPT_DIR ?? "/opt/cursor/artifacts";
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "s7-33-spend-alert.json"), `${JSON.stringify({ mode: report.mode, ...report.spendAlert }, null, 2)}\n`);
  await writeFile(join(dir, "s7-33-error-alert.json"), `${JSON.stringify({ mode: report.mode, ...report.errorAlert }, null, 2)}\n`);
  await writeFile(
    join(dir, "s7-33-recover.json"),
    `${JSON.stringify({ mode: report.mode, spend: report.spendRecover, error: report.errorRecover }, null, 2)}\n`,
  );
  await writeFile(join(dir, "s7-33-simulated.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${line(report.spendAlert)}\n`);
  process.stdout.write(`${line(report.errorAlert)}\n`);
  process.stdout.write(`${line(report.spendRecover)}\n`);
  process.stdout.write(`${line(report.errorRecover)}\n`);
  process.stdout.write(`mode=${report.mode}\n`);
  process.stdout.write(`receipts ${dir}\n`);
  return 0;
}

if (isDirectRun()) {
  void main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : "monitor simulation failed";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    },
  );
}
