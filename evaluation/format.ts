import type { EvalMetrics, Ratio } from "./score";

function percent(value: Ratio): string {
  const rate = value.rate === null ? "n/a" : `${(value.rate * 100).toFixed(1)}%`;
  return `${rate} (${value.numerator}/${value.denominator})`;
}

function pass(isPass: boolean): string {
  return isPass ? "PASS" : "FAIL";
}

function table(rows: readonly (readonly [string, string])[]): string[] {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`);
}

/** The metrics as a plain-text table for the terminal. Pure. */
export function formatMetricsTable(metrics: EvalMetrics): string {
  const { validity, inventedVenue, formatCompliance, diversity, candidateRecall: recall, gates } = metrics;
  const rows: (readonly [string, string])[] = [
    ["Cases", String(metrics.caseCount)],
    ["Validity (cases)", `${percent(validity.cases)}  gate ≥ ${gates.validity.target * 100}%: ${pass(gates.validity.pass)}`],
    ["Validity (options)", percent(validity.options)],
    ["Invented venue (cases)", `${percent(inventedVenue.cases)}  gate = 0: ${pass(gates.inventedVenue.pass)}`],
    ["Invented venue (options)", percent(inventedVenue.options)],
    ["Invented ids recorded", String(inventedVenue.inventedIds)],
    ["Format compliance", percent(formatCompliance.overall)],
    ["  parse_intent", percent(formatCompliance.byStage.parse_intent)],
    ["  plan_itineraries", percent(formatCompliance.byStage.plan_itineraries)],
    ["  repair_itinerary", percent(formatCompliance.byStage.repair_itinerary)],
    ["Distinct venues", percent(diversity.distinctVenues)],
    [`Outside top-${diversity.topN} reviewed`, percent(diversity.outsideTopN)],
    ["Overlapping responses", `${percent(diversity.overlappingResponses)}  target 0`],
    [
      "Candidate recall",
      `${percent(recall.lowerBound)} to ${percent(recall.upperBound)}  ` +
        `hit ${recall.hit}, miss ${recall.miss}, unknown ${recall.unknown}, n/a ${recall.notApplicable}`,
    ],
    ["Plan validity | good pool", percent(metrics.planValidityGivenPool)],
  ];
  const outcomes = Object.entries(metrics.outcomes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => `${key} ${count}`)
    .join(", ");
  return [...table(rows), "", `Outcomes: ${outcomes}`].join("\n");
}
