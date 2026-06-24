
import Fastify from 'fastify';
import cors from '@fastify/cors';
import dotenv from 'dotenv';
import { authenticate, requireAdmin, AuthenticatedRequest } from './auth';
import { rateLimit } from './rateLimit';
import { recordRequestMetric } from './telemetry';

dotenv.config();

const fastify = Fastify({
    logger: true,
    bodyLimit: 256 * 1024 // cap payload size to ~256KB to avoid oversized context uploads
});

const enableWhitelist = process.env.ENABLE_WHITELIST !== 'false';
const authPreHandlers = enableWhitelist ? [authenticate, rateLimit] : [rateLimit];

fastify.register(cors, {
    origin: process.env.CORS_ORIGIN || '*'
});

import { classifyMisconceptions, generateSocraticQuestion, generateCodeContextSummary } from './gemini';
import {
    applyVerdicts,
    chooseStrategy,
    createSessionState,
    detectLearnerSignals,
    inferIntentAndConfidence,
    MessageIntent,
    NEUTRAL_CONFIDENCE,
    pickTopMisconception,
    pickTopMisconceptions,
    sanitizeUserInput,
    snapshotState,
    randomSessionId
} from './misconceptions';
import { assessResolution, ResolutionState } from './resolution';
import { dbInsert, dbUpdate, pool } from './db';
import { inspectUserInput } from './guards/inputGuard';
import { config, validateConfig } from './config';
import crypto from 'crypto';

type CodeContext = {
    id: string;
    hash: string;
    fullCode: string;
    summary: string;
    symbols: string[];
    createdAt: string;
};

type SessionContext = {
    startTime: string;
    endTime: string | null;
    userId: string | null;
    queryOrder: string[];
    activeQueryId: string | null;
    queries: Map<string, QueryContext>;
    codeContexts: Map<string, CodeContext>;
    activeContextId: string | null;
    persisted: boolean; // Track if session exists in DB
};

type QueryTurn = {
    role: 'user' | 'assistant';
    parts: string;
    type?: 'question' | 'resolution';
};

type MisconceptionTimelineEntry = {
    turnIndex: number;
    targeted: string | null;
    deltas: Record<string, number>;
    confidenceBefore: number | null;
    confidenceAfter: number | null;
    resolved: boolean;
};

type QueryContext = {
    id: string;
    startTime: string;
    endTime: string | null;
    resolved: boolean;
    resolvedAt: string | null;
    state: ReturnType<typeof createSessionState>;
    intentCounts: Record<MessageIntent, number>;
    turnCount: number;
    directAnswerCount: number;
    reasoningCount: number;
    tokensIn: number;
    tokensOut: number;
    turns: QueryTurn[];
    misconceptionTimeline: MisconceptionTimelineEntry[];
    originalQuestion: string | null;
    hintLevel: number;
    // Cross-turn counters feeding the resolution detector / frustration handling.
    highConfidenceStreak: number;
    frustrationStreak: number;
};

const MAX_CONTEXT_CHARS = 24000; // reasonable cap: allows medium files but blocks very large payloads
const MAX_CONTEXT_LINES = 60; // hard limit: students should focus on small, targeted code snippets

const newSessionContext = (userId?: string | null): SessionContext => ({
    startTime: new Date().toISOString(),
    endTime: null,
    userId: userId ?? null,
    queryOrder: [],
    activeQueryId: null,
    queries: new Map(),
    codeContexts: new Map(),
    activeContextId: null,
    persisted: false
});

const newQueryContext = (id: string): QueryContext => ({
    id,
    startTime: new Date().toISOString(),
    endTime: null,
    resolved: false,
    resolvedAt: null,
    state: createSessionState(),
    intentCounts: {
        solution_request: 0,
        debugging: 0,
        conceptual: 0,
        clarification: 0,
        off_topic: 0
    },
    turnCount: 0,
    directAnswerCount: 0,
    reasoningCount: 0,
    tokensIn: 0,
    tokensOut: 0,
    turns: [],
    misconceptionTimeline: [],
    originalQuestion: null,
    hintLevel: 1,
    highConfidenceStreak: 0,
    frustrationStreak: 0
});

const sessionStore = new Map<string, SessionContext>();

