# Dry-run the spend and error monitors

Prove the spend monitor and the error-rate monitor without a Datadog account. The dry-run writes mock receipts and does not create alerts.

## Force a breach, then a recovery

From the repo root, run:

```bash
node --import tsx --import ./tests/setup.mjs ops/datadog/dry-run-monitors.ts
```

The script sets `RATE_LIMIT_DAILY_SPEND_USD` to 5 in its own process. That is the configured default. 80% of that cap is 4,000,000 micros, and `dailySpendFraction` returns 0.8.

Stdout shows these lines:

```text
spend monitor state=alert value=0.8 threshold=0.8 metric=nightcap.spend.daily_fraction
error monitor state=alert value=0.1 threshold=0.1 metric=nightcap.request.error
spend monitor state=OK value=0 threshold=0.8 metric=nightcap.spend.daily_fraction
error monitor state=OK value=0 threshold=0.1 metric=nightcap.request.error
exporter=noop
```

The error line is 1 failed request out of 10, which is 0.1. The recovery lines are a ledger at 0 and 0 failures out of 10.

Receipts land in `NIGHTCAP_MONITOR_RECEIPT_DIR`, or in `/opt/cursor/artifacts` when that variable is unset.

- `s7-33-spend-alert.json` shows the spend monitor in alert. The series metric is `nightcap.spend.daily_fraction` and the point is 0.8. That is the metric the monitor query reads.
- `s7-33-error-alert.json` shows the error monitor in alert at 0.1.
- `s7-33-recover.json` shows both monitors in ok.
- `s7-33-noop.json` shows the skipped submit.

The script deletes `DD_API_KEY`, `DD_APP_KEY`, and `DD_MONITORS_APPLY` in its own process before it evaluates the monitors. A key in your shell does not create a monitor and does not send a series.

## Confirm a missing key does nothing

Run the same command with `DD_API_KEY` unset.

Stderr contains `Datadog metrics disabled: DD_API_KEY is unset, so no series were submitted`.

Stderr also contains `Datadog exporter no-op: DD_API_KEY is unset`.

The process exits 0.

To print the monitor payloads without creating them, run:

```bash
node --import tsx --import ./tests/setup.mjs ops/datadog/create-monitors.ts
```

Stderr contains `Datadog monitor create disabled: DD_MONITORS_APPLY is not 1, so no monitor was created`. The process exits 0.

## Create the monitors when keys exist

Leave `DD_MONITORS_APPLY` unset until you intend to write monitors in a Datadog account.

Set `DD_API_KEY`, `DD_APP_KEY`, and `DD_MONITORS_APPLY=1`. Then run `ops/datadog/create-monitors.ts` with the same `node` command as above.

The script searches by monitor name. The first run creates a missing monitor. The next run updates that monitor. A redirect does not receive the keys.

The spend monitor queries `max(last_1h):max:nightcap.spend.daily_fraction{service:nightcap} >= 0.8`.

The error monitor queries the last hour of `nightcap.request.error` divided by `nightcap.request.total` for `source:app`, and alerts at or above 0.1. Eval runs use `source:eval` and stay out of that query.

`notify_no_data` is false on both monitors. An idle hour does not page. The error monitor sets `require_full_window` so the first partial hour does not alert.

No notification channel is attached. Wire a channel in Datadog after you have read a real breach.

## Record the weekly snapshot

Once a week, open the Nightcap dashboard and record these four widgets for the last 7 days.

1. Validity. Widget title `Request validity`. Query `1 - (sum:nightcap.request.error{service:nightcap,source:app}.as_count() / sum:nightcap.request.total{service:nightcap,source:app}.as_count())`.
2. p50. Widget title `Request latency p50`. Use the LLM Observability metric `latency_ms` on the `request` span, 50th percentile.
3. p99. Widget title `Request latency p99`. Use the same `latency_ms` metric, 99th percentile.
4. Cost per request. Widget title `Ledger cost per request`. Multiply `nightcap.spend.daily_fraction` by `RATE_LIMIT_DAILY_SPEND_USD`, then divide by `sum:nightcap.request.total{service:nightcap,source:app}.as_count()` for that UTC day.

Use the ledger fraction for cost. The `cost_usd` tag counts model spend only, so Places and Routes are missing from it.

Write down the four numbers, the UTC week they cover, and whether each monitor was OK at the start of the week.
