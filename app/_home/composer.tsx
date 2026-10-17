import { useState, type KeyboardEvent } from "react";

import { ChipMenu } from "./chip-menu";
import { composerSubmitUi } from "./composer-submit";
import { ArrowRight, MagnifyingGlass } from "./icons";
import {
  CHIP_TABLE,
  TEXTAREA_MAX_CHARS,
  chipLabel,
  parseCustomBudget,
  roundCoord,
  type Overrides,
} from "./request-text";

export interface ComposerProps {
  readonly text: string;
  readonly onText: (text: string) => void;
  readonly overrides: Overrides;
  readonly onOverrides: (next: Overrides) => void;
  readonly busy: boolean;
  readonly canSubmit: boolean;
  readonly onSubmit: () => void;
}

export function Composer({ text, onText, overrides, onOverrides, busy, canSubmit, onSubmit }: ComposerProps) {
  const [customDraft, setCustomDraft] = useState("");
  const submitUi = composerSubmitUi(busy, canSubmit);

  function submitNight() {
    if (busy) return;
    onSubmit();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submitNight();
    }
  }

  function locate() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((position) => {
      const lat = roundCoord(position.coords.latitude);
      const lng = roundCoord(position.coords.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      onOverrides({ ...overrides, near: { lat, lng } });
    });
  }

  const nearLabel = overrides.near
    ? `Near ${overrides.near.lat.toFixed(3)}, ${overrides.near.lng.toFixed(3)}`
    : "Use my location";

  return (
    <form
      className="home-composer"
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        submitNight();
      }}
    >
      <textarea
        aria-label="Describe your night"
        placeholder="Drinks then dinner in the West Village, something low-key, around $150"
        value={text}
        maxLength={TEXTAREA_MAX_CHARS}
        onChange={(event) => onText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="home-toolbar">
        <ChipMenu
          label={chipLabel("when", overrides)}
          selected={overrides.when !== null}
          options={CHIP_TABLE.when.options}
          value={overrides.when}
          onChoose={(when) => onOverrides({ ...overrides, when })}
        />
        <ChipMenu
          label={chipLabel("budget", overrides)}
          selected={overrides.budget !== null}
          options={CHIP_TABLE.budget.options}
          value={overrides.budget?.kind === "preset" ? overrides.budget.usd : null}
          onChoose={(usd) => onOverrides({ ...overrides, budget: { kind: "preset", usd } })}
          footer={(close) => (
            <div className="home-custom">
              <input
                aria-label="Custom budget in dollars"
                inputMode="numeric"
                value={customDraft}
                placeholder={CHIP_TABLE.budget.customLabel}
                onChange={(event) => setCustomDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  const usd = parseCustomBudget(customDraft);
                  if (!usd) return;
                  onOverrides({ ...overrides, budget: { kind: "custom", usd } });
                  close();
                }}
              />
            </div>
          )}
        />
        <ChipMenu
          label={chipLabel("travel", overrides)}
          selected={overrides.travel !== null}
          options={CHIP_TABLE.travel.options}
          value={overrides.travel}
          onChoose={(travel) => onOverrides({ ...overrides, travel })}
        />
        <button type="button" className="btn btn-ghost home-locate" aria-pressed={overrides.near !== null} onClick={locate}>
          <MagnifyingGlass />
          {nearLabel}
        </button>
        <span className="home-toolbar-spacer" />
        {submitUi.status ? (
          <p role="status" className="home-plan-status">
            {submitUi.status}
          </p>
        ) : null}
        <button type="submit" className="btn btn-primary home-submit" disabled={submitUi.disabled}>
          {submitUi.label}
          {busy ? null : <ArrowRight />}
        </button>
      </div>
    </form>
  );
}
