"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { Composer } from "./composer";
import { Hero, Nav, TryRow } from "./chrome";
import { useNyClock } from "./ny-clock";
import { streamPlan } from "./plan-client";
import { IDLE, nextRequestId, planReducer } from "./plan-state";
import { NO_OVERRIDES, canSubmit, composeRequestText, type Overrides } from "./request-text";
import { IntentTags, Results } from "./results";

export function HomePage() {
  const [text, setText] = useState("");
  const [overrides, setOverrides] = useState<Overrides>(NO_OVERRIDES);
  const [plan, dispatch] = useReducer(planReducer, IDLE);
  const now = useNyClock();
  const inFlight = useRef<AbortController | null>(null);

  const submit = useCallback(async () => {
    if (!canSubmit(text)) return;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    const requestId = nextRequestId();
    const requestText = composeRequestText(text, overrides, now ?? new Date());
    dispatch({ type: "submitted", requestId });
    for await (const update of streamPlan(requestText, controller.signal)) {
      dispatch({ type: "received", requestId, update });
    }
  }, [text, overrides, now]);

  useEffect(() => () => inFlight.current?.abort(), []);

  return (
    <div className="home">
      <Nav />
      <Hero now={now} />
      <div className="home-band">
        <Composer
          text={text}
          onText={setText}
          overrides={overrides}
          onOverrides={setOverrides}
          canSubmit={canSubmit(text)}
          onSubmit={() => {
            void submit();
          }}
        />
        <TryRow onPick={setText} />
      </div>
        <IntentTags plan={plan} />
      <Results key={plan.kind === "idle" ? "idle" : plan.requestId} plan={plan} />
    </div>
  );
}
