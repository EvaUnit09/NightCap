import Link from "next/link";

import { EXAMPLES } from "./request-text";
import { formatNyTime } from "./ny-clock";

export function Nav() {
  return (
    <nav className="nav home-nav">
      <Link className="nav-brand" href="/">
        Nightcap
      </Link>
      <span className="home-saved">Saved plans</span>
    </nav>
  );
}

export function Hero({ now }: { readonly now: Date | null }) {
  return (
    <header className="home-hero">
      <p className="home-eyebrow">
        New York · Date planner · <span className="home-clock">{now ? formatNyTime(now) : "\u00a0"}</span>
      </p>
      <h1>
        Plan a date night <br />
        <span className="text-muted">in one sentence.</span>
      </h1>
    </header>
  );
}

export function TryRow({ onPick }: { readonly onPick: (example: (typeof EXAMPLES)[number]) => void }) {
  return (
    <div className="home-try">
      <span className="text-muted home-try-label">Try</span>
      {EXAMPLES.map((example) => (
        <button key={example} type="button" className="btn btn-secondary" onClick={() => onPick(example)}>
          {example}
        </button>
      ))}
    </div>
  );
}
