---
name: verify-nightcap
description: "Drive the Nightcap Next.js web app the way a user does and save proof. Use when a change touches the home page, an unknown route, or any rendered page, and when a task needs evidence from the running app."
---

# Verify Nightcap

Nightcap is a Next.js App Router app. The user-facing surface that exists today is the web page at `/` and the built-in unknown-route page. Neither page reads env vars, auth, or the database, so launch needs no `.env.local` and no Supabase. Itinerary planning is not in the app yet, so it is not in the feature map.

Read [features/README.md](features/README.md) before driving. Drive only the instance this skill started.

## Launch

From the repo root:

```bash
.cursor/skills/verify-nightcap/scripts/verify-nightcap launch
```

That runs `npm run dev -- --hostname 127.0.0.1 --port 4173` in its own process group. Ready means `http://127.0.0.1:4173/` returns HTTP 200 and the body contains `<h1>Nightcap</h1>`. The command prints `ready`, the pid, the run id, and the log path. A second launch while that pid is healthy prints `already running` and does not start another server.

This checkout can run one Next server. `next dev` and another Next process share `.next`. Launch refuses when port 3000 is already serving a page with `<h1>Nightcap</h1>`, and when port 4173 is already taken. It does not kill either one.

Teardown is `verify-nightcap cleanup`. It signals the process group recorded at launch and deletes `.cursor/skills/verify-nightcap/.run/`. It leaves `.cursor/skills/verify-nightcap/artifacts/` in place.

## Doctor

```bash
.cursor/skills/verify-nightcap/scripts/verify-nightcap doctor
```

Run this first whenever a drive looks wrong. It is read-only. It passes only when all of these are true:

- `.run/state.env` exists and its pid is alive
- installed `next` matches `dependencies.next` in `package.json`
- a listener on port 4173 belongs to that process group
- `GET /` is HTTP 200 and contains `<title>Nightcap</title>` and `<h1>Nightcap</h1>`

It prints the url, pid, port, run id, log path, and Next version.

## Drive

The helper saves the HTTP response. The browser step records what a user sees. Do both for the feature you are proving. Stable handles are the path, the document title, and the heading text. There are no buttons or fields on these pages.

Home:

```bash
.cursor/skills/verify-nightcap/scripts/verify-nightcap drive home
```

Then open the printed URL `/` in a browser. The accessibility tree has a level-1 heading named `Nightcap` and the document is titled `Nightcap`. Write that snapshot to the printed `ARIA_PATH` and a screenshot to the printed `SCREENSHOT_PATH`.

Unknown route:

```bash
.cursor/skills/verify-nightcap/scripts/verify-nightcap drive not-found
```

Then open `<url>/does-not-exist`. The accessibility tree shows a level-1 heading `404` and a level-2 heading `This page could not be found.` The document title visible to the user is `404: This page could not be found.` Save the snapshot and screenshot to the printed `ARIA_PATH` and `SCREENSHOT_PATH`.

`verify-nightcap url` prints the base URL.

## Evidence

Proof for a feature is the pair of the request and the resulting page, plus the browser snapshot and screenshot. HTTP files alone do not finish a UI proof. Artifacts go in `.cursor/skills/verify-nightcap/artifacts/<run-id>/`:

- `home.html`, `home.headers.txt`, `home.proof.txt`, `home.aria.txt`, `home.png`
- `not-found.html`, `not-found.headers.txt`, `not-found.proof.txt`, `not-found.aria.txt`, `not-found.png`

`*.proof.txt` records the feature id, entry path, HTTP status, and pass or fail. There is no test-only endpoint and no dry-run mode. Nothing is mocked: the page is the dev server rendering `app/page.tsx`. There is no database row or file side effect to check beyond these artifacts.

## Cleanup

```bash
.cursor/skills/verify-nightcap/scripts/verify-nightcap cleanup
```

This stops the pid recorded in `.run/state.env` by signaling that process group, then removes `.run/`. It never deletes `artifacts/`. After cleanup, the `home.*` and `not-found.*` files from the run must still be on disk. Do not kill a process by name, and do not stop a server this script did not start. If a drive fails, run cleanup before starting another attempt so port 4173 is not left occupied.

## Helpers

The only helper is `.cursor/skills/verify-nightcap/scripts/verify-nightcap`. Invoke it by that path. Commands: `launch`, `doctor`, `url`, `drive home`, `drive not-found`, `cleanup`.
