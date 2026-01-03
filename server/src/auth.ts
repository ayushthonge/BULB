
import { FastifyRequest, FastifyReply } from 'fastify';
import { supabase } from './supabase';

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

    const token = authHeader.replace('Bearer ', '');

    try {
        console.log('Verifying token:', token.substring(0, 20) + '...');
        const { data: { user }, error } = await supabase.auth.getUser(token);

        if (error || !user) {
            console.error('--- AUTH ERROR ---');
            console.error('Token provided (first 50 chars):', token.substring(0, 50) + '...');
            console.error('Supabase Error:', JSON.stringify(error, null, 2));
            console.error('User object:', user ? 'Found' : 'Missing');
            return reply.code(401).send({
                error: 'Invalid token',
                details: error?.message || 'User not found in Supabase',
                hint: "Ensure you are using the 'access_token' and not the refresh token or session object."
            });
        }

        // Check user role from public.users table or metadata
        const { data: userData } = await supabase
            .from('users')
            .select('role')
            .eq('id', user.id)
            .single();

        (request as AuthenticatedRequest).user = {
            id: user.id,
            email: user.email!,
            role: userData?.role || 'student' // Default to student
        };

    } catch (err) {
        return reply.code(401).send({ error: 'Authentication failed' });
    }
};

export const requireAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    const req = request as AuthenticatedRequest;
    if (req.user?.role !== 'admin') {
        return reply.code(403).send({ error: 'Admin access required' });
    }
};
