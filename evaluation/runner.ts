import { runPipeline, type PipelineDeps } from "../src/pipeline";
import { allCandidates } from "../src/retrieval";
import type { Candidate } from "../src/validation/candidate";
import type { Intent } from "../src/validation/intent";
import type { EvalCase } from "./cases";
import { poolOf, recordFromError, recordFromResult, type EvalCaseRecord, type PoolVenue } from "./record";

/**
 * Runs one case and returns its record. The pipeline runner below is one;
 * a baseline (build step 20) supplies its own and reuses the rest.
 */
export type CaseRunner = (evalCase: EvalCase, signal: AbortSignal) => Promise<EvalCaseRecord>;

/** Decides whether a pool admits at least one fully valid itinerary (candidate recall). */
export type PoolOracle = (intent: Intent, candidates: readonly Candidate[], signal: AbortSignal) => Promise<boolean>;

export const DEFAULT_CONCURRENCY = 4;
/** One live case is parse + plan + up to 2 repair rounds; this is far above a normal run. */
export const DEFAULT_CASE_TIMEOUT_MS = 180_000;

export interface RunCasesOptions {
  readonly concurrency?: number;
  readonly caseTimeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Called as each case finishes, in finish order. */
  readonly onRecord?: (record: EvalCaseRecord) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** The oracle's verdict, or null when there is no oracle or it threw (the case stays scorable). */
async function judgePool(
  oracle: PoolOracle | undefined,
  intent: Intent,
  candidates: readonly Candidate[],
  signal: AbortSignal,
): Promise<boolean | null> {
  if (oracle === undefined) {
    return null;
  }
  try {
    return await oracle(intent, candidates, signal);
  } catch {
    return null;
  }
}

/**
 * The pipeline as a `CaseRunner`. Retrieval is wrapped to capture the
 * candidate pool for the novelty and recall metrics; nothing else in
 * `deps` changes. The oracle, when given, runs only for a case that did
 * not complete and has a pool, since a completed case already proves its
 * pool works.
 */
export function pipelineCaseRunner(deps: PipelineDeps, options: { readonly poolOracle?: PoolOracle } = {}): CaseRunner {
  return async (evalCase, signal) => {
    let candidates: readonly Candidate[] = [];
    const observing: PipelineDeps = {
      ...deps,
      retrieve: async (intent, retrieveSignal) => {
        const retrieval = await deps.retrieve(intent, retrieveSignal);
        candidates = allCandidates(retrieval);
        return retrieval;
      },
    };
    const observed = (poolOracle: boolean | null): { pool: PoolVenue[]; poolOracle: boolean | null } => ({
      pool: poolOf(candidates),
      poolOracle,
    });
    try {
      const result = await runPipeline({ text: evalCase.query, testCaseId: evalCase.id, signal }, observing);
      const intent = result.kind === "failed" ? result.intent : null;
      const verdict =
        intent !== null && candidates.length > 0
          ? await judgePool(options.poolOracle, intent, candidates, signal)
          : null;
      return recordFromResult(evalCase.id, result, observed(verdict));
    } catch (error) {
      return recordFromError(evalCase.id, messageOf(error), observed(null));
    }
  };
}

async function runOne(
  runCase: CaseRunner,
  evalCase: EvalCase,
  options: RunCasesOptions,
): Promise<EvalCaseRecord> {
  // Not AbortSignal.timeout: its timer is unref'd, so a case awaiting only the
  // signal lets the event loop drain and the process exits mid-run.
  const timeoutMs = options.caseTimeoutMs ?? DEFAULT_CASE_TIMEOUT_MS;
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new DOMException(`The operation timed out after ${timeoutMs}ms`, "TimeoutError")),
    timeoutMs,
  );
  const signal = options.signal === undefined ? timeout.signal : AbortSignal.any([options.signal, timeout.signal]);
  try {
    return await runCase(evalCase, signal);
  } catch (error) {
    return recordFromError(evalCase.id, messageOf(error), { pool: [], poolOracle: null });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs every case with at most `concurrency` in flight and returns the
 * records in case order. A case that throws becomes an `error` record; it
 * never stops the run.
 */
export async function runCases(
  cases: readonly EvalCase[],
  runCase: CaseRunner,
  options: RunCasesOptions = {},
): Promise<EvalCaseRecord[]> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, cases.length));
  const records = new Array<EvalCaseRecord>(cases.length);
  let next = 0;
  const worker = async () => {
    while (next < cases.length) {
      const index = next;
      next += 1;
      const record = await runOne(runCase, cases[index], options);
      records[index] = record;
      options.onRecord?.(record);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return records;
}
