import type { AgentCaseRecord } from "./runner";
import type { AgentEvalMetrics } from "./score";

export const AGENT_REPORT_SCHEMA_VERSION = 1;

export interface AgentEvalReport {
  readonly schemaVersion: typeof AGENT_REPORT_SCHEMA_VERSION;
  readonly system: "refine_agent";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly metrics: AgentEvalMetrics;
  readonly records: readonly AgentCaseRecord[];
}

export function formatAgentMetrics(metrics: AgentEvalMetrics): string {
  const lines = [
    `cases\t${metrics.caseCount}`,
    `completion_rate\t${metrics.completionRate.toFixed(4)}`,
    `post_edit_validity\t${metrics.postEditValidity.toFixed(4)}`,
    `average_steps\t${metrics.averageSteps.toFixed(4)}`,
    `cost_per_turn\t${metrics.costPerTurn.toFixed(6)}`,
    `workflow_completion\t${metrics.byKind.workflow.completionRate.toFixed(4)}`,
    `adversarial_completion\t${metrics.byKind.adversarial.completionRate.toFixed(4)}`,
    `scripted_completion\t${metrics.byKind.scripted.completionRate.toFixed(4)}`,
  ];
  return `${lines.join("\n")}\n`;
}
