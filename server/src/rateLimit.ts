import { FastifyReply, FastifyRequest } from 'fastify';

// Simple in-memory token bucket per user and global. Suitable for single-instance deployments.
// For multi-instance, move this to Redis/shared store.
const WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const USER_MAX_REQUESTS = 60; // balanced: not too low, not too high
const GLOBAL_MAX_REQUESTS = 1200; // across all users per window

const userBuckets: Map<string, { windowStart: number; count: number }> = new Map();
let globalWindowStart = Date.now();
let globalCount = 0;

function shouldThrottle(count: number, limit: number) {
    return count > limit;
}

export async function rateLimit(request: FastifyRequest, reply: FastifyReply) {
    const now = Date.now();
    const userId = (request as any).user?.id || 'anonymous';

    // Global window
    if (now - globalWindowStart > WINDOW_MS) {
        globalWindowStart = now;
        globalCount = 0;
    }
    globalCount += 1;
    if (shouldThrottle(globalCount, GLOBAL_MAX_REQUESTS)) {
        return reply.code(429).send({ error: 'Global rate limit exceeded. Please retry shortly.' });
    }

    // Per-user window
    const bucket = userBuckets.get(userId) || { windowStart: now, count: 0 };
    if (now - bucket.windowStart > WINDOW_MS) {
        bucket.windowStart = now;
        bucket.count = 0;
    }
    bucket.count += 1;
    userBuckets.set(userId, bucket);

    if (shouldThrottle(bucket.count, USER_MAX_REQUESTS)) {
        return reply.code(429).send({ error: 'Rate limit exceeded. Please retry in a few minutes.' });
    }
}
