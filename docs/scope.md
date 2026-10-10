# AI Engineering: Project Scoping Doc — Nightcap

Last updated: 2026-09-28. Decisions and trade-offs: [decision-log.md](decision-log.md).
Architecture: [architecture.md](architecture.md).

---

## 0. Project Summary

- *Problem:* Planning a night out for a date means juggling venues, timing, budget, and location across several tabs. It's tedious, and people default to the same few places.
- *Why it matters / impact:* Turns 30+ minutes of tab-juggling into one request, and surfaces places the couple hasn't been to. Portfolio goal: show an LLM system that is grounded in real data, measured, and observable.
- *Proposed approach:* A web app (NYC, couples first). The LLM parses a free-text request, venue candidates come **only** from the Google Places API (cached), the LLM selects and orders stops from candidate IDs, and deterministic code validates hours, budget and travel. A repair prompt fixes failures. A refinement agent handles follow-up edits.
- *Primary success metric:* **Itinerary validity rate ≥ 90%** on a frozen 80-case test set, with **0% invented venues** as a hard gate. Secondary: diversity/novelty metrics (see §1).
- *Key risks / unknowns:* stale hours and closures in Places data (top risk, spiked in week 1); generic "same few places" output; API cost and latency; travel-time accuracy; the 4-week timeline with the refinement agent in core v1.

---



## 1. Problem Framing & Success Metrics



### Business / User Problem

**User (v1):** couples in NYC planning a date. Friend groups (3–8 people) are deferred to v2.

**Pain:** Choosing a sequence of venues (e.g. drinks → dinner → dessert/bar) means cross-checking hours, prices, neighborhoods and walking time across Maps, review sites and reservation apps. The easy way out is to go back to familiar places.

**Why an LLM:** Requests are vibe- and constraint-laden free text ("low-key but special, she's vegetarian, we'll be near Union Sq after 7") that don't map cleanly to filters. The LLM parses intent, selects and orders from retrieved real venues, and explains each pick. Deterministic code handles what code is good at: hours, budget and travel validation. A **filter-only baseline** (structured filters + greedy routing, no LLM) is included in the eval to prove the LLM adds value.

### Goal

By **2026-10-25** (4 weeks), ship a deployed v1 that:

- produces itineraries at ≥ 90% validity on test set v1, with 0 invented venues;
- beats the filter-only baseline and raw ChatGPT/Claude on validity and judge-rated fit;
- has been used by beta friends, with feedback collected.



### Stakeholders


| Person                   | Role                                             |
| ------------------------ | ------------------------------------------------ |
| Noah                     | Owner: PM, eng, design, eval                     |
| Beta friends             | Users, source of 20 real test cases and feedback |
| 5 interviewees (friends) | Problem evidence and time-to-plan baseline       |




### Prior Work


| Tool                                     | What it does                 | Gap                                                                                    |
| ---------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------- |
| ChatGPT / Claude directly                | Free-text date ideas         | Invents or misremembers venues and hours; no validation. **Used as an eval baseline.** |
| Google Maps lists, Beli, The Infatuation | Venue discovery and curation | No multi-stop planning, timing or budget fit                                           |




### Input and Output

**Input:** free-text request, plus optional structured fields (date/time, budget, neighborhood).

**Output:** 2–3 themed itineraries with no venue shared between options. Each has 2–4 timed stops, or exactly 1 when the user explicitly asked for a single place, and each stop has: Google Place ID, name, start/end time, estimated cost, travel mode (`TRANSIT` for subway/train, `BICYCLE`, or `WALK` — not rideshare, DRIVE, or taxi) and minutes to the next stop, and a one-line "why".

**Storage (Supabase Postgres):**

