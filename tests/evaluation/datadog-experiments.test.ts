import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { EXIT_OK, runEvalCli } from "../../evaluation/cli";
import { loadLatestReports } from "../../evaluation/compare";
import {
  adaptDatadogExperiments,
  applyEvalObservabilityDefaults,
  createMemoryExperimentsClient,
  evalProjectName,
  planExperimentPush,
  promptVersionLabel,
  pushEvalReport,
} from "../../evaluation/datadog-experiments";
import type { EvalCaseRecord } from "../../evaluation/record";
import { DEFAULT_RESULTS_DIR, type EvalReport } from "../../evaluation/report";
import { scoreRecords } from "../../evaluation/score";

const V1 = "parse_intent@v1+plan_itineraries@v1+repair_itinerary@v1";
const V2 = "parse_intent@v1+plan_itineraries@v2+repair_itinerary@v1";

class FakeDataset {
  readonly #id: string;
  readonly #records: Array<{ readonly id: string; readonly tags: readonly string[] }> = [];

  constructor(id: string) {
    this.#id = id;
  }

  addRecord(
    _input: Readonly<Record<string, string>>,
    _expectedOutput: undefined,
    _metadata: Readonly<Record<string, string>>,
    tags: string[],
  ): this {
    const caseId = tags.find((tag) => tag.startsWith("test_case_id:"))?.slice("test_case_id:".length);
    this.#records.push({ id: `rec-${caseId}`, tags });
    return this;
  }

