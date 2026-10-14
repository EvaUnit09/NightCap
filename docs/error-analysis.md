# Run the weekly error analysis

Each week, pull invalid traces and repair-triggered traces, join thumbs-down, tag the fixed taxonomy, add to v2, and record the review.

## Pull invalid and repair-triggered traces

In Datadog LLM Observability, set the window to the last 7 days. Span search uses `@ml_app:nightcap` unless production sets `DD_LLMOBS_ML_APP` to another name.

Repair-triggered traces are spans whose `stage` tag is `repair`.

```text
@ml_app:nightcap @stage:repair
```

Invalid traces are spans that carry validator codes on `outcome_codes`. The validate stage and the repair stage both write that tag.

```text
@ml_app:nightcap @outcome_codes:*
```

A request span can close as ok when the plan handler still emits an SSE error frame. Count those failures with the plan error metric.

```text
sum:nightcap.plan.errors{service:nightcap,env:prod,outcome:failed} by {failure_stage,failure_code}.as_count()
```

`failure_stage:validate` with `failure_code:no_valid_options` means every planned option was dropped. `failure_stage:parse` is a parse miss.

Print the same queries from the repo root. The command does not call Datadog.

```bash
node --import tsx evaluation/error-analysis.ts
```

## Join thumbs-down on request_hash

Run this read-only query with the Supabase service role. An empty result in the first beta week is expected.

```sql
SELECT request_hash, itinerary_id, created_at
FROM public.feedback
WHERE thumbs = -1
  AND request_hash IS NOT NULL
  AND created_at >= now() - interval '7 days'
ORDER BY created_at DESC
```

Closed-venue reports use a second read-only query.

```sql
SELECT request_hash, closed_report_place_id, created_at
FROM public.feedback
WHERE closed_report_place_id IS NOT NULL
  AND request_hash IS NOT NULL
  AND created_at >= now() - interval '7 days'
ORDER BY created_at DESC
```

For each hash, search Datadog. Paste the 64 hex characters after the colon. The Datadog tag is `request_hash`.

```text
@ml_app:nightcap @request_hash:
```

`feedback.request_hash` is the Supabase column. It matches the Datadog tag `request_hash`. The feedback API copies `requests.client_hash` into `feedback.request_hash`. The client does not send the hash.

## Tag the fixed taxonomy

Tag every pulled trace and every thumbs-down with one label from this list.

- closed venue
- over budget
- travel too far
- wrong vibe
- generic/repeat venue
- parse miss
- agent overreach
- other

Validator codes are a different set. Map them like this.

- `closed` and `not_operational` tag closed venue. A venue that is not `OPERATIONAL` is the same label. A spike in closed venue reports means re-check Place Details at plan time.
- `over_budget` and `implausible_cost` tag over budget.
- `travel_too_long`, `travel_mismatch`, and `travel_unverified` tag travel too far.
- `invalid_format` and `name_mismatch` tag parse miss.
- `invented_venue` on a span whose `stage` is `agent` tags agent overreach. The same code on any other stage tags other.
- `not_found` and `travel_service_unavailable` tag other.

A pipeline failure on the parse stage tags parse miss. A plan-stage failure tags parse miss only when the code is `no_json` or `schema_invalid`. Redact, retrieve, and validate failures stay other until you read the trace and pick a label.

`wrong vibe` and `generic/repeat venue` have no validator code. Use them when the thumbs-down or the trace shows that complaint.

Count by label. Fix the top one. The change is a prompt, a retrieval filter, a re-rank change, or a validator change.

## Add the case to v2

Add to v2. Append one representative case to `evaluation/nightcap_eval_cases_v2.json`. Copy the fields from a case in `evaluation/nightcap_eval_cases_v1.json`. The file starts as an empty array. The first new id is `nc-061`.

Do not edit `evaluation/nightcap_eval_cases_v1.json`. v2 is the only place new failures go until the one-time fold into v1.

`npm run eval` still scores v1. After the fix, re-run that command and write the before and after numbers in the review.

## Review template

Copy the headings below to the end of this file for each week. Fill every field.

### Date

Write the UTC date of the review.

### Counts

Write one count for each label, including zeros.

- closed venue
- over budget
- travel too far
- wrong vibe
- generic/repeat venue
- parse miss
- agent overreach
- other

### Fix

Name the top label and the change. Prompt, retrieval filter, re-rank, or validator.

### Before/after

Record validity, p50 latency, p99 latency, and cost per request before the fix and after the fix. Take those metrics from the weekly snapshot in `docs/monitors-dry-run.md`.
