/**
 * Research analytics over the system logs.
 *
 * The peer reviews of the paper asked specifically for quantified evidence of
 * misconception persistence, decay, resolution, and — for RQ3 — recurrence of
 * targeted errors. This module computes those aggregates straight from the
 * tables the pipeline already writes, so the deployment doubles as the data
 * collection instrument. Each query is defensive (empty tables -> zeros) and
 * read-only.
 */

import { pool } from './db';

export interface Analytics {
    generated_at: string;
    overview: {
        sessions: number;
        users: number;
        queries: number;
        turns: number;
        tokens_in: number;
        tokens_out: number;
        avg_tokens_per_turn: number;
    };
    resolution: {
        auto_resolved: number;
        user_resolved: number;
        resolved_total: number;
        unresolved_or_open: number;
        resolution_rate: number | null;
    };
    pedagogy: {
        avg_turns_per_query: number;
        avg_max_hint_level: number;
        avg_direct_answer_pct: number;
        avg_reasoning_pct: number;
    };
    misconceptions: {
        id: string;
        queries_targeted: number;
        turns_targeted: number;
        resolution_events: number;
        per_misconception_resolution_rate: number | null;
    }[];
    recurrence: {
        resolved_user_misconception_pairs: number;
        recurred_pairs: number;
        recurrence_rate: number | null;
        note: string;
    };
}

async function safeRow<T>(sql: string, fallback: T): Promise<T> {
    try {
        const r = await pool.query(sql);
        return (r.rows[0] as T) ?? fallback;
    } catch (e: any) {
        console.warn('[analytics] query failed:', e?.message);
        return fallback;
    }
}

async function safeRows<T>(sql: string): Promise<T[]> {
    try {
        const r = await pool.query(sql);
        return r.rows as T[];
    } catch (e: any) {
        console.warn('[analytics] query failed:', e?.message);
        return [];
    }
}

const num = (v: any): number => (v === null || v === undefined ? 0 : Number(v));
const rate = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);

export async function getAnalytics(): Promise<Analytics> {
    const overview = await safeRow<any>(
        `SELECT
            (SELECT COUNT(*) FROM misconception_sessions) AS sessions,
            (SELECT COUNT(DISTINCT user_id) FROM misconception_sessions WHERE user_id IS NOT NULL) AS users,
            (SELECT COUNT(DISTINCT query_id) FROM query_turns) AS queries,
            (SELECT COUNT(*) FROM query_turns) AS turns,
            (SELECT COALESCE(SUM(tokens_in), 0) FROM query_turns) AS tokens_in,
            (SELECT COALESCE(SUM(tokens_out), 0) FROM query_turns) AS tokens_out`,
        {}
    );

    const labels = await safeRows<{ label: string; n: string }>(
        `SELECT label, COUNT(*)::int AS n FROM query_training_data GROUP BY label`
    );
    const auto = num(labels.find(l => l.label === 'auto_resolved')?.n);
    const user = num(labels.find(l => l.label === 'resolved_by_user')?.n);
    const totalQueries = num(overview.queries);
    const resolvedTotal = auto + user;

    const depth = await safeRow<any>(
        `SELECT AVG(turn_count)::numeric(10,2) AS avg_turns, AVG(max_hint)::numeric(10,2) AS avg_max_hint
         FROM (
             SELECT query_id, COUNT(*) AS turn_count, MAX(hint_level) AS max_hint
             FROM query_turns GROUP BY query_id
         ) q`,
        {}
    );

    const pcts = await safeRow<any>(
        `SELECT AVG(direct_answer_pct)::numeric(10,2) AS direct, AVG(reasoning_pct)::numeric(10,2) AS reasoning
         FROM misconception_sessions`,
        {}
    );

    const misconceptions = await safeRows<any>(
        `SELECT targeted_misconception AS id,
                COUNT(DISTINCT query_id)::int AS queries_targeted,
                COUNT(*)::int AS turns_targeted,
                SUM(CASE WHEN misconception_resolved THEN 1 ELSE 0 END)::int AS resolution_events
         FROM query_turns
         WHERE targeted_misconception IS NOT NULL
         GROUP BY targeted_misconception
         ORDER BY turns_targeted DESC`
    );

    const recurrence = await safeRow<any>(
        `WITH turns AS (
             SELECT qt.query_id, qt.targeted_misconception AS mc,
                    qt.misconception_resolved AS resolved, qt.created_at AS ts, s.user_id
             FROM query_turns qt
             JOIN misconception_sessions s ON s.session_id = qt.session_id
             WHERE qt.targeted_misconception IS NOT NULL AND s.user_id IS NOT NULL
         ),
         res AS (
             SELECT user_id, mc, MIN(ts) AS resolved_ts
             FROM turns WHERE resolved = true GROUP BY user_id, mc
         )
         SELECT
             COUNT(*)::int AS resolved_pairs,
             COUNT(*) FILTER (WHERE EXISTS (
                 SELECT 1 FROM turns t
                 WHERE t.user_id = res.user_id AND t.mc = res.mc AND t.ts > res.resolved_ts
             ))::int AS recurred_pairs
         FROM res`,
        { resolved_pairs: 0, recurred_pairs: 0 }
    );

    const turns = num(overview.turns);
    const tokensTotal = num(overview.tokens_in) + num(overview.tokens_out);

    return {
        generated_at: new Date().toISOString(),
        overview: {
            sessions: num(overview.sessions),
            users: num(overview.users),
            queries: totalQueries,
            turns,
            tokens_in: num(overview.tokens_in),
            tokens_out: num(overview.tokens_out),
            avg_tokens_per_turn: turns > 0 ? Math.round((tokensTotal / turns) * 10) / 10 : 0,
        },
        resolution: {
            auto_resolved: auto,
            user_resolved: user,
            resolved_total: resolvedTotal,
            unresolved_or_open: Math.max(0, totalQueries - resolvedTotal),
            resolution_rate: rate(resolvedTotal, totalQueries),
        },
        pedagogy: {
            avg_turns_per_query: num(depth.avg_turns),
            avg_max_hint_level: num(depth.avg_max_hint),
            avg_direct_answer_pct: num(pcts.direct),
            avg_reasoning_pct: num(pcts.reasoning),
        },
        misconceptions: misconceptions.map(m => ({
            id: m.id,
            queries_targeted: num(m.queries_targeted),
            turns_targeted: num(m.turns_targeted),
            resolution_events: num(m.resolution_events),
            per_misconception_resolution_rate: rate(num(m.resolution_events), num(m.queries_targeted)),
        })),
        recurrence: {
            resolved_user_misconception_pairs: num(recurrence.resolved_pairs),
            recurred_pairs: num(recurrence.recurred_pairs),
            recurrence_rate: rate(num(recurrence.recurred_pairs), num(recurrence.resolved_pairs)),
            note: 'recurrence_rate = share of (user, misconception) pairs that were re-targeted in a later turn after first dropping below the resolution threshold (RQ3 signal).',
        },
    };
}