  async push(): Promise<{ pushedCount: number; totalCount: number }> {
    return { pushedCount: this.#records.length, totalCount: this.#records.length };
  }

  id(): string {
    return this.#id;
  }

  version(): number | null {
    return null;
  }

  latestVersion(): number {
    return 3;
  }

  records(): ReadonlyArray<{ readonly id: string; readonly tags: readonly string[] }> {
    return this.#records;
  }
}

function completed(caseId: string): EvalCaseRecord {
  return {
    caseId,
    outcome: { kind: "completed" },
    intent: null,
    options: [],
    dropped: [],
    retrievalGaps: [],
    pool: [],
    poolOracle: null,
    audit: null,
  };
}

function report(promptVersions: Readonly<Record<string, string>>, caseId = "nc-001"): EvalReport {
  const records = [completed(caseId)];
  return {
    schemaVersion: 1,
    system: "pipeline",
    caseSet: "v1",
    startedAt: "2026-10-13T00:00:00.000Z",
    finishedAt: "2026-10-13T00:00:01.000Z",
    limit: 1,
    concurrency: 1,
    promptVersions,
    metrics: scoreRecords(records),
    records,
  };
}

describe("datadog experiments", () => {
  it("records prompt_version and test_case_id for two prompt versions", async () => {
    const client = createMemoryExperimentsClient();
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);

    await pushEvalReport({
      report: report({ parse_intent: "v1", plan_itineraries: "v1", repair_itinerary: "v1" }),
      client,
      projectName: "nightcap-eval",
      log,
    });
    await pushEvalReport({
      report: report({ parse_intent: "v1", plan_itineraries: "v2", repair_itinerary: "v1" }),
      client,
      projectName: "nightcap-eval",
      log,
    });

    assert.deepEqual(
      client.experiments.map((experiment) => experiment.tags.prompt_version),
      [V1, V2],
    );
    assert.deepEqual(client.experiments[0]?.spans[0]?.tags, {
      test_case_id: "nc-001",
      prompt_version: V1,
    });
    assert.deepEqual(client.experiments[1]?.spans[0]?.tags, {
      test_case_id: "nc-001",
      prompt_version: V2,
    });
    assert.deepEqual(client.datasets[0]?.records[0]?.tags, [`test_case_id:nc-001`, `prompt_version:${V1}`]);
    assert.deepEqual(client.datasets[1]?.records[0]?.tags, [`test_case_id:nc-001`, `prompt_version:${V2}`]);
    assert.deepEqual(lines, [
      `experiment submit nc-001 prompt_version=${V1}`,
      `experiment submit nc-001 prompt_version=${V2}`,
    ]);
    assert.equal(promptVersionLabel({}), "none");
  });

  it("prefers DD_LLMOBS_PROJECT_NAME over DD_EVAL_ML_APP", () => {
    assert.equal(evalProjectName({}), "nightcap-eval");
    assert.equal(evalProjectName({ DD_EVAL_ML_APP: "eval-lab" }), "eval-lab");
    assert.equal(
      evalProjectName({ DD_EVAL_ML_APP: "eval-lab", DD_LLMOBS_PROJECT_NAME: "proj-a" }),
      "proj-a",
    );
  });

  it("plans a live push only when DD_EVAL_PUSH is live or 1 and both keys are set", () => {
    const keys = { DD_API_KEY: "api", DD_APP_KEY: "app" };
    assert.deepEqual(planExperimentPush({}), { kind: "skip", reason: "DD_EVAL_PUSH must be live or 1" });
    assert.deepEqual(planExperimentPush(keys), { kind: "skip", reason: "DD_EVAL_PUSH must be live or 1" });
    assert.deepEqual(planExperimentPush({ ...keys, DD_EVAL_PUSH: "yes" }), {
      kind: "skip",
      reason: "DD_EVAL_PUSH must be live or 1",
    });
    assert.deepEqual(planExperimentPush({ ...keys, DD_EVAL_PUSH: "live" }), { kind: "live" });
    assert.deepEqual(planExperimentPush({ ...keys, DD_EVAL_PUSH: "1" }), { kind: "live" });
    assert.deepEqual(planExperimentPush({ DD_EVAL_PUSH: "live" }), {
      kind: "skip",
      reason: "DD_API_KEY or DD_APP_KEY is not set",
    });
    assert.deepEqual(planExperimentPush({ DD_EVAL_PUSH: "1", DD_API_KEY: "api" }), {
      kind: "skip",
      reason: "DD_API_KEY or DD_APP_KEY is not set",
    });
    assert.deepEqual(planExperimentPush({ ...keys, DD_EVAL_PUSH: "0" }), {
      kind: "skip",
      reason: "DD_EVAL_PUSH is off",
    });
    assert.deepEqual(planExperimentPush({ ...keys, DD_EVAL_PUSH: "off" }), {
      kind: "skip",
      reason: "DD_EVAL_PUSH is off",
    });
    assert.deepEqual(planExperimentPush({ ...keys, DD_EVAL_PUSH: "false" }), {
      kind: "skip",
      reason: "DD_EVAL_PUSH is off",
    });
    assert.deepEqual(planExperimentPush({ DD_EVAL_PUSH: "mock" }), { kind: "mock" });
    assert.deepEqual(planExperimentPush({ ...keys, DD_EVAL_PUSH: "mock" }), { kind: "mock" });
  });

  it("reuses one dataset id for two prompt versions", async () => {
    const store = new Map<string, FakeDataset>();
    const starts: Array<{ readonly id: string; readonly version: number | undefined }> = [];
    const spans: Array<{ readonly datasetRecordId?: string; readonly promptVersion: string }> = [];
    let creates = 0;
    const client = adaptDatadogExperiments({
      async pullDataset(name) {
        const found = store.get(name);
        if (found === undefined) {
          throw new Error(`Dataset '${name}' not found in project 'nightcap-eval' (after 1000ms)`);
        }
        return found;
      },
      createDataset(name) {
        creates += 1;
        const dataset = new FakeDataset("ds-1");
        store.set(name, dataset);
        return dataset;
      },
      async startExperiment(options) {
        starts.push({ id: options.dataset.id, version: options.dataset.version });
        return {
          experimentId: () => "exp-1",
          async submitSpan(span) {
            spans.push({
              datasetRecordId: span.datasetRecordId,
              promptVersion: span.tags.prompt_version ?? "",
            });
          },
          async close() {
            return undefined;
          },
        };
      },
    });
    const lines: string[] = [];
    const versions = { parse_intent: "v1", plan_itineraries: "v1", repair_itinerary: "v1" };

    await pushEvalReport({
      report: report(versions),
      client,
      projectName: "nightcap-eval",
      log: (line) => lines.push(line),
    });
    await pushEvalReport({
      report: report({ ...versions, plan_itineraries: "v2" }),
      client,
      projectName: "nightcap-eval",
      log: (line) => lines.push(line),
    });

    assert.equal(creates, 1);
    assert.deepEqual(starts, [
      { id: "ds-1", version: 3 },
      { id: "ds-1", version: 3 },
    ]);
    assert.deepEqual(spans, [
      { datasetRecordId: "rec-nc-001", promptVersion: V1 },
      { datasetRecordId: "rec-nc-001", promptVersion: V2 },
    ]);
    assert.deepEqual(lines, [
      `experiment submit nc-001 prompt_version=${V1}`,
      `experiment submit nc-001 prompt_version=${V2}`,
    ]);
  });

  it("leaves the dataset uncreated when lookup fails for another reason", async () => {
    let creates = 0;
    const client = adaptDatadogExperiments({
      async pullDataset() {
        throw new Error("Failed to list datasets in project 'nightcap-eval': HTTP 500");
      },
      createDataset() {
        creates += 1;
        return new FakeDataset("ds-x");
      },
      async startExperiment() {
        throw new Error("start should not run");
      },
    });

    await assert.rejects(
      () =>
        pushEvalReport({
          report: report({ parse_intent: "v1", plan_itineraries: "v1", repair_itinerary: "v1" }),
          client,
          projectName: "nightcap-eval",
          log: () => undefined,
        }),
      /Failed to list datasets in project 'nightcap-eval': HTTP 500/,
    );
    assert.equal(creates, 0);
  });

  it("copies DD_EVAL_ML_APP only onto empty tracer env vars", () => {
    const env: Record<string, string | undefined> = { DD_EVAL_ML_APP: "eval-lab", DD_LLMOBS_ML_APP: "nightcap" };
    applyEvalObservabilityDefaults(env);
    assert.equal(env.DD_LLMOBS_ML_APP, "nightcap");
    assert.equal(env.DD_LLMOBS_PROJECT_NAME, "eval-lab");
  });
});

