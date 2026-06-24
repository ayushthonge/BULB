
import { FastifyRequest, FastifyReply } from 'fastify';
import { dbSelectOne } from './db';

export interface AuthenticatedRequest extends FastifyRequest {
    user?: {
        id: string;
        email: string;
        role: 'admin' | 'student';
    };
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
        const row = await dbSelectOne('whitelist_users', 'email, role', { token, active: true });

        if (!row) {
            return reply.code(401).send({
                error: 'Invalid or inactive token',
                hint: "Use Command Palette > 'Socratic: Set Auth Token' with the token provided by your instructor."
            });
        }

        (request as AuthenticatedRequest).user = {
            id: row.email,
            email: row.email,
            role: row.role || 'student'
        };
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
