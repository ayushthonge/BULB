import crypto from 'crypto';

export type MisconceptionId =
    | 'off-by-one'
    | 'mutation-vs-reassignment'
    | 'return-vs-print'
    | 'async-vs-parallel'
    | 'null-checks'
    | 'scope-shadowing'
    | 'statefulness'
    | 'side-effects';

export type VerdictStatus = 'reinforced' | 'weakened' | 'new' | 'absent';

export interface MisconceptionVerdict {
    id: MisconceptionId;
    status: VerdictStatus;
    certainty: number; // 0-1
    rationale?: string;
}

export interface MisconceptionState {
    map: Map<MisconceptionId, number>;
    learnerConfidence: number;
    lastQuestion: string | null;
    summary: string;
    turnIndex: number;
}

export interface MisconceptionUpdateResult {
    deltas: Record<MisconceptionId, number>;
    resolutionEvents: MisconceptionId[];
}

export const MISCONCEPTION_TAXONOMY: { id: MisconceptionId; label: string; description: string; examples: string[] }[] = [
    {
        id: 'off-by-one',
        label: 'Off-by-one errors',
        description: 'Loops or indexing that miss first/last element or iterate one step too far.',
        examples: ['for (i <= length)', 'index starts at 1 vs 0', 'using <= instead of <']
    },
    {
        id: 'mutation-vs-reassignment',
        label: 'Mutation vs reassignment',
        description: 'Changing an object in place vs creating a new object or variable binding.',
        examples: ['list.append vs list = list + [x]', 'spreading vs push']
    },
    {
        id: 'return-vs-print',
        label: 'Return vs print',
        description: 'Returning a value from a function vs printing or logging it.',
        examples: ['missing return', 'using print instead of returning']
    },
    {
        id: 'async-vs-parallel',
        label: 'Async does not mean parallel',
        description: 'Concurrency vs true parallelism; awaiting vs spawning threads.',
        examples: ['await inside loop', 'thinking async speeds CPU work']
    },
    {
        id: 'null-checks',
        label: 'Null/undefined checks',
        description: 'Accessing properties before null/undefined guards; missing default paths.',
        examples: ['cannot read property of undefined', 'optional chaining']
    },
    {
        id: 'scope-shadowing',
        label: 'Scope / shadowing',
        description: 'Variables shadowed or out of scope leading to wrong references.',
        examples: ['let inside block not visible', 'this vs outer variable']
    },
    {
        id: 'statefulness',
        label: 'Stateful logic assumptions',
        description: 'Forgetting to reset or initialize state between calls/iterations.',
        examples: ['stale cache', 'accumulator not reset']
    },
    {
        id: 'side-effects',
        label: 'Side-effects and ordering',
        description: 'Order-dependent mutations cause unexpected outputs.',
        examples: ['mutating input array then reusing']
    }
];

const CLAMP = (n: number) => Math.min(1, Math.max(0, n));

export const NEUTRAL_CONFIDENCE = 0.32;
const DELTA_UP = 0.22;
const DELTA_DOWN = 0.18;
const DECAY = 0.9;
const RESOLUTION_THRESHOLD = 0.18;

export function createSessionState(): MisconceptionState {
    return {
        map: new Map(),
        learnerConfidence: 0.5,
        lastQuestion: null,
        summary: '',
        turnIndex: 0
    };
}

export function applyVerdicts(
    state: MisconceptionState,
    verdicts: MisconceptionVerdict[]
): MisconceptionUpdateResult {
    const deltas: Record<MisconceptionId, number> = Object.create(null);
    const resolutionEvents: MisconceptionId[] = [];

    verdicts.forEach(v => {
        const prev = state.map.get(v.id) ?? NEUTRAL_CONFIDENCE;
        let next = prev;

        switch (v.status) {
            case 'reinforced':
                next = prev + DELTA_UP;
                break;
            case 'weakened':
                next = prev - DELTA_DOWN;
                break;
            case 'new':
                next = NEUTRAL_CONFIDENCE + DELTA_UP / 2;
                break;
            case 'absent':
                next = prev * DECAY;
                break;
        }

        next = CLAMP(next);
        deltas[v.id] = next - prev;

        if (next < RESOLUTION_THRESHOLD) {
            state.map.delete(v.id);
            resolutionEvents.push(v.id);
        } else {
            state.map.set(v.id, next);
        }
    });

    // Apply decay to misconceptions not mentioned at all
    MISCONCEPTION_TAXONOMY.forEach(item => {
        const mentioned = verdicts.some(v => v.id === item.id);
        if (!mentioned && state.map.has(item.id)) {
            const prev = state.map.get(item.id)!;
            const next = CLAMP(prev * DECAY);
            if (next < RESOLUTION_THRESHOLD) {
                state.map.delete(item.id);
                resolutionEvents.push(item.id);
                deltas[item.id] = -prev;
            } else {
                state.map.set(item.id, next);
                deltas[item.id] = next - prev;
            }
        }
    });

    return { deltas, resolutionEvents };
}

export function pickTopMisconception(state: MisconceptionState) {
    let top: { id: MisconceptionId; confidence: number } | null = null;
    for (const [id, confidence] of state.map.entries()) {
        if (!top || confidence > top.confidence) {
            top = { id, confidence };
        }
    }
    return top;
}

