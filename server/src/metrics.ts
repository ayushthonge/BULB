
import client from 'prom-client';

const register = new client.Registry();

client.collectDefaultMetrics({ register });

export const metrics = {
    hintLevelDistribution: new client.Histogram({
        name: 'hint_level_distribution',
        help: 'Distribution of hint levels or depth provided to students',
        buckets: [1, 2, 3, 4, 5],
        labelNames: ['level']
    }),
    avgTurnsPerSession: new client.Summary({
        name: 'avg_turns_per_session',
        help: 'Average number of turns per chat session',
        percentiles: [0.5, 0.9, 0.99]
    }),
    dropOffRate: new client.Counter({
        name: 'drop_off_rate',
        help: 'Number of sessions dropped after the first response'
    }),
    blockedPrompts: new client.Counter({
        name: 'blocked_prompts',
        help: 'Number of answer-seeking prompts that were blocked'
    }),
    activeSessions: new client.Gauge({
        name: 'active_sessions',
        help: 'Number of currently active chat sessions'
    }),
    resolutionClicks: new client.Counter({
        name: 'resolution_clicks',
        help: 'Number of times users explicitly marked a query as resolved'
    }),
    resolutionTurns: new client.Histogram({
        name: 'resolution_turns',
        help: 'Turns elapsed before user marked resolution',
        buckets: [1, 2, 3, 5, 8, 13, 21]
    }),
    resolutionLatencySeconds: new client.Histogram({
        name: 'resolution_latency_seconds',
        help: 'Seconds from session start to user resolution click',
        buckets: [30, 60, 120, 300, 600, 1200, 1800]
    })
};

// Register custom metrics
Object.values(metrics).forEach(metric => register.registerMetric(metric));

export { register };
