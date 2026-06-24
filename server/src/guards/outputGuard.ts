/**
 * Output guard — the constraint-enforcement layer the paper calls for.
 *
 * The language model is treated as an untrusted generator: every candidate
 * tutor utterance is validated here before it can reach the learner. A valid
 * Socratic move is a SINGLE short question that contains no code, no concrete
 * fix, no explanation, and no step list, and that does not merely repeat the
 * previous question.
 *
 * `validateSocraticQuestion` is pure so it can be unit-tested against a corpus
 * of adversarial / leaky outputs, and is the single source of truth that both
 * the generator retry loop and the legacy `hardValidateQuestion` rely on.
 */

export type OutputViolation =
    | 'empty'
    | 'no_question_mark'
    | 'multiple_questions'
    | 'contains_code'
    | 'directive_or_fix'
    | 'explanation'
    | 'reveals_answer'
    | 'step_list'
    | 'too_long'
    | 'too_many_words'
    | 'duplicate_of_previous'
    | 'not_interrogative';

export interface SocraticValidation {
    valid: boolean;
    reason: string | null;
    violations: OutputViolation[];
}

const VIOLATION_REASON: Record<OutputViolation, string> = {
    empty: 'Empty response',
    no_question_mark: 'Response is not a question',
    multiple_questions: 'Response contains more than one question',
    contains_code: 'Response contains code or markup',
    directive_or_fix: 'Response gives a directive or concrete fix',
    explanation: 'Response explains rather than asks',
    reveals_answer: 'Response states the answer',
    step_list: 'Response contains steps or a list',
    too_long: 'Response is too long for this hint level',
    too_many_words: 'Response exceeds the word limit',
    duplicate_of_previous: 'Response is too similar to the previous question',
    not_interrogative: 'Response is not phrased as a question',
};

const MAX_WORDS = 25;
const WH_OR_AUX =
    /\b(what|why|how|when|where|which|who|whose|whom|can|could|do|does|did|is|are|was|were|will|would|should|have|has|had|if|might|may)\b/i;

