<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Entry point
- **poteto-mode** — Default router. Describe the outcome; it picks the playbook (bug-fix, feature, investigation, etc.) and drives verification.

## Vendored pstack skills
- poteto-mode (router + all playbooks)
- architect
- tdd
- blast-radius
- maintain-verification-skill
- typescript-best-practices
- verify-nightcap (project-specific control skill)

## Vendored cursor-team-kit skills
- deslop
- verify-this
- check-compiler-errors
- fix-ci
- loop-on-ci
- fix-merge-conflicts
- get-pr-comments
- review-and-ship
- make-pr-easy-to-review
- run-smoke-tests
- control-ui

## PII redactor (`src/monitoring`)

The module imports `server-only` so the given-name list cannot ship to
the client. Tracing (`withRequestTrace` / `withStage`) is server-only
for the same reason and must not be imported from `app/` client files.
Plain-node scripts and the eval runner must load
`tests/setup.mjs` (or an equivalent shim) or run with
`--conditions=react-server`. `npm test` already imports the shim.

## Cursor Cloud specific instructions

- Node 22 (`package.json` `engines` and `.nvmrc`). Install with `npm ci`. The home page, `npm test`, `npm run lint`, `npm run typecheck`, and `npm run build` need no API keys. Live Places tests stay off unless `RUN_LIVE_PLACES=1` and `GOOGLE_PLACES_API_KEY` are set.
- This checkout can run one Next server; `next dev` processes share `.next`. Launch with `.cursor/skills/verify-nightcap/scripts/verify-nightcap launch` (127.0.0.1:4173). The launcher refuses when port 3000 is already serving Nightcap.
- Readiness is HTTP 200 from `GET /` with `<title>Nightcap</title>` and `<h1>Nightcap</h1>`. `GET /does-not-exist` is 404, with heading `404` and the text `This page could not be found.`
- `lsof` skips the `next-server` process because its title contains parentheses, so `verify-nightcap doctor` and `verify-nightcap drive` can exit before they record proof while the page is already healthy. Use the HTTP checks above.
