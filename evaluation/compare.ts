import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { percent } from "./format";
import { REPORT_SCHEMA_VERSION, type EvalReport } from "./report";
import type { Ratio } from "./score";

/**
 * The step 20 comparison: one row per system, one column per metric from
 * `scoreRecords`. Reads finished reports; it runs nothing and needs no keys.
 */

export const COMPARED_SYSTEMS = ["pipeline", "filter-only", "raw-model"] as const;
export type ComparedSystem = (typeof COMPARED_SYSTEMS)[number];

/** This one never retrieves, so a candidate-recall number would measure nothing for it. */
const NO_RETRIEVAL: ReadonlySet<string> = new Set<ComparedSystem>(["raw-model"]);
const NOT_APPLICABLE = "n/a";

function rate(value: Ratio): string {
  return value.rate === null ? NOT_APPLICABLE : `${(value.rate * 100).toFixed(1)}%`;
}

function cells(report: EvalReport): string[] {
  const { metrics } = report;
  const { diversity, candidateRecall: recall } = metrics;
  const retrieves = !NO_RETRIEVAL.has(report.system);
  return [
    report.system,
    String(metrics.caseCount),
    percent(metrics.validity.cases),
    percent(metrics.inventedVenue.cases),
    percent(metrics.formatCompliance.overall),
    percent(diversity.distinctVenues),
    percent(diversity.outsideTopN),
    percent(diversity.overlappingResponses),
    retrieves ? `${rate(recall.lowerBound)} to ${rate(recall.upperBound)}` : NOT_APPLICABLE,
    retrieves ? percent(metrics.planValidityGivenPool) : NOT_APPLICABLE,
  ];
}

/** Systems in `COMPARED_SYSTEMS` order, then any other. */
function ordered(reports: readonly EvalReport[]): EvalReport[] {
  const rank = (system: string) => {
    const index = (COMPARED_SYSTEMS as readonly string[]).indexOf(system);
    return index < 0 ? COMPARED_SYSTEMS.length : index;
  };
  return [...reports].sort((a, b) => rank(a.system) - rank(b.system));
}

/** A markdown table, so it pastes into a PR or the README. Pure. */
export function formatComparisonTable(reports: readonly EvalReport[]): string {
  const topN = reports[0]?.metrics.diversity.topN;
  const header = [
    "System",
    "Cases",
    "Validity",
    "Invented venue",
    "Format compliance",
    "Distinct venues",
    `Outside top-${topN ?? "N"}`,
    "Overlap",
    "Candidate recall",
    "Plan validity given good pool",
  ];
  const line = (row: readonly string[]) => `| ${row.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...ordered(reports).map((report) => line(cells(report)))].join(
    "\n",
  );
}

function isReport(value: unknown, system: string): value is EvalReport {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const report = value as Partial<EvalReport>;
  return report.schemaVersion === REPORT_SCHEMA_VERSION && report.system === system && report.metrics !== undefined;
}

/**
 * The newest v1 report per system in `dir`, by the timestamp in its file
 * name, in `COMPARED_SYSTEMS` order. A system with no report is left out;
 * a file that does not parse or does not match its name throws.
 */
export async function loadLatestReports(dir: string): Promise<EvalReport[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const latest = COMPARED_SYSTEMS.flatMap((system) => {
    const newest = names
      .filter((name) => name.startsWith(`${system}-v1-`) && name.endsWith(".json"))
      .sort()
      .at(-1);
    return newest === undefined ? [] : [{ system, name: newest }];
  });
  return Promise.all(
    latest.map(async ({ system, name }) => {
      const parsed: unknown = JSON.parse(await readFile(join(dir, name), "utf8"));
      if (!isReport(parsed, system)) {
        throw new Error(`${name} is not a ${system} report (schema version ${REPORT_SCHEMA_VERSION})`);
      }
      return parsed;
    }),
  );
}
