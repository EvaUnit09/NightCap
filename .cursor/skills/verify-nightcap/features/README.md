# Nightcap verification map

This directory is the maintained source for verifying Nightcap's user-facing behavior. Read the index before driving the app, then use the matching feature file as the recipe.

The app currently renders two pages. The home shell and the unknown-route page are the map. Itinerary requests, streaming plans, feedback, and saved plans are not implemented, so they have no feature files.

## Baseline preconditions

- Dependencies are installed (`node_modules/next` matches `package.json`).
- No Nightcap server is already serving port 3000. This checkout can run one Next process.
- Launch with `.cursor/skills/verify-nightcap/scripts/verify-nightcap launch`, which serves `http://127.0.0.1:4173`.
- Run `verify-nightcap doctor` and require the url, pid, port 4173, and Next version.
- Never drive an instance that was not started by this verification run.

## Driving conventions

- Start every recipe from a freshly launched server unless a feature file says otherwise.
- Prefer the path, document title, and accessible heading name. These pages have no buttons or text fields.
- Run HTTP checks through `verify-nightcap drive <feature>`.
- Open the same URL in a browser for the accessibility snapshot and screenshot.
- Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the request and the resulting page, not only a screenshot.
- UI proof includes an accessibility snapshot that shows the heading, and a screenshot of the same page. The home page has no CSS, so a dark browser can hide the heading in the image.
- HTTP proof includes the status line, the saved HTML, and `*.proof.txt`.
- Record the feature id and entry path with every artifact. The helper writes these into `*.proof.txt`.
- Report an unreachable path with the command you ran and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with verify-nightcap` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Home](./home.md) covers opening `/` and reading the Nightcap title and heading.
- [Unknown route](./not-found.md) covers opening a path that has no page and reading the 404.
