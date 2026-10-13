import type { EvalCaseRecord } from "./record";
import type { EvalReport } from "./report";

export const EVAL_EXPERIMENT_PUSH_SKIPPED = "eval experiment push skipped";
export const EVAL_EXPERIMENT_SUBMIT = "experiment submit";
export const DEFAULT_EVAL_PROJECT_NAME = "nightcap-eval";

const NOOP_EXPERIMENT_ID = "00000000-0000-0000-0000-000000000000";

interface LoadedTracer {
  readonly llmobs?: { readonly experiments?: unknown };
}

const loadDdTrace = (): Promise<{ default: LoadedTracer }> => import("dd-trace");

export type ExperimentPushPlan =
  | { readonly kind: "skip"; readonly reason: string }
  | { readonly kind: "mock" }
  | { readonly kind: "live" };

export interface ExperimentDatasetRecord {
  readonly input: Readonly<Record<string, string>>;
  readonly metadata: Readonly<Record<string, string>>;
  readonly tags: readonly string[];
}

export interface ExperimentPushResult {
  readonly pushedCount: number;
  readonly totalCount: number;
  readonly id: string | null;
  readonly version: number | null;
  readonly recordIds: Readonly<Record<string, string>>;
}

export interface ExperimentDataset {
  addRecord(record: ExperimentDatasetRecord): ExperimentDataset;
  push(): Promise<ExperimentPushResult>;
}

export interface ExperimentSpan {
  readonly name: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly input: Readonly<Record<string, string>>;
  readonly output: Readonly<Record<string, string>>;
  readonly datasetRecordId?: string;
}

export interface StartedExperiment {
  submitSpan(span: ExperimentSpan): Promise<void>;
  close(): Promise<void>;
}

export interface ExperimentsClient {
  createDataset(name: string, options: { readonly description: string; readonly projectName: string }): ExperimentDataset;
  startExperiment(options: {
    readonly name: string;
    readonly projectName: string;
    readonly datasetName: string;
    readonly datasetId: string | null;
    readonly datasetVersion: number | null;
    readonly tags: Readonly<Record<string, string>>;
  }): Promise<StartedExperiment>;
}

export interface RecordedDataset {
  readonly name: string;
  readonly projectName: string;
  readonly description: string;
  readonly records: ExperimentDatasetRecord[];
}

export interface RecordedExperiment {
  readonly name: string;
  readonly projectName: string;
  readonly datasetName: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly spans: ExperimentSpan[];
}

export interface MemoryExperimentsClient extends ExperimentsClient {
  readonly datasets: RecordedDataset[];
  readonly experiments: RecordedExperiment[];
}

export function promptVersionLabel(versions: Readonly<Record<string, string>>): string {
  const names = Object.keys(versions).sort();
  if (names.length === 0) {
    return "none";
  }
  return names.map((name) => `${name}@${versions[name]}`).join("+");
}

export function planExperimentPush(env: Readonly<Record<string, string | undefined>>): ExperimentPushPlan {
  const flag = env.DD_EVAL_PUSH?.trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") {
    return { kind: "skip", reason: "DD_EVAL_PUSH is off" };
  }
  if (flag === "mock") {
    return { kind: "mock" };
  }
  const apiKey = env.DD_API_KEY?.trim() ?? "";
  const appKey = env.DD_APP_KEY?.trim() ?? "";
  if (apiKey === "" || appKey === "") {
    return { kind: "skip", reason: "DD_API_KEY or DD_APP_KEY is not set" };
  }
  return { kind: "live" };
}

export function evalProjectName(env: Readonly<Record<string, string | undefined>>): string {
  const project = env.DD_LLMOBS_PROJECT_NAME?.trim();
  if (project) {
    return project;
  }
  const app = env.DD_EVAL_ML_APP?.trim();
  if (app) {
    return app;
  }
  return DEFAULT_EVAL_PROJECT_NAME;
}

/**
 * Copies `DD_EVAL_ML_APP` onto the tracer env vars dd-trace reads at init
 * when the operator has not set those itself. Call before tracing starts.
 */
export function applyEvalObservabilityDefaults(env: Record<string, string | undefined>): void {
  const app = env.DD_EVAL_ML_APP?.trim();
  if (!app) {
    return;
  }
  if (!env.DD_LLMOBS_ML_APP?.trim()) {
    env.DD_LLMOBS_ML_APP = app;
  }
  if (!env.DD_LLMOBS_PROJECT_NAME?.trim()) {
    env.DD_LLMOBS_PROJECT_NAME = app;
  }
}

