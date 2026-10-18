/**
 * Offline ≥20-case gate for assembler vs plan-card.
 *
 * Intent from case labels (no parse model). Candidates are a synthetic pool
 * sized from each case's stopTypes so every case can exercise the planner.
 * Travel is a fixed calculator. Plan-card uses a scripted ref picker.
 *
 * Latency numbers are measured for planner+schedule only on this synthetic
 * pool. They are not live Places/Anthropic wall times.
 *
 * Usage: node --import tsx --import ./tests/setup.mjs evaluation/planner-gate.ts
 */
import { cpus, loadavg } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { planFromPool } from "../src/assembly/plan-from-pool";
import { admitOption } from "../src/pipeline/emit-gate";
import {
  buildPlanBrief,
  expandPlanCard,
  parsePlanCard,
  type PlanBrief,
  type PlanCard,
} from "../src/pipeline/plan-card";
import type { Candidate } from "../src/validation/candidate";
import type { Intent } from "../src/validation/intent";
import type { TravelCalculator } from "../src/validation/travel";
import { validateItinerary } from "../src/validation/validator";
import { intentFromCase } from "./case-intent";
import { loadEvalCasesV1, type EvalCase } from "./cases";
import { isValidCase } from "./score";
import { poolOf, recordFromResult, recordedIntent, type EvalCaseRecord } from "./record";

const CASE_LIMIT = 20;
const REPORT_DIR = "/cursor/stores/bc-275992fd-98de-4137-b423-fa78788f2966/internal/planner-gate";
const TEN_MINUTES: TravelCalculator = { calculateMinutes: (legs) => legs.map(() => 10) };
const PER_TYPE = 4;

type Mode = "assembler" | "plan-card";

interface CaseTiming {
  readonly caseId: string;
  readonly wallMs: number;
  readonly outcome: string;
  readonly inventedIds: number;
  readonly optionCount: number;
  readonly valid: boolean;
}

interface ModeSummary {
  readonly mode: Mode;
  readonly n: number;
  readonly medianWallMs: number;
  readonly p95WallMs: number;
  readonly inventedIdsTotal: number;
  readonly validityRate: number;
  readonly completed: number;
  readonly gateInventedPass: boolean;
  readonly gateP95Pass: boolean;
  readonly cases: readonly CaseTiming[];
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))]!;
}

