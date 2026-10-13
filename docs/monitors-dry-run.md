# Dry-run the spend and error monitors

Prove the spend monitor and the error-rate monitor without creating Datadog alerts. The scripts below print the monitor bodies and a simulated breach. A missing `DD_API_KEY` logs one line and sends no metrics.

## Simulate a breach, then a recovery

From the repo root, run:

```bash
node --import tsx --import ./tests/setup.mjs ops/datadog/force-breach.ts --simulate
```

The script reads `ops/datadog/monitors/daily-spend-80.json` and `ops/datadog/monitors/error-rate-1h-10.json`. It replays samples through those queries. Stdout includes `SIMULATED` and these lines:

```text
SIMULATED spend state=Alert value=0.85 threshold=0.8 metric=nightcap.spend.daily_fraction
SIMULATED error state=Alert value=0.3 threshold=0.1 metric=nightcap.plan.errors
SIMULATED spend state=OK value=0.1 threshold=0.8 metric=nightcap.spend.daily_fraction
SIMULATED error state=OK value=0.075 threshold=0.1 metric=nightcap.plan.errors
mode=SIMULATED
```

Spend recovery is a later sample of 0.1, after the 0.85 point leaves the 5 minute window. Error recovery is 3 failures and 37 successes in the same hour, which is 0.075.

Receipts land in `NIGHTCAP_MONITOR_RECEIPT_DIR`, or in `/opt/cursor/artifacts` when that variable is unset.

- `s7-33-spend-alert.json` has `"mode": "SIMULATED"` and `"state": "Alert"`.
- `s7-33-error-alert.json` has the error monitor in Alert at 0.3.
- `s7-33-recover.json` has both monitors in OK.
- `s7-33-simulated.json` is the full report.

A key in your shell does not create a monitor. This command does not call Datadog.

## Print the monitor bodies

```bash
node --import tsx ops/datadog/create-monitors.ts
```

This command needs no server-only shim. It prints `POST https://api.datadoghq.com/api/v1/monitor` and both JSON bodies. It exits 0. It does not call the network. `DD_MONITORS_APPLY` is ignored. Pass `--apply` when you mean to write monitors.

The spend query is `max(last_5m):max:nightcap.spend.daily_fraction{service:nightcap,env:prod} >= 0.8`.

The error query is the last hour of `nightcap.plan.errors` divided by `nightcap.plan.requests`, and it alerts at or above 0.1. Both queries filter `env:prod`.

## Confirm a missing key does nothing

Leave `DD_API_KEY` unset and start the server, or call `createMetricsSinkFromEnv()`.

Stderr contains this line once per process:

```text
[monitoring] Datadog metrics off: DD_API_KEY not set
```

The process keeps serving plans. No distribution point is posted.

## Set DD_ENV in production

The monitor queries filter `env:prod`. Set `DD_ENV=prod` on the production server. Samples then carry `env:prod`. A server without `DD_ENV` still records spend in the ledger, and these monitors do not see those samples.

`ops/datadog/create-monitors.ts --env dryrun` rewrites each `env:prod` token and suffixes the monitor name with ` [dryrun]`.

## Create the monitors when keys exist

`--validate` and `--apply` need `DD_API_KEY` and `DD_APP_KEY`. The app key is the same one experiments use. This file does not set that variable.

```bash
node --import tsx ops/datadog/create-monitors.ts --validate
node --import tsx ops/datadog/create-monitors.ts --apply
```

`--apply` lists monitors tagged `managed-by:ops-datadog`, updates a monitor with the same name, and creates one when the name is missing. Add `--notify oncall` to append `@oncall` to the message. The JSON files contain no `@` handle.

`notify_no_data` is false. An idle window does not page. The error monitor sets `timeout_h` to 1, so an alert with no new points resolves after an hour. The spend fraction is the UTC-day ledger, so the 5 minute window is only freshness.

## Record the weekly snapshot

Once a week, open the Nightcap dashboard and write down these four numbers for the last 7 days.

1. Validity. Widget title `Request validity`. Query `1 - (sum:nightcap.plan.errors{service:nightcap,env:prod}.as_count() / sum:nightcap.plan.requests{service:nightcap,env:prod}.as_count())`. Counted outcomes are completed, failed, internal_error, and spend_cap_unavailable.
2. p50. Widget title `Request latency p50`. Use the LLM Observability metric `latency_ms` on the `request` span, 50th percentile.
3. p99. Widget title `Request latency p99`. Use the same `latency_ms` metric, 99th percentile.
4. Cost per request. Widget title `Ledger cost per request`. For one UTC day, multiply `max:nightcap.spend.daily_fraction{service:nightcap,env:prod}` by `RATE_LIMIT_DAILY_SPEND_USD`, then divide by `sum:nightcap.plan.requests{service:nightcap,env:prod}.as_count()` for that day.

The ledger fraction includes Places and Routes. The `cost_usd` span tag is model spend only.

Write down the four numbers, the UTC week they cover, and whether each monitor was OK at the start of the week.
