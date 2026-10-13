import { pathToFileURL } from "node:url";

import { getRateLimitDailySpendUsd, resetConfig } from "../../src/models/config";
import {
  METRICS_DISABLED_WARNING,
  REQUEST_ERROR_METRIC,
  SPEND_FRACTION_METRIC,
  publishDailySpend,
  requestSeries,
  setSeriesPosterForTests,
  spendSeries,
  submitSeries,
  type DatadogSeriesBody,
} from "../../src/monitoring/datadog-metrics";
import {
  ERROR_RATE_ALERT,
  SPEND_ALERT_FRACTION,
  dailySpendFraction,
  eightyPercentMicros,
  monitorState,
  requestErrorRate,
  type MonitorState,
} from "../../src/monitoring/spend-fraction";
import { createExporter } from "../../src/monitoring/tracing";
import {
  MONITORS_CREATE_DISABLED,
  loadMonitors,
  writeDryRunReceipt,
  type MonitorDefinition,
} from "./create-monitors";

const SAMPLE_TIME_SEC = 1_700_000_000;

export interface MonitorEvaluation {
  readonly name: string;
  readonly query: string;
  readonly metric: string;
  readonly value: number;
  readonly threshold: number;
  readonly state: MonitorState;
  readonly series: DatadogSeriesBody;
}

export interface DryRunReport {
  readonly capUsd: number;
  readonly spendMicros: number;
  readonly spendAlert: MonitorEvaluation;
  readonly spendRecover: MonitorEvaluation;
  readonly errorAlert: MonitorEvaluation & { readonly errors: number; readonly total: number };
  readonly errorRecover: MonitorEvaluation & { readonly errors: number; readonly total: number };
}

export function buildDryRunReport(monitors: readonly MonitorDefinition[], capUsd: number): DryRunReport {
  const spend = monitors.find((monitor) => monitor.query.includes(SPEND_FRACTION_METRIC));
  const error = monitors.find((monitor) => monitor.query.includes(REQUEST_ERROR_METRIC));
  if (spend === undefined || error === undefined) {
    throw new Error("monitors.json is missing the spend monitor or the error monitor");
  }
  if (spend.options.thresholds.critical !== SPEND_ALERT_FRACTION) {
    throw new Error("spend monitor threshold drifted from 0.8");
  }
  if (error.options.thresholds.critical !== ERROR_RATE_ALERT) {
    throw new Error("error monitor threshold drifted from 0.1");
  }
  if (!error.query.includes("source:app") || !error.query.includes("last_1h")) {
    throw new Error("error monitor must query app requests over the last hour");
  }

  const spendMicros = eightyPercentMicros(capUsd);
  const spendAlertValue = dailySpendFraction(spendMicros, capUsd);
  const spendRecoverValue = dailySpendFraction(0, capUsd);
  const errorAlertValue = requestErrorRate(1, 10);
  const errorRecoverValue = requestErrorRate(0, 10);
  if (spendAlertValue !== 0.8 || errorAlertValue !== 0.1) {
    throw new Error("forced breach did not land on 0.8 spend and 0.1 errors");
  }
  if (monitorState(spendAlertValue, spend.options.thresholds.critical) !== "alert") {
    throw new Error("spend breach did not alert");
  }
  if (monitorState(spendRecoverValue, spend.options.thresholds.critical) !== "ok") {
    throw new Error("spend recovery did not return to ok");
  }
  if (monitorState(errorAlertValue, error.options.thresholds.critical) !== "alert") {
    throw new Error("error breach did not alert");
  }
  if (monitorState(errorRecoverValue, error.options.thresholds.critical) !== "ok") {
    throw new Error("error recovery did not return to ok");
  }

  return {
    capUsd,
    spendMicros,
    spendAlert: evaluation(spend, SPEND_FRACTION_METRIC, spendAlertValue, spendSeries(spendMicros, capUsd, SAMPLE_TIME_SEC)),
    spendRecover: evaluation(spend, SPEND_FRACTION_METRIC, spendRecoverValue, spendSeries(0, capUsd, SAMPLE_TIME_SEC)),
    errorAlert: {
      ...evaluation(error, REQUEST_ERROR_METRIC, errorAlertValue, requestSeries(true, "app", SAMPLE_TIME_SEC)),
      errors: 1,
      total: 10,
    },
    errorRecover: {
      ...evaluation(error, REQUEST_ERROR_METRIC, errorRecoverValue, requestSeries(false, "app", SAMPLE_TIME_SEC)),
      errors: 0,
      total: 10,
    },
  };
}

function evaluation(
  monitor: MonitorDefinition,
  metric: string,
  value: number,
  series: DatadogSeriesBody,
): MonitorEvaluation {
  return {
    name: monitor.name,
    query: monitor.query,
    metric,
    value,
    threshold: monitor.options.thresholds.critical,
    state: monitorState(value, monitor.options.thresholds.critical),
    series,
  };
}

function monitorLogLine(kind: "spend" | "error", item: MonitorEvaluation): string {
  const state = item.state === "ok" ? "OK" : "alert";
  return `${kind} monitor state=${state} value=${item.value} threshold=${item.threshold} metric=${item.metric}`;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

async function main(): Promise<number> {
  delete process.env.DD_API_KEY;
  delete process.env.DD_APP_KEY;
  delete process.env.DATADOG_API_KEY;
  delete process.env.DD_MONITORS_APPLY;
  process.env.RATE_LIMIT_DAILY_SPEND_USD = "5";
  resetConfig();

  const report = buildDryRunReport(loadMonitors(), getRateLimitDailySpendUsd());
  const submit = await submitSeries(report.spendAlert.series, {
    env: {},
    fetch: () => Promise.reject(new Error("dry-run must not call fetch")),
  });
  if (submit.mode !== "skipped") return 1;

  const exporter = createExporter();
  if (exporter.kind !== "noop") return 1;
  console.warn("[monitoring] Datadog exporter no-op: DD_API_KEY is unset");

  process.env.NIGHTCAP_METRIC_TIMING = "1";
  setSeriesPosterForTests(async () => ({ mode: "skipped", warning: "probe" }));
  publishDailySpend(report.spendMicros);
  await new Promise((resolve) => setImmediate(resolve));

  const dir = process.env.NIGHTCAP_MONITOR_RECEIPT_DIR ?? "/opt/cursor/artifacts";
  await writeDryRunReceipt(dir, "s7-33-spend-alert.json", report.spendAlert);
  await writeDryRunReceipt(dir, "s7-33-error-alert.json", report.errorAlert);
  await writeDryRunReceipt(dir, "s7-33-recover.json", {
    spend: report.spendRecover,
    error: report.errorRecover,
  });
  await writeDryRunReceipt(dir, "s7-33-noop.json", {
    exporter: exporter.kind,
    submit,
    warning: METRICS_DISABLED_WARNING,
    create: MONITORS_CREATE_DISABLED,
  });

  console.log(monitorLogLine("spend", report.spendAlert));
  console.log(monitorLogLine("error", report.errorAlert));
  console.log(monitorLogLine("spend", report.spendRecover));
  console.log(monitorLogLine("error", report.errorRecover));
  console.log(`exporter=${exporter.kind}`);
  console.log(`receipts ${dir}`);
  return 0;
}

if (isDirectRun()) {
  void main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : "monitor dry-run failed";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    },
  );
}