/** Directives / advice / concrete fixes — the tutor must never tell. */
const DIRECTIVE_PATTERNS: RegExp[] = [
    /\byou\s+(should|need\s+to|have\s+to|must|ought\s+to)\b/i,
    /\b(the\s+)?(fix|solution|answer|correct\s+way)\s+(is|would\s+be)\b/i,
    /\bmake\s+sure\s+(to|you|that)\b/i,
    /\bbe\s+sure\s+to\b/i,
    /\b(try|consider)\s+(using|adding|removing|replacing|changing|setting|initializing|returning|moving|wrapping)\b/i,
    /\bjust\s+(add|change|use|remove|replace|set|return|write|put|call|move|wrap)\b/i,
    /\bsimply\s+\w+/i,
    /\bhere(?:'s| is)\s+(how|what|the)\b/i,
    /\ball\s+you\s+(have\s+to|need\s+to|need)\b/i,
    /\byou\s+(can|could)\s+(fix|solve|resolve)\b/i,
];

/** Explanatory / causal phrasing — the tutor must ask, not explain. */
const EXPLANATION_PATTERNS: RegExp[] = [
    /\bbecause\b/i,
    /\bfor\s+example\b/i,
    /\bthat(?:'s| is)\s+(why|because)\b/i,
    /\bthe\s+reason\s+(is|why)\b/i,
    /\bthis\s+(means|is\s+because|happens\s+because)\b/i,
    /\bin\s+other\s+words\b/i,
    /\bnote\s+that\b/i,
    /\bkeep\s+in\s+mind\b/i,
];

/** Declarative statements of the answer/diagnosis. */
const REVEALS_ANSWER_PATTERNS: RegExp[] = [
    /\b(the\s+)?(problem|bug|issue|error|mistake)\s+is\s+(that|in|the|your|you|a|an|caused)\b/i,
    /\bthis\s+(is|will)\s+(cause|causing|throw|return|produce)\b/i,
    /\byour\s+code\s+(is|does|will|should)\b/i,
];

const STEP_PATTERNS: RegExp[] = [
    /\bstep\s*(\d|one|two|three)\b/i,
    /(^|\s)\d+\.\s/,
    /(^|[\s])[-•*]\s+\w/,
    /\bfirst[, ][^?]*\bthen\b/i,
    /\bfirst[, ][^?]*\bsecond[, ]/i,
];

function anyMatch(text: string, patterns: RegExp[]): boolean {
    return patterns.some(re => re.test(text));
}

/** Inline-backtick or fenced/markup snippets that constitute code. */
function containsCode(text: string): boolean {
    if (/```|<[^>]+>/.test(text)) return true;
    const inline = text.match(/`([^`]+)`/g);
    if (inline) {
        for (const span of inline) {
            const inner = span.slice(1, -1);
            if (inner.length > 30 || /[;{}]|=>|\breturn\b/.test(inner)) {
                return true;
            }
        }
    }
    return false;
}

function similarity(a: string, b: string): number {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    const na = norm(a);
    const nb = norm(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    const wa = new Set(na.split(/\s+/));
    const wb = new Set(nb.split(/\s+/));
    let inter = 0;
    wa.forEach(w => {
        if (wb.has(w)) inter += 1;
    });
    return inter / Math.max(wa.size, wb.size);
}

export function validateSocraticQuestion(
    question: string,
    options: { previousQuestion?: string | null; hintLevel?: number } = {}
): SocraticValidation {
    const violations: OutputViolation[] = [];
    const text = (question || '').trim();

    if (!text) {
        return { valid: false, reason: VIOLATION_REASON.empty, violations: ['empty'] };
    }

    const questionMarks = (text.match(/\?/g) || []).length;
    if (questionMarks === 0) violations.push('no_question_mark');
    if (questionMarks > 1) violations.push('multiple_questions');

    if (containsCode(text)) violations.push('contains_code');
    if (anyMatch(text, DIRECTIVE_PATTERNS)) violations.push('directive_or_fix');
    if (anyMatch(text, EXPLANATION_PATTERNS)) violations.push('explanation');
    if (anyMatch(text, REVEALS_ANSWER_PATTERNS)) violations.push('reveals_answer');
    if (anyMatch(text, STEP_PATTERNS)) violations.push('step_list');

    const level = options.hintLevel ?? 1;
    const maxChars = level === 1 ? 100 : level === 2 ? 130 : 160;
    if (text.length > maxChars) violations.push('too_long');

    const wordCount = text.split(/\s+/).filter(Boolean).length;
    if (wordCount > MAX_WORDS) violations.push('too_many_words');

    if (!WH_OR_AUX.test(text)) violations.push('not_interrogative');

    if (options.previousQuestion && similarity(text, options.previousQuestion) > 0.68) {
        violations.push('duplicate_of_previous');
    }

    const valid = violations.length === 0;
    return {
        valid,
        reason: valid ? null : VIOLATION_REASON[violations[0]],
        violations,
    };
}

/**
 * Build a corrective instruction that names what the previous attempt did
 * wrong, so the regeneration prompt steers the model away from the violation
 * instead of blindly retrying the same prompt.
 */
export function correctiveInstruction(violations: OutputViolation[]): string {
    const tips: string[] = [];
    if (violations.includes('multiple_questions')) tips.push('Ask exactly ONE question (one question mark).');
    if (violations.includes('contains_code')) tips.push('Do NOT include any code, symbols, or markup.');
    if (violations.includes('directive_or_fix')) tips.push('Do NOT tell them what to do or suggest a fix.');
    if (violations.includes('explanation') || violations.includes('reveals_answer'))
        tips.push('Do NOT explain or state the cause; only ask.');
    if (violations.includes('step_list')) tips.push('No steps or lists.');
    if (violations.includes('too_long') || violations.includes('too_many_words'))
        tips.push('Keep it under 20 words.');
    if (violations.includes('duplicate_of_previous')) tips.push('Ask something clearly DIFFERENT from the previous question.');
    if (violations.includes('no_question_mark') || violations.includes('not_interrogative'))
        tips.push('Phrase it as a single direct question ending in a question mark.');
    return tips.length ? 'Your previous attempt was rejected. ' + tips.join(' ') : '';
}