describe("eval CLI experiment push", () => {
  let outDir: string;
  after(async () => {
    if (outDir !== undefined) {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  async function dir(): Promise<string> {
    outDir ??= await mkdtemp(join(tmpdir(), "nightcap-eval-dd-"));
    return outDir;
  }

  it("skips the push and exits 0 when Datadog keys are absent", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runEvalCli(["--limit", "1", "--out", await dir()], {
      env: { NIGHTCAP_EVAL_OFFLINE: "1" },
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      now: () => new Date("2026-10-13T00:00:00.000Z"),
    });

    assert.equal(code, EXIT_OK);
    const log = [...stdout, ...stderr].join("\n");
    assert.match(log, /eval experiment push skipped: DD_EVAL_PUSH must be live or 1/);
    assert.match(log, /Report: /);
    assert.equal(log.includes("experiment submit"), false);
  });

  it("skips the push when DD_EVAL_PUSH=live and a Datadog key is missing", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const client = createMemoryExperimentsClient();
    const code = await runEvalCli(["--limit", "1", "--out", await dir()], {
      env: { DD_EVAL_PUSH: "live", NIGHTCAP_EVAL_OFFLINE: "1" },
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      now: () => new Date("2026-10-13T00:00:02.000Z"),
      experiments: client,
    });

    assert.equal(code, EXIT_OK);
    const log = [...stdout, ...stderr].join("\n");
    assert.match(log, /eval experiment push skipped: DD_API_KEY or DD_APP_KEY is not set/);
    assert.equal(log.includes("experiment submit"), false);
    assert.equal(client.experiments.length, 0);
  });

  it("does not push when both keys are set and DD_EVAL_PUSH is unset", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const client = createMemoryExperimentsClient();
    const code = await runEvalCli(["--limit", "1", "--out", await dir()], {
      env: { DD_API_KEY: "api", DD_APP_KEY: "app", NIGHTCAP_EVAL_OFFLINE: "1" },
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      now: () => new Date("2026-10-13T00:00:03.000Z"),
      experiments: client,
    });

    assert.equal(code, EXIT_OK);
    const log = [...stdout, ...stderr].join("\n");
    assert.match(log, /eval experiment push skipped: DD_EVAL_PUSH must be live or 1/);
    assert.equal(log.includes("experiment submit"), false);
    assert.equal(client.experiments.length, 0);
  });

  it("pushes when DD_EVAL_PUSH=live and both keys are set", async () => {
    const stdout: string[] = [];
    const client = createMemoryExperimentsClient();
    const code = await runEvalCli(["--limit", "1", "--out", await dir()], {
      env: {
        DD_EVAL_PUSH: "live",
        DD_API_KEY: "api",
        DD_APP_KEY: "app",
        NIGHTCAP_EVAL_OFFLINE: "1",
      },
      stdout: (text) => stdout.push(text),
      stderr: () => undefined,
      now: () => new Date("2026-10-13T00:00:04.000Z"),
      experiments: client,
    });

    assert.equal(code, EXIT_OK);
    assert.match(stdout.join("\n"), /experiment submit nc-001 prompt_version=/);
    assert.equal(client.experiments[0]?.spans[0]?.tags.test_case_id, "nc-001");
    assert.equal(client.experiments.length, 1);
  });

  it("logs an experiment submit for nc-001 when the push is mocked", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const output = await dir();
    const client = createMemoryExperimentsClient();
    const code = await runEvalCli(["--limit", "1", "--out", output], {
      env: { DD_EVAL_PUSH: "mock" },
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      now: () => new Date("2026-10-13T00:00:01.000Z"),
      experiments: client,
    });

    assert.equal(code, EXIT_OK);
    const log = [...stdout, ...stderr].join("\n");
    assert.match(log, /experiment submit nc-001 prompt_version=/);
    assert.equal(log.includes(`Report: ${output}/`), true);
    assert.equal(client.experiments[0]?.spans[0]?.tags.test_case_id, "nc-001");
    assert.equal(client.experiments.length, 1);
  });

  it("keeps a mock run out of the default results directory --compare reads", async () => {
    const startedAt = "2099-01-02T03:04:05.000Z";
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runEvalCli(["--limit", "1"], {
      env: { DD_EVAL_PUSH: "mock" },
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      now: () => new Date(startedAt),
    });

    assert.equal(code, EXIT_OK);
    const log = [...stdout, ...stderr].join("\n");
    assert.match(log, /experiment submit nc-001 prompt_version=/);
    assert.match(log, /Validity \(cases\)\s+0\.0% \(0\/1\)/);
    const reportPath = log.match(/Report: (\S+)/)?.[1];
    if (reportPath === undefined) {
      throw new Error(`expected a report path in:\n${log}`);
    }
    assert.equal(reportPath.startsWith(`${DEFAULT_RESULTS_DIR}/`), false);
    const isolatedDir = dirname(reportPath);
    const isolated = await loadLatestReports(isolatedDir);
    assert.deepEqual(
      isolated.map((item) => ({
        system: item.system,
        startedAt: item.startedAt,
        caseId: item.records[0]?.caseId,
        outcome: item.records[0]?.outcome.kind,
        numerator: item.metrics.validity.cases.numerator,
        denominator: item.metrics.validity.cases.denominator,
        rate: item.metrics.validity.cases.rate,
      })),
      [
        {
          system: "pipeline",
          startedAt,
          caseId: "nc-001",
          outcome: "error",
          numerator: 0,
          denominator: 1,
          rate: 0,
        },
      ],
    );
    const compared = await loadLatestReports(DEFAULT_RESULTS_DIR);
    assert.equal(
      compared.some((item) => item.startedAt === startedAt),
      false,
    );
    const compareStdout: string[] = [];
    const compareCode = await runEvalCli(["--compare", "--out", isolatedDir], {
      env: {},
      stdout: (text) => compareStdout.push(text),
      stderr: () => undefined,
      now: () => new Date(startedAt),
    });
    assert.equal(compareCode, EXIT_OK);
    assert.match(compareStdout.join("\n"), /\| pipeline \| 1 \| 0\.0% \(0\/1\) \|/);
    await rm(isolatedDir, { recursive: true, force: true });
  });

  it("keeps an offline run out of the default results directory --compare reads", async () => {
    const startedAt = "2099-01-02T03:04:06.000Z";
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runEvalCli(["--limit", "1"], {
      env: { NIGHTCAP_EVAL_OFFLINE: "1" },
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      now: () => new Date(startedAt),
    });

    assert.equal(code, EXIT_OK);
    const log = [...stdout, ...stderr].join("\n");
    assert.match(log, /eval experiment push skipped: DD_EVAL_PUSH must be live or 1/);
    assert.equal(log.includes("experiment submit"), false);
    const reportPath = log.match(/Report: (\S+)/)?.[1];
    if (reportPath === undefined) {
      throw new Error(`expected a report path in:\n${log}`);
    }
    assert.equal(reportPath.startsWith(`${DEFAULT_RESULTS_DIR}/`), false);
    const isolated = await loadLatestReports(dirname(reportPath));
    assert.equal(isolated[0]?.startedAt, startedAt);
    assert.equal(isolated[0]?.records[0]?.outcome.kind, "error");
    assert.equal(isolated[0]?.metrics.validity.cases.numerator, 0);
    assert.equal(isolated[0]?.metrics.validity.cases.denominator, 1);
    const compared = await loadLatestReports(DEFAULT_RESULTS_DIR);
    assert.equal(
      compared.some((item) => item.startedAt === startedAt),
      false,
    );
    await rm(dirname(reportPath), { recursive: true, force: true });
  });
});

