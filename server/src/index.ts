
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

import { register } from './metrics';
import { classifyMisconceptions, generateSessionSummary, generateSocraticQuestion } from './gemini';
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

type SessionContext = {
    state: ReturnType<typeof createSessionState>;
    startTime: string;
    endTime: string | null;
    userId: string | null;
    intentCounts: Record<MessageIntent, number>;
    turnCount: number;
    directAnswerCount: number;
    reasoningCount: number;
    tokensIn: number;
    tokensOut: number;
    persisted: boolean; // Track if session exists in DB
};

const newSessionContext = (userId?: string | null): SessionContext => ({
    state: createSessionState(),
    startTime: new Date().toISOString(),
    endTime: null,
    userId: userId ?? null,
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
    persisted: false
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
        const { message, history = [], context = '', session_id, turn_index, user_id } = request.body || {};

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
        session.state.turnIndex = typeof turn_index === 'number' ? turn_index : session.state.turnIndex + 1;

        const sanitizedMessage = sanitizeUserInput(message);
        const sanitizedContext = typeof context === 'string' ? sanitizeUserInput(context) : '';

        // Refresh summary every 3 turns or when empty
        if (!session.state.summary || session.state.turnIndex % 3 === 0) {
            session.state.summary = await generateSessionSummary(history);
        }

        const { intent, confidence, messageIntent } = inferIntentAndConfidence(sanitizedMessage, session.state.learnerConfidence);
        session.state.learnerConfidence = confidence;
        session.intentCounts[messageIntent] = (session.intentCounts[messageIntent] || 0) + 1;
        
        // Direct answer seeking
        if (messageIntent === 'solution_request') {
            session.directAnswerCount += 1;
        }
        // Reasoning includes conceptual, clarification, and debugging (not direct solutions)
        if (messageIntent === 'conceptual' || messageIntent === 'clarification' || messageIntent === 'debugging') {
            session.reasoningCount += 1;
        }

        const preUpdateMap = new Map(session.state.map);

        const { verdicts, classifierCertainty, usage: classifierUsage } = await classifyMisconceptions({
            userMessage: sanitizedMessage,
            previousQuestion: session.state.lastQuestion,
            sessionSummary: session.state.summary,
            codeContext: sanitizedContext
        });

        const update = applyVerdicts(session.state, verdicts);
        const top = pickTopMisconception(session.state);
        const strategy = chooseStrategy(intent, session.state.learnerConfidence, top?.confidence ?? null);

        const { question, usage: generatorUsage, understood, summary } = await generateSocraticQuestion({
            targetedMisconception: top?.id || null,
            strategy,
            userMessage: sanitizedMessage,
            sessionSummary: session.state.summary,
            fileContext: sanitizedContext,
            lastQuestion: session.state.lastQuestion
        });

        session.state.lastQuestion = question;

        session.turnCount = session.state.turnIndex;
        // Don't auto-update endTime on every turn; only when session explicitly ends

        const tokensIn = (classifierUsage?.prompt || 0) + (generatorUsage?.prompt || 0);
        const tokensOut = (classifierUsage?.candidates || 0) + (generatorUsage?.candidates || 0);
        session.tokensIn += tokensIn;
        session.tokensOut += tokensOut;

        const targeted = top?.id || null;
        const confidenceBefore = targeted ? (preUpdateMap.get(targeted) ?? NEUTRAL_CONFIDENCE) : null;
        const confidenceAfter = targeted ? (session.state.map.get(targeted) ?? 0) : null;
        const resolved = targeted ? update.resolutionEvents.includes(targeted) : false;
        
        // Detect if all doubts resolved (no active misconceptions)
        const allResolved = session.state.map.size === 0 && update.resolutionEvents.length > 0;

        // Append to history for the caller (extension keeps its own copy)
        const responsePayload = {
            response: question,
            session_id: sessionId,
            targeted_misconception: targeted,
            classifier_certainty: classifierCertainty,
            deltas: update.deltas,
            resolution_events: update.resolutionEvents,
            state: snapshotState(session.state),
            tokens_in: tokensIn,
            tokens_out: tokensOut,
            intent: messageIntent,
            confidence_before: confidenceBefore,
            confidence_after: confidenceAfter,
            resolved,
            all_doubts_resolved: allResolved,
            is_new_session: isNewSession,
            student_understood: understood,
            learning_summary: summary || null
        };

        await logTurn({
            sessionId,
            turnIndex: session.state.turnIndex,
            userMessage: sanitizedMessage,
            fileContext: sanitizedContext,
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

        await upsertSessionMetrics({
            sessionId,
            userId: session.userId,
            startTime: session.startTime,
            endTime: session.endTime,
            turnCount: session.turnCount,
            directAnswerPct: session.turnCount > 0 ? Math.round((session.directAnswerCount / session.turnCount) * 100 * 100) / 100 : 0,
            reasoningPct: session.turnCount > 0 ? Math.round((session.reasoningCount / session.turnCount) * 100 * 100) / 100 : 0,
            tokensIn: session.tokensIn,
            tokensOut: session.tokensOut
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

// Summary Endpoint (no auth for testing)
fastify.post('/summary', async (request: any, reply) => {
    const { history } = request.body;
    const summary = await generateSessionSummary(history);
    return { summary };
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

    await upsertSessionMetrics({
        sessionId: session_id,
        userId: session.userId,
        startTime: session.startTime,
        endTime: endTime,
        turnCount: session.turnCount,
        directAnswerPct: session.turnCount > 0 ? Math.round((session.directAnswerCount / session.turnCount) * 100 * 100) / 100 : 0,
        reasoningPct: session.turnCount > 0 ? Math.round((session.reasoningCount / session.turnCount) * 100 * 100) / 100 : 0,
        tokensIn: session.tokensIn,
        tokensOut: session.tokensOut
    });

    // Optionally remove from memory
    sessionStore.delete(session_id);

    return { 
        success: true, 
        session_id,
        final_metrics: {
            turn_count: session.turnCount,
            direct_answer_pct: session.turnCount > 0 ? Math.round((session.directAnswerCount / session.turnCount) * 100 * 100) / 100 : 0,
            reasoning_pct: session.turnCount > 0 ? Math.round((session.reasoningCount / session.turnCount) * 100 * 100) / 100 : 0,
            tokens_in: session.tokensIn,
            tokens_out: session.tokensOut
        }
    };
});

// Start new doubt (ends current session and creates new one)
fastify.post('/session/new-doubt', async (request: any, reply) => {
    const { current_session_id, user_id } = request.body;
    
    // End current session if provided
    if (current_session_id) {
        const currentSession = sessionStore.get(current_session_id);
        if (currentSession) {
            const endTime = new Date().toISOString();
            currentSession.endTime = endTime;
            await upsertSessionMetrics({
                sessionId: current_session_id,
                userId: currentSession.userId,
                startTime: currentSession.startTime,
                endTime: endTime,
                turnCount: currentSession.turnCount,
                directAnswerPct: currentSession.turnCount > 0 ? Math.round((currentSession.directAnswerCount / currentSession.turnCount) * 100 * 100) / 100 : 0,
                reasoningPct: currentSession.turnCount > 0 ? Math.round((currentSession.reasoningCount / currentSession.turnCount) * 100 * 100) / 100 : 0,
                tokensIn: currentSession.tokensIn,
                tokensOut: currentSession.tokensOut
            });
            sessionStore.delete(current_session_id);
        }
    }

    // Create new session
    const newSessionId = randomSessionId();
    const newSession = newSessionContext(user_id);
    sessionStore.set(newSessionId, newSession);
    await initializeSessionInDB(newSessionId, newSession.userId, newSession.startTime);
    newSession.persisted = true;

    return { 
        success: true,
        new_session_id: newSessionId,
        previous_session_id: current_session_id || null
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
    turnIndex: number;
    userMessage: string;
    fileContext: string;
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
        await supabase.from('misconception_turns').insert({
            session_id: params.sessionId,
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

async function upsertSessionMetrics(params: {
    sessionId: string;
    userId: string | null;
    startTime: string;
    endTime: string | null;
    turnCount: number;
    directAnswerPct: number;
    reasoningPct: number;
    tokensIn: number;
    tokensOut: number;
}) {
    try {
        await supabase.from('misconception_sessions').upsert({
            session_id: params.sessionId,
            user_id: params.userId,
            session_start_time: params.startTime,
            session_end_time: params.endTime,
            turn_count: params.turnCount,
            direct_answer_pct: params.directAnswerPct,
            reasoning_pct: params.reasoningPct,
            tokens_in: params.tokensIn,
            tokens_out: params.tokensOut,
            updated_at: new Date().toISOString()
        });
    } catch (error: any) {
        console.warn('Supabase session upsert failed', error?.message);
    }
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