- `requests`: redacted request text, parsed intent, timestamps
- `itineraries`: generated options, validation results, prompt/model versions
- `feedback`: thumbs, would-go, did-you-go, new-to-you, closed-venue reports
- `places_cache`: `place_id` indefinitely, lat/lng for 30 days; hours, price, rating, and names fetched live
- `itineraries.stops`: `placeId` plus planning fields only (times, stopType, estimatedCostUsd, travelToNext, why). Names and Places details are hydrated live on view/share (decision #29)

Anonymous by default. A magic link saves and shares plans. The old "names and other PII are redacted from the free text before storage and logging" / no-PII-in-DB rule is **superseded by decision #27 for the database**: `requests.redacted_text` stores heuristic-redacted request text (users who put full names in a request accept that risk). Logs and Datadog get no free text (spans get only `parsed_intent` plus a hash of the request, never the free text). The redactor's bar is good, not perfect.

### Constraints


| Constraint            | Target                             | Notes                                                                                        |
| --------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------- |
| Latency (p50 / p99)   | < 8s / < 20s end to end            | First itinerary is streamed as soon as it passes validation                                  |
| Cost per request      | < $0.10 avg                        | Beta target (#30). Places Enterprise fields stay (novelty re-rank needs rating and review count). Plan stage ≈ $0.03; #36 model comparison is the lever to bring cost down. |
| Quality bar           | ≥ 90% validity, 0% invented venues | Validity defined under Success Metrics                                                       |
| Privacy / compliance  | Logs and Datadog get no free text; DB stores heuristic-redacted text | **Superseded by decision #27 for the DB** (old target: "No PII in logs or DB"). Logs/Datadog get no free text (`parsed_intent` + request hash only; `parsed_intent` is not redacted yet). Google Places terms respected. |
| Availability / uptime | Best-effort                        | Portfolio demo; daily spend cap may pause service                                            |




### Success Metrics

**Test set v1 (frozen,** `evaluation/`**):** 60 hand-written synthetic requests covering boroughs, budgets ($50–$300), times, vibes and edge cases (late Sunday, dietary needs, tight budgets), plus 20 real beta requests. v1 stays frozen for comparison. New failure cases go into v2.

- **Technical metrics**
  - **Validity rate (primary), ≥ 90%.** An itinerary is valid only if **all** of these hold: every venue exists in Places and is `OPERATIONAL`; every venue is open for its scheduled slot; the total estimated cost is within budget; travel between consecutive stops is ≤ 25 min.
  - **Invented-venue rate = 0%.** A hard gate: any Place ID not returned by retrieval fails the case.
  - **Diversity/novelty:** distinct-venue ratio across the test set; % of venues outside the top-N most-reviewed for their category and area; venue overlap between options in one response (target 0).
  - **Fit to request:** Opus 5 LLM-judge score, calibrated against ~30 human labels (agreement % reported).
  - **Format compliance:** % of schema-valid structured outputs on the first try.
- **User-facing metrics:** thumbs up/down per itinerary; "would you actually go?" plus a did-you-go follow-up; "new to you?" per venue; time to plan compared with the interview baseline.
- **System metrics:** p50/p99 latency, cost per request, error rate, Places cache hit rate, repair-loop rate.

**Problem evidence:** before building, 5 friend interviews: how they planned their last date, time spent, number of tabs/apps, and whether they reused a familiar place.

### Checklist

- [x] I have strong evidence that the problem I'm trying to solve is an important problem to solve. *(5 interviews, week 1)*
- [x] I have strong evidence that an LLM-based approach is the right tool for this problem (vs. traditional software, rule-based, or classical ML). *(filter-only baseline comparison)*
- [x] The goals and metrics align with user needs and/or team priorities.
- [x] I have shared the scope with relevant stakeholders and flagged dependencies.
- [x] I have documented key decisions and trade-offs in my README or decision log.

---



## 2. Prompt Engineering & Systematic Tracking



### Prompt Architecture

A code-controlled pipeline of three prompts. All outputs are structured and validated with Zod.


| Prompt             | Model     | Input                                                                      | Output                                                              |
| ------------------ | --------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `parse_intent`     | Haiku 4.5 | Redacted free text + optional fields                                       | JSON: area, datetime window, budget, dietary, vibe_tags, stop_types |
| `plan_itineraries` | Sonnet 5  | Parsed intent + re-ranked candidate list (Place IDs, hours, price, coords) | 2–3 itineraries referencing **only** candidate IDs                  |
| `repair_itinerary` | Sonnet 5  | Itinerary + specific validator errors + candidates                         | Fixes only the failing stops (max 2 rounds, then drop the option)   |


The refinement agent (§5) has its own system prompt.

### Prompt Organization

```
prompts/
 ├── parse_intent/v1.md          # front-matter: name, version
 ├── plan_itineraries/v1.md
 ├── repair_itinerary/v1.md
 ├── refine_agent/v1.md
 └── few_shot/
     └── parse_intent_examples.json
```

Git is the source of truth. The prompt name and version are attached as tags to every Datadog trace, so versions can be compared in the dashboard.

### Evaluation Framework


| Evaluation Aspect    | Approach                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Test set size        | 80 cases (v1 frozen) plus 25 agent cases (§5)                                                                                |
| Test set composition | 60 synthetic (borough, budget, time, vibe, edge-case coverage) + 20 real beta requests                                       |
| Metrics              | Deterministic validity checks; invented-venue rate; diversity metrics; calibrated Opus 5 judge for fit; format compliance    |
| Evaluation tooling   | TS eval runner in `evaluation/` → results pushed to Datadog LLM Observability datasets/experiments; small smoke subset in CI |
| Update cadence       | Weekly: invalid, thumbs-down and repair-triggered traces triaged → new cases added to v2                                     |


Baselines run on the same set: filter-only (no LLM) and raw ChatGPT/Claude (no retrieval).

### Checklist

- [ ] Prompts are stored in separate versioned files, not hardcoded.
- [ ] I have a structured test set with diverse cases and expected outputs/criteria.
- [ ] I have a repeatable evaluation process for comparing prompt versions.
- [ ] Prompt changes are tested against the evaluation set before deployment.
- [ ] I have documented my prompt iteration history and key learnings.

---



## 3. Model Selection & Evaluation



### Candidate Models


| Model                     | Provider        | Cost (input/output per 1M) | Latency (est.) | Quality Notes                                                         | License              |
| ------------------------- | --------------- | -------------------------- | -------------- | --------------------------------------------------------------------- | -------------------- |
| `claude-haiku-4-5`        | Anthropic       | $1 / $5                    | Fastest        | Candidate for parse; test on plan                                     | Commercial API terms |
| `claude-sonnet-5`         | Anthropic       | $2 / $10                   | Mid            | Default for plan, repair and agent; plan stage ≈ $0.03/request        | Commercial API terms |
| `claude-opus-5`           | Anthropic       | $5 / $25                   | Slowest        | Quality ceiling; ≈ $0.08/request on plan (over budget); offline judge | Commercial API terms |
| GPT or Gemini class (TBD) | OpenAI / Google | TBD at eval time           | TBD            | Cross-provider comparison                                             | Commercial API terms |


Prices are Anthropic's list prices as of 2026-06. Cost estimates assume the plan stage uses about 6K input and 2K output tokens and will be replaced with measured values.

### Evaluation Approach

Every candidate runs on test set v1 for each stage it's eligible for. Report validity, invented-venue rate, judge fit score, format compliance, p50/p99 latency and cost per request in one table. Choose the cheapest model per stage that holds validity ≥ 90% and fit within 5% of the best.

### Model Routing (if applicable)

Static routing per stage: parse → Haiku 4.5; plan → Sonnet 5; repair → Sonnet 5; refinement agent → Sonnet 5. No dynamic router in v1. The eval decides whether each stage moves to a cheaper or stronger model. Model IDs live in config, not code.

### Checklist

- [ ] I have tested at least 2-3 models from different providers/sizes on my test set.
- [ ] I have compared performance, cost, and latency in a structured way.
- [ ] I have ensured the model licenses are appropriate for my use case.
- [ ] I have documented the rationale for my final model choice(s).
- [ ] If using model routing, I have tested and documented the routing logic.

---



## 4. RAG Implementation (adapted: structured candidate retrieval)

Nightcap retrieves from a structured API, not from a document corpus. This section covers **candidate retrieval**. Chunking and embeddings are N/A: there are no documents to chunk, and Google's terms restrict storing review text for embedding. See the decision log.

### Data Sources


| Source                                                          | Type                                                                                     | Volume                        | Update Frequency | Notes                              |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------- | ---------------- | ---------------------------------- |
| Google Places API (Text Search / Nearby Search / Place Details) | Structured venue data: hours, price level, rating, review count, coords, business_status | ~20–60 candidates per request | Details live; `place_id` cached indefinitely; lat/lng ≤ 30 days | Hours, price, rating, and names are not cached. Saved stops store `placeId` only; names and details are hydrated live on view/share. |
| Beta "closed venue" reports                                     | User feedback                                                                            | Low                           | Continuous       | Staleness signal                   |




### Chunking Strategy

N/A: structured records, no chunking.

### Embedding Model & Vector Store


| Component       | Choice   | Rationale                                                                           |
| --------------- | -------- | ----------------------------------------------------------------------------------- |
| Embedding model | N/A (v1) | Vibe matching via parsed tags plus Places categories; revisit if judge fit plateaus |
| Vector store    | N/A (v1) | Postgres cache table only                                                           |




### Retrieval Strategy

1. Query Places per stop type using area, time window, category and price level from the parsed intent.
2. Filter: `business_status == OPERATIONAL`, open during the candidate slot, within the price band.
3. Re-rank: vibe-tag fit, with a **novelty penalty** on very high review counts (addresses "same few places").
4. Pass the top-K per stop type to the plan prompt.



### RAG Evaluation


| Metric                             | Description                                                        | Baseline | Current |
| ---------------------------------- | ------------------------------------------------------------------ | -------- | ------- |
| Candidate recall                   | % of test cases where the pool admits ≥ 1 fully valid itinerary    |          |         |
| Pool diversity                     | Distinct categories/areas and % outside the top-N most-reviewed    |          |         |
| Plan validity given a good pool    | Validity on cases where candidate recall = 1 (isolates generation) |          |         |
| End-to-end validity                | Primary metric                                                     |          |         |
| Retrieval latency / cache hit rate | Per request                                                        |          |         |




### Checklist

- [ ] ~~I have tested multiple chunking strategies~~ N/A (structured data)
- [ ] ~~I have evaluated at least two embedding models~~ N/A in v1
- [ ] I have a retrieval test set (the 80-case set is scored for candidate recall).
- [ ] I can isolate whether failures come from retrieval or generation.
- [ ] I have documented the improvement from each retrieval enhancement (filtering, novelty re-rank).

---



## 5. Agent Systems



### Agent Architecture

The main pipeline is a code-controlled workflow, **not** an agent. The agent is scoped to **refinement**: after results appear, the user chats edits ("cheaper dinner", "start an hour later", "swap the bar for dessert") and a tool-calling agent modifies the chosen itinerary. It's built with the Anthropic TypeScript SDK tool runner on Sonnet 5. **Core v1 feature.**

Flow: user message + current itinerary → agent calls tools → must call `validate_itinerary` → returns an updated itinerary, or reverts with an explanation.

### Tools


| Tool                 | Purpose                                                                 | Input / Output                                                          | Error Handling                                                            |
| -------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `search_venues`      | Find replacement candidates                                             | area, category, price, open_at → list of Place IDs + facts              | Places error → `is_error` result; agent tells the user it couldn't search |
| `replace_stop`       | Swap one stop                                                           | stop index, Place ID (must come from a tool result) → updated itinerary | Unknown ID → rejected with an error                                       |
| `reorder_stops`      | Change the order or timing of stops                                     | new order / times → updated itinerary                                   | Invalid indices → error                                                   |
| `validate_itinerary` | Same deterministic checker as the pipeline (hours, budget, travel time) | itinerary → pass / list of errors                                       | Always available; required before the final answer                        |




### Safety & Robustness


| Concern                  | Approach                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Error handling           | Tool failures returned as `is_error` results; one retry for Places 429/timeout; friendly message on failure                                                  |
| Security                 | User text treated as data; Zod on every tool input; server-side keys only; no arbitrary URLs or code                                                         |
| Infinite loop prevention | Max 6 tool calls per turn                                                                                                                                    |
| Guardrails               | The final itinerary must pass the validator, or it reverts to the last valid version; venue IDs must originate from tool results; off-topic requests refused |
| Cost monitoring          | Budget of $0.03 per turn, tracked in Datadog; counts toward the global daily spend cap                                                                       |




### Agent Evaluation


| Test Type                              | # Tests     | Description                                                                                                       |
| -------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------- |
| Unit tests (individual tools)          | ~4 per tool | Input contracts, error paths, rejection of unknown IDs                                                            |
| Integration tests (complete workflows) | ~5          | Pipeline output → refinement → validated result                                                                   |
| Adversarial tests                      | 5           | Invent a venue, prompt injection in the request, off-topic, contradictory constraints, budget pushes past the cap |
| Representative task suite              | 20          | Scripted edits; completion rate, post-edit validity, average steps, cost per turn                                 |




### Checklist

- [ ] Each tool has unit tests and documented input/output contracts.
- [ ] I have explicit error handling for all tool failures.
- [ ] I have safeguards against infinite loops and runaway costs.
- [ ] I have a representative task test suite with measured completion rates.
- [ ] I have logged and analyzed agent traces to identify failure patterns.

---



## 6. Deployment & User Interface



### API Design


| Aspect         | Approach                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Framework      | Next.js route handlers (TypeScript)                                                                                                  |
| Streaming      | Yes. Server-sent events stream the parsed intent first, then each itinerary once it passes validation                                |
| Authentication | Anonymous by default; Supabase magic link to save/share plans                                                                        |
| Rate limiting  | 5 plans/hour/IP (Upstash Redis / Vercel KV) + global daily spend cap → "come back tomorrow" mode; Turnstile captcha on first request |
| Error handling | Anthropic/Places timeout or 429 → one retry → partial results with a friendly message; errors traced in Datadog                      |




### User Interface


| Aspect             | Approach                                                                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI framework       | Next.js (React)                                                                                                                                                                                 |
| Key interactions   | Request box + optional filters (date/time, budget, neighborhood) → streamed side-by-side itinerary cards (stop timeline) + route map (Google Maps JS) → refinement chat panel → save/share link |
| Feedback mechanism | Thumbs up/down per itinerary; "would you go?" + did-you-go follow-up; "new to you?" per venue; "this place was closed" report                                                                   |




### Infrastructure


| Aspect           | Approach                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| Hosting          | Vercel (app, preview deploy per PR) + Supabase (Postgres, auth) + Datadog                             |
| Containerization | Dockerfile for local dev and the eval runner                                                          |
| CI/CD            | GitHub Actions: typecheck, lint, unit tests, eval smoke subset on PR; Vercel deploys on merge to main |




### Checklist

- [ ] My API handles streaming, errors, and rate limiting.
- [ ] My UI is accessible and provides a way for users to give feedback.
- [ ] My application is containerized with Docker.
- [ ] I have CI/CD set up so tests run automatically on push.
- [ ] I have a live demo link or clear setup instructions in my README.

---



## 7. System Monitoring & Error Analysis



### Component-Level Monitoring


| Component      | Metrics to Track                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| Prompts        | Format compliance, repair-trigger rate, judge fit score, tokens per stage                                           |
| Retrieval      | Candidate recall, cache hit rate, Places latency, pool diversity, % dropped as non-operational                      |
| Agents         | Task completion rate, avg tool calls, tool error rate, reverts, cost per turn                                       |
| Overall system | Validity rate, invented-venue rate, thumbs-up rate, reported-closed rate, p50/p99 latency, cost/request, error rate |




### Logging


| Logging Approach | Tool/Method                                                                                                                                                                                                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Basic            | Supabase tables (requests, itineraries, feedback)                                                                                                                                                                                                                                       |
| Advanced         | Datadog LLM Observability: one trace per request; spans for parse, each Places call (cache hit/miss), re-rank, plan, validate, repair, agent turns. Tags: prompt version, model, test-case ID. Metadata: tokens, cost, latency, validation errors by type. The old "PII redacted before logging" / no-PII-in-DB line is **superseded by decision #27 for the DB**. Logs and Datadog get no free text: spans carry `parsed_intent` plus a request hash, never the free-text request. |




### Error Analysis Process

Weekly:

1. Pull every invalid and repair-triggered trace from Datadog, and every thumbs-down from Supabase feedback joined to its trace.
2. Tag each with the fixed taxonomy: closed venue · over budget · travel too far · wrong vibe · generic/repeat venue · parse miss · agent overreach · other.
3. Count by category and fix the top one (prompt, retrieval filter, re-rank or validator).
4. Add representative cases to test set v2, then re-run the eval.
5. Record in `docs/error-analysis.md`: date, counts, fix, before/after metrics.

**Staleness (top risk):** drop venues that aren't `OPERATIONAL`; track the reported-closed rate. A spike in week 1 → re-check Place Details at plan time.

**Alerts:** daily spend > 80% of cap; 1h error rate > 10%. Weekly dashboard snapshot (validity, p50/p99, cost/request).

### Checklist

- [ ] I have structured logging for every request.
- [ ] I track cost, latency, and quality metrics over time.
- [ ] I have a process for reviewing and categorizing errors.
- [ ] I have a feedback loop: errors inform prompt/RAG/agent improvements.
- [ ] I have alerting for critical metric regressions (if applicable).

---



## 8. Fine-Tuning (Optional / Advanced)

**Skipped for v1.** Prompt and retrieval optimization isn't exhausted, there's no training data, and the timeline is 4 weeks. Revisit only if the parse stage on Haiku plateaus below target after prompt iteration. See the decision log.

---



## 9. Code Quality & Repository Structure



### Project Structure

Adapted from the template's Python layout to a single TypeScript/Next.js app, organized by domain.

```
nightcap/
├── app/                  # Next.js UI + API route handlers
├── src/
│   ├── pipeline/         # parse → plan → repair orchestration
│   ├── retrieval/        # Places client, cache, filtering, re-rank
│   ├── agent/            # refinement agent + tools
│   ├── validation/       # deterministic itinerary checker (shared by pipeline, agent, eval)
│   ├── models/           # model config and routing
│   └── monitoring/       # Datadog wrappers, PII redaction, cost accounting
├── prompts/              # versioned prompt files
├── evaluation/           # test sets (v1 frozen), runner, judge, results
├── tests/                # unit, integration, e2e (Playwright)
├── docs/                 # scope, decision log, architecture, error analysis
├── .env.example
├── package.json
├── Dockerfile
└── README.md
```



### Code Standards

- Strict TypeScript; Zod schemas at every boundary (user input, LLM output, Places responses, tool inputs).
- JSDoc on exported functions.
- No hardcoded values: API keys, model IDs, TTLs, caps and thresholds in config/env.
- Small, focused modules; immutable data; explicit error handling.
- TDD with 80%+ coverage on `src/`.



### README Contents

- Overview of the problem and solution.
- Architecture diagram (from `docs/architecture.md`).
- Key decisions and trade-offs (link to the decision log).
- Setup instructions (clone → env → run).
- Eval results: validity, baselines, model comparison, cost/latency.
- Live demo link.

---



## 10. Project Timeline & Milestones

Start: Mon 2026-09-28. Four weeks.


| Milestone                                                                                         | Target Date | Status      |
| ------------------------------------------------------------------------------------------------- | ----------- | ----------- |
| Problem scoping & design complete                                                                 | 2026-09-28  | In progress |
| 5 interviews, Places staleness spike, test set v1 (60 synthetic), validator, filter-only baseline | 2026-10-04  | Done        |
| Prompt engineering baseline (parse → plan → repair) + Datadog tracing                             | 2026-10-11  | Not started |
| Retrieval v1 (Places + cache + re-rank)                                                           | 2026-10-11  | Not started |
| Evaluation framework complete + model comparison, ≥ 90% validity                                  | 2026-10-11  | Not started |
| Deployment & UI (streaming, cards, map, feedback)                                                 | 2026-10-18  | Not started |
| Agent system v1 (refinement agent + its eval)                                                     | 2026-10-18  | Not started |
| Monitoring & observability (alerts, error-analysis loop)                                          | 2026-10-25  | Not started |
| Fine-tuning experiments                                                                           | N/A         | Skipped     |
| Beta (+20 real cases), error analysis, README, demo                                               | 2026-10-25  | Not started |


**Cut order if behind:** (1) model comparison reduced to 2 models; (2) route map; (3) share links. The refinement agent stays (owner priority).

---



## 11. Appendix

- **Links:** repo, live demo, Datadog dashboard, eval results (TBD).
- **Architecture:** [architecture.md](architecture.md). Build sequence: [architecture.md#build-sequence](architecture.md#build-sequence).
- **Decision log:** [decision-log.md](decision-log.md).
- **Glossary:**
  - *Validity rate:* % of itineraries passing all four checks (exists + operational, open at slot, within budget, travel ≤ 25 min between stops).
  - *Invented-venue rate:* % of itineraries containing a Place ID not returned by retrieval.
  - *Candidate recall:* % of cases where the retrieved pool admits at least one valid itinerary.
  - *Distinct-venue ratio:* unique venues ÷ total venue slots across the test set.
  - *Novelty share:* % of venues outside the top-N most-reviewed for their category and area.
  - *Judge agreement:* % agreement between the Opus 5 judge and human labels on the calibration set.