// Chat Endpoint implementing misconception classifier pipeline
fastify.post('/chat', { preHandler: authPreHandlers }, async (request: AuthenticatedRequest & any, reply) => {
    const reqStart = Date.now();
    try {
        const { message, history = [], context = '', context_id, context_hash, session_id, query_id, turn_index, user_id } = request.body || {};
        const authedUserId = request.user?.id || user_id || null;

        if (!message || typeof message !== 'string') {
            return reply.code(400).send({ error: 'Missing message' });
        }

        if (context && typeof context === 'string' && context.length > MAX_CONTEXT_CHARS) {
            return reply.code(413).send({ error: `Context too large. Limit ${MAX_CONTEXT_CHARS} characters.` });
        }

        if (context && typeof context === 'string') {
            const lineCount = context.split('\n').length;
            if (lineCount > MAX_CONTEXT_LINES) {
                return reply.code(413).send({
                    error: `Code context exceeds ${MAX_CONTEXT_LINES} lines (got ${lineCount}). Select a smaller portion of code to focus on.`,
                    line_count: lineCount,
                    max_lines: MAX_CONTEXT_LINES
                });
            }
        }

        const sessionId = session_id || randomSessionId();
        let session = sessionStore.get(sessionId);
        let isNewSession = false;
        if (!session) {
            session = newSessionContext(authedUserId);
            sessionStore.set(sessionId, session);
            isNewSession = true;
            // Persist session immediately to avoid FK constraint violations
            await initializeSessionInDB(sessionId, session.userId, session.startTime);
            session.persisted = true;
        }

        session.userId = authedUserId ?? session.userId;

        const incomingQueryId = typeof query_id === 'string' && query_id.trim() ? query_id.trim() : null;
        let query: QueryContext | undefined = incomingQueryId ? session.queries.get(incomingQueryId) : undefined;
        let queryId: string;

        if (!query) {
            queryId = randomSessionId();
            query = newQueryContext(queryId);
            session.queries.set(queryId, query);
            session.queryOrder.push(queryId);
            session.activeQueryId = queryId;
        } else {
            queryId = incomingQueryId!;
        }

        if (query.hintLevel === undefined || query.hintLevel === null) {
            query.hintLevel = 1;
        }

        query.state.turnIndex = typeof turn_index === 'number' ? turn_index : query.state.turnIndex + 1;

        // Handle code context: hash, cache, summarize
        let codeContextRef: CodeContext | null = null;
        let contextChanged = false;

        if (context && typeof context === 'string' && context.trim()) {
            // Always compute server-side MD5, ignore client hash for cache matching
            const serverHash = crypto.createHash('md5').update(context).digest('hex');
            const existingContext = context_id ? session.codeContexts.get(context_id) : null;

            if (!existingContext || existingContext.hash !== serverHash) {
                // New or changed context - generate summary
                contextChanged = true;
                const contextId = context_id || randomSessionId();
                const summary = await generateCodeContextSummary(context);
                const symbols = extractSymbols(context);

                codeContextRef = {
                    id: contextId,
                    hash: serverHash,
                    fullCode: context,
                    summary,
                    symbols,
                    createdAt: new Date().toISOString()
                };

                session.codeContexts.set(contextId, codeContextRef);
                session.activeContextId = contextId;
            } else {
                // Context unchanged - reuse cached
                codeContextRef = existingContext;
                contextChanged = false;
            }
        } else if (session.activeContextId) {
            // No new context provided, use active cached context
            codeContextRef = session.codeContexts.get(session.activeContextId) || null;
        }

        if (query.resolved) {
            return {
                response: {
                    type: 'resolution',
                    text: 'This query is resolved. Start a new query to continue.'
                },
                session_id: sessionId,
                query_id: queryId,
                resolved: true,
                is_new_session: isNewSession
            };
        }

        const sanitizedMessage = sanitizeUserInput(message);

        const { intent, confidence, messageIntent } = inferIntentAndConfidence(sanitizedMessage, query.state.learnerConfidence);
        query.state.learnerConfidence = confidence;
        query.intentCounts[messageIntent] = (query.intentCounts[messageIntent] || 0) + 1;

        // Input guard: deterministically block tutor-subversion attempts
        // (prompt injection, jailbreak, system-prompt probing) BEFORE spending
        // any model tokens. Ordinary "just tell me" frustration is NOT blocked
        // here — it flows through and is handled pedagogically downstream.
        const guardResult = inspectUserInput(sanitizedMessage);
        if (guardResult.blocked) {
            const guardResponse = guardResult.response ||
                "Let's keep working through your code. What are you trying to do, and what happens instead?";
            query.turns.push({ role: 'user', parts: sanitizedMessage });
            query.turns.push({ role: 'assistant', parts: guardResponse, type: 'question' });

            await logTurn({
                sessionId, queryId,
                turnIndex: query.state.turnIndex,
                userMessage: sanitizedMessage,
                fileContext: codeContextRef?.id || null,
                question: guardResponse,
                targeted: null,
                classifierCertainty: 0,
                rawVerdicts: [],
                deltas: {},
                resolutions: [],
                confidenceBefore: null,
                confidenceAfter: null,
                resolved: false,
                resolutionSource: null,
                intent: messageIntent,
                strategy: `input_guard:${guardResult.category}`,
                hintLevel: query.hintLevel,
                learnerConfidence: query.state.learnerConfidence,
                tokensIn: 0, tokensOut: 0
            });

            await recordRequestMetric({
                userId: session.userId,
                path: '/chat',
                statusCode: 200,
                latencyMs: Date.now() - reqStart,
                tokensIn: 0, tokensOut: 0,
                modelStatus: `input_guard_block:${guardResult.category}`
            });

            return {
                response: { type: 'question', text: guardResponse },
                session_id: sessionId,
                query_id: queryId,
                context_id: codeContextRef?.id || null,
                context_hash: codeContextRef?.hash || null,
                context_changed: contextChanged,
                targeted_misconception: null,
                classifier_certainty: 0,
                deltas: {},
                resolution_events: [],
                state: snapshotState(query.state),
                tokens_in: 0, tokens_out: 0,
                intent: messageIntent,
                confidence_before: null, confidence_after: null,
                resolved: false,
                guard: { blocked: true, category: guardResult.category },
                is_new_session: isNewSession
            };
        }

        // Off-topic: redirect without burning an LLM call
        if (messageIntent === 'off_topic') {
            const offTopicResponse = "I'm here to help you understand your code through questions. Can you tell me what part of your code you're working on or what concept you're struggling with?";
            query.turns.push({ role: 'user', parts: sanitizedMessage });
            query.turns.push({ role: 'assistant', parts: offTopicResponse, type: 'question' });

            await logTurn({
                sessionId, queryId,
                turnIndex: query.state.turnIndex,
                userMessage: sanitizedMessage,
                fileContext: codeContextRef?.id || null,
                question: offTopicResponse,
                targeted: null,
                classifierCertainty: 0,
                rawVerdicts: [],
                deltas: {},
                resolutions: [],
                confidenceBefore: null,
                confidenceAfter: null,
                resolved: false,
                resolutionSource: null,
                intent: messageIntent,
                strategy: null,
                hintLevel: query.hintLevel,
                learnerConfidence: query.state.learnerConfidence,
                tokensIn: 0, tokensOut: 0
            });

            await recordRequestMetric({
                userId: session.userId,
                path: '/chat',
                statusCode: 200,
                latencyMs: Date.now() - reqStart,
                tokensIn: 0, tokensOut: 0,
                modelStatus: 'off_topic_skip'
            });

            return {
                response: { type: 'question', text: offTopicResponse },
                session_id: sessionId,
                query_id: queryId,
                context_id: codeContextRef?.id || null,
                context_hash: codeContextRef?.hash || null,
                context_changed: contextChanged,
                targeted_misconception: null,
                classifier_certainty: 0,
                deltas: {},
                resolution_events: [],
                state: snapshotState(query.state),
                tokens_in: 0, tokens_out: 0,
                intent: messageIntent,
                confidence_before: null, confidence_after: null,
                resolved: false,
                is_new_session: isNewSession
            };
        }

        // Direct answer seeking
        if (messageIntent === 'solution_request') {
            query.directAnswerCount += 1;
        }
        // Reasoning includes conceptual, clarification, and debugging (not direct solutions)
        if (messageIntent === 'conceptual' || messageIntent === 'clarification' || messageIntent === 'debugging') {
            query.reasoningCount += 1;
        }

        const preUpdateMap = new Map(query.state.map);

        // Classifier receives summary only (or full code if context just changed)
        const classifierContext = codeContextRef
            ? (contextChanged ? codeContextRef.fullCode : codeContextRef.summary)
            : null;

        const { verdicts, classifierCertainty, usage: classifierUsage } = await classifyMisconceptions({
            userMessage: sanitizedMessage,
            previousQuestion: query.state.lastQuestion,
            codeContext: classifierContext ?? undefined
        });

        const update = applyVerdicts(query.state, verdicts);
        const top = pickTopMisconception(query.state);
        const topTwo = pickTopMisconceptions(query.state, 2, 0.5);

        const targeted = top?.id || null;
        const confidenceBefore = targeted ? (preUpdateMap.get(targeted) ?? NEUTRAL_CONFIDENCE) : null;
        const confidenceAfter = targeted ? (query.state.map.get(targeted) ?? 0) : null;
        const resolved = targeted ? update.resolutionEvents.includes(targeted) : false;

        if (!query.originalQuestion) {
            query.originalQuestion = sanitizedMessage;
        }

        // ---- Resolution / frustration assessment (derived, no extra LLM call) ----
        const learnerSignals = detectLearnerSignals(sanitizedMessage);

        if (query.state.learnerConfidence >= 0.7) query.highConfidenceStreak += 1;
        else query.highConfidenceStreak = 0;

        const lowProgressTurn =
            (learnerSignals.solutionSeeking || learnerSignals.confusion || messageIntent === 'solution_request') &&
            !learnerSignals.understanding && !learnerSignals.articulatedCause;
        if (lowProgressTurn) query.frustrationStreak += 1;
        else query.frustrationStreak = 0;

        const everTargeted =
            query.state.map.size > 0 ||
            preUpdateMap.size > 0 ||
            update.resolutionEvents.length > 0 ||
            query.misconceptionTimeline.some(e => !!e.targeted);

        const resolution: ResolutionState = assessResolution({
            activeMap: Array.from(query.state.map.entries()).map(([id, confidence]) => ({ id, confidence })),
            everTargeted,
            resolutionEventsThisTurn: update.resolutionEvents.length,
            newMisconceptionThisTurn: verdicts.some(v => v.status === 'new'),
            messageIntent,
            understanding: learnerSignals.understanding,
            articulatedCause: learnerSignals.articulatedCause,
            confusion: learnerSignals.confusion,
            solutionSeeking: learnerSignals.solutionSeeking,
            highConfidenceStreak: query.highConfidenceStreak,
            frustrationStreak: query.frustrationStreak
        });

        // ---- Auto-resolution fast path: finalize WITHOUT a generator call ----
        if (config.autoResolveEnabled && resolution.action === 'auto_resolve') {
            const closeText =
                "It sounds like you've worked out what was going on — and you explained why, which is the part that sticks. I'll close this query; start a new one whenever you're ready.";
            const tokensInAuto = classifierUsage?.prompt || 0;
            const tokensOutAuto = classifierUsage?.candidates || 0;
            query.tokensIn += tokensInAuto;
            query.tokensOut += tokensOutAuto;
            query.turnCount = query.state.turnIndex;

            query.turns.push({ role: 'user', parts: sanitizedMessage });
            query.turns.push({ role: 'assistant', parts: closeText, type: 'resolution' });
            query.misconceptionTimeline.push({
                turnIndex: query.state.turnIndex, targeted, deltas: update.deltas,
                confidenceBefore, confidenceAfter, resolved: true
            });

            await logTurn({
                sessionId, queryId, turnIndex: query.state.turnIndex,
                userMessage: sanitizedMessage, fileContext: codeContextRef?.id || null,
                question: closeText, targeted, classifierCertainty,
                rawVerdicts: verdicts, deltas: update.deltas, resolutions: update.resolutionEvents,
                confidenceBefore, confidenceAfter, resolved: true, resolutionSource: 'auto_detected',
                intent: messageIntent, strategy: 'auto_resolve', hintLevel: query.hintLevel,
                learnerConfidence: query.state.learnerConfidence,
                tokensIn: tokensInAuto, tokensOut: tokensOutAuto,
                resolutionScore: resolution.score, resolutionStatus: resolution.status,
                resolutionSignals: resolution.signals
            });

            const summary = await finalizeQueryResolution(sessionId, session, query, 'auto');

            await recordRequestMetric({
                userId: session.userId, path: '/chat', statusCode: 200,
                latencyMs: Date.now() - reqStart, tokensIn: tokensInAuto, tokensOut: tokensOutAuto,
                modelStatus: 'auto_resolved'
            });

            return {
                response: { type: 'resolution', text: closeText },
                session_id: sessionId, query_id: queryId,
                context_id: codeContextRef?.id || null, context_hash: codeContextRef?.hash || null,
                context_changed: contextChanged, targeted_misconception: targeted,
                classifier_certainty: classifierCertainty, deltas: update.deltas,
                resolution_events: update.resolutionEvents, state: snapshotState(query.state),
                tokens_in: tokensInAuto, tokens_out: tokensOutAuto, intent: messageIntent,
                confidence_before: confidenceBefore, confidence_after: confidenceAfter,
                resolved: true,
                resolution: {
                    status: resolution.status, score: resolution.score,
                    action: resolution.action, signals: resolution.signals,
                    frustration: resolution.frustration
                },
                summary,
                is_new_session: isNewSession
            };
        }

        // ---- Otherwise pick a strategy, biasing toward a reflective close or a
        // more concrete (still non-answer) probe when the learner is stuck. ----
        let strategy = chooseStrategy(intent, messageIntent, top?.id ?? null);
        if (resolution.action === 'confirm_resolution') {
            strategy = 'reflective';
        }
        if (resolution.frustration) {
            query.hintLevel = 3; // most concrete hint level the output guard still allows
        }

        // Generator receives summary + relevant snippets for up to 2 misconceptions
        let generatorContext: string | null = null;
        if (codeContextRef) {
            let ctx = codeContextRef.summary;
            for (const m of topTwo) {
                const snippet = extractRelevantSnippet(codeContextRef.fullCode, m.id);
                if (snippet) ctx += '\n' + snippet;
            }
            generatorContext = ctx;
        }

        const { question, usage: generatorUsage } = await generateSocraticQuestion({
            targetedMisconception: top?.id || null,
            secondaryMisconception: topTwo.length > 1 ? topTwo[1].id : null,
            strategy,
            userMessage: sanitizedMessage,
            fileContext: generatorContext ?? undefined,
            lastQuestion: query.state.lastQuestion,
            hintLevel: query.hintLevel
        });

        query.state.lastQuestion = question;
        query.hintLevel = Math.min(query.hintLevel + 1, 3);

        query.turnCount = query.state.turnIndex;
        // Don't auto-update endTime on every turn; only when session explicitly ends

        const tokensIn = (classifierUsage?.prompt || 0) + (generatorUsage?.prompt || 0);
        const tokensOut = (classifierUsage?.candidates || 0) + (generatorUsage?.candidates || 0);
        query.tokensIn += tokensIn;
        query.tokensOut += tokensOut;

        query.turns.push({ role: 'user', parts: sanitizedMessage });
        query.turns.push({ role: 'assistant', parts: question, type: 'question' });
        query.misconceptionTimeline.push({
            turnIndex: query.state.turnIndex,
            targeted,
            deltas: update.deltas,
            confidenceBefore,
            confidenceAfter,
            resolved
        });

        // Append to history for the caller (extension keeps its own copy)
        const responsePayload = {
            response: {
                type: 'question',
                text: question
            },
            session_id: sessionId,
            query_id: queryId,
            context_id: codeContextRef?.id || null,
            context_hash: codeContextRef?.hash || null,
            context_changed: contextChanged,
            targeted_misconception: targeted,
            classifier_certainty: classifierCertainty,
            deltas: update.deltas,
            resolution_events: update.resolutionEvents,
            state: snapshotState(query.state),
            tokens_in: tokensIn,
            tokens_out: tokensOut,
            intent: messageIntent,
            confidence_before: confidenceBefore,
            confidence_after: confidenceAfter,
            resolved,
            resolution: {
                status: resolution.status,
                score: resolution.score,
                action: resolution.action,
                signals: resolution.signals,
                frustration: resolution.frustration
            },
            is_new_session: isNewSession
        };

        await logTurn({
            sessionId,
            queryId,
            turnIndex: query.state.turnIndex,
            userMessage: sanitizedMessage,
            fileContext: codeContextRef?.id || null,
            question,
            targeted,
            classifierCertainty,
            rawVerdicts: verdicts,
            deltas: update.deltas,
            resolutions: update.resolutionEvents,
            confidenceBefore,
            confidenceAfter,
            resolved,
            resolutionSource: resolved ? 'auto_threshold' : null,
            intent: messageIntent,
            strategy,
            hintLevel: query.hintLevel,
            learnerConfidence: query.state.learnerConfidence,
            tokensIn,
            tokensOut,
            resolutionScore: resolution.score,
            resolutionStatus: resolution.status,
            resolutionSignals: resolution.signals
        });

        await updateSessionMetricsRow(sessionId, session);

        await recordRequestMetric({
            userId: session.userId,
            path: '/chat',
            statusCode: 200,
            latencyMs: Date.now() - reqStart,
            tokensIn,
            tokensOut,
            modelStatus: 'ok'
        });

        return responsePayload;
    } catch (err: any) {
        await recordRequestMetric({
            userId: (request as any).user?.id,
            path: '/chat',
            statusCode: 500,
            latencyMs: Date.now() - reqStart,
            modelStatus: 'error',
            modelError: err?.message
        });
        console.error('----------------------------------------');
        console.error('CHAT ENDPOINT ERROR:');
        console.error('Message:', err.message);
        console.error('Stack:', err.stack);
        console.error('----------------------------------------');
        return reply.code(500).send({
            error: err.message || 'Internal Server Error',
            details: err.stack,
            hint: "Check server console for full logs"
        });
    }
});

