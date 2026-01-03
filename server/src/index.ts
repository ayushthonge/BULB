
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
import { chatWithGemini, generateSessionSummary } from './gemini';

// Metrics Endpoint (no auth for testing)
fastify.get('/metrics', async (request, reply) => {
    const metrics = await register.metrics();
    reply.header('Content-Type', register.contentType);
    return metrics;
});

// Chat Endpoint (no auth for testing)
fastify.post('/chat', async (request: any, reply) => {
    try {
        const { message, history, context } = request.body;

        const response = await chatWithGemini(history || [], message, context);

        return { response };
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
