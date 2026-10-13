import type { TravelMode } from "../../src/validation/common";
import type { Intent } from "../../src/validation/intent";
import type { ItineraryOption } from "../../src/validation/itinerary";
import { FAILURE_COPY, type PlanState } from "./plan-state";

const GHOST_HINTS = [
  "Usually drinks, then dinner.",
  "A different neighborhood or order.",
  "Every stop checked open for your time.",
] as const;

const NY_TIME = { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" } as const;

function formatStopTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", NY_TIME).format(new Date(iso));
}

function legWord(mode: TravelMode): string {
  switch (mode) {
    case "WALK":
      return "walk";
    case "TRANSIT":
      return "subway";
    case "BICYCLE":
      return "bike";
    default: {
      const unexpected: never = mode;
      return unexpected;
    }
  }
}

function intentOf(plan: PlanState): Intent | null {
  switch (plan.kind) {
    case "idle":
      return null;
    case "streaming":
    case "done":
    case "failed":
      return plan.intent;
    default: {
      const unexpected: never = plan;
      return unexpected;
    }
  }
}

function tagsFor(intent: Intent): readonly string[] {
  return [
    intent.area,
    `$${intent.budgetUsd}`,
    ...intent.stopTypes,
    ...intent.vibeTags,
    ...intent.dietary,
    ...(intent.singleStop ? ["One spot"] : []),
  ];
}

export function IntentTags({ plan }: { readonly plan: PlanState }) {
  const intent = intentOf(plan);
  if (!intent) return null;
  return (
    <div className="home-tags" aria-label="Parsed intent">
      {tagsFor(intent).map((tag, index) => (
        <span className="tag" key={`${tag}-${index}`}>
          {tag}
        </span>
      ))}
    </div>
  );
}

function OptionCard({ index, option }: { readonly index: number; readonly option: ItineraryOption }) {
  const total = option.stops.reduce((sum, stop) => sum + stop.estimatedCostUsd, 0);
  return (
    <article className="home-card">
      <span className="text-muted home-option-label">{`OPTION ${index + 1}`}</span>
      <h2>{option.theme}</h2>
      <ol className="home-stops">
        {option.stops.map((stop) => (
          <li key={stop.placeId}>
            <p className="text-muted home-stop-time">
              {formatStopTime(stop.start)}–{formatStopTime(stop.end)}
            </p>
            <p className="home-stop-name">{stop.name}</p>
            <p className="text-muted home-stop-why">{stop.why}</p>
            {stop.travelToNext ? (
              <p className="text-muted home-leg">
                {stop.travelToNext.minutes} min {legWord(stop.travelToNext.mode)}
              </p>
            ) : null}
          </li>
        ))}
      </ol>
      <p className="home-total">Total ${total}</p>
    </article>
  );
}

function GhostCard({ index, live }: { readonly index: number; readonly live: boolean }) {
  return (
    <article className={live ? "home-ghost home-ghost-live" : "home-ghost"}>
      <span className="text-muted home-option-label">{`OPTION ${index + 1}`}</span>
      <div className="home-bar home-bar-wide" />
      <div className="home-bar home-bar-short" />
      <span className="text-muted home-hint">{GHOST_HINTS[index]}</span>
    </article>
  );
}

export function Results({ plan }: { readonly plan: PlanState }) {
  const showGhosts = plan.kind === "idle" || plan.kind === "streaming";
  return (
    <section className="home-results" aria-label="Itineraries">
      {plan.kind === "failed" ? (
        <p className="home-alert" role="alert">
          {FAILURE_COPY[plan.reason]}
        </p>
      ) : null}
      <div className="home-grid">
        {([0, 1, 2] as const).map((index) => {
          const option = plan.kind === "idle" ? null : plan.options[index];
          if (option) return <OptionCard key={index} index={index} option={option} />;
          if (!showGhosts) return null;
          return <GhostCard key={index} index={index} live={plan.kind === "streaming"} />;
        })}
      </div>
    </section>
  );
}
