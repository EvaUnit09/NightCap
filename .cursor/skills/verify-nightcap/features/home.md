# Home

Opening the site shows the Nightcap title, a nav brand, and the heading "Plan a date night in one sentence." The composer asks for one sentence. Three empty option cards sit below it. Saved plans is text in the nav, not a link.

## Sub-features

- `home-open` loads `/` and shows the date-night heading.
- `home-title` sets the document title and the description the browser exposes.
- `home-compose` covers the empty textbox, the example buttons, the chip menus, and Cmd/Ctrl+Enter.
- `home-submit-offline` covers a keyless plan request ending in the friendly unavailable alert.
- `home-submit-live` covers a keyed run that replaces the ghost cards. It stays off unless API keys are present.

## How to get to it (user POV)

- Open the site root in a browser.

## Driving it with verify-nightcap

Preconditions:

- `verify-nightcap doctor` prints `http://127.0.0.1:4173` and a live pid.
- The brand "Nightcap" links to `/`. "Saved plans" is not a link.

- **Open home.** Visit the site root. Run `.cursor/skills/verify-nightcap/scripts/verify-nightcap drive home`. The command exits 0, `home.proof.txt` says `result: pass` and `status: 200`, and `home.html` contains `<title>Nightcap</title>`, `Plan a date night`, `content="Night-out itineraries for New York."`, `Plan our night`, `OPTION 1`, `OPTION 2`, and `OPTION 3`.
- **Read the page.** Open `http://127.0.0.1:4173/` in a browser. The document title is `Nightcap` and the accessibility tree has one level-1 heading named `Plan a date night in one sentence.` Save the snapshot to the printed `ARIA_PATH` (`home.aria.txt`) and a screenshot to the printed `SCREENSHOT_PATH` (`home.png`). Also capture the page at about 1440px wide and again near 900px.

## Gotchas

- Port 3000 is the everyday `npm run dev` port. A verification run uses 4173 and must refuse a server it did not start. The port-3000 guard treats a page as Nightcap when the title is Nightcap and the body has either `<h1>Nightcap</h1>` or `Plan a date night`, so an older checkout still blocks a second server.
- The HTML shell includes Next scripts. Assert the home markers, not that the body is only those strings.
- A 404 response also contains `<title>Nightcap</title>`. Home proof requires HTTP 200, `Plan a date night`, and the idle composer markers.
- `drive home` does not write the screenshot. The browser step has to, or the UI proof is incomplete.
- `next dev` loads `.env.local`. If that file holds real keys, a submit spends model calls. The friendly alert path is the one to check when keys are unset.
