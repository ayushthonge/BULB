# Socratic AI

A VS Code tutor for programming students that **helps by asking questions, never
by giving answers.** It keeps a stateful model of the misconceptions a learner is
exhibiting and persists on them across turns until they resolve — scaffolding
productive struggle instead of short-circuiting it.

Based on the ITiCSE 2026 paper *“A Good Rubber Duck Does Not Quack: Designing
Socratic Scaffolding in AI Tutors.”*

## Why this design

LLM coding assistants are optimized to hand over solutions, which undermines the
struggle that conceptual learning requires. Socratic AI instead:

- **withholds answers by construction** — the model is an *untrusted generator*
  whose every output is validated to be a single short question with no code,
  fix, or explanation;
- **tracks misconceptions statefully** — bounded confidence updates per turn, so
  the tutor keeps probing a real conceptual gap rather than accepting surface
  correctness;
- **knows when it's done** — it automatically detects when a query is resolved
  (or when a learner is stuck) from signals it already has.

## Repository layout

```
server/      Fastify pedagogical service (all instructional logic) + Gemini + Postgres
extension/   VS Code extension (UI only; no pedagogical reasoning)
docs/        PLAN.md, ARCHITECTURE.md, DEPLOYMENT.md
```

## Quickstart

```bash
# server
cd server && cp .env.example .env      # set GEMINI_API_KEY + DATABASE_URL
npm install && npm run migrate
npm run dev                            # http://localhost:3000  (GET /health)
npm test                               # unit tests for guards / resolution / model

# extension
cd ../extension && npm install && npm run compile
# press F5 in VS Code to launch the Extension Development Host
```

## Key capabilities

- **Guardrails beyond prompting** — a deterministic input guard (prompt-injection
  / jailbreak / system-probe) and output guard (no code / fix / explanation /
  multi-question / duplicates), both unit-tested.
- **Automatic resolution tracking** — derived from existing signals, with a
  reflective-confirmation affordance, an auto-close fast path, and a non-answer
  off-ramp for frustrated learners.
- **Low token cost** — candidate-filtered compact taxonomy (~89% smaller
  classifier block) plus model-call-free fast paths.
- **Production-ready** — central validated config, durable state with restart
  recovery, auth caching, graceful shutdown, real health check, Docker + Render
  deploy, idempotent migrations.
- **Research analytics** — `/admin/analytics` + an export script for misconception
  persistence / decay / resolution / recurrence and questioning depth.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it works and
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) to deploy.

## Configuration & thresholds

Everything tunable lives in `server/src/config.ts` and is overridable via
environment variables (see `server/.env.example`). Pedagogical thresholds are
documented in [docs/PLAN.md](docs/PLAN.md).

## Reverting

All of the production-hardening work is on the `socratic-production-hardening`
branch. Restore the pre-hardening state with `git checkout baseline-pre-hardening`
(tag) or `git checkout ayush` (the original branch, untouched).