fastify.get('/', async (request, reply) => {
    return { status: 'ok', message: 'Socratic AI Server Running' };
});

// Health check
fastify.get('/health', async (request, reply) => {
    return { status: 'healthy', gemini: 'connected' };
});

// Admin: add a user to the whitelist
fastify.post('/admin/whitelist/add', { preHandler: [authenticate, requireAdmin] }, async (request: AuthenticatedRequest & any, reply) => {
    const { email, role } = request.body || {};
    if (!email || typeof email !== 'string' || !email.includes('@')) {
        return reply.code(400).send({ error: 'Valid email required' });
    }
    const userRole = role === 'admin' ? 'admin' : 'student';
    const token = crypto.randomBytes(16).toString('hex');
    try {
        await dbInsert('whitelist_users', { email: email.toLowerCase().trim(), token, role: userRole, active: true });
        return { success: true, email, token, role: userRole };
    } catch (err: any) {
        if (err.message?.includes('duplicate')) {
            return reply.code(409).send({ error: 'Email already exists' });
        }
        throw err;
    }
});

// Admin: list whitelisted users (no tokens exposed)
fastify.get('/admin/whitelist/list', { preHandler: [authenticate, requireAdmin] }, async (request: AuthenticatedRequest & any, reply) => {
    const result = await pool.query('SELECT email, role, active, created_at FROM whitelist_users ORDER BY created_at DESC');
    return { users: result.rows };
});

