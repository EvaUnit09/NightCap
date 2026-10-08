# Home

Opening the site shows the Nightcap name as the page title and as the only heading. There is no form and no other control.

## Sub-features

- `home-open` loads `/` and shows the Nightcap heading.
- `home-title` sets the document title and the description the browser exposes.

## How to get to it (user POV)

- Open the site root in a browser.

## Driving it with verify-nightcap

Preconditions:

- `verify-nightcap doctor` prints `http://127.0.0.1:4173` and a live pid.
- No other entry point exists. The page has no navigation links.

- **Open home.** Visit the site root. Run `.cursor/skills/verify-nightcap/scripts/verify-nightcap drive home`. The command exits 0, `home.proof.txt` says `result: pass` and `status: 200`, and `home.html` contains `<title>Nightcap</title>`, `<h1>Nightcap</h1>`, and `content="Night-out itineraries for New York."`.
- **Read the page.** Open `http://127.0.0.1:4173/` in a browser. The document title is `Nightcap` and the accessibility tree has one level-1 heading named `Nightcap`. Save the snapshot to the printed `ARIA_PATH` (`home.aria.txt`) and a screenshot to the printed `SCREENSHOT_PATH` (`home.png`).

## Gotchas

- Port 3000 is the everyday `npm run dev` port. A verification run uses 4173 and must refuse a server it did not start.
- The HTML shell includes Next scripts. Assert the `<h1>Nightcap</h1>` marker and the accessibility heading, not that the body is only that tag.
- The page has no CSS. In a dark browser the heading can be black on black in the screenshot. The accessibility snapshot and the `<h1>` marker still prove it is there. Save the screenshot anyway.
- A 404 response also contains `<title>Nightcap</title>` before the error title. Home proof requires HTTP 200 and the level-1 heading `Nightcap`.
- `drive home` does not write the screenshot. The browser step has to, or the UI proof is incomplete.
