import type { AgentCaseRecord } from "./runner";

export interface AgentEvalMetrics {
  readonly caseCount: number;
  readonly completionRate: number;
  readonly postEditValidity: number;
  readonly averageSteps: number;
  readonly costPerTurn: number;
  readonly byKind: Readonly<
    Record<
      "workflow" | "adversarial" | "scripted",
      { readonly count: number; readonly completionRate: number; readonly postEditValidity: number }
    >
  >;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function kindSlice(
  records: readonly AgentCaseRecord[],
  kind: AgentCaseRecord["kind"],
): { readonly count: number; readonly completionRate: number; readonly postEditValidity: number } {
  const slice = records.filter((record) => record.kind === kind);
  return {
    count: slice.length,
    completionRate: rate(slice.filter((record) => record.completed).length, slice.length),
    postEditValidity: rate(slice.filter((record) => record.postEditValid).length, slice.length),
  };
}

/** Score agent-suite records into the step 32 report metrics. */
export function scoreAgentRecords(records: readonly AgentCaseRecord[]): AgentEvalMetrics {
  return {
    caseCount: records.length,
    completionRate: rate(records.filter((record) => record.completed).length, records.length),
    postEditValidity: rate(records.filter((record) => record.postEditValid).length, records.length),
    averageSteps: mean(records.map((record) => record.steps)),
    costPerTurn: mean(records.map((record) => record.costUsd)),
    byKind: {
      workflow: kindSlice(records, "workflow"),
      adversarial: kindSlice(records, "adversarial"),
      scripted: kindSlice(records, "scripted"),
    },
  };
}