// End session explicitly
fastify.post('/session/end', { preHandler: authPreHandlers }, async (request: AuthenticatedRequest & any, reply) => {
    const { session_id } = request.body;
    if (!session_id) {
        return reply.code(400).send({ error: 'Missing session_id' });
    }

    const session = sessionStore.get(session_id);
    if (!session) {
        return reply.code(404).send({ error: 'Session not found' });
    }

    const endTime = new Date().toISOString();
    session.endTime = endTime;

    await updateSessionMetricsRow(session_id, session, endTime);

    // Optionally remove from memory
    sessionStore.delete(session_id);

    return {
        success: true,
        session_id
    };
});

// Start a new query within a session
fastify.post('/query/start', { preHandler: authPreHandlers }, async (request: AuthenticatedRequest & any, reply) => {
    const { session_id, user_id } = request.body || {};
    const authedUserId = request.user?.id || user_id || null;
    const sessionId = session_id || randomSessionId();
    let session = sessionStore.get(sessionId);
    let isNewSession = false;
    if (!session) {
        session = newSessionContext(authedUserId);
        sessionStore.set(sessionId, session);
        isNewSession = true;
        await initializeSessionInDB(sessionId, session.userId, session.startTime);
        session.persisted = true;
    }

    const queryId = randomSessionId();
    const query = newQueryContext(queryId);
    session.queries.set(queryId, query);
    session.queryOrder.push(queryId);
    session.activeQueryId = queryId;

    return {
        success: true,
        session_id: sessionId,
        query_id: queryId,
        is_new_session: isNewSession
    };
});

