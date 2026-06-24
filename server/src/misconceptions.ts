import crypto from 'crypto';
import { config } from './config';
import { validateSocraticQuestion } from './guards/outputGuard';

export type MisconceptionId =
    | 'off-by-one'
    | 'mutation-vs-reassignment'
    | 'return-vs-print'
    | 'async-vs-parallel'
    | 'null-checks'
    | 'scope-shadowing'
    | 'statefulness'
    | 'side-effects'
    | 'operator-precedence'
    | 'type-coercion'
    | 'infinite-loop'
    | 'recursion-base-case'
    | 'equality-vs-assignment'
    | 'variable-initialization'
    | 'boolean-logic'
    | 'string-immutability';

export type VerdictStatus = 'reinforced' | 'weakened' | 'new' | 'absent';

export interface MisconceptionVerdict {
    id: MisconceptionId;
    status: VerdictStatus;
    certainty: number; // 0-1, kept for training data
    rationale?: string;
}

export interface MisconceptionState {
    map: Map<MisconceptionId, number>;
    learnerConfidence: number;
    lastQuestion: string | null;
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
    },
    {
        id: 'operator-precedence',
        label: 'Operator precedence',
        description: 'Confusion about order of operations: arithmetic, logical, or bitwise.',
        examples: ['a + b * c evaluated left-to-right', '! and && precedence', 'missing parentheses']
    },
    {
        id: 'type-coercion',
        label: 'Type coercion surprises',
        description: 'Implicit type conversion producing unexpected results.',
        examples: ['"5" + 3 === "53"', '[] == false', 'null == undefined']
    },
    {
        id: 'infinite-loop',
        label: 'Infinite loop / missing termination',
        description: 'Loop never terminates because exit condition is unreachable or wrong.',
        examples: ['while(true) without break', 'counter never incremented', 'wrong direction increment']
    },
    {
        id: 'recursion-base-case',
        label: 'Recursion base case errors',
        description: 'Missing, unreachable, or incorrect base case in recursive functions.',
        examples: ['no return for base case', 'base case never reached', 'wrong base case value']
    },
    {
        id: 'equality-vs-assignment',
        label: 'Equality vs assignment',
        description: 'Using = when == or === is intended, or vice versa.',
        examples: ['if (x = 5)', '== vs === in JS', 'assignment in condition']
    },
    {
        id: 'variable-initialization',
        label: 'Uninitialized variables',
        description: 'Reading a variable before assigning it a value.',
        examples: ['undefined accumulator', 'using var before let declaration', 'NaN from uninitialized number']
    },
    {
        id: 'boolean-logic',
        label: 'Boolean logic errors',
        description: "Mistakes with De Morgan's law, short-circuit evaluation, or negation.",
        examples: ['!(a && b) vs !a && !b', 'or vs and confusion', 'double negation']
    },
    {
        id: 'string-immutability',
        label: 'String immutability',
        description: 'Attempting to mutate a string in-place when strings are immutable.',
        examples: ['str[0] = "X" does nothing', 'expecting .replace to modify in-place']
    }
];

const CLAMP = (n: number) => Math.min(1, Math.max(0, n));

// Pedagogical thresholds are owned by config.ts (env-overridable) so the values
// reported in the paper stay in sync with what actually runs. See docs/PLAN.md §4.
export const NEUTRAL_CONFIDENCE = config.thresholds.neutralConfidence;
const DELTA_UP = config.thresholds.deltaUp;
const DELTA_DOWN = config.thresholds.deltaDown;
const DECAY = config.thresholds.decay;
const RESOLUTION_THRESHOLD = config.thresholds.resolutionThreshold;

