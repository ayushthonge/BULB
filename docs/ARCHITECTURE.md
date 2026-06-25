# Socratic AI — Architecture

A VS Code tutor that helps CS students **by asking questions, never by giving
answers**. It maintains a stateful model of which programming misconceptions a
learner is exhibiting and persists on them across turns until they resolve.

This document describes the implementation as it actually runs (it also fills
the "explain how classification / confidence / thresholds work" gap the paper
reviewers flagged).

## Components

```
┌────────────────────────┐         ┌─────────────────────────────────────────┐
│  VS Code extension      │  HTTPS  │  Fastify server (pedagogical service)     │
│  (no pedagogical logic) │ ──────► │  all instructional decisions live here    │
│  - captures ≤60 lines   │         │                                           │
│  - renders one question │         │  ┌─────────────────────────────────────┐  │
│  - resolution/frustration│        │  │ Gemini (untrusted generator)        │  │
│    affordances          │ ◄────── │  │  classifier + question generator     │  │
└────────────────────────┘  JSON   │  └─────────────────────────────────────┘  │
                                    └───────────────┬───────────────────────────┘
                                                    │
                                            Neon Postgres
                              (whitelist, sessions, turns, state, summaries,
                               training data, request metrics)
```

The extension performs **no** pedagogical reasoning. It sends the user message
plus an optional selected code region (capped at 60 lines) and renders exactly
what the server returns. This keeps instructional behaviour stable across IDEs
and model changes, and lets the server treat the LLM as an *untrusted generator*
whose every output is validated.

## Per-turn pipeline (`POST /chat`)

1. **authenticate** — bearer token → whitelist row, with a short-lived in-memory
   cache so Postgres isn't hit every request (`auth.ts`).
2. **rateLimit** — per-user + global windows protect the Gemini quota (`rateLimit.ts`).
3. **input guard** *(deterministic, zero-token)* — blocks prompt-injection,
   jailbreak, and system-prompt probing with a fixed Socratic redirect and no
   model call. Ordinary "just tell me the answer" frustration is **not** blocked
   here; it flows on and is handled pedagogically (`guards/inputGuard.ts`).
4. **intent + learner-confidence heuristics** — regex signals classify the turn
   (solution_request / debugging / conceptual / clarification / off_topic) and
   nudge a running learner-confidence value (`misconceptions.ts`).
5. **classifier** *(Gemini)* — compares the utterance against the previous
   question, code context, and a **candidate-filtered, compact** taxonomy, and
   returns per-misconception verdicts (`reinforced` / `weakened` / `new` /
   `absent`) with certainty + rationale (`gemini.ts`, `classifyMisconceptions`).
6. **state update** — bounded confidence deltas + decay; below-threshold
   misconceptions emit resolution events (`applyVerdicts`).
7. **resolution / frustration assessment** *(derived, no extra model call)* —
   combines cleared/decayed misconceptions, explicit understanding, articulated
   cause, and sustained confidence into a resolution score + action
   (`resolution.ts`).
8. **strategy + generator** *(Gemini)* — picks a pedagogical move (diagnostic /
   narrowing / conceptual-contrast / reflective), then generates ONE question.
   On a likely-resolved turn the strategy biases to a reflective close; a
   frustrated learner is pushed to the most concrete (still non-answer) hint.
   The **auto-resolve fast path skips the generator entirely** (token saving).
9. **output guard** *(deterministic)* — the candidate question must be a single
   short question with no code, fix, explanation, answer reveal, step list, or
   near-duplicate. On failure the generator is re-prompted with the specific
   violation; after N tries a safe fallback question is used
   (`guards/outputGuard.ts`).
10. **persist + respond** — turn, metrics, and a durable working-state snapshot
    are written; the response carries the question plus a `resolution` block for
    the UI.

## Misconception confidence model

Each misconception has a confidence in `[0,1]` (the system's estimate that it is
currently active). After each turn (`applyVerdicts`):

| Verdict | Update |
|---------|--------|
| `reinforced` | `c → c + DELTA_UP` |
| `weakened` | `c → c − DELTA_DOWN` |
| `new` | `c → NEUTRAL + DELTA_UP/2` |
| `absent` / unmentioned | `c → c × DECAY` |

When `c < RESOLUTION_THRESHOLD` the misconception is removed and a resolution
event fires. Updates are small and bounded so weak/noisy signals accumulate
gradually rather than flipping the tutor's focus turn to turn. Defaults:
`NEUTRAL=0.32, DELTA_UP=0.22, DELTA_DOWN=0.18, DECAY=0.9, RESOLUTION=0.18`
(all env-overridable via `config.ts`).

## Automatic resolution detection (`resolution.ts`)

A weighted, documented heuristic — **not** a calibrated probability — produces a
score in `[0,1]` and one of three actions:

- `continue` — keep probing.
- `confirm_resolution` (score ≥ `RESOLVE_CONFIRM_SCORE`) — the tutor closes with
  a reflective question and the UI surfaces a soft "mark resolved?" affordance.
- `auto_resolve` (score ≥ `RESOLVE_AUTO_SCORE`, gated on explicit understanding +
  cleared state) — the query is finalized automatically and the generator call
  is skipped.

It also raises a `frustration` flag after `FRUSTRATION_TURNS` low-progress turns
so the UI can offer a non-answer off-ramp.

## Token-cost strategy

- **Compact taxonomy**: one line per misconception instead of full JSON+examples.
- **Candidate pre-filter**: classify only `{active} ∪ {keyword-matched} ∪ {core}`
  misconceptions (typically 3–6 of 16). Measured ~89% smaller taxonomy block.
- **Fast paths with no model call**: off-topic redirect, input-guard block, and
  auto-resolve all short-circuit before/around the generator.
- Everything (models, token caps, toggles) is env-configurable.
- *Future*: Gemini explicit context caching for the static instruction block —
  left as a documented toggle; the prefilter already removes most of the cost.

## Data model (Postgres)

`whitelist_users`, `misconception_sessions`, `query_turns` (full per-turn record
incl. verdicts, deltas, resolution score/status/signals), `query_state` (durable
working state for restart recovery), `query_summaries` + `query_training_data`
(longitudinal trajectories, labelled auto vs user resolution), `request_metrics`.
See `server/src/scripts/migrate.sql`.

## Durability

In-memory session state is an LRU-bounded cache; the live pedagogical state of
each query is written through to `query_state`, so a restart or eviction
rehydrates an in-flight conversation. Session creation is an idempotent upsert,
so client reconnects after a redeploy are safe.

## Research analytics

`GET /admin/analytics` and `npm run export-analytics` compute/export misconception
persistence, decay, resolution rates, **recurrence** (RQ3), questioning depth,
and token usage from the logs (`analytics.ts`).
