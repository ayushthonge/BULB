import { dbInsert } from './db';

export type RequestMetric = {
    userId?: string | null;
    path: string;
    statusCode: number;
    latencyMs: number;
    tokensIn?: number;
    tokensOut?: number;
    modelStatus?: string;
    modelError?: string;
};

export async function recordRequestMetric(metric: RequestMetric) {
    try {
        await dbInsert('request_metrics', {
            user_id: metric.userId ?? null,
            path: metric.path,
            status_code: metric.statusCode,
            latency_ms: metric.latencyMs,
            tokens_in: metric.tokensIn ?? 0,
            tokens_out: metric.tokensOut ?? 0,
            model_status: metric.modelStatus ?? null,
            model_error: metric.modelError ?? null,
            created_at: new Date().toISOString()
        });
    } catch (err) {
        // Swallow errors to avoid impacting user traffic
        console.error('Failed to record metric', (err as Error)?.message);
    }
}