export function createMemoryExperimentsClient(): MemoryExperimentsClient {
  const datasets: RecordedDataset[] = [];
  const experiments: RecordedExperiment[] = [];
  return {
    datasets,
    experiments,
    createDataset(name, options) {
      const recorded: RecordedDataset = {
        name,
        projectName: options.projectName,
        description: options.description,
        records: [],
      };
      datasets.push(recorded);
      return {
        addRecord(record) {
          recorded.records.push(record);
          return this;
        },
        async push() {
          return {
            pushedCount: recorded.records.length,
            totalCount: recorded.records.length,
            id: null,
            version: null,
            recordIds: {},
          };
        },
      };
    },
    async startExperiment(options) {
      const recorded: RecordedExperiment = {
        name: options.name,
        projectName: options.projectName,
        datasetName: options.datasetName,
        tags: { ...options.tags },
        spans: [],
      };
      experiments.push(recorded);
      return {
        async submitSpan(span) {
          recorded.spans.push(span);
        },
        async close() {
          return undefined;
        },
      };
    },
  };
}

function outcomeLabel(record: EvalCaseRecord): string {
  const { outcome } = record;
  switch (outcome.kind) {
    case "completed":
      return "completed";
    case "failed":
      return `${outcome.failure.stage}/${outcome.failure.code}`;
    case "error":
      return "error";
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

export async function pushEvalReport(input: {
  readonly report: EvalReport;
  readonly client: ExperimentsClient;
  readonly projectName: string;
  readonly log: (line: string) => void;
}): Promise<{ readonly promptVersion: string; readonly caseIds: readonly string[] }> {
  const promptVersion = promptVersionLabel(input.report.promptVersions);
  const datasetName = `nightcap-${input.report.caseSet}`;
  const dataset = input.client.createDataset(datasetName, {
    description: `Nightcap eval ${input.report.caseSet} ${input.report.system}`,
    projectName: input.projectName,
  });
  for (const record of input.report.records) {
    dataset.addRecord({
      input: { test_case_id: record.caseId },
      metadata: {
        system: input.report.system,
        prompt_version: promptVersion,
        outcome: outcomeLabel(record),
      },
      tags: [`test_case_id:${record.caseId}`, `prompt_version:${promptVersion}`],
    });
  }
  const pushed = await dataset.push();

  const experiment = await input.client.startExperiment({
    name: `nightcap-${input.report.system}-${input.report.caseSet}`,
    projectName: input.projectName,
    datasetName,
    datasetId: pushed.id,
    datasetVersion: pushed.version,
    tags: {
      prompt_version: promptVersion,
      system: input.report.system,
      case_set: input.report.caseSet,
    },
  });
  const caseIds: string[] = [];
  try {
    for (const record of input.report.records) {
      const tags = { test_case_id: record.caseId, prompt_version: promptVersion };
      const datasetRecordId = pushed.recordIds[record.caseId];
      await experiment.submitSpan({
        name: record.caseId,
        tags,
        input: { test_case_id: record.caseId },
        output: { outcome: outcomeLabel(record) },
        ...(datasetRecordId === undefined ? {} : { datasetRecordId }),
      });
      caseIds.push(record.caseId);
      input.log(`${EVAL_EXPERIMENT_SUBMIT} ${record.caseId} prompt_version=${promptVersion}`);
    }
  } finally {
    await experiment.close();
  }
  return { promptVersion, caseIds };
}

const DATASET_LOOKUP_WAIT_MS = 1_000;

interface DdDatasetRecord {
  readonly id: string | null;
  readonly tags: readonly string[];
}

interface DdDataset {
  addRecord(
    input: Readonly<Record<string, string>>,
    expectedOutput: undefined,
    metadata: Readonly<Record<string, string>>,
    tags: string[],
  ): unknown;
  push(): Promise<{ pushedCount: number; totalCount: number }>;
  id(): string | null;
  version(): number | null;
  latestVersion(): number | null;
  records(): readonly DdDatasetRecord[];
}

interface DdStarted {
  experimentId(): string | null;
  submitSpan(input: ExperimentSpan): Promise<unknown>;
  close(): Promise<void>;
}

interface DdExperiments {
  createDataset(name: string, options: { description: string; projectName: string }): DdDataset;
  pullDataset(name: string, options?: { projectName?: string; maxWaitMs?: number }): Promise<DdDataset>;
  startExperiment(options: {
    name: string;
    projectName: string;
    tags: Readonly<Record<string, string>>;
    dataset: { id: string; version?: number; name: string };
  }): Promise<DdStarted>;
}

function isDdExperiments(value: unknown): value is DdExperiments {
  return (
    typeof value === "object" &&
    value !== null &&
    "createDataset" in value &&
    "pullDataset" in value &&
    "startExperiment" in value &&
    typeof value.createDataset === "function" &&
    typeof value.pullDataset === "function" &&
    typeof value.startExperiment === "function"
  );
}

function isDdStarted(value: unknown): value is DdStarted {
  return (
    typeof value === "object" &&
    value !== null &&
    "experimentId" in value &&
    "submitSpan" in value &&
    "close" in value &&
    typeof value.experimentId === "function" &&
    typeof value.submitSpan === "function" &&
    typeof value.close === "function"
  );
}

function caseIdFromTags(tags: readonly string[]): string | null {
  const tag = tags.find((item) => item.startsWith("test_case_id:"));
  if (tag === undefined) {
    return null;
  }
  const caseId = tag.slice("test_case_id:".length);
  return caseId === "" ? null : caseId;
}

function isDatasetMissing(error: unknown, name: string): boolean {
  return error instanceof Error && error.message.includes(`Dataset '${name}' not found`);
}

function recordIdsByCase(dataset: DdDataset): Record<string, string> {
  const recordIds: Record<string, string> = {};
  for (const record of dataset.records()) {
    const caseId = caseIdFromTags(record.tags);
    if (caseId !== null && record.id !== null && record.id !== "") {
      recordIds[caseId] = record.id;
    }
  }
  return recordIds;
}

export function adaptDatadogExperiments(experiments: DdExperiments): ExperimentsClient {
  return {
    createDataset(name, options) {
      const pending: ExperimentDatasetRecord[] = [];
      return {
        addRecord(record) {
          pending.push(record);
          return this;
        },
        async push() {
          let dataset: DdDataset;
          try {
            dataset = await experiments.pullDataset(name, {
              projectName: options.projectName,
              maxWaitMs: DATASET_LOOKUP_WAIT_MS,
            });
          } catch (error) {
            if (!isDatasetMissing(error, name)) {
              throw error;
            }
            dataset = experiments.createDataset(name, {
              description: options.description,
              projectName: options.projectName,
            });
          }
          const known = new Set(Object.keys(recordIdsByCase(dataset)));
          for (const record of pending) {
            const caseId = caseIdFromTags(record.tags);
            if (caseId !== null && known.has(caseId)) {
              continue;
            }
            dataset.addRecord(record.input, undefined, record.metadata, [...record.tags]);
            if (caseId !== null) {
              known.add(caseId);
            }
          }
          const result = await dataset.push();
          return {
            pushedCount: result.pushedCount,
            totalCount: result.totalCount,
            id: dataset.id(),
            version: dataset.latestVersion() ?? dataset.version(),
            recordIds: recordIdsByCase(dataset),
          };
        },
      };
    },
    async startExperiment(options) {
      if (options.datasetId === null || options.datasetId === "") {
        throw new Error("Datadog experiment requires a dataset id");
      }
      const started = await experiments.startExperiment({
        name: options.name,
        projectName: options.projectName,
        tags: options.tags,
        dataset: {
          id: options.datasetId,
          name: options.datasetName,
          ...(options.datasetVersion === null ? {} : { version: options.datasetVersion }),
        },
      });
      if (!isDdStarted(started)) {
        throw new Error("dd-trace startExperiment returned an unusable experiment");
      }
      const id = started.experimentId();
      if (id === null || id === NOOP_EXPERIMENT_ID) {
        throw new Error("Datadog experiments client did not create an experiment");
      }
      return {
        submitSpan: (span) => started.submitSpan(span).then(() => undefined),
        close: () => started.close(),
      };
    },
  };
}

export async function createDatadogExperimentsClient(): Promise<ExperimentsClient> {
  const loaded = await loadDdTrace();
  const tracer = loaded.default;
  const experiments = isDdExperiments(tracer.llmobs?.experiments) ? tracer.llmobs.experiments : null;
  if (experiments === null) {
    throw new Error("dd-trace experiments API is unavailable");
  }
  return adaptDatadogExperiments(experiments);
}
