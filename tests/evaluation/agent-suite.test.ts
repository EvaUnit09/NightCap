import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AGENT_EVAL_CASES,
  agentCaseCounts,
  formatAgentMetrics,
  runAgentEvalSuite,
  scoreAgentRecords,
} from "../../evaluation/agent";

describe("agent evaluation suite (step 32)", () => {
  it("includes 5 workflow, 5 adversarial, and 20 scripted cases", () => {
    const counts = agentCaseCounts(AGENT_EVAL_CASES);
    assert.equal(counts.workflow, 5);
    assert.equal(counts.adversarial, 5);
    assert.equal(counts.scripted, 20);
    assert.equal(AGENT_EVAL_CASES.length, 30);
  });

  it("reports completion rate, post-edit validity, average steps, and cost per turn", async () => {
    const report = await runAgentEvalSuite(() => new Date("2026-10-13T21:00:00.000Z"));
    const metrics = scoreAgentRecords(report.records);
    assert.equal(metrics.caseCount, 30);
    assert.ok(metrics.completionRate > 0.5);
    assert.equal(metrics.postEditValidity, 1);
    assert.ok(metrics.averageSteps >= 0);
    assert.ok(metrics.costPerTurn >= 0);
    const table = formatAgentMetrics(metrics);
    assert.match(table, /completion_rate\t/);
    assert.match(table, /post_edit_validity\t/);
    assert.match(table, /average_steps\t/);
    assert.match(table, /cost_per_turn\t/);
  });
});
