
import Fastify from 'fastify';
import cors from '@fastify/cors';
import dotenv from 'dotenv';

dotenv.config();

const fastify = Fastify({
    logger: true
});

fastify.register(cors, {
    origin: '*'
});

import { register, metrics } from './metrics';
import { classifyMisconceptions, generateSocraticQuestion, generateCodeContextSummary } from './gemini';
import {
    applyVerdicts,
    chooseStrategy,
    createSessionState,
    inferIntentAndConfidence,
    MessageIntent,
    NEUTRAL_CONFIDENCE,
    pickTopMisconception,
    sanitizeUserInput,
    snapshotState,
    randomSessionId
} from './misconceptions';
import { supabase } from './supabase';
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
};

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
        clarification: 0
    },
    turnCount: 0,
    directAnswerCount: 0,
    reasoningCount: 0,
    tokensIn: 0,
    tokensOut: 0,
    turns: [],
    misconceptionTimeline: [],
    originalQuestion: null
});

const sessionStore = new Map<string, SessionContext>();

// Metrics Endpoint (no auth for testing)
fastify.get('/metrics', async (request, reply) => {
    const metrics = await register.metrics();
    reply.header('Content-Type', register.contentType);
    return metrics;
});

// Chat Endpoint implementing misconception classifier pipeline
fastify.post('/chat', async (request: any, reply) => {
    try {
        const { message, history = [], context = '', context_id, context_hash, session_id, query_id, turn_index, user_id } = request.body || {};

        if (!message || typeof message !== 'string') {
            return reply.code(400).send({ error: 'Missing message' });
        }

        const sessionId = session_id || randomSessionId();
        let session = sessionStore.get(sessionId);
        let isNewSession = false;
        if (!session) {
            session = newSessionContext(user_id);
            sessionStore.set(sessionId, session);
            isNewSession = true;
            // Persist session immediately to avoid FK constraint violations
            await initializeSessionInDB(sessionId, session.userId, session.startTime);
            session.persisted = true;
        }

        session.userId = user_id ?? session.userId;

        let queryId = typeof query_id === 'string' && query_id.trim() ? query_id.trim() : null;
        let query: QueryContext | undefined = queryId ? session.queries.get(queryId) : undefined;

        if (!query) {
            queryId = randomSessionId();
            query = newQueryContext(queryId);
            session.queries.set(queryId, query);
            session.queryOrder.push(queryId);
            session.activeQueryId = queryId;
        }

        query.state.turnIndex = typeof turn_index === 'number' ? turn_index : query.state.turnIndex + 1;

        // Handle code context: hash, cache, summarize
        let codeContextRef: CodeContext | null = null;
        let contextChanged = false;

        if (context && typeof context === 'string' && context.trim()) {
            const receivedHash = context_hash || crypto.createHash('md5').update(context).digest('hex');
            const existingContext = context_id ? session.codeContexts.get(context_id) : null;

            if (!existingContext || existingContext.hash !== receivedHash) {
                // New or changed context - generate summary
                contextChanged = true;
                const contextId = context_id || randomSessionId();
                const summary = await generateCodeContextSummary(context);
                const symbols = extractSymbols(context);

                codeContextRef = {
                    id: contextId,
                    hash: receivedHash,
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
            codeContext: classifierContext
        });

        const update = applyVerdicts(query.state, verdicts);
        const top = pickTopMisconception(query.state);
        const strategy = chooseStrategy(intent, query.state.learnerConfidence, top?.confidence ?? null);

        // Generator receives summary + relevant snippet
        const generatorContext = codeContextRef
            ? codeContextRef.summary + (top?.id ? extractRelevantSnippet(codeContextRef.fullCode, top.id) : '')
            : null;

        const { question, usage: generatorUsage } = await generateSocraticQuestion({
            targetedMisconception: top?.id || null,
            strategy,
            userMessage: sanitizedMessage,
            fileContext: generatorContext,
            lastQuestion: query.state.lastQuestion
        });

        query.state.lastQuestion = question;

        query.turnCount = query.state.turnIndex;
        // Don't auto-update endTime on every turn; only when session explicitly ends

        const tokensIn = (classifierUsage?.prompt || 0) + (generatorUsage?.prompt || 0);
        const tokensOut = (classifierUsage?.candidates || 0) + (generatorUsage?.candidates || 0);
        query.tokensIn += tokensIn;
        query.tokensOut += tokensOut;

        const targeted = top?.id || null;
        const confidenceBefore = targeted ? (preUpdateMap.get(targeted) ?? NEUTRAL_CONFIDENCE) : null;
        const confidenceAfter = targeted ? (query.state.map.get(targeted) ?? 0) : null;
        const resolved = targeted ? update.resolutionEvents.includes(targeted) : false;

        if (!query.originalQuestion) {
            query.originalQuestion = sanitizedMessage;
        }

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
            deltas: update.deltas,
            resolutions: update.resolutionEvents,
            confidenceBefore,
            confidenceAfter,
            resolved,
            intent: messageIntent,
            tokensIn,
            tokensOut
        });

        return responsePayload;
    } catch (err: any) {
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

// End session explicitly
fastify.post('/session/end', async (request: any, reply) => {
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

    // Optionally remove from memory
    sessionStore.delete(session_id);

    return { 
        success: true, 
        session_id
    };
});

// Start a new query within a session
fastify.post('/query/start', async (request: any, reply) => {
    const { session_id, user_id } = request.body || {};
    const sessionId = session_id || randomSessionId();
    let session = sessionStore.get(sessionId);
    let isNewSession = false;
    if (!session) {
        session = newSessionContext(user_id);
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
fastify.post('/query/resolve', async (request: any, reply) => {
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

    const endTime = new Date().toISOString();
    query.endTime = endTime;
    query.resolved = true;
    query.resolvedAt = endTime;

    metrics.resolutionClicks.inc();
    metrics.resolutionTurns.observe(query.turnCount);
    const elapsedSeconds = Math.max(1, Math.round((Date.parse(endTime) - Date.parse(query.startTime)) / 1000));
    metrics.resolutionLatencySeconds.observe(elapsedSeconds);

    const summary = buildQuerySummary({
        sessionId: session_id,
        userId: session.userId,
        query
    });

    await logQuerySummaryTrainingData({
        sessionId: session_id,
        userId: session.userId,
        query,
        summary
    });

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

async function initializeSessionInDB(sessionId: string, userId: string | null, startTime: string) {
    try {
        await supabase.from('misconception_sessions').insert({
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

async function logTurn(params: {
    sessionId: string;
    queryId: string;
    turnIndex: number;
    userMessage: string;
    fileContext: string | null;
    question: string;
    targeted: string | null;
    classifierCertainty: number;
    deltas: Record<string, number>;
    resolutions: string[];
    confidenceBefore: number | null;
    confidenceAfter: number | null;
    resolved: boolean;
    intent: MessageIntent;
    tokensIn: number;
    tokensOut: number;
}) {
    try {
        await supabase.from('query_turns').insert({
            session_id: params.sessionId,
            query_id: params.queryId,
            turn_index: params.turnIndex,
            user_message: params.userMessage,
            file_context: params.fileContext,
            question: params.question,
            targeted_misconception: params.targeted,
            classifier_certainty: params.classifierCertainty,
            confidence_deltas: params.deltas,
            resolution_events: params.resolutions,
            misconception_confidence_before: params.confidenceBefore,
            misconception_confidence_after: params.confidenceAfter,
            misconception_resolved: params.resolved,
            intent: params.intent,
            tokens_in: params.tokensIn,
            tokens_out: params.tokensOut,
            created_at: new Date().toISOString()
        });
    } catch (error: any) {
        // Non-blocking log failure
        console.warn('Supabase log failed', error?.message);
    }
}

function buildQuerySummary(params: {
    sessionId: string;
    userId: string | null;
    query: QueryContext;
}) {
    const { query } = params;
    const durationSeconds = query.startTime && query.resolvedAt
        ? Math.max(1, Math.round((Date.parse(query.resolvedAt) - Date.parse(query.startTime)) / 1000))
        : null;

    const keyTurns = query.turns
        .map((t, i) => ({ index: i + 1, role: t.role, text: t.parts, type: t.type }))
        .slice(0, 6);

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
            tokens_in: query.tokensIn,
            tokens_out: query.tokensOut,
            duration_seconds: durationSeconds
        },
        resolution_label: 'resolved_by_user',
        resolved_at: query.resolvedAt
    };
}

async function logQuerySummaryTrainingData(params: {
    sessionId: string;
    userId: string | null;
    query: QueryContext;
    summary: Record<string, unknown>;
}) {
    try {
        await supabase.from('query_summaries').insert({
            session_id: params.sessionId,
            query_id: params.query.id,
            user_id: params.userId,
            summary: params.summary,
            created_at: new Date().toISOString()
        });

        await supabase.from('query_training_data').insert({
            session_id: params.sessionId,
            query_id: params.query.id,
            user_id: params.userId,
            label: 'resolved_by_user',
            history: params.query.turns,
            summary: params.summary,
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
    // Extract ~200 character snippet around loops, arrays, etc based on misconception
    const keywords: Record<string, string[]> = {
        'off-by-one': ['for', 'while', '[', 'length', 'size'],
        'mutation-vs-reassignment': ['push', 'pop', 'splice', '='],
        'return-vs-print': ['return', 'console', 'print'],
        'async-vs-parallel': ['async', 'await', 'Promise'],
        'null-checks': ['null', 'undefined', '?.', '??'],
        'scope-shadowing': ['let', 'const', 'var', '{'],
        'statefulness': ['state', 'this.', 'useState'],
        'side-effects': ['=', 'push', 'splice']
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
        await fastify.listen({ port: 3000, host: '0.0.0.0' });
        console.log('🚀 Server listening on http://0.0.0.0:3000');
        console.log('✅ Authentication DISABLED for testing');
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

start();