export function createSessionState(): MisconceptionState {
    return {
        map: new Map(),
        learnerConfidence: 0.5,
        lastQuestion: null,
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

export function pickTopMisconceptions(
    state: MisconceptionState,
    maxCount: number = 2,
    minConfidence: number = 0.5
): { id: MisconceptionId; confidence: number }[] {
    return Array.from(state.map.entries())
        .map(([id, confidence]) => ({ id, confidence }))
        .filter(entry => entry.confidence >= minConfidence)
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, maxCount);
}

export type Strategy = 'diagnostic' | 'narrowing' | 'conceptual-contrast' | 'reflective';

export function chooseStrategy(
    intent: 'debugging' | 'explanation' | 'unknown',
    messageIntent: MessageIntent,
    targetedMisconception: MisconceptionId | null
): Strategy {
    if (!targetedMisconception) {
        return 'diagnostic';
    }
    if (messageIntent === 'solution_request') {
        return 'conceptual-contrast';
    }
    if (messageIntent === 'debugging' || intent === 'debugging') {
        return 'narrowing';
    }
    if (messageIntent === 'conceptual' || intent === 'explanation') {
        return 'reflective';
    }
    if (messageIntent === 'clarification') {
        return 'diagnostic';
    }
    return 'diagnostic';
}

export type MessageIntent = 'solution_request' | 'debugging' | 'conceptual' | 'clarification' | 'off_topic';

function classifyMessageIntent(message: string): MessageIntent {
    const lower = message.toLowerCase().trim();
    const wordCount = lower.split(/\s+/).length;

    // Short acknowledgments (< 4 words with no question mark) -> conceptual
    if (wordCount <= 3 && !/\?/.test(message)) {
        return 'conceptual';
    }

    // Off-topic detection: clearly unrelated to programming/code
    if (/\b(weather|sports|movie|music|recipe|cook|football|cricket|basketball|dating|boyfriend|girlfriend|politics|election|stock|crypto|bitcoin|homework for (english|history|math|bio)|write (me )?(an? )?(essay|poem|story|email|letter)|tell (me )?(a )?joke|who (is|are) you|what('s| is) your name|are you (a |an )?(human|robot|ai|bot)|sing|play|game)\b/.test(lower) &&
        !/\b(code|function|variable|loop|array|string|error|bug|class|method|return|parameter|argument|compile|runtime)\b/.test(lower)) {
        return 'off_topic';
    }

    // Solution-seeking: explicit requests for answers/code
    if (/\b(give me|just tell|what is the answer|full solution|complete solution|show (me )?the (code|answer|solution)|write (it|the code|this) for me|can you (just )?(solve|fix|do) (it|this)|i give up|please (just )?(tell|show|give))\b/.test(lower)) {
        return 'solution_request';
    }

    // Debugging: error-related or investigating behavior
    if (/\b(error|exception|stack\s*trace|bug|fails?|fix(ed|ing)?|debug(ging)?|crash(es|ed)?|broken|wrong output|doesn'?t work|not working|unexpected|infinite loop|off by one|index out|segfault|runtime)\b/.test(lower)) {
        return 'debugging';
    }

    // Clarification: asking about the tutor's question or terminology
    if (/\b(what do you mean|which one|clarif(y|ication)|can you (rephrase|explain the question)|i don'?t understand (the|your) question|what (exactly|specifically))\b/.test(lower)) {
        return 'clarification';
    }

    // Code snippet detection: if message contains code-like content, likely debugging
    if (/[{};]|=>|function\s|const\s|let\s|var\s|for\s*\(|while\s*\(|if\s*\(/.test(message)) {
        return 'debugging';
    }

    return 'conceptual';
}

export function inferIntentAndConfidence(message: string, priorConfidence: number) {
    const lower = message.toLowerCase();
    const wordCount = lower.split(/\s+/).length;
    let intent: 'debugging' | 'explanation' | 'unknown' = 'unknown';

    if (/\b(error|bug|fix|crash|broken|wrong|fails?|debug)\b/.test(lower)) {
        intent = 'debugging';
    }
    if (/\b(explain|why|how does|what does|understand|concept|meaning)\b/.test(lower)) {
        intent = 'explanation';
    }

    let confidence = priorConfidence;
    let signalDirection = 0; // +1 positive, -1 negative, 0 neutral

    // --- STRONG POSITIVE SIGNALS (understanding demonstrated) ---

    // Student identifies the problem themselves
    if (/\b(the (problem|issue|bug) is|i (see|found|noticed) (that|the)|it('s| is) because|the reason is)\b/.test(lower)) {
        confidence += 0.15;
        signalDirection = 1;
    }
    // Student explains their reasoning (substantive: at least 10 chars after trigger)
    if (/\b(i think .{10,}because|so (that|it) (means|would)|if .{5,} then)\b/.test(lower)) {
        confidence += 0.12;
        signalDirection = 1;
    }
    // Student tests a hypothesis
    if (/\b(what if (i|we)|let me try|i('ll| will) try|would it work if|if i change)\b/.test(lower)) {
        confidence += 0.10;
        signalDirection = 1;
    }
    // Student corrects themselves (strongest positive signal)
    if (/\b(wait,? (actually|no)|i was wrong|actually,? it('s| is)|oh,? i see|now i (understand|get it))\b/.test(lower)) {
        confidence += 0.18;
        signalDirection = 1;
    }
    // Student uses correct technical terminology in context (>8 words to avoid trivial use)
    if (wordCount > 8 && /\b(null check|base case|off.by.one|boundary|edge case|return value|scope|initialization|termination condition|type coercion|operator precedence|boolean logic|recursion|immutable)\b/.test(lower)) {
        confidence += 0.08;
        signalDirection = 1;
    }

    // --- STRONG NEGATIVE SIGNALS ---

    // Total confusion
    if (/\b(i (have no|don'?t have any) idea|completely (lost|confused)|no clue)\b/.test(lower) || /\?{2,}|\.{3,}/.test(message)) {
        confidence -= 0.15;
        signalDirection = -1;
    }
    // Asking for direct answers
    if (/\b(just tell me|give me the answer|what('s| is) the (answer|solution|fix))\b/.test(lower)) {
        confidence -= 0.12;
        signalDirection = -1;
    }
    // Mild uncertainty
    if (/\b(i'?m not sure|confused|stuck|i don'?t (know|understand|get))\b/.test(lower)) {
        confidence -= 0.10;
        signalDirection = -1;
    }
    // Tentative but attempting (mild positive)
    if (/\b(i think|maybe|perhaps|possibly|could it be)\b/.test(lower)) {
        confidence += 0.05;
        signalDirection = signalDirection || 1;
    }
    // Very short non-advancing response (< 4 words, no reasoning)
    if (wordCount <= 3 && !/\b(because|so|therefore|means)\b/.test(lower)) {
        confidence -= 0.05;
        signalDirection = -1;
    }

    confidence = CLAMP(confidence);
    const messageIntent = classifyMessageIntent(message);

    return { intent, confidence, messageIntent, signalDirection };
}

export interface LearnerSignals {
    /** Explicit closure / comprehension ("now I get it", "makes sense", "thanks"). */
    understanding: boolean;
    /** Articulating a cause or self-correcting ("the problem is...", "it's because..."). */
    articulatedCause: boolean;
    /** Expressed confusion / being stuck. */
    confusion: boolean;
    /** Explicitly asking for the answer to be handed over. */
    solutionSeeking: boolean;
}

/**
 * Detect pedagogically meaningful signals in a learner utterance. These feed
 * the resolution detector and frustration handling. Pure and regex-based so
 * they cost nothing and are deterministic/testable. (Note: causal words like
 * "because" are fine FROM the learner — they are only forbidden in tutor output.)
 */
export function detectLearnerSignals(message: string): LearnerSignals {
    const lower = (message || '').toLowerCase();

    const understanding =
        /\b(now i (understand|get it|see)|i (understand|get) it now|that makes sense|makes sense now|i see (it )?now|oh,? i see|got it|gotcha|that('s| is) (clear|helpful))\b/.test(lower) &&
        !/\b(do(n'?t| not)|never|not really|still (don'?t|not))\s+(understand|get|see|make sense)\b/.test(lower);

    const articulatedCause =
        /\b(the (problem|issue|bug|error|reason) is|it'?s because|that'?s because|i (see|realize|notice|found|think) (that|the|it|i)|so it (means|happens|would)|i was wrong|actually,? (it|the|i))\b/.test(lower);

    const confusion =
        /\b(i'?m (confused|lost|stuck)|completely (lost|confused)|no (idea|clue)|i (?:still |really |just )?do(?:n'?t| not) (?:understand|get|know))\b/.test(lower) ||
        /\?{2,}/.test(message || '');

    const solutionSeeking =
        /\b(just tell me|give me the (answer|solution|code|fix)|what'?s the (answer|fix|solution)|do it for me|fix it for me|i give up)\b/.test(lower);

    return { understanding, articulatedCause, confusion, solutionSeeking };
}

export function sanitizeUserInput(input: string) {
    return input
        .replace(/[\u0000-\u001F\u007F]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Back-compat wrapper. The canonical Socratic output validation now lives in
 * guards/outputGuard.ts; this delegates so existing callers keep working.
 */
export function hardValidateQuestion(
    question: string,
    previousQuestion?: string | null,
    hintLevel?: number
) {
    const { valid, reason } = validateSocraticQuestion(question, {
        previousQuestion,
        hintLevel,
    });
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
        case 'operator-precedence':
            return 'Which operation executes first in that expression?';
        case 'type-coercion':
            return 'What type does each operand have before that operation?';
        case 'infinite-loop':
            return 'Under what condition does this loop stop?';
        case 'recursion-base-case':
            return 'When does the recursion stop calling itself?';
        case 'equality-vs-assignment':
            return 'Is that symbol checking a value or changing it?';
        case 'variable-initialization':
            return 'What value does that variable hold before this line runs?';
        case 'boolean-logic':
            return 'What does that combined condition actually evaluate to?';
        case 'string-immutability':
            return 'Does that operation change the original string or create a new one?';
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
        turnIndex: state.turnIndex
    };
}

export function randomSessionId() {
    return crypto.randomBytes(8).toString('hex');
}
