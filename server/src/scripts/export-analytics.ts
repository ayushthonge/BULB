/**
 * Export longitudinal research data for offline analysis (the RQ3 / discourse /
 * artifact analyses the reviewers asked for).
 *
 * Writes three files into the output directory (default ./export):
 *   - analytics-summary.json : the aggregate dashboard (getAnalytics)
 *   - query-summaries.jsonl  : one JSON object per resolved query, including the
 *                              full misconception trajectory + passive metrics
 *   - turns.csv              : per-turn rows for quantitative / discourse analysis
 *
 * Usage: npm run export-analytics [outDir]
 */

import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { pool } from '../db';
import { getAnalytics } from '../analytics';

const CSV_COLUMNS = [
    'session_id', 'query_id', 'turn_index', 'intent', 'strategy',
    'targeted_misconception', 'classifier_certainty',
    'misconception_confidence_before', 'misconception_confidence_after',
    'misconception_resolved', 'hint_level', 'learner_confidence',
    'resolution_score', 'resolution_status', 'tokens_in', 'tokens_out', 'created_at',
];

function csvCell(v: any): string {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
    const outDir = path.resolve(process.argv[2] || './export');
    mkdirSync(outDir, { recursive: true });

    console.log('Computing aggregate analytics...');
    const analytics = await getAnalytics();
    writeFileSync(path.join(outDir, 'analytics-summary.json'), JSON.stringify(analytics, null, 2));

    console.log('Exporting query summaries...');
    const summaries = await pool.query(
        `SELECT s.session_id, s.query_id, s.user_id, s.summary, s.created_at, t.label
         FROM query_summaries s
         LEFT JOIN query_training_data t
           ON t.session_id = s.session_id AND t.query_id = s.query_id
         ORDER BY s.created_at ASC`
    );
    const jsonl = summaries.rows
        .map(r => JSON.stringify({
            session_id: r.session_id,
            query_id: r.query_id,
            user_id: r.user_id,
            label: r.label,
            created_at: r.created_at,
            summary: typeof r.summary === 'string' ? JSON.parse(r.summary) : r.summary,
        }))
        .join('\n');
    writeFileSync(path.join(outDir, 'query-summaries.jsonl'), jsonl);

    console.log('Exporting per-turn rows...');
    const turns = await pool.query(
        `SELECT ${CSV_COLUMNS.join(', ')} FROM query_turns ORDER BY created_at ASC`
    );
    const header = CSV_COLUMNS.join(',');
    const body = turns.rows.map(row => CSV_COLUMNS.map(c => csvCell(row[c])).join(',')).join('\n');
    writeFileSync(path.join(outDir, 'turns.csv'), header + '\n' + body);

    console.log(`\nDone. Wrote to ${outDir}:`);
    console.log(`  analytics-summary.json`);
    console.log(`  query-summaries.jsonl   (${summaries.rows.length} queries)`);
    console.log(`  turns.csv               (${turns.rows.length} turns)`);

    await pool.end();
}

main().catch(async err => {
    console.error('Export failed:', err?.message);
    try { await pool.end(); } catch { /* ignore */ }
    process.exit(1);
});
