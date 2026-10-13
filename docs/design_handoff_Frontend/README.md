# Handoff: Nightcap home page — "Say the night"

## Overview
The new home page for Nightcap (`app/page.tsx`, which today renders only `<h1>Nightcap</h1>`). It's built around one task: a couple describes their date in one sentence, then submits to get 2–3 validated itineraries. The large text box is the focus of the page.

## About the design files
`Home.dc.html` is an HTML **design reference**: a prototype showing the intended look and behavior, not production code. Rebuild it in the Next.js app (`app/`) as React components, following the repo's conventions (see `AGENTS.md`: this Next version has breaking changes, so read `node_modules/next/dist/docs/` first). Open `Home.dc.html` in a browser to see it running. `base.css` is the original token and component stylesheet; the `:root` block in `Home.dc.html` overrides its colors with the Wine palette.

## Fidelity
High-fidelity. Colors, type, spacing and copy are final. Designed at 1440px wide.

## Layout (top to bottom)
The page is full height. Background: `radial-gradient(50% 45% at 8% 0%, accent-900, bg 70%)`, a soft wine glow in the top-left corner. All sections use 72px horizontal padding and are left-aligned.

1. **Nav**: padding 28px 72px, flex, gap 11.2px. Brand "Nightcap" (Inter 500, 18px) pushed left with `margin-right:auto`. Link "Saved plans" (14px, inherits text color, accent on hover).
2. **Hero**: padding 104px 72px 56px, column, gap 11.2px.
   - Eyebrow: `New York · Date planner · {time}`, 12px, letter-spacing 0.18em, uppercase, color accent-300. `{time}` is the live New York time (`h:mm AM`, `America/New_York`), refreshed every 30 s.
   - H1: "Plan a date night" / line break / "in one sentence." Inter 500, 88px, line-height 1, letter-spacing −0.035em. The second line uses muted text (text at 55% opacity).
3. **Input band**: padding 40px 72px, column, gap 11.2px. A 1px divider runs along the top and bottom edges and fades to transparent over the 48px at each end: `linear-gradient(to right, transparent, divider 48px, divider calc(100% - 48px), transparent)`.
   - **Composer card**: radius 14px, background surface, box-shadow `0 0 0 1px accent-700, 0 0 48px accent-900` (ring plus glow).
     - Textarea: font inherited, 30px, line-height 1.35, letter-spacing −0.015em, no border or outline, transparent, `resize:none`, min-height 132px, padding 28px 32px 8px, caret color accent. Placeholder: "Drinks then dinner in the West Village, something low-key, around $150".
     - Toolbar: flex, wrap, gap 5.6px, padding 16px 20px 20px 32px.
       - Secondary chips "Tonight", "$150 for two", "Walking" (`.btn-secondary`, 14px).
       - Ghost button with a magnifying-glass icon and "Use my location" (14px, text color, 70% opacity).
       - A spacer, then the primary button "Plan our night" with an arrow-right icon (17px, padding 14px 28px, 1px accent border, background 10% accent, accent text). It is disabled (45% opacity) while the textarea is empty.
   - **Try row**: "TRY" label (12px, 0.12em, uppercase, muted), then four `.btn-secondary` 13px example buttons:
     - "Cocktails then ramen in the East Village"
     - "Just dinner, one spot, West Village"
     - "First date somewhere we can talk"
     - "Something outdoors in Williamsburg"
4. **Results area (empty state)**: padding 64px 72px 72px, grid `repeat(auto-fit, minmax(260px,1fr))`, gap 32px. Three placeholder cards: padding 28px, radius 14px, inset 1px neutral-900 ring. Each has a label "OPTION 1/2/3" (12px uppercase muted), two 12px-tall bars (60% and 42% wide, neutral-900, radius 4px), and a hint (13px muted):
   - "Usually drinks, then dinner."
   - "A different neighborhood or order."
   - "Every stop checked open for your time."

## Interactions & behavior
- Clicking an example fills the textarea with that text. It does not submit.
- "Plan our night" submits the free text plus the chip values. This maps to the pipeline input "free-text request + optional filters" (`docs/architecture.md`, build step 25).
- The chips are optional overrides; their menus were **not designed**, so follow the patterns already on this page:
  - **Tonight**: a date picker with Tonight, Tomorrow and This Friday.
  - **$150 for two**: $75, $150, $250, or Custom. The budget is for the whole party.
  - **Walking**: Walk, Subway or Bike, which map to `WALK`, `TRANSIT` and `BICYCLE`. No rideshare or taxi.
  - Once a chip is changed, show it as selected (accent border and text).
- "Use my location" asks for browser geolocation and fills in the area.
- After submit (not designed; suggested):
  - Stream the response over SSE (see `src/api/plan-stream.ts`).
  - Show the parsed intent as tags under the composer.
  - Replace each placeholder card with an itinerary as it passes validation. Each itinerary shows timed stops, a one-line reason for each stop, travel legs, a total and the actions.
- Focus: `:focus-visible` shows a 2px accent outline with a 2px offset. The textarea has no outline; the composer's ring is its focus indicator. You can make the ring stronger on `:focus-within` (accent instead of accent-700).
- Hover and pressed states for `.btn-*` come from `base.css`. Secondary buttons tint with text at 7% (14% when pressed); primary buttons tint with accent at 12% (22% when pressed).
- Responsive: below about 900px, drop the H1 to about 48px and the horizontal padding to 24px. Let the toolbar wrap, with the primary button full width. The results grid already collapses.
- Keyboard: Cmd/Ctrl+Enter in the textarea should submit.

## State
- `text`: string
- `when`, `budgetUsd`, `travelMode`: chip overrides; when unset, defer to what the parser reads from the text
- `status`: idle | streaming | done | error
- `intent`: the parsed intent
- `options[]`: the itineraries
- `now`: a clock that ticks every 30 s

## Design tokens (Wine palette)
- **Ground and text**:
  - bg `#150b0f`
  - surface `#23161c`
  - text `#f3ecef`
  - muted text: text at 55%
  - divider: text at 16%
- **Accent** `#d6778a`, ramp from 100 to 900:
  - `#ffedf1` `#ffd8e0` `#ffb9c8` `#f69dad` `#dd7d90` `#b66374` `#8e4c59` `#633a41` `#3b2428`
- **Neutral**, ramp from 100 to 900:
  - `#ffeef8` `#f7e1ea` `#e3ced7` `#c9b4bd` `#ac98a1` `#8d7a82` `#705d65` `#53424a` `#36262d`
- **Shadows**:
  - sm: `0 0 0 1px #4d4549`
  - md: `0 0 0 1px #696164, 0 6px 18px rgba(0,0,0,.55)`
- **Type**: Inter (Google Fonts, weights 400 and 500). Headings use weight 500 and never go bolder. Base text is 15px with line-height 1.55.
- **Spacing scale**: 2.8, 5.6, 8.4, 11.2, 16.8 and 22.4px. Layout values on this page: 20, 28, 32, 40, 56, 64, 72 and 104px.
- **Radius**: 4px (sm), 8px (md, buttons), 14px (lg, cards and composer).
- **Buttons** (`.btn`): Inter 500, 14px, padding 5.6px 10px, radius 8px. Primary buttons are outlined, never filled.

## Assets
Icons come from Phosphor (`@phosphor-icons/react`): `MagnifyingGlass` and `ArrowRight`, regular weight, sized 16px and 18px. There are no images.

## Files
- `Home.dc.html`: the design reference (open it in a browser)
- `base.css`: the base token and component stylesheet the reference loads