// Explicit user-driven query resolution endpoint
fastify.post('/query/resolve', { preHandler: authPreHandlers }, async (request: AuthenticatedRequest & any, reply) => {
    const { session_id, query_id } = request.body || {};
    if (!session_id) {
        return reply.code(400).send({ error: 'Missing session_id' });
    }
    if (!query_id) {
        return reply.code(400).send({ error: 'Missing query_id' });
    }

    const session = sessionStore.get(session_id);
    if (!session) {
        return reply.code(404).send({ error: 'Session not found' });
    }

    const query = session.queries.get(query_id);
    if (!query) {
        return reply.code(404).send({ error: 'Query not found' });
    }

    if (query.resolved) {
        return {
            success: true,
            session_id,
            query_id,
            resolved: true,
            response: {
                type: 'resolution',
                text: 'Query already resolved.'
            }
        };
    }

    const summary = await finalizeQueryResolution(session_id, session, query, 'user');

    return {
        success: true,
        session_id,
        query_id,
        resolved: true,
        response: {
            type: 'resolution',
            text: 'Query resolved by user.'
        },
        summary
    };
});

/**
 * Finalize a query as resolved — used by both the manual /query/resolve endpoint
 * (source 'user') and the automatic resolution detector (source 'auto'). Marks
 * the query resolved, builds the longitudinal summary + training row with the
 * correct label, and refreshes session metrics.
 */
