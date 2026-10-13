# Shared plan

Opening `/s/<slug>` shows a public share page. With no database the server says sharing is unavailable. An invalid or unknown slug shows the share-missing page (Nightcap heading, "This shared plan was not found.", link back home). A real saved slug needs persist configured and shows the stops.

## Sub-features

- `shared-plan-unconfigured` covers a valid-format slug when persist is unset: "Sharing is not available on this server."
- `shared-plan-missing` covers an invalid or unknown slug: the segment not-found UI.
- `shared-plan-ready` covers a real saved slug with stops and "Plan another night." It stays off unless the database holds that share.

## How to get to it (user POV)

- Open a share link shaped like `/s/<slug>` (from Save and share after a keyed save, or by typing a slug).
- There is no link to a share URL from the idle home page.

## Driving it with verify-nightcap

Preconditions:

- `verify-nightcap doctor` prints `http://127.0.0.1:4173` and a live pid.
- Keyless checks below do not need `.env.local`. Ready-state proof needs a real share row in the database.

- **Open a missing share.** Visit `/s/bad-slug` (fails the share-slug shape). Run `.cursor/skills/verify-nightcap/scripts/verify-nightcap drive shared-plan-missing`. The command exits 0, `shared-plan-missing.proof.txt` says `result: pass`, and the HTML contains `This shared plan was not found.` and `Plan a night`. HTTP status may be `200` or `404` (Next soft `notFound()` under Suspense); proof is the copy, not a hard 404.
- **Read the missing page.** Open `http://127.0.0.1:4173/s/bad-slug` in a browser. The accessibility tree has a level-1 heading `Nightcap` and the missing-plan message. Save to the printed `ARIA_PATH` and `SCREENSHOT_PATH`.
- **Open unconfigured sharing.** When persist is unset, visit a valid-format slug such as `/s/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`. Run `.cursor/skills/verify-nightcap/scripts/verify-nightcap drive shared-plan-unconfigured`. The command exits 0 and the HTML contains `Sharing is not available on this server.` Skip this drive when a database is configured; use a known-missing valid slug for `shared-plan-missing` instead, or a real slug for ready.
- **Ready state (optional).** With a real share slug from a keyed save, open `/s/<slug>`. Expect `Shared plan`, stop list markers, and `Plan another night`. There is no keyless harness drive for ready.

## Gotchas

- This is not the unknown-route page. `/does-not-exist` is Next's builtin 404; `/s/bad-slug` uses `app/s/[slug]/not-found.tsx`.
- Valid slug shape is 16–64 chars of `[A-Za-z0-9_-]` (`isShareSlug` in `src/api/share.ts`). Short junk always hits missing.
- Streaming HTML can include loading fallback text (`Loading the shared plan.`) and RSC payloads; assert the user-visible share copy, not that the body is only that string.
- `drive shared-plan-missing` and `drive shared-plan-unconfigured` do not write screenshots. The browser step has to.
