# Architecture

Status: design (pre-implementation). Build order: [build-sequence.md](build-sequence.md). See [scope.md](scope.md) for targets and
[decision-log.md](decision-log.md) for why.

## Request flow

```mermaid
flowchart TD
    U[User: free-text request + optional filters] --> API[Next.js route handler<br/>rate limit + spend cap]
    API --> RED[PII redaction]
    RED --> P1[parse_intent<br/>Haiku 5.5 → Zod intent]
    P1 -->|SSE: parsed intent| U
    P1 --> R[Retrieval<br/>Places Text Search:<br/>1 combined + ≤ 1 refill]
    R -.->|coords port; DB adapter at step 24| C[(places_cache<br/>place_id + coords ≤ 30d)]
    R --> F[Filter: OPERATIONAL, open at slot, price band]
    F --> RR[Re-rank: vibe fit + novelty penalty]
    RR --> P2[plan_itineraries<br/>Haiku 5.5, candidate IDs only]
    P2 --> V{Validator<br/>exists · open · budget · travel ≤ 25 min}
    V -->|fail, ≤ 2 rounds| P3[repair_itinerary<br/>Haiku 5.5, failing stops only]
    P3 --> V
    V -->|pass| S[SSE: stream itinerary]
    S --> U
    S --> DB[(requests / itineraries<br/>Supabase)]
```

## Refinement agent

```mermaid
flowchart LR
    M[User edit message + current itinerary] --> A[Refine agent<br/>Haiku 5.5, tool runner<br/>≤ 6 tool calls, ≤ $0.08/turn]
    A --> T1[search_venues]
    A --> T2[replace_stop / reorder_stops]
    A --> T3[validate_itinerary]
    T1 --> C[(places_cache)]
    T3 -->|pass| OUT[Updated itinerary]
    T3 -->|fail after caps| REV[Revert to last valid + explain]
```

Rules: venue IDs must come from tool results; the final answer must pass `validate_itinerary`;
user text is treated as data.

## Shared components

| Component | Location | Used by |
|---|---|---|
| Itinerary validator (deterministic) | `src/validation/` | Pipeline, repair loop, agent tool, eval runner |
| Places client + re-rank + coords-cache port (import via `src/retrieval/index.ts` only) | `src/retrieval/` | Pipeline, agent `search_venues`, eval |
| Prompt loader (versioned files) | `prompts/` + `src/pipeline/` | All LLM stages |
| Model config / routing | `src/models/` | All LLM stages, eval model comparison |
| Tracing, redaction, cost | `src/monitoring/` | Everything |

## Data model (Supabase Postgres)

| Table | Key fields |
|---|---|
| `requests` | id, created_at, redacted_text, parsed_intent (jsonb), client_hash |
| `itineraries` | id, request_id, option_index, stops (jsonb: `placeId` + planning fields only; no name/address/rating/hours), valid (bool), validation_errors (jsonb), prompt_versions, models, cost_usd, latency_ms |
| `feedback` | id, itinerary_id, thumbs, would_go, did_go, new_to_you (jsonb per venue), closed_report_place_id |
| `places_cache` | place_id (PK), lat, lng, coords_fetched_at, coords_expires_at (≤ 30d). No payload. Query-result cache dropped. |
| `saved_plans` | id, user_id (magic link), itinerary_id, share_slug |

## Observability (Datadog)

One trace per request (or agent turn) in Datadog LLM Observability. Spans: `parse` → `places.search` (× N, cache hit/miss) →
`rerank` → `plan` → `validate` → `repair` (× ≤ 2) → `stream`. Tags: prompt versions, model IDs,
test-case ID (eval runs). Metadata: tokens, cost, latency, validation errors by type.
Span tags and metadata carry an allowlisted `parsed_intent` summary (no `area`, `dietary`, or `vibeTags` text) plus an HMAC-SHA256 request hash (#27, #32).
Free text goes only to LLM Obs input and output (#42). `parse`, `plan`, and `repair` are `task` spans; dd-trace's Anthropic integration, the one plugin on, nests an `llm` span under each with the prompt, reply, tokens, cost, and Prompt Tracking id and version. The `request` workflow span's input is the redacted request and its output the emitted place ids and names. HTTP and fetch plugins stay off, so Places and Routes calls are never traced, and no API key or `REQUEST_HASH_SECRET` reaches a span.
Eval runs push to Datadog datasets/experiments for version comparison.

## Deployment

Vercel (Next.js app + route handlers, preview per PR) · Supabase (Postgres + magic-link auth) ·
Upstash/Vercel KV (rate limits) · Datadog · GitHub Actions (typecheck, lint, tests,
eval smoke subset) · Dockerfile for local dev and the eval runner.
