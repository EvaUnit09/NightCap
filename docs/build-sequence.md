# Build sequence

Written 2026-10-08 from [scope.md](scope.md). Status column added 2026-10-12.

The Is done column is `yes`, `partial`, or `no`, judged against that row's Done when clause. `partial` means the module is in the tree and at least one Done when clause is still open. Remaining work for the 2026-10-11 milestone is in [work-2026-10-12.md](work-2026-10-12.md).

The validator is in `src/validation/validator.ts`. PR #21 committed the 60-case set to `evaluation/nightcap_eval_cases_v1.json`. No check keeps its ids frozen yet. The filter-only baseline is not in the repo.

Build in phase order. The validator, Places client, prompt loader, model router, and Datadog
wrapper are shared: the pipeline, repair loop, agent, and eval runner call the same ones.
`search_venues` uses the same retrieval path as the planner.

**Out of v1:** embeddings and a review-text store, fine-tuning, a dynamic model router,
friend-group mode. Opus 5 is an offline judge only. Anonymous use stays the default.

**Travel minutes:** Google Routes `computeRouteMatrix` Essentials, one billed element
per hop. See decision log #25.

**Cut order if 2026-10-25 slips:** (1) model comparison reduced to 2 models; (2) route map;
(3) share links. The refinement agent stays.

### 1. Contracts