async function finalizeQueryResolution(
    sessionId: string,
    session: SessionContext,
    query: QueryContext,
    source: 'user' | 'auto'
) {
    if (!query.resolved) {
        const endTime = new Date().toISOString();
        query.endTime = endTime;
        query.resolved = true;
        query.resolvedAt = endTime;
    }

    const label = source === 'auto' ? 'auto_resolved' : 'resolved_by_user';
    const summary = buildQuerySummary({
        sessionId,
        userId: session.userId,
        query,
        resolutionLabel: label
    });

    await logQuerySummaryTrainingData({
        sessionId,
        userId: session.userId,
        query,
        summary,
        label
    });

    await updateSessionMetricsRow(sessionId, session);
    return summary;
}

async function initializeSessionInDB(sessionId: string, userId: string | null, startTime: string) {
    try {
        await dbInsert('misconception_sessions', {
            session_id: sessionId,
            user_id: userId,
            session_start_time: startTime,
            session_end_time: null,
            turn_count: 0,
            direct_answer_pct: 0,
            reasoning_pct: 0,
            tokens_in: 0,
            tokens_out: 0,
            updated_at: new Date().toISOString()
        });
    } catch (error: any) {
        console.error('Failed to initialize session in DB:', error?.message);
        throw error; // Critical error - should not proceed
    }
}

