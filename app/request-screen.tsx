"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { planRequestSchema, type PlanRequest } from "../src/api/plan-request";
import { loadItinerary } from "../src/client/load-itinerary";
import { requestPlan } from "../src/client/plan-events";
import {
  feedbackTargets,
  initialScreen,
  reduceScreen,
  type FeedbackTarget,
  type ScreenModel,
} from "../src/client/request-screen-state";
import type { Intent } from "../src/validation/intent";
import type { ItineraryOption } from "../src/validation/itinerary";

const WHEN = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/New_York",
});

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return WHEN.format(date);
}

function intentLine(intent: Intent): string {
  return `${intent.area} · $${intent.budgetUsd} · ${formatWhen(intent.window.start)}`;
}

function Notice({ children }: { readonly children: string }) {
  return (
    <p className="notice" role="status">
      {children}
    </p>
  );
}

function FeedbackBar({
  itineraryId,
  placeIds,
}: {
  readonly itineraryId?: string;
  readonly placeIds: readonly string[];
}) {
  const [placeId, setPlaceId] = useState(placeIds[0] ?? "");
  const [note, setNote] = useState("");
  const selected = placeIds.includes(placeId) ? placeId : (placeIds[0] ?? "");

  async function send(signal: Record<string, unknown>) {
    if (!itineraryId) return;
    const response = await fetch("/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itineraryId, signal }),
    });
    setNote(response.ok ? "Saved." : "Not saved.");
  }

  return (
    <fieldset className="feedback" disabled={itineraryId === undefined}>
      <legend>Feedback</legend>
      <button type="button" onClick={() => void send({ kind: "thumbs", thumbs: 1 })}>
        Thumbs up
      </button>
      <button type="button" onClick={() => void send({ kind: "thumbs", thumbs: -1 })}>
        Thumbs down
      </button>
      <button type="button" onClick={() => void send({ kind: "would_go", wouldGo: true })}>
        Would go
      </button>
      <button type="button" onClick={() => void send({ kind: "did_go", didGo: true })}>
        Did go
      </button>
      <label>
        Place
        <select value={selected} onChange={(event) => setPlaceId(event.target.value)} disabled={placeIds.length === 0}>
          {placeIds.length === 0 ? <option value="">No place</option> : null}
          {placeIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={selected.length === 0}
        onClick={() => void send({ kind: "new_to_you", placeId: selected, value: true })}
      >
        New to me
      </button>
      <button
        type="button"
        disabled={selected.length === 0}
        onClick={() => void send({ kind: "closed_venue", placeId: selected })}
      >
        Closed
      </button>
      {note ? <p role="status">{note}</p> : null}
    </fieldset>
  );
}

function Timelines({
  options,
  targets,
}: {
  readonly options: readonly ItineraryOption[];
  readonly targets: readonly FeedbackTarget[];
}) {
  if (options.length === 0) return null;
  const linked = targets.length === options.length;
  return (
    <div className="timelines">
      {options.map((option, index) => (
        <article className="card" key={targets[index]?.itineraryId ?? index}>
          <h2>{option.theme}</h2>
          <ol>
            {option.stops.map((stop) => (
              <li key={stop.placeId}>
                <time dateTime={stop.start}>{formatWhen(stop.start)}</time>
                <strong>{stop.name}</strong>
                <p>{stop.why}</p>
              </li>
            ))}
          </ol>
          {linked ? <FeedbackBar itineraryId={targets[index]?.itineraryId} placeIds={option.stops.map((stop) => stop.placeId)} /> : null}
        </article>
      ))}
    </div>
  );
}

function Results({ screen }: { readonly screen: ScreenModel }) {
  const targets = feedbackTargets(screen);
  switch (screen.phase) {
    case "idle":
      return <FeedbackBar placeIds={[]} />;
    case "planning":
      return (
        <div aria-busy="true">
          <Notice>Planning the night.</Notice>
          {screen.intent ? <p className="intent">{intentLine(screen.intent)}</p> : null}
          <Timelines options={screen.options} targets={[]} />
          <FeedbackBar placeIds={[]} />
        </div>
      );
    case "ready":
      return (
        <div>
          {screen.intent ? <p className="intent">{intentLine(screen.intent)}</p> : null}
          <Timelines options={screen.options} targets={targets} />
          {targets.length === 0 ? <FeedbackBar placeIds={[]} /> : null}
        </div>
      );
    case "daily_spend_cap":
    case "hourly_plan_limit":
      return (
        <div>
          <Notice>{screen.message}</Notice>
          <FeedbackBar placeIds={[]} />
        </div>
      );
    case "unavailable":
      return (
        <div>
          <Notice>Planning is unavailable right now.</Notice>
          <FeedbackBar placeIds={[]} />
        </div>
      );
    case "rejected":
      return (
        <div>
          <Notice>That request could not be sent. Check the text and try again.</Notice>
          <FeedbackBar placeIds={[]} />
        </div>
      );
    case "failed":
      return (
        <div>
          <Notice>This plan did not finish. Try again.</Notice>
          <FeedbackBar placeIds={[]} />
        </div>
      );
    case "reloading":
      return <Notice>Loading the saved plan.</Notice>;
    case "reload_missing":
      return <Notice>That plan could not be reloaded.</Notice>;
    case "reloaded":
      return (
        <article className="card reload">
          <h2>Saved plan</h2>
          <ol>
            {screen.stops.map((stop) => (
              <li key={stop.placeId}>
                <time dateTime={stop.start}>{formatWhen(stop.start)}</time>
                <strong>{stop.name ?? stop.placeId}</strong>
                <p>{stop.why}</p>
              </li>
            ))}
          </ol>
          <FeedbackBar itineraryId={screen.id} placeIds={screen.stops.map((stop) => stop.placeId)} />
        </article>
      );
    default: {
      const neverScreen: never = screen;
      return neverScreen;
    }
  }
}

