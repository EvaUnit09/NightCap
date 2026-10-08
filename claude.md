# Nightcap

AI-powered web app that turns a natural language request into 2 to 3
complete night-out itineraries (venues, timing, budget, travel) for
dates or friend hangouts. NYC first. Portfolio project.

## Context
- Full-stack web app with AI observability (Datadog)
- Solo build; friends act as beta users
- Venues must come from real data. Never let the LLM invent places.

## Documentation rules
- ALL documentation lives in docs/. Never put planning docs in the repo root.
- docs/scope.md is the source of truth. Fill it in section by section.
  Update it in place; do not create v2 copies.
- Record key choices and trade-offs in docs/decision-log.md
  (date, decision, alternatives, reason).
- Architecture notes and diagrams go in docs/architecture.md.
- In plan mode you cannot write files. After the plan is approved,
  write or update the docs before writing any code.

## Planning workflow
1. Read docs/scope.md fully before asking anything.
2. Interview me one section at a time, in template order.
3. Ask 3 to 5 questions per round. Prefer multiple choice with your
   recommended default marked, so I can answer quickly.
4. Push back on vague answers, especially success metrics. Ask how a
   metric would be measured on a test set.
5. Skip sections that do not apply (fine-tuning, maybe agents), but
   ask me first and log the reason in the decision log.
6. Do not start implementation until I say the scope is done.