function aggregateSessionStats(session: SessionContext) {
    let turnCount = 0;
    let directAnswers = 0;
    let reasoning = 0;
    let offTopicCount = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let misconceptionsResolved = 0;
    let misconceptionsActive = 0;

    session.queries.forEach(q => {
        turnCount += q.turnCount;
        directAnswers += q.directAnswerCount;
        reasoning += q.reasoningCount;
        offTopicCount += q.intentCounts.off_topic || 0;
        tokensIn += q.tokensIn;
        tokensOut += q.tokensOut;

        // Count resolved misconceptions from timeline
        const resolvedSet = new Set<string>();
        q.misconceptionTimeline.forEach(entry => {
            if (entry.resolved && entry.targeted) {
                resolvedSet.add(entry.targeted);
            }
        });
        misconceptionsResolved += resolvedSet.size;

        // Active misconceptions still in state map
        misconceptionsActive += q.state.map.size;
    });

    const directPct = turnCount > 0 ? Math.round((directAnswers / turnCount) * 100 * 100) / 100 : 0;
    const reasoningPct = turnCount > 0 ? Math.round((reasoning / turnCount) * 100 * 100) / 100 : 0;

    return { turnCount, directPct, reasoningPct, offTopicCount, tokensIn, tokensOut, misconceptionsResolved, misconceptionsActive };
}

async function updateSessionMetricsRow(sessionId: string, session: SessionContext, endTimeOverride?: string) {
    try {
        const aggregates = aggregateSessionStats(session);
        await dbUpdate('misconception_sessions', {
            turn_count: aggregates.turnCount,
            direct_answer_pct: aggregates.directPct,
            reasoning_pct: aggregates.reasoningPct,
            off_topic_count: aggregates.offTopicCount,
            misconceptions_resolved: aggregates.misconceptionsResolved,
            misconceptions_active: aggregates.misconceptionsActive,
            tokens_in: aggregates.tokensIn,
            tokens_out: aggregates.tokensOut,
            session_end_time: endTimeOverride || session.endTime,
            updated_at: new Date().toISOString()
        }, { session_id: sessionId });
    } catch (error: any) {
        console.warn('Session metrics update failed', error?.message);
    }
}

async function logTurn(params: {
    sessionId: string;
    queryId: string;
    turnIndex: number;
    userMessage: string;
    fileContext: string | null;
    question: string;
    targeted: string | null;
    classifierCertainty: number;
    rawVerdicts: any[];
    deltas: Record<string, number>;
    resolutions: string[];
    confidenceBefore: number | null;
    confidenceAfter: number | null;
    resolved: boolean;
    resolutionSource: string | null;
    intent: MessageIntent;
    strategy: string | null;
    hintLevel: number;
    learnerConfidence: number;
    tokensIn: number;
    tokensOut: number;
    resolutionScore?: number | null;
    resolutionStatus?: string | null;
    resolutionSignals?: string[];
}) {
    try {
        await dbInsert('query_turns', {
            session_id: params.sessionId,
            query_id: params.queryId,
            turn_index: params.turnIndex,
            user_message: params.userMessage,
            file_context: params.fileContext,
            question: params.question,
            targeted_misconception: params.targeted,
            classifier_certainty: params.classifierCertainty,
            raw_verdicts: JSON.stringify(params.rawVerdicts),
            confidence_deltas: JSON.stringify(params.deltas),
            resolution_events: JSON.stringify(params.resolutions),
            misconception_confidence_before: params.confidenceBefore,
            misconception_confidence_after: params.confidenceAfter,
            misconception_resolved: params.resolved,
            resolution_source: params.resolutionSource,
            intent: params.intent,
            strategy: params.strategy,
            hint_level: params.hintLevel,
            learner_confidence: params.learnerConfidence,
            tokens_in: params.tokensIn,
            tokens_out: params.tokensOut,
            resolution_score: params.resolutionScore ?? null,
            resolution_status: params.resolutionStatus ?? null,
            resolution_signals: params.resolutionSignals ? JSON.stringify(params.resolutionSignals) : null,
            created_at: new Date().toISOString()
        });
    } catch (error: any) {
        // Non-blocking log failure
        console.warn('Turn log failed', error?.message);
    }
}

