# Unknown route

Opening a path the app does not define shows a 404 page. The status is not found, the heading is 404, and the message says the page could not be found.

## Sub-features

- `not-found-status` responds to an unknown path with HTTP 404.
- `not-found-copy` shows the 404 heading and the not-found message.

## How to get to it (user POV)

- Type a path that is not the site root, such as `/does-not-exist`, into the address bar.

## Driving it with verify-nightcap

Preconditions:

- `verify-nightcap doctor` prints `http://127.0.0.1:4173` and a live pid.
- The path `/does-not-exist` is not a real page. There is no link to it from home.

- **Open an unknown path.** Visit `/does-not-exist`. Run `.cursor/skills/verify-nightcap/scripts/verify-nightcap drive not-found`. The command exits 0, `not-found.proof.txt` says `result: pass` and `status: 404`, and `not-found.html` contains `>404<` and `This page could not be found.`
- **Read the page.** Open `http://127.0.0.1:4173/does-not-exist` in a browser. The accessibility tree shows a heading named `404` and the text `This page could not be found.` Save the snapshot to the printed `ARIA_PATH` (`not-found.aria.txt`) and a screenshot to the printed `SCREENSHOT_PATH` (`not-found.png`).

## Gotchas

- The 404 HTML includes `<title>Nightcap</title>` and then `<title>404: This page could not be found.</title>`. The first title is the root layout. Proof is HTTP 404 plus the heading `404` and the message, not the absence of the word Nightcap.
- Home and this page are different proofs. A passing home drive does not cover an unknown path.
- `drive not-found` does not write the screenshot. The browser step has to, or the UI proof is incomplete.