export function RequestScreen({ itineraryId }: { readonly itineraryId?: string }) {
  const textId = useId();
  const busy = useRef(false);
  const [screen, setScreen] = useState<ScreenModel>(() => initialScreen(itineraryId));
  const [text, setText] = useState("");
  const [date, setDate] = useState("");
  const [budget, setBudget] = useState("");
  const [neighborhood, setNeighborhood] = useState("");

  useEffect(() => {
    if (!itineraryId) return;
    const controller = new AbortController();
    void loadItinerary(itineraryId, { signal: controller.signal }).then((loaded) => {
      if (controller.signal.aborted) return;
      setScreen((current) =>
        loaded.kind === "ready"
          ? reduceScreen(current, { type: "reload_ready", id: loaded.id, stops: loaded.stops })
          : reduceScreen(current, { type: "reload_missing" }),
      );
    });
    return () => controller.abort();
  }, [itineraryId]);

  function dispatch(event: Parameters<typeof reduceScreen>[1]) {
    setScreen((current) => reduceScreen(current, event));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    const body: { text: string; date?: string; budgetUsd?: number; neighborhood?: string } = {
      text: text.trim(),
    };
    if (date) body.date = date;
    if (/^\d+$/.test(budget)) body.budgetUsd = Number(budget);
    const place = neighborhood.trim();
    if (place) body.neighborhood = place;
    const parsed = planRequestSchema.safeParse(body);
    if (!parsed.success) {
      dispatch({ type: "rejected" });
      return;
    }
    const input: PlanRequest = parsed.data;
    busy.current = true;
    dispatch({ type: "submit" });
    try {
      const outcome = await requestPlan(input, {
        onIntent: (intent) => dispatch({ type: "intent", intent }),
        onItinerary: (option) => dispatch({ type: "itinerary", option }),
        onDone: (itineraryIds) => dispatch({ type: "done", itineraryIds }),
        onFailed: (code) => dispatch({ type: "failed", code }),
      });
      switch (outcome.kind) {
        case "streamed":
        case "aborted":
          return;
        case "daily_spend_cap":
          dispatch({ type: "daily_spend_cap", message: outcome.message });
          return;
        case "hourly_plan_limit":
          dispatch({ type: "hourly_plan_limit", message: outcome.message });
          return;
        case "unavailable":
          dispatch({ type: "unavailable" });
          return;
        case "rejected":
          dispatch({ type: "rejected" });
          return;
        default: {
          const neverOutcome: never = outcome;
          return neverOutcome;
        }
      }
    } finally {
      busy.current = false;
    }
  }

  function onTextKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  const planning = screen.phase === "planning";

  return (
    <div className="night">
      <p className="lead">Two or three ways to spend the night in New York.</p>
      <form onSubmit={onSubmit}>
        <label htmlFor={textId}>What do you want tonight?</label>
        <textarea
          id={textId}
          name="text"
          value={text}
          required
          maxLength={8192}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onTextKeyDown}
        />
        <div className="filters">
          <label>
            Date
            <input name="date" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
          <label>
            Budget ($)
            <input
              name="budget"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
            />
          </label>
          <label>
            Neighborhood
            <input
              name="neighborhood"
              type="text"
              maxLength={80}
              value={neighborhood}
              onChange={(event) => setNeighborhood(event.target.value)}
            />
          </label>
        </div>
        <div className="actions">
          <button className="submit" type="submit" disabled={planning || text.trim().length === 0}>
            Plan the night
          </button>
          <p className="hint">Press ⌘Enter or Ctrl+Enter from the text box.</p>
        </div>
      </form>
      <Results screen={screen} />
    </div>
  );
}
