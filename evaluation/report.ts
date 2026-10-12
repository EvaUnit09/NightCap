import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { EvalCaseRecord } from "./record";
import type { EvalMetrics } from "./score";

export const REPORT_SCHEMA_VERSION = 1;
/** Git-ignored. */
export const DEFAULT_RESULTS_DIR = join(import.meta.dirname, "results");

export interface EvalReport {
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION;
  /** What produced the records: "pipeline", or a baseline name (build step 20). */
  readonly system: string;
  readonly caseSet: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly limit: number | null;
  readonly concurrency: number;
  readonly promptVersions: Readonly<Record<string, string>>;
  readonly metrics: EvalMetrics;
  readonly records: readonly EvalCaseRecord[];
}

function fileNameFor(report: EvalReport): string {
  return `${report.system}-${report.caseSet}-${report.startedAt.replace(/[:.]/g, "-")}.json`;
}

/** Writes the report as JSON under `dir` and returns its path. */
export async function writeReport(dir: string, report: EvalReport): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, fileNameFor(report));
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return path;
}
