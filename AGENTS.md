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
the client. Plain-node scripts and the eval runner must load
`tests/setup.mjs` (or an equivalent shim) or run with
`--conditions=react-server`. `npm test` already imports the shim.