| # | Action | Lands in | Done when | Is done |
|---|---|---|---|---|
| 1 | Scaffold one Next.js app with the domain folders in scope §9. | `app/`, `src/`, `prompts/`, `evaluation/`, `tests/` | Strict TypeScript builds. Domain folders exist. | yes |
| 2 | Define shared Zod schemas: intent, candidate, stop, itinerary, validation error, tool input. | `src/validation/` | Every boundary parses with Zod. An itinerary is 2–3 options of 2–4 timed stops (exactly 1 stop when singleStop is true), with no venue shared between options. Travel modes are TRANSIT, BICYCLE, and WALK. | yes |
| 3 | Move model IDs, cache TTL, rate limits, travel cap, and spend caps into config. | `src/models/`, `.env.example` | No key, model id, TTL, or threshold is hardcoded. | yes |
| 4 | Create `requests`, `itineraries`, `feedback`, `places_cache`, `saved_plans`. | Supabase migration | Columns match the [data model](architecture.md#data-model-supabase-postgres). `places_cache` stores only fields Google's terms allow. `itineraries.stops` store `placeId` plus planning fields; names and details are hydrated live on view/share. | yes |
| 5 | Redact names and other PII from free text before any database write. The old "stored and traced only in redacted form" / no-PII-in-DB done-when is **superseded by decision #27 for the DB**. Logs and Datadog get no free text: spans get `parsed_intent` plus a request hash, never the free text. | `src/monitoring/` | A request is stored as heuristic-redacted text (`requests.redacted_text`). The redactor's bar is good, not perfect. | partial |

### 2. Shared kernel

Do this before prompt iteration. Later phases call these modules; they do not reimplement them.

| # | Action | Lands in | Done when | Is done |
|---|---|---|---|---|
| 6 | Build the deterministic validator: operational, open for the slot, within budget, travel ≤ 25 min. | `src/validation/` | The same function is callable from the pipeline, the repair loop, the agent tool, and the eval runner. | partial |
| 7 | Choose how travel minutes are computed. | `src/validation/`, decision log | One method feeds the ≤ 25 min check. | yes |
| 8 | Add versioned prompt files and a loader. Git stays the source of truth. | `prompts/*/v1.md`, loader in `src/pipeline/` | `parse_intent`, `plan_itineraries`, `repair_itinerary`, and `refine_agent` load from files. Each trace is tagged with prompt name and version. | yes |
| 9 | Wire static routing: Haiku 4.5 for parse; Sonnet 5 for plan, repair, and the agent. | `src/models/` | Stage code asks the router for a model id. There is no dynamic router. | yes |
| 10 | Open one Datadog LLM Observability trace per request, with a span per stage. | `src/monitoring/` | Spans cover parse, each Places call (cache hit or miss), re-rank, plan, validate, repair, and later agent turns. Metadata includes tokens, cost, latency, and validation errors by type. | yes |

### 3. Retrieval — target 2026-10-11

| # | Action | Lands in | Done when | Is done |
|---|---|---|---|---|
| 11 | Call Places Text Search, Nearby Search, and Place Details. Venues come only from these responses. Phase 3 ships Text Search only: one combined search plus at most one refill (decision #33). Nearby Search and Details wait for a caller that needs them (#29 hydration). | `src/retrieval/` | A query returns Place IDs plus hours, price, coords, rating, review count, and business status. | yes |
| 12 | Cache `place_id` indefinitely and lat/lng for ≤ 30 days. Hours, price, rating, and names are fetched live. Saved stops store `placeId` only; the app hydrates names and details on view/share (decision #29). The previous query-keyed 24h details cache is dropped. Extra Places calls on view/share are covered by #30 (new beta target, lands in PR #7). Phase 3 ships the coords-cache port, TTL policy, and an in-memory adapter; the Supabase adapter lands with the first DB client (step 24, decision #34). | `places_cache` | Expired coordinates are not served. A repeat details query still calls Places. | yes |
| 13 | Filter to `OPERATIONAL` venues that are open for the slot and inside the price band, then re-rank. | `src/retrieval/` | Top-K per stop type prefers vibe-tag fit and penalizes very high review counts. Closed venues never reach the planner. | yes |
| 14 | Retry a Places 429 or timeout once, then surface a partial result with a clear error. | `src/retrieval/` | The failure is a span with status error. The user is not shown an invented stop. | yes |

### 4. Pipeline and eval — target 2026-10-11

| # | Action | Lands in | Done when | Is done |
|---|---|---|---|---|
| 15 | Orchestrate redact → parse → retrieve → plan → validate → repair. | `src/pipeline/` | Repair fixes only the failing stops, at most twice, then that option is dropped. | yes |
| 16 | Hard-gate invented venues. Any Place ID absent from retrieval fails the case. | `src/pipeline/`, `src/validation/` | The pipeline cannot emit an unknown id, and the eval can compute invented-venue rate. | partial |
| 17 | Stream with SSE: parsed intent first, then each itinerary only after it passes validation. | `app/` route handler | The client never receives an unvalidated stop. | no |
| 18 | Check in the frozen 60-case synthetic set. | `evaluation/` | Cases cover borough, budget ($15–$320), time, vibe, and edges (late Sunday, dietary, tight budget). v1 stays frozen; new failures go to v2. | yes |
| 19 | Score validity, invented-venue rate, diversity/novelty, and format compliance. | `evaluation/` runner | One command prints the four metrics. Candidate recall is scored separately so a retrieval miss is not blamed on the planner. | no |
| 20 | Run both baselines on the same set: filter-only (no LLM) and raw ChatGPT/Claude (no retrieval). | `evaluation/` | The comparison table exists before a prompt version is called done. | no |
| 21 | CI on every PR: typecheck, lint, unit tests, and a small eval smoke subset. | `.github/workflows`, Dockerfile | A prompt change cannot merge without the smoke subset. Target 80% coverage on `src/`. | no |

### 5. API and UI — target 2026-10-18

| # | Action | Lands in | Done when | Is done |
|---|---|---|---|---|
| 22 | Cap anonymous use: 5 plans per hour per IP, plus a global daily spend cap. | Upstash or Vercel KV, `src/monitoring/` | Over the daily cap, the API returns a come-back-tomorrow response and stops calling models. | no |
| 23 | Require Turnstile on the first request. Keep API keys server-side. | `app/` route handler | A request with no captcha token is rejected. The browser never sees the Anthropic or Places key. | no |
| 24 | Persist the redacted request, parsed intent, options (placeIds + planning fields), validation result, prompt versions, model, cost, and latency. Pipeline must strip venue names before persist. | `requests`, `itineraries` | A finished plan reloads placeIds from Postgres; names and Places details are hydrated live on view. | no |
| 25 | Build the request screen: free text plus optional date, budget, and neighborhood, then side-by-side stop timelines. | `app/` | A beta user can submit a request and see 2–3 streamed itineraries with a one-line why on each stop. | no |
| 26 | Collect thumbs, would-go, did-you-go, new-to-you, and closed-venue reports. | `feedback`, UI | Each signal is stored against the itinerary or place id and can be joined back to the Datadog trace. | no |
| 27 | Add the route map. Cut this second if the date slips. | Google Maps JS | Stops for the selected itinerary render on a map. | no |
| 28 | Add magic-link save and share. Cut this third if the date slips. | Supabase auth, `saved_plans` | An anonymous session can save a plan and open it from a share slug. | partial |

### 6. Refinement agent — target 2026-10-18

Core v1. Do not cut this to make the date.

| # | Action | Lands in | Done when | Is done |
|---|---|---|---|---|
| 29 | Implement `search_venues`, `replace_stop`, `reorder_stops`, and `validate_itinerary`. | `src/agent/` | Each tool has a Zod contract and about four unit tests, including unknown-id rejection. Places errors return `is_error`. | partial |
| 30 | Run the agent on Sonnet 5 with a hard stop at 6 tool calls and $0.03 per turn. | `src/agent/`, cost ledger | User text is treated as data. Venue ids must come from a tool result in this turn. Off-topic requests are refused. | partial |
| 31 | Require `validate_itinerary` before the final answer. On failure, revert to the last valid itinerary and explain. | `src/agent/` | A turn cannot end on an invalid plan. The revert is counted in agent metrics. | no |
| 32 | Add the agent suite: 5 workflow tests, 5 adversarial tests, and 20 scripted edits. | `evaluation/` | The report includes completion rate, post-edit validity, average steps, and cost per turn. | no |

### 7. Observe and ship — target 2026-10-25

| # | Action | Lands in | Done when | Is done |
|---|---|---|---|---|
| 33 | Alert when daily spend passes 80% of the cap, and when the 1-hour error rate passes 10%. | Datadog monitors | Both monitors fire on a forced breach in a dry run. A weekly snapshot covers validity, p50/p99, and cost per request. | no |
| 34 | Push eval runs to Datadog datasets and experiments, tagged with prompt version and test-case id. | `evaluation/` runner | Two prompt versions can be compared in the dashboard. | no |
| 35 | Write the weekly error-analysis loop. | `docs/error-analysis.md` | Each review pulls invalid and repair-triggered traces from Datadog, joins thumbs-down from Supabase, tags the fixed taxonomy, and adds representative cases to v2. | no |
| 36 | Calibrate an offline Opus 5 judge on about 30 human labels, then run the model comparison. Shrink to 2 models first if the date slips. | `evaluation/` | Agreement is reported. Each stage keeps the cheapest model that holds ≥ 90% validity and fit within 5% of the best. Opus stays off the request path. | no |
| 37 | Run the beta, fold 20 real requests into frozen v1, and publish the README plus a live demo. | `README.md`, Vercel | The README links this doc, the decision log, eval results, and the demo. v1 is 80 cases and stays frozen. | no |
