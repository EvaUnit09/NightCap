# Eval comparison (v1)

Step 20 Done when. Built from the newest saved report of each system in
`evaluation/results/` (git-ignored) via `npm run eval -- --compare` on
2026-10-12. No API keys required for `--compare`.

Reports used (newest per system):

- `pipeline-v1-2026-10-12T22-20-45-111Z.json`
- `filter-only-v1-2026-10-12T22-28-14-957Z.json`
- `raw-model-v1-2026-10-12T22-28-34-484Z.json`

| System | Cases | Validity | Invented venue | Format compliance | Distinct venues | Outside top-3 | Overlap | Candidate recall | Plan validity given good pool |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pipeline | 60 | 80.0% (48/60) | 3.3% (2/60) | 100.0% (263/263) | 90.5% (162/179) | 45.8% (82/179) | 0.0% (0/33) | 91.7% to 91.7% | 87.3% (48/55) |
| filter-only | 60 | 38.3% (23/60) | 0.0% (0/52) | n/a (0/0) | 91.8% (56/61) | 26.2% (16/61) | 0.0% (0/14) | 38.3% to 38.3% | 100.0% (23/23) |
| raw-model | 60 | 0.0% (0/60) | n/a (0/0) | 0.0% (0/60) | n/a (0/0) | n/a (0/0) | n/a (0/0) | n/a | n/a |

Notes:

- Metric definitions are decision #38 (`evaluation/score.ts`). Novelty uses top-3 (`NOVELTY_TOP_N`).
- Baselines are decision #39. Filter-only is also the pipeline's `PoolOracle`.
- Raw-model's newest report is all `plan/schema_invalid` (60/60). An earlier run was all `plan/model_error`. Both leave validity at 0%. That is the measured baseline until a prompt version improves it.
- Pipeline validity (80%) is still below the ≥ 90% gate. Invented-venue rate (3.3%) is not the 0% hard gate.