function median(sorted: readonly number[]): number {
  if (sorted.length === 0) {
    return 0;
  }
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

function openHours(): Candidate["openingHours"] {
  return Array.from({ length: 7 }, (_, day) => ({
    open: { day, hour: 0, minute: 0 },
    close: { day, hour: 23, minute: 59 },
  }));
}

/** Deterministic pool: PER_TYPE venues per intent stop type, always open. */
function syntheticPool(intent: Intent, caseId: string): Candidate[] {
  const candidates: Candidate[] = [];
  for (const stopType of intent.stopTypes) {
    for (let i = 0; i < PER_TYPE; i++) {
      candidates.push({
        placeId: `ChIJ_${caseId}_${stopType}_${i}`,
        name: `${stopType} ${i + 1} (${caseId})`,
        stopType,
        businessStatus: "OPERATIONAL",
        priceLevel: "PRICE_LEVEL_MODERATE",
        rating: 4.2 + (i % 5) * 0.1,
        reviewCount: 100 + i * 50,
        location: { lat: 40.73 + i * 0.001, lng: -74.0 - i * 0.001 },
        openingHours: openHours(),
        types: [stopType === "dinner" ? "restaurant" : stopType],
      });
    }
  }
  return candidates;
}

function scriptedPlanCard(brief: PlanBrief, intent: Intent): PlanCard | null {
  const used = new Set<string>();
  const pick = (): PlanCard["options"][number] | null => {
    const stops = [];
    for (const stopType of intent.stopTypes) {
      const venue = brief.venues.find((entry) => entry.candidate.stopType === stopType && !used.has(entry.ref));
      if (venue === undefined) {
        return null;
      }
      used.add(venue.ref);
      stops.push({ ref: venue.ref, why: `Scripted pick for ${stopType}` });
    }
    return { theme: `Card ${intent.stopTypes.join(" then ")}`, stops };
  };
  const first = pick();
  const second = pick();
  if (first === null || second === null) {
    return null;
  }
  return { options: [first, second] };
}

function failedRecord(
  evalCase: EvalCase,
  intent: Intent,
  candidates: readonly Candidate[],
  stage: "retrieve" | "plan" | "validate",
  code: "no_candidates" | "schema_invalid" | "no_valid_options",
  plannedOptionCount = 0,
): EvalCaseRecord {
  return {
    caseId: evalCase.id,
    outcome: { kind: "failed", failure: { stage, code } },
    intent: recordedIntent(intent, "case_label"),
    options: [],
    pool: poolOf(candidates),
    poolOracle: null,
    dropped: [],
    retrievalGaps: [],
    audit: {
      modelCalls: [],
      candidateCount: candidates.length,
      plannedOptionCount,
      inventedPlaceIds: [],
      repairRoundsRun: 0,
      totalCostUsd: 0,
    },
  };
}

async function runAssemblerCase(evalCase: EvalCase, signal: AbortSignal): Promise<{ record: EvalCaseRecord; wallMs: number }> {
  const intent = intentFromCase(evalCase);
  const candidates = syntheticPool(intent, evalCase.id);
  const started = performance.now();
  const assembled = await planFromPool({
    intent,
    candidates,
    models: {
      async complete() {
        throw new Error("assembler gate uses template narration");
      },
    },
    travel: TEN_MINUTES,
    validate: (input, travel) => validateItinerary(input, { travelCalculator: travel, maxLegs: 6 }),
    maxLegs: 6,
    narratePromptVersion: "v1",
    signal,
  });
  const wallMs = performance.now() - started;
  if (assembled.kind === "none") {
    return {
      wallMs,
      record: failedRecord(evalCase, intent, candidates, "validate", "no_valid_options", assembled.plannedOptionCount),
    };
  }
  return {
    wallMs,
    record: recordFromResult(
      evalCase.id,
      {
        kind: "completed",
        intent,
        options: assembled.emitted,
        dropped: assembled.dropped,
        retrievalGaps: [],
        audit: {
          modelCalls: assembled.modelCalls,
          candidateCount: candidates.length,
          plannedOptionCount: assembled.plannedOptionCount,
          inventedPlaceIds: [],
          repairRoundsRun: 0,
          totalCostUsd: 0,
        },
      },
      { pool: poolOf(candidates), poolOracle: null },
    ),
  };
}

async function runPlanCardCase(evalCase: EvalCase, signal: AbortSignal): Promise<{ record: EvalCaseRecord; wallMs: number }> {
  const intent = intentFromCase(evalCase);
  const candidates = syntheticPool(intent, evalCase.id);
  const started = performance.now();
  const brief = buildPlanBrief(candidates);
  const card = scriptedPlanCard(brief, intent);
  if (card === null) {
    return {
      wallMs: performance.now() - started,
      record: failedRecord(evalCase, intent, candidates, "plan", "schema_invalid"),
    };
  }
  const parsed = parsePlanCard(card, brief, intent);
  if (!parsed.success) {
    return {
      wallMs: performance.now() - started,
      record: failedRecord(evalCase, intent, candidates, "plan", "schema_invalid"),
    };
  }
  const expanded = await expandPlanCard({
    card: parsed.data,
    brief,
    intent,
    travel: TEN_MINUTES,
    maxLegs: 6,
    signal,
  });
  const wallMs = performance.now() - started;
  if (expanded.kind === "none_schedulable") {
    return {
      wallMs,
      record: failedRecord(evalCase, intent, candidates, "validate", "no_valid_options", 2),
    };
  }
  const candidateIds = new Set(candidates.map((c) => c.placeId));
  const emitted = [];
  for (let i = 0; i < expanded.itinerary.options.length; i++) {
    const admitted = admitOption(
      { optionIndex: i, option: expanded.itinerary.options[i]!, repairRounds: 0 },
      candidateIds,
    );
    if (admitted.kind === "admitted") {
      emitted.push(admitted.option);
    }
  }
  const [first, ...rest] = emitted;
  if (first === undefined) {
    return {
      wallMs,
      record: failedRecord(evalCase, intent, candidates, "validate", "no_valid_options", expanded.itinerary.options.length),
    };
  }
  return {
    wallMs,
    record: recordFromResult(
      evalCase.id,
      {
        kind: "completed",
        intent,
        options: [first, ...rest],
        dropped: [],
        retrievalGaps: [],
        audit: {
          modelCalls: [],
          candidateCount: candidates.length,
          plannedOptionCount: expanded.itinerary.options.length,
          inventedPlaceIds: [],
          repairRoundsRun: 0,
          totalCostUsd: 0,
        },
      },
      { pool: poolOf(candidates), poolOracle: null },
    ),
  };
}

function summarize(mode: Mode, timings: readonly CaseTiming[]): ModeSummary {
  const walls = [...timings.map((t) => t.wallMs)].sort((a, b) => a - b);
  const inventedIdsTotal = timings.reduce((sum, t) => sum + t.inventedIds, 0);
  const validCount = timings.filter((t) => t.valid).length;
  const p95WallMs = percentile(walls, 95);
  return {
    mode,
    n: timings.length,
    medianWallMs: median(walls),
    p95WallMs,
    inventedIdsTotal,
    validityRate: timings.length === 0 ? 0 : validCount / timings.length,
    completed: timings.filter((t) => t.outcome === "completed").length,
    gateInventedPass: inventedIdsTotal === 0,
    gateP95Pass: p95WallMs < 10_000,
    cases: timings,
  };
}

async function runMode(mode: Mode, cases: readonly EvalCase[]): Promise<ModeSummary> {
  const timings: CaseTiming[] = [];
  for (const evalCase of cases) {
    const run = mode === "assembler" ? runAssemblerCase : runPlanCardCase;
    const { record, wallMs } = await run(evalCase, AbortSignal.timeout(60_000));
    const inventedIds = record.audit?.inventedPlaceIds.length ?? 0;
    timings.push({
      caseId: evalCase.id,
      wallMs,
      outcome:
        record.outcome.kind === "failed"
          ? `${record.outcome.failure.stage}/${record.outcome.failure.code}`
          : record.outcome.kind,
      inventedIds,
      optionCount: record.options.length,
      valid: isValidCase(record),
    });
    process.stdout.write(`[${mode}] ${evalCase.id} ${timings.at(-1)!.outcome} ${wallMs.toFixed(1)}ms\n`);
  }
  return summarize(mode, timings);
}

async function main(): Promise<void> {
  const cases = loadEvalCasesV1().slice(0, CASE_LIMIT);
  const assembler = await runMode("assembler", cases);
  const planCard = await runMode("plan-card", cases);
  const report = {
    measuredAt: new Date().toISOString(),
    environment: {
      loadAverage1m: loadavg()[0],
      cores: cpus().length,
      pool: `synthetic ${PER_TYPE}/stopType`,
      travel: "fixed-10min",
      parse: "intentFromCase",
      anthropic: "none (template / scripted card)",
      label: "measured-offline-synthetic-pool",
    },
    claim:
      "On a synthetic always-open pool, assembler and plan-card invent 0 place ids; wall is planner+schedule only (no live Places/Anthropic).",
    assembler,
    planCard,
    recommendation:
      assembler.gateInventedPass && assembler.gateP95Pass
        ? "Assembler passes offline invented-id and p95 gates on the synthetic pool. Next: live ≥20-case replay with ANTHROPIC_API_KEY + GOOGLE_PLACES_API_KEY."
        : "Assembler missed an offline gate; inspect cases before live replay.",
  };
  await mkdir(REPORT_DIR, { recursive: true });
  const path = join(REPORT_DIR, `gate-${Date.now()}.json`);
  await writeFile(path, JSON.stringify(report, null, 2));
  await writeFile(join(REPORT_DIR, "latest.json"), JSON.stringify(report, null, 2));
  process.stdout.write(`\nWrote ${path}\n`);
  process.stdout.write(
    `assembler n=${assembler.n} median=${assembler.medianWallMs.toFixed(1)}ms p95=${assembler.p95WallMs.toFixed(1)}ms invented=${assembler.inventedIdsTotal} validity=${assembler.validityRate.toFixed(2)} inventedGate=${assembler.gateInventedPass} p95Gate=${assembler.gateP95Pass}\n`,
  );
  process.stdout.write(
    `plan-card n=${planCard.n} median=${planCard.medianWallMs.toFixed(1)}ms p95=${planCard.p95WallMs.toFixed(1)}ms invented=${planCard.inventedIdsTotal} validity=${planCard.validityRate.toFixed(2)} inventedGate=${planCard.gateInventedPass} p95Gate=${planCard.gateP95Pass}\n`,
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
