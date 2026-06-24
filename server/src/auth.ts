
import { FastifyRequest, FastifyReply } from 'fastify';
import { dbSelectOne } from './db';
import { config } from './config';

export interface AuthenticatedRequest extends FastifyRequest {
    user?: {
        id: string;
        email: string;
        role: 'admin' | 'student';
    };
}

type CachedUser = { user: AuthenticatedRequest['user'] | null; expires: number };

// Short-lived token -> user cache so we don't hit Postgres on every request.
// Negative results are cached too (briefly) to blunt bad-token hammering.
const tokenCache = new Map<string, CachedUser>();

export function invalidateAuthCache(token?: string) {
    if (token) tokenCache.delete(token);
    else tokenCache.clear();
}

async function resolveUser(token: string): Promise<AuthenticatedRequest['user'] | null> {
    const ttl = config.authCacheTtlMs;
    if (ttl > 0) {
        const cached = tokenCache.get(token);
        if (cached && cached.expires > Date.now()) {
            return cached.user;
        }
    }

    const row = await dbSelectOne('whitelist_users', 'email, role', { token, active: true });
    const user = row
        ? { id: row.email, email: row.email, role: (row.role || 'student') as 'admin' | 'student' }
        : null;

    if (ttl > 0) {
        // Cache misses for a shorter window so a freshly added token activates quickly.
        const expires = Date.now() + (user ? ttl : Math.min(ttl, 10000));
        tokenCache.set(token, { user, expires });
        if (tokenCache.size > 5000) tokenCache.clear(); // crude bound
    }
    return user;
}

export const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;

    if (!authHeader) {
        return reply.code(401).send({ error: 'Missing Authorization header' });
    }

    const token = authHeader.replace('Bearer ', '').trim();

    if (!token) {
        return reply.code(401).send({ error: 'Empty token' });
    }

    try {
        const user = await resolveUser(token);

        if (!user) {
            return reply.code(401).send({
                error: 'Invalid or inactive token',
                hint: "Use Command Palette > 'Socratic: Set Auth Token' with the token provided by your instructor."
            });
        }

        (request as AuthenticatedRequest).user = user;
    } catch (err) {
        console.error('Auth lookup failed:', (err as Error)?.message);
        return reply.code(401).send({ error: 'Authentication failed' });
    }
};

export const requireAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    const req = request as AuthenticatedRequest;
    if (req.user?.role !== 'admin') {
        return reply.code(403).send({ error: 'Admin access required' });
    }
};
