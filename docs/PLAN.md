# Socratic AI — Production Hardening Plan

> Branch: `socratic-production-hardening` · Restore point: tag `baseline-pre-hardening`
> Revert anytime with `git checkout baseline-pre-hardening` (the original `ayush` branch is untouched).

## 1. Goal

Socratic AI is a VS Code tutor that helps CS students **without ever giving a direct answer** —
it asks the right questions to lead them to resolve their own query. The system tracks
"misconceptions" with per-turn confidence and persists on conceptual gaps across turns
(see `_ITiCSE_2026__SocraticAI.pdf`).

This plan addresses four explicit weaknesses, all confirmed by the user request and by the
peer-review feedback:

1. **Guardrails beyond prompt engineering** — deterministic enforcement that the tutor never
   leaks a solution, code, fix, or explanation, and resists prompt-injection / "just give me
   the answer" coercion.
2. **Automatic query-resolution tracking** — detect, from signals already available, when a
   query is effectively resolved (the student articulated understanding / the targeted
   misconceptions decayed) instead of relying only on a manual "I Understand" button.
3. **Low token cost** — cut per-turn token usage without losing classification quality.
4. **Production / deployment readiness** — durable state, hardening, analytics, deploy config.

The peer reviews additionally ask for: rigorous + documented confidence/threshold logic
(Reviewer 1), strong system-log analytics to quantify misconception persistence/decay/recurrence
(Reviewer 2 & 3), and a "bail-out" path for frustrated students (Reviewer 4). All are folded in.

## 2. Architecture (target)

```
VS Code Extension (no pedagogical logic)
   │  message + selected code (≤60 lines)
   ▼
Fastify server  ──────────────────────────────────────────────────────────────┐
   1. authenticate (token, cached)                                              │
   2. rateLimit (per-user + global)                                             │
   3. inputGuard      ── deterministic; blocks injection/abuse, NO LLM call ────┤  zero-token
   4. intent + learner-confidence heuristics (regex)                            │  fast paths
   5. classifier  (Gemini) ── compact taxonomy + candidate pre-filter ──────────┤
   6. misconception state update (bounded deltas, decay, resolution threshold)  │
   7. resolution detector ── combines state + articulation + confidence ────────┤  NO extra LLM
   8. strategy + hint-level selection                                           │
   9. generator   (Gemini) ── single Socratic question ─────────────────────────┤
  10. outputGuard ── rejects code/fix/explanation/multi-question; regen or fall  │
  11. persist (turns, state, metrics) + respond                                 │
   └────────────────────────────────────────────────────────────────────────────┘
   ▼
Neon Postgres  (whitelist, sessions, turns, summaries, training data, metrics)
```

## 3. Workstreams

### Phase 1 — Guardrails (the core "no direct answers" guarantee)
- `config.ts`: one typed, validated config object (models, thresholds, toggles, NODE_ENV).
- `guards/inputGuard.ts`: detect prompt-injection / jailbreak / role-override / "just give the
  answer" coercion → canned Socratic redirect, **no LLM call** (saves tokens + blocks attacks).
- `guards/outputGuard.ts`: strengthen `hardValidateQuestion` into a full Socratic validator —
  reject code, imperative fixes ("change X to Y", "you should", "use a…"), declarative answers,
  multi-question, step lists, explanations, over-length, and near-duplicates. On violation:
  regenerate with stricter instruction; after N tries, deterministic safe fallback question.
- Wire both into `/chat`. Unit tests (node:test) over adversarial inputs/outputs.

### Phase 2 — Automatic resolution tracking
- `resolution.ts`: pure function → `{ status: active|likely_resolved|resolved, score, signals[] }`
  from existing signals (targeted misconceptions cleared, sustained high learner confidence,
  self-correction / "now I get it" articulation, explicit understanding). **No extra LLM call.**
- On `likely_resolved`: tutor's next move becomes a reflective *confirmation* prompt and the
  response flags it so the extension can surface a soft "Did that resolve it?" affordance.
- Persist `resolution_score` + `resolution_signals` per turn (migration `002`).
- Frustration / bail-out signal: when stuck/frustrated for several turns, escalate hint level
  and offer a non-answer off-ramp (re-frame, suggest a tiny experiment, or pointer to a human),
  never the solution.

### Phase 3 — Token optimization
- Compact taxonomy serialization (one line per id; drop verbose JSON + examples by default).
- Candidate pre-filter: classify only against {currently active} ∪ {keyword-matched} ∪ {paper
  core set}, not all 16 — typically 3–6 entries. Full-taxonomy fallback behind a flag.
- Tighter `maxOutputTokens`; all model names + caps configurable. Optional Gemini context-cache
  scaffold (env-gated, graceful fallback). Per-turn token deltas already tracked → measure.

### Phase 4 — Durability & hardening
- Auth token→user cache (TTL) to avoid a DB hit per request.
- DB-backed session/query **state rehydration** so restarts/redeploys don't lose learner state
  (in-memory LRU + Postgres persistence; no Redis dependency).
- Sanitize 500s in production (no stack traces to client). Fail-fast config validation on boot.
- Real `/health` (DB ping + key presence) + `/ready`. Graceful shutdown (drain pool).

### Phase 5 — Extension UX
- Auto-surface resolution affordance when the server flags `likely_resolved`.
- Frustration/bail-out messaging; clearer guard messages.
- Harden `renderMessage` (escape before markdown) — defense-in-depth on the webview.

### Phase 6 — Research analytics (serves reviewers' RQ3)
- Admin analytics endpoint + export script computing misconception persistence, decay curves,
  resolution rate, recurrence across queries, and depth-of-questioning per session.

### Phase 7 — Deployment
- Dockerfile, deploy config, idempotent migration runner (`npm run migrate`), `.env.example`
  refresh, `README` + `DEPLOYMENT.md` + `ARCHITECTURE.md`.

### Phase 8 — Verify
- `tsc` builds clean (server + extension), full test run green, final push.

## 4. Tunable thresholds (documented for replicability — Reviewer 1)

| Name | Value | Meaning |
|------|-------|---------|
| `NEUTRAL_CONFIDENCE` | 0.32 | starting confidence for a newly seen misconception |
| `DELTA_UP` | 0.22 | increment when a misconception is *reinforced* |
| `DELTA_DOWN` | 0.18 | decrement when *weakened* |
| `DECAY` | 0.90 | per-turn multiplicative decay for un-mentioned misconceptions |
| `RESOLUTION_THRESHOLD` | 0.18 | below this a misconception is considered resolved |
| `RESOLVE_CONFIRM_SCORE` | 0.70 | resolution score that triggers a confirmation prompt |
| `FRUSTRATION_TURNS` | 3 | consecutive low-progress turns before offering an off-ramp |

All values live in `config.ts` and are overridable via environment variables so the deployment
and the paper's reported settings stay in sync.
```