function runEntry(args: readonly string[], env: Record<string, string | undefined>) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "DD_API_KEY",
    "DD_APP_KEY",
    "DD_EVAL_PUSH",
    "NIGHTCAP_EVAL_OFFLINE",
    "ANTHROPIC_API_KEY",
    "GOOGLE_PLACES_API_KEY",
    "ENABLE_LIVE_ROUTES",
    "DD_EVAL_ML_APP",
    "DD_LLMOBS_PROJECT_NAME",
  ]) {
    delete childEnv[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete childEnv[key];
    } else {
      childEnv[key] = value;
    }
  }
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "--import", "./tests/setup.mjs", "evaluation/run.ts", ...args],
    { env: childEnv, encoding: "utf8", timeout: 30_000 },
  );
}

describe("npm run eval experiment push", () => {
  it("mocked --limit 1 logs experiment submit for nc-001 and exits 0", () => {
    const result = runEntry(["--limit", "1", "--out", join(tmpdir(), "nightcap-eval-mock-proof")], {
      DD_EVAL_PUSH: "mock",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(`${result.stdout}\n${result.stderr}`, /experiment submit nc-001 /);
  });

  it("missing DD_API_KEY skips the push and exits 0", () => {
    const result = runEntry(["--limit", "1", "--out", join(tmpdir(), "nightcap-eval-skip-proof")], {
      NIGHTCAP_EVAL_OFFLINE: "1",
    });

    assert.equal(result.status, 0, result.stderr);
    const log = `${result.stdout}\n${result.stderr}`;
    assert.match(log, /eval experiment push skipped/);
    assert.equal(log.includes("experiment submit"), false);
  });
});
