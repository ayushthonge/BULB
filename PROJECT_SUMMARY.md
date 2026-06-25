# Socratic AI — Project Summary

> **This file is superseded.** The previous summary described an earlier
> iteration (Supabase, Prometheus `/metrics`, `systemPrompt.ts`, disabled auth)
> that no longer reflects the codebase. For accurate, current documentation see:
>
> - [README.md](README.md) — overview & quickstart
> - [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the system works (pipeline,
>   guardrails, misconception/confidence model, resolution detection, data model)
> - [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — production deployment
> - [docs/PLAN.md](docs/PLAN.md) — hardening plan & documented thresholds

## One-paragraph summary

Socratic AI is a VS Code extension plus a Fastify pedagogical service that tutors
programming students with Socratic questioning and **never** hands over answers.
The server (the only place pedagogical decisions are made) classifies each
learner utterance against a misconception taxonomy using Google Gemini, maintains
a stateful per-misconception confidence model with bounded updates, enforces
Socratic constraints on every generated question via deterministic guards, and
automatically tracks when a query is resolved. State and longitudinal research
data persist in Postgres (Neon).