function buildQuerySummary(params: {
    sessionId: string;
    userId: string | null;
    query: QueryContext;
    resolutionLabel?: string;
}) {
    const { query } = params;
    const durationSeconds = query.startTime && query.resolvedAt
        ? Math.max(1, Math.round((Date.parse(query.resolvedAt) - Date.parse(query.startTime)) / 1000))
        : null;

    const keyTurns = query.turns
        .map((t, i) => ({ index: i + 1, role: t.role, text: t.parts, type: t.type }))
        .slice(0, 6);

    // Compute misconception resolution stats
    const autoResolved = new Set<string>();
    const allTargeted = new Set<string>();
    query.misconceptionTimeline.forEach(entry => {
        if (entry.targeted) allTargeted.add(entry.targeted);
        if (entry.resolved && entry.targeted) autoResolved.add(entry.targeted);
    });
    const stillActive = Array.from(query.state.map.entries()).map(([id, conf]) => ({ id, confidence: conf }));

    return {
        session_id: params.sessionId,
        query_id: query.id,
        user_id: params.userId,
        original_question: query.originalQuestion,
        misconception_trajectory: query.misconceptionTimeline,
        key_turns: keyTurns,
        passive_metrics: {
            turn_count: query.turnCount,
            direct_answer_pct: query.turnCount > 0 ? Math.round((query.directAnswerCount / query.turnCount) * 100 * 100) / 100 : 0,
            reasoning_pct: query.turnCount > 0 ? Math.round((query.reasoningCount / query.turnCount) * 100 * 100) / 100 : 0,
            off_topic_count: query.intentCounts.off_topic || 0,
            tokens_in: query.tokensIn,
            tokens_out: query.tokensOut,
            duration_seconds: durationSeconds
        },
        misconception_resolution: {
            total_targeted: allTargeted.size,
            auto_resolved: Array.from(autoResolved),
            still_active: stillActive,
            resolution_rate: allTargeted.size > 0
                ? Math.round((autoResolved.size / allTargeted.size) * 100) / 100
                : null
        },
        resolution_label: params.resolutionLabel ?? 'resolved_by_user',
        resolved_at: query.resolvedAt
    };
}

async function logQuerySummaryTrainingData(params: {
    sessionId: string;
    userId: string | null;
    query: QueryContext;
    summary: Record<string, unknown>;
    label?: string;
}) {
    try {
        await dbInsert('query_summaries', {
            session_id: params.sessionId,
            query_id: params.query.id,
            user_id: params.userId,
            summary: JSON.stringify(params.summary),
            created_at: new Date().toISOString()
        });

        await dbInsert('query_training_data', {
            session_id: params.sessionId,
            query_id: params.query.id,
            user_id: params.userId,
            label: params.label ?? 'resolved_by_user',
            history: JSON.stringify(params.query.turns),
            summary: JSON.stringify(params.summary),
            created_at: new Date().toISOString()
        });
    } catch (error: any) {
        console.warn('Query training data log failed', error?.message);
    }
}

function extractSymbols(code: string): string[] {
    const symbols: string[] = [];
    const functionRegex = /(?:function|const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[=\(]/g;
    const classRegex = /class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g;

    let match;
    while ((match = functionRegex.exec(code)) !== null) {
        symbols.push(match[1]);
    }
    while ((match = classRegex.exec(code)) !== null) {
        symbols.push(match[1]);
    }

    return [...new Set(symbols)].slice(0, 20);
}

function extractRelevantSnippet(code: string, misconceptionId: string): string {
    const keywords: Record<string, string[]> = {
        'off-by-one': ['for', 'while', '[', 'length', 'size'],
        'mutation-vs-reassignment': ['push', 'pop', 'splice', '='],
        'return-vs-print': ['return', 'console', 'print'],
        'async-vs-parallel': ['async', 'await', 'Promise'],
        'null-checks': ['null', 'undefined', '?.', '??'],
        'scope-shadowing': ['let', 'const', 'var', '{'],
        'statefulness': ['state', 'this.', 'useState'],
        'side-effects': ['=', 'push', 'splice'],
        'operator-precedence': ['+', '-', '*', '/', '%', '&&', '||', '!'],
        'type-coercion': ['==', '+', 'parseInt', 'toString', 'Number', 'String'],
        'infinite-loop': ['while', 'for', 'do', 'break', 'continue'],
        'recursion-base-case': ['return', 'if', 'function', '=>'],
        'equality-vs-assignment': ['=', '==', '===', 'if'],
        'variable-initialization': ['let', 'var', 'const', 'undefined', 'NaN'],
        'boolean-logic': ['&&', '||', '!', 'true', 'false', 'if'],
        'string-immutability': ['replace', 'slice', 'substring', 'charAt', '[']
    };

    const searchTerms = keywords[misconceptionId] || [];
    if (searchTerms.length === 0) return '';

    const lines = code.split('\n');
    for (let i = 0; i < lines.length; i++) {
        for (const term of searchTerms) {
            if (lines[i].includes(term)) {
                const start = Math.max(0, i - 2);
                const end = Math.min(lines.length, i + 3);
                const snippet = lines.slice(start, end).join('\n');
                return snippet.length > 500 ? snippet.slice(0, 500) + '...' : snippet;
            }
        }
    }

    return '';
}

const start = async () => {
    try {
        // Fail fast in production if required secrets are missing; warn in dev.
        validateConfig();
        await fastify.listen({ port: config.port, host: config.host });
        console.log(`Server listening on http://${config.host}:${config.port}`);
        console.log(`Authentication ${enableWhitelist ? 'ENABLED' : 'DISABLED'} | env=${config.nodeEnv}`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

start();
