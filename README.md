# Nightcap

Nightcap plans a date night in New York City from one plain-text request. You get two or three timed options. Each stop is a real Google Places venue, and the app checks hours, budget, and travel before it shows a plan.

## Documents

- [Build sequence](docs/build-sequence.md) lists each build step and whether it is done.
- [Decision log](docs/decision-log.md) records the product choices and the alternatives that were set aside.
- [Eval comparison (v1)](docs/eval-comparison-v1.md) is the 60-case baseline for pipeline, filter-only, and raw-model. The report files named in that doc are written under `evaluation/results/`. Git ignores that directory.
- The refine-agent suite prints its report with `npm run eval:agent`. The [agent report formatter](evaluation/agent/report.ts) formats completion rate, post-edit validity, average steps, and cost per turn. The [agent suite runner](evaluation/agent/run.ts) builds that report.

## Live demo

Open the [Nightcap demo](https://nightcap-dusky.vercel.app). GitHub stores `https://nightcap-dusky.vercel.app` as the repository homepage.

When you deploy a new Vercel URL, set the repository homepage to it and replace the link in this section.

## Frozen cases

Frozen v1 is 60 synthetic cases, `nc-001` through `nc-060`, in `evaluation/nightcap_eval_cases_v1.json`. `EVAL_V1_CASE_COUNT` in `evaluation/cases.ts` is 60. A later change adds 20 real beta requests and updates the freeze test in the same commit.

## Run locally

Use Node 22.

```bash
npm ci
npm test
npm run dev
```

`npm run dev` serves the app on port 3000. The launcher `.cursor/skills/verify-nightcap/scripts/verify-nightcap launch` serves `http://127.0.0.1:4173`.
