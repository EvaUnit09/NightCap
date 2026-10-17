# Home

Opening the site shows the Nightcap title, a nav brand, a New York date-planner clock, and the heading "Plan a date night in one sentence." The composer asks for one sentence (chips, Use my location, Plan our night). Three ghost option cards sit below it, each labeled OPTION 1–3 with a short hint. Saved plans is text in the nav, not a link. After a successful keyed plan, option cards replace the ghosts, the route map mounts for the selected option, and a Save and share block appears.

## Sub-features

- `home-open` loads `/` and shows the date-night heading.
- `home-title` sets the document title and the description the browser exposes.
- `home-compose` covers the empty textbox, the example buttons, the chip menus, Use my location, and Cmd/Ctrl+Enter.
- `home-submit-offline` covers a keyless plan request ending in the friendly unavailable alert.
- `home-submit-live` covers a keyed run that replaces the ghost cards and can show parsed-intent tags. It stays off unless API keys are present.
- `home-map` covers the route map after a done plan and Show on map to change which option is selected. Needs a keyed run; without a browser Maps key the map status is "Map is off."
- `home-save-share` covers the Save and share block after a done plan (email sign-in or Signed in, Save this plan). Copy link appears only after a successful save returns a share path. Needs a keyed run; save needs auth and persist.

## How to get to it (user POV)

- Open the site root in a browser.

## Driving it with verify-nightcap

Preconditions:

- `verify-nightcap doctor` prints `http://127.0.0.1:4173` and a live pid.
- The brand "Nightcap" links to `/`. "Saved plans" is not a link.
- Keyless idle and offline-submit work with no `.env.local`. Live options, map, and save need keys (and save needs auth/persist).

- **Open home.** Visit the site root. Run `.cursor/skills/verify-nightcap/scripts/verify-nightcap drive home`. The command exits 0, `home.proof.txt` says `result: pass` and `status: 200`, and `home.html` contains `<title>Nightcap</title>`, `Plan a date night`, `content="Night-out itineraries for New York."`, `Plan our night`, `OPTION 1`, `OPTION 2`, and `OPTION 3`.
- **Read the page.** Open `http://127.0.0.1:4173/` in a browser. The document title is `Nightcap` and the accessibility tree has one level-1 heading named `Plan a date night in one sentence.` Ghost cards show OPTION labels and hint lines. Save the snapshot to the printed `ARIA_PATH` (`home.aria.txt`) and a screenshot to the printed `SCREENSHOT_PATH` (`home.png`). Also capture the page at about 1440px wide and again near 900px.
- **Keyless submit.** With no model keys, enter a sentence and click Plan our night. Expect a `role="alert"` with friendly unavailable copy (for example "Planning is unavailable right now. Try again in a minute.").
- **Keyed done / map / save (optional).** With keys, submit until options replace ghosts. Expect `aria-label="Route map"` as soon as the plan is done (selection starts on the first option). Click Show on map on another option to switch selection (`aria-pressed="true"` on that button). Expect a Save and share heading with sign-in and Save this plan. Do not expect Copy link until a signed-in save succeeds. Skip when keys are unset; record `verified-unreachable` with that prerequisite.

## Gotchas

- Port 3000 is the everyday `npm run dev` port. A verification run uses 4173 and must refuse a server it did not start. The port-3000 guard treats a page as Nightcap when the title is Nightcap and the body has either `<h1>Nightcap</h1>` or `Plan a date night`, so an older checkout still blocks a second server.
- The HTML shell includes Next scripts. Assert the home markers, not that the body is only those strings.
- A 404 response also contains `<title>Nightcap</title>`. Home proof requires HTTP 200, `Plan a date night`, and the idle composer markers.
- `drive home` does not write the screenshot. The browser step has to, or the UI proof is incomplete.
- `next dev` loads `.env.local`. If that file holds real keys, a submit spends model calls. The friendly alert path is the one to check when keys are unset.
- Map and Save and share mount only after a done plan (`app/_home/results.tsx`). Idle HTML will not contain those strings. Show on map does not mount the map; it only changes the selected option.
