import { pathToFileURL } from "node:url";

import type { ValidationErrorCode } from "../src/validation/validation-error";

export const ERROR_TAXONOMY = [
  "closed venue",
  "over budget",
  "travel too far",
  "wrong vibe",
  "generic/repeat venue",
  "parse miss",
  "agent overreach",
  "other",
] as const;

export type ErrorTaxonomyLabel = (typeof ERROR_TAXONOMY)[number];

const VALIDATOR_LABEL = {
  not_found: "other",
  not_operational: "closed venue",
  closed: "closed venue",
  over_budget: "over budget",
  travel_too_long: "travel too far",
  invented_venue: "other",
  invalid_format: "parse miss",
  name_mismatch: "parse miss",
  implausible_cost: "over budget",
  travel_unverified: "travel too far",
  travel_mismatch: "travel too far",
  travel_service_unavailable: "other",
} as const satisfies Record<ValidationErrorCode, ErrorTaxonomyLabel>;

export const WEEKLY_PULL = {
  repairSpans: "@ml_app:nightcap @stage:repair",
  invalidSpans: "@ml_app:nightcap @outcome_codes:*",
  failedPlans:
    "sum:nightcap.plan.errors{service:nightcap,env:prod,outcome:failed} by {failure_stage,failure_code}.as_count()",
  traceByHashPrefix: "@ml_app:nightcap @request_hash:",
  thumbsDownSql: `SELECT request_hash, itinerary_id, created_at
FROM public.feedback
WHERE thumbs = -1
  AND request_hash IS NOT NULL
  AND created_at >= now() - interval '7 days'
ORDER BY created_at DESC`,
  closedReportSql: `SELECT request_hash, closed_report_place_id, created_at
FROM public.feedback
WHERE closed_report_place_id IS NOT NULL
  AND request_hash IS NOT NULL
  AND created_at >= now() - interval '7 days'
ORDER BY created_at DESC`,
} as const;

export type PipelineFailureStage = "redact" | "parse" | "retrieve" | "plan" | "validate";

export function labelForValidatorCode(
  code: ValidationErrorCode,
  spanStage?: string,
): ErrorTaxonomyLabel {
  if (code === "invented_venue" && spanStage === "agent") {
    return "agent overreach";
  }
  return VALIDATOR_LABEL[code];
}

export function labelForPipelineFailure(failure: {
  readonly stage: PipelineFailureStage;
  readonly code: string;
}): ErrorTaxonomyLabel {
  switch (failure.stage) {
    case "parse":
      return "parse miss";
    case "plan":
      if (failure.code === "no_json" || failure.code === "schema_invalid") {
        return "parse miss";
      }
      return "other";
    case "redact":
    case "retrieve":
    case "validate":
      return "other";
    default: {
      const neverStage: never = failure.stage;
      return neverStage;
    }
  }
}

export function weeklyPullText(): string {
  return [
    "repair-spans",
    WEEKLY_PULL.repairSpans,
    "",
    "invalid-spans",
    WEEKLY_PULL.invalidSpans,
    "",
    "failed-plans",
    WEEKLY_PULL.failedPlans,
    "",
    "trace-by-hash",
    `${WEEKLY_PULL.traceByHashPrefix}<request_hash>`,
    "",
    "thumbs-down",
    WEEKLY_PULL.thumbsDownSql,
    "",
    "closed-report",
    WEEKLY_PULL.closedReportSql,
    "",
    "join-key",
    "feedback.request_hash",
  ].join("\n");
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  process.stdout.write(`${weeklyPullText()}\n`);
}
