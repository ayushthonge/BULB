/**
 * Input guard — the first deterministic guardrail.
 *
 * Runs before any model call. Its job is NOT to police ordinary
 * "just tell me the answer" frustration (that is legitimate learner behaviour
 * and is handled pedagogically downstream via the solution_request intent).
 *
 * Its job is to catch attempts to subvert the tutor itself:
 *   - prompt injection / instruction override ("ignore previous instructions")
 *   - role / persona hijacking ("you are now a coding assistant that...")
 *   - system-prompt probing ("print your system prompt")
 *   - explicit attempts to disable the Socratic constraint ("stop asking
 *     questions and just give the code")
 *
 * When tripped, we return a fixed Socratic redirect and the caller skips the
 * LLM entirely — this both blocks the attack and costs zero tokens.
 */

export type InputGuardCategory = 'injection' | 'system_probe' | 'jailbreak';

export interface InputGuardResult {
    blocked: boolean;
    category?: InputGuardCategory;
    matched?: string;
    response?: string;
}

const REDIRECT =
    "I can't switch out of tutoring mode, but I'm here to help you get there yourself. " +
    'What are you trying to make the code do, and what is it doing instead?';

/** Instruction-override / injection attempts. */
const INJECTION_PATTERNS: RegExp[] = [
    /\bignore\s+(?:all\s+)?(?:your\s+|the\s+|previous\s+|prior\s+|above\s+)?(?:instructions?|rules?|prompts?|guidelines?|constraints?)\b/i,
    /\bdisregard\s+(?:all\s+)?(?:your\s+|the\s+|previous\s+|prior\s+)?(?:instructions?|rules?|prompts?|guidelines?)\b/i,
    /\bforget\s+(?:everything|all|your|the)\b.{0,30}\b(?:instructions?|rules?|prompts?|said|told)\b/i,
    /\boverride\s+(?:your\s+|the\s+)?(?:instructions?|rules?|settings?|prompt)\b/i,
    /\bnew\s+instructions?\s*:/i,
    /\bsystem\s*(?:prompt|message|instruction)\b/i,
    /\b(?:from\s+now\s+on|starting\s+now)\b.{0,40}\b(?:you\s+(?:will|must|should|are)|answer|give|provide|tell)\b/i,
];

/** Persona / mode hijacking. */
const JAILBREAK_PATTERNS: RegExp[] = [
    /\byou\s+are\s+(?:now\s+)?(?:a|an|my)?\s*(?:helpful\s+)?(?:coding\s+)?(?:assistant|expert|ai|chatbot|developer|tutor\s+that\s+(?:gives|provides|answers))\b/i,
    /\b(?:act|behave|respond|roleplay|role-play)\s+as\s+(?:a|an|if)\b/i,
    /\bpretend\s+(?:to\s+be|you(?:'re| are))\b/i,
    /\b(?:enable|enter|activate)\s+(?:developer|dev|debug|god|dan|unrestricted|jailbreak)\s+mode\b/i,
    /\byou(?:'re| are)\s+no\s+longer\b/i,
    /\b(?:stop|quit|cease)\s+(?:asking|being)\s+(?:questions?|socratic|a\s+tutor)\b.{0,40}\b(?:just|and|give|tell|provide|answer|write)\b/i,
    /\bdo\s+not\s+ask\s+(?:me\s+)?(?:any\s+)?(?:more\s+)?questions?\b/i,
];

/** Attempts to extract the hidden prompt / config. */
const SYSTEM_PROBE_PATTERNS: RegExp[] = [
    /\b(?:print|show|reveal|repeat|output|display|tell\s+me)\b.{0,30}\b(?:your\s+)?(?:system\s+)?(?:prompt|instructions?|rules?|guidelines?|configuration|config)\b/i,
    /\bwhat\s+(?:are|were)\s+(?:your|the)\s+(?:exact\s+)?(?:instructions?|rules?|system\s+prompt|guidelines?)\b/i,
    /\brepeat\s+(?:the\s+)?(?:words?\s+|text\s+)?above\b/i,
];

function firstMatch(text: string, patterns: RegExp[]): string | null {
    for (const re of patterns) {
        const m = re.exec(text);
        if (m) return m[0];
    }
    return null;
}

/**
 * Inspect raw (already sanitized) user input for tutor-subversion attempts.
 * Pure and side-effect free so it is trivially testable.
 */
export function inspectUserInput(message: string): InputGuardResult {
    if (!message || !message.trim()) {
        return { blocked: false };
    }

    // Probe patterns are the most specific, so they win over the broader
    // "mentions the system prompt" injection pattern below.
    const probe = firstMatch(message, SYSTEM_PROBE_PATTERNS);
    if (probe) {
        return { blocked: true, category: 'system_probe', matched: probe, response: REDIRECT };
    }

    const injection = firstMatch(message, INJECTION_PATTERNS);
    if (injection) {
        return { blocked: true, category: 'injection', matched: injection, response: REDIRECT };
    }

    const jailbreak = firstMatch(message, JAILBREAK_PATTERNS);
    if (jailbreak) {
        return { blocked: true, category: 'jailbreak', matched: jailbreak, response: REDIRECT };
    }

    return { blocked: false };
}
