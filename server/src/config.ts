/**
 * Centralized, validated application configuration.
 *
 * Every tunable in the system is read here exactly once, given a documented
 * default, and exposed as a typed, frozen object. This keeps the pedagogical
 * thresholds reported in the paper in lock-step with what actually runs, and
 * lets deployments override behaviour purely through environment variables.
 *
 * Import `config` for values. Call `validateConfig()` at boot to fail fast in
 * production when a required secret is missing.
 */

import dotenv from 'dotenv';

dotenv.config();

function envStr(key: string, fallback: string): string {
    const v = process.env[key];
    return v === undefined || v === '' ? fallback : v;
}

function envInt(key: string, fallback: number): number {
    const v = process.env[key];
    if (v === undefined || v === '') return fallback;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
}

function envFloat(key: string, fallback: number): number {
    const v = process.env[key];
    if (v === undefined || v === '') return fallback;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
    const v = process.env[key];
    if (v === undefined || v === '') return fallback;
    return !/^(false|0|no|off)$/i.test(v.trim());
}

const nodeEnv = (envStr('NODE_ENV', 'development').toLowerCase()) as
    | 'development'
    | 'production'
    | 'test';

export interface AppConfig {
    nodeEnv: 'development' | 'production' | 'test';
    isProd: boolean;
    isTest: boolean;
    port: number;
    host: string;
    corsOrigin: string;
    enableWhitelist: boolean;

    gemini: {
        apiKey: string;
        classifierModel: string;
        generatorModel: string;
        summaryModel: string;
        classifierMaxTokens: number;
        generatorMaxTokens: number;
        summaryMaxTokens: number;
        generatorRetries: number;
    };

    rateLimit: {
        windowMs: number;
        perUser: number;
        global: number;
    };

    context: {
        maxChars: number;
        maxLines: number;
        summaryMaxInput: number;
    };

    /** Pedagogical thresholds — see docs/PLAN.md §4 and the paper §4.4. */
    thresholds: {
        neutralConfidence: number;
        deltaUp: number;
        deltaDown: number;
        decay: number;
        resolutionThreshold: number;
        /** Resolution score (0-1) at which the tutor asks the learner to confirm. */
        resolveConfirmScore: number;
        /** Resolution score at which the query may auto-resolve without a prompt. */
        resolveAutoScore: number;
        /** Consecutive low-progress turns before offering a non-answer off-ramp. */
        frustrationTurns: number;
    };

    classifier: {
        /** Emit a compact one-line-per-misconception taxonomy instead of full JSON. */
        compactTaxonomy: boolean;
        /** Only classify against active + keyword-matched + core misconceptions. */
        candidatePreFilter: boolean;
        /** Hard cap on candidate misconceptions sent to the classifier. */
        maxCandidates: number;
    };

    /** TTL for the in-memory token->user auth cache (ms). 0 disables caching. */
    authCacheTtlMs: number;
    /** Max sessions held in the in-memory state cache before LRU eviction. */
    stateCacheMax: number;
    /**
     * When true, a query that reaches the auto-resolution bar is finalized
     * automatically (and the generator call is skipped). When false, the same
     * situation only prompts the learner to confirm, preserving full agency.
     */
    autoResolveEnabled: boolean;
}

export const config: AppConfig = Object.freeze({
    nodeEnv,
    isProd: nodeEnv === 'production',
    isTest: nodeEnv === 'test',
    port: envInt('PORT', 3000),
    host: envStr('HOST', '0.0.0.0'),
    corsOrigin: envStr('CORS_ORIGIN', '*'),
    enableWhitelist: envBool('ENABLE_WHITELIST', true),

    gemini: {
        apiKey: envStr('GEMINI_API_KEY', ''),
        classifierModel: envStr('GEMINI_CLASSIFIER_MODEL', 'gemini-2.5-flash-lite'),
        generatorModel: envStr('GEMINI_GENERATOR_MODEL', 'gemini-2.5-flash-lite'),
        summaryModel: envStr('GEMINI_SUMMARY_MODEL', 'gemini-2.5-flash-lite'),
        classifierMaxTokens: envInt('GEMINI_CLASSIFIER_MAX_TOKENS', 448),
        generatorMaxTokens: envInt('GEMINI_GENERATOR_MAX_TOKENS', 80),
        summaryMaxTokens: envInt('GEMINI_SUMMARY_MAX_TOKENS', 350),
        generatorRetries: envInt('GEMINI_GENERATOR_RETRIES', 2),
    },

    rateLimit: {
        windowMs: envInt('RATE_LIMIT_WINDOW_MS', 60000),
        perUser: envInt('RATE_LIMIT_PER_USER', 10),
        global: envInt('RATE_LIMIT_GLOBAL', 15),
    },

    context: {
        maxChars: envInt('MAX_CONTEXT_CHARS', 24000),
        maxLines: envInt('MAX_CONTEXT_LINES', 60),
        summaryMaxInput: envInt('SUMMARY_MAX_INPUT', 8000),
    },

    thresholds: {
        neutralConfidence: envFloat('MC_NEUTRAL_CONFIDENCE', 0.32),
        deltaUp: envFloat('MC_DELTA_UP', 0.22),
        deltaDown: envFloat('MC_DELTA_DOWN', 0.18),
        decay: envFloat('MC_DECAY', 0.9),
        resolutionThreshold: envFloat('MC_RESOLUTION_THRESHOLD', 0.18),
        resolveConfirmScore: envFloat('RESOLVE_CONFIRM_SCORE', 0.7),
        resolveAutoScore: envFloat('RESOLVE_AUTO_SCORE', 0.9),
        frustrationTurns: envInt('FRUSTRATION_TURNS', 3),
    },

    classifier: {
        compactTaxonomy: envBool('CLASSIFIER_COMPACT_TAXONOMY', true),
        candidatePreFilter: envBool('CLASSIFIER_CANDIDATE_PREFILTER', true),
        maxCandidates: envInt('CLASSIFIER_MAX_CANDIDATES', 8),
    },

    authCacheTtlMs: envInt('AUTH_CACHE_TTL_MS', 60000),
    stateCacheMax: envInt('STATE_CACHE_MAX', 500),
    autoResolveEnabled: envBool('AUTO_RESOLVE_ENABLED', true),
});

/**
 * Validate required configuration. In production a missing secret is fatal
 * (process exits) so a misconfigured deploy never silently serves degraded
 * traffic. In development/test we only warn so the suite and local hacking
 * keep working without real credentials.
 */
export function validateConfig(): { ok: boolean; problems: string[] } {
    const problems: string[] = [];

    if (!config.gemini.apiKey) {
        problems.push('GEMINI_API_KEY is missing — model calls will be skipped/fallback only.');
    }
    if (!process.env.DATABASE_URL) {
        problems.push('DATABASE_URL is missing — persistence and auth lookups will fail.');
    }
    if (config.enableWhitelist && !process.env.DATABASE_URL) {
        problems.push('ENABLE_WHITELIST is on but DATABASE_URL is missing — all requests will 401.');
    }

    const ok = problems.length === 0;

    if (!ok) {
        const header = `[config] ${problems.length} configuration problem(s) detected:`;
        if (config.isProd) {
            console.error(header);
            problems.forEach(p => console.error('  - ' + p));
            console.error('[config] Refusing to start in production with invalid configuration.');
            process.exit(1);
        } else {
            console.warn(header);
            problems.forEach(p => console.warn('  - ' + p));
        }
    }

    return { ok, problems };
}
