import { AGENT_EVAL_CASES, agentCaseCounts } from "./cases";
import { formatAgentMetrics, type AgentEvalReport, AGENT_REPORT_SCHEMA_VERSION } from "./report";
import { runAgentCases } from "./runner";
import { scoreAgentRecords } from "./score";

/** Entry for the step 32 agent suite. Safe offline (scripted model, no live APIs). */
export async function runAgentEvalSuite(
  now: () => Date = () => new Date(),
): Promise<AgentEvalReport> {
  const counts = agentCaseCounts(AGENT_EVAL_CASES);
  if (counts.workflow !== 5 || counts.adversarial !== 5 || counts.scripted !== 20) {
    throw new Error(
      `Agent suite size mismatch: workflow=${counts.workflow} adversarial=${counts.adversarial} scripted=${counts.scripted}`,
    );
  }
  const startedAt = now().toISOString();
  const records = await runAgentCases(AGENT_EVAL_CASES);
  const finishedAt = now().toISOString();
  return {
    schemaVersion: AGENT_REPORT_SCHEMA_VERSION,
    system: "refine_agent",
    startedAt,
    finishedAt,
    metrics: scoreAgentRecords(records),
    records,
  };
}

async function main(): Promise<void> {
  const report = await runAgentEvalSuite();
  process.stdout.write(formatAgentMetrics(report.metrics));
  process.stdout.write(`records\t${report.records.length}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
