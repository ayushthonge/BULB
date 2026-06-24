import { FastifyReply, FastifyRequest } from 'fastify';

const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'); // 1 minute default
const USER_MAX = parseInt(process.env.RATE_LIMIT_PER_USER || '10');
const GLOBAL_MAX = parseInt(process.env.RATE_LIMIT_GLOBAL || '15'); // 30 RPM Gemini / 2 calls per chat = 15

const userBuckets: Map<string, { windowStart: number; count: number }> = new Map();
let globalWindowStart = Date.now();
let globalCount = 0;

export async function rateLimit(request: FastifyRequest, reply: FastifyReply) {
    const now = Date.now();
    const user = (request as any).user;
    const userId = user?.id || 'anonymous';
    const isAdmin = user?.role === 'admin';

    // Global window — enforced for everyone including admins (protects Gemini quota)
    if (now - globalWindowStart > WINDOW_MS) {
        globalWindowStart = now;
        globalCount = 0;
    }
    globalCount += 1;
    if (globalCount > GLOBAL_MAX) {
        const retryAfter = Math.ceil((WINDOW_MS - (now - globalWindowStart)) / 1000);
        reply.header('Retry-After', retryAfter);
        return reply.code(429).send({ error: 'Global rate limit exceeded. Please retry shortly.', retry_after: retryAfter });
    }

    // Per-user window — admins bypass this
    if (!isAdmin) {
        const bucket = userBuckets.get(userId) || { windowStart: now, count: 0 };
        if (now - bucket.windowStart > WINDOW_MS) {
            bucket.windowStart = now;
            bucket.count = 0;
        }
        bucket.count += 1;
        userBuckets.set(userId, bucket);

        if (bucket.count > USER_MAX) {
            const retryAfter = Math.ceil((WINDOW_MS - (now - bucket.windowStart)) / 1000);
            reply.header('Retry-After', retryAfter);
            return reply.code(429).send({ error: 'Rate limit exceeded. Please wait and try again.', retry_after: retryAfter });
        }
    }
}