export type Strategy = 'diagnostic' | 'narrowing' | 'conceptual-contrast' | 'reflective';

export function chooseStrategy(intent: 'debugging' | 'explanation' | 'unknown',
    learnerConfidence: number,
    topConfidence: number | null): Strategy {
    if (topConfidence && topConfidence > 0.75) {
        return 'conceptual-contrast';
    }
    if (intent === 'debugging') {
        return learnerConfidence > 0.55 ? 'narrowing' : 'diagnostic';
    }
    if (intent === 'explanation') {
        return 'reflective';
    }
    return 'diagnostic';
}

export type MessageIntent = 'solution_request' | 'debugging' | 'conceptual' | 'clarification';

function classifyMessageIntent(message: string): MessageIntent {
    const lower = message.toLowerCase();

    const wantsSolution = /give me|just tell|what is the answer|full solution|complete solution|show (me )?the code/.test(lower);
    if (wantsSolution) {
        return 'solution_request';
    }

    const debuggingSignals = /error|exception|stack trace|bug|fails?|fix|debug|crash/.test(lower) || /\?/.test(message);
    if (debuggingSignals) {
        return 'debugging';
    }

    const clarificationSignals = /meaning|clarif(y|ication)|what do you mean|which one/.test(lower);
    if (clarificationSignals) {
        return 'clarification';
    }

    return 'conceptual';
}

export function inferIntentAndConfidence(message: string, priorConfidence: number) {
    const lower = message.toLowerCase();
    let intent: 'debugging' | 'explanation' | 'unknown' = 'unknown';

    if (/[?]/.test(message)) {
        intent = 'debugging';
    }
    if (lower.includes('explain') || lower.includes('why')) {
        intent = 'explanation';
    }

    let confidence = priorConfidence;
    if (lower.includes("i'm not sure") || lower.includes('confused') || lower.includes('stuck')) {
        confidence -= 0.08;
    }
    if (lower.includes('i think') || lower.includes('maybe')) {
        confidence += 0.04;
    }
    confidence = CLAMP(confidence);

    const messageIntent = classifyMessageIntent(message);

    return { intent, confidence, messageIntent };
}

export function sanitizeUserInput(input: string) {
    return input
        .replace(/[\u0000-\u001F\u007F]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

export function hardValidateQuestion(question: string, previousQuestion?: string | null) {
    const multipleQuestions = (question.match(/\?/g) || []).length > 1;
    const hasCode = /```|\bcode\b|\bclass\b|<[^>]+>/i.test(question);
    const hasSteps = /step\s+\d|first,|second,|third,/i.test(question);
    const tooLong = question.length > 160;
    const hasExplanation = /because|for example|you should/i.test(question);

    // Check if question is too similar to previous
    let isSameAsPrevious = false;
    if (previousQuestion) {
        const normalizedCurrent = question.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
        const normalizedPrevious = previousQuestion.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
        
        // Exact match or very high similarity
        if (normalizedCurrent === normalizedPrevious) {
            isSameAsPrevious = true;
        } else {
            // Check if 80%+ of words are the same
            const currentWords = new Set(normalizedCurrent.split(/\s+/));
            const previousWords = new Set(normalizedPrevious.split(/\s+/));
            const intersection = new Set([...currentWords].filter(w => previousWords.has(w)));
            const similarity = intersection.size / Math.max(currentWords.size, previousWords.size);
            if (similarity > 0.8) {
                isSameAsPrevious = true;
            }
        }
    }

    const valid = !multipleQuestions && !hasCode && !hasSteps && !tooLong && !hasExplanation && !isSameAsPrevious;
    const reason = valid ? null : isSameAsPrevious ? 'Question too similar to previous' : 'Question validation failed (multiple questions / code / steps / explanation / too long)';
    return { valid, reason };
}

export function fallbackQuestion(targeted: MisconceptionId | null): string {
    if (!targeted) {
        return 'What specific case still seems unclear?';
    }
    const lookup = MISCONCEPTION_TAXONOMY.find(t => t.id === targeted);
    switch (targeted) {
        case 'off-by-one':
            return 'What happens at the first and last index of the loop?';
        case 'mutation-vs-reassignment':
            return 'How does the data change after this line compared to before it?';
        case 'return-vs-print':
            return 'Where does the value go after this function runs?';
        case 'async-vs-parallel':
            return 'Which parts actually wait for others to finish here?';
        case 'null-checks':
            return 'What if the value is null before this access?';
        case 'scope-shadowing':
            return 'Which variable name is actually read at this point?';
        case 'statefulness':
            return 'When is the state reset between runs?';
        case 'side-effects':
            return 'What else changes when this code executes in this order?';
        default:
            return lookup?.label ? `What is uncertain about ${lookup.label.toLowerCase()} here?` : 'What part needs another look?';
    }
}

export function snapshotState(state: MisconceptionState) {
    const entries = Array.from(state.map.entries()).map(([id, confidence]) => ({ id, confidence }));
    return {
        map: entries,
        learnerConfidence: state.learnerConfidence,
        lastQuestion: state.lastQuestion,
        summary: state.summary,
        turnIndex: state.turnIndex
    };
}

export function randomSessionId() {
    return crypto.randomBytes(8).toString('hex');
}
