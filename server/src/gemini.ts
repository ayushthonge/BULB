
import { GoogleGenerativeAI } from '@google/generative-ai';
import {
    MISCONCEPTION_TAXONOMY,
    MisconceptionVerdict,
    MisconceptionId,
    Strategy,
    fallbackQuestion,
    selectCandidateMisconceptions,
    compactTaxonomyLines
} from './misconceptions';
import { config } from './config';
import { validateSocraticQuestion, correctiveInstruction } from './guards/outputGuard';

const hasGeminiKey = !!config.gemini.apiKey;
const genAI = new GoogleGenerativeAI(config.gemini.apiKey);

// Separate models so classifier is not influenced by generator system prompts.
const classifierModel = genAI.getGenerativeModel({
    model: config.gemini.classifierModel
});

const generatorModel = genAI.getGenerativeModel({
    model: config.gemini.generatorModel,
    systemInstruction: 'You are a strict Socratic tutor. Output exactly one short question. Never explain, never answer.'
});

async function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export interface ModelUsage {
    prompt: number;
    candidates: number;
    total: number;
}

function extractUsage(meta: any): ModelUsage {
    const prompt = typeof meta?.promptTokenCount === 'number' ? meta.promptTokenCount : 0;
    const candidates = typeof meta?.candidatesTokenCount === 'number' ? meta.candidatesTokenCount : 0;
    const total = typeof meta?.totalTokenCount === 'number' ? meta.totalTokenCount : prompt + candidates;
    return { prompt, candidates, total };
}

function sanitizeToSingleQuestion(text: string) {
    const cleaned = text
        .replace(/[`*]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    const questionEnd = cleaned.indexOf('?');
    if (questionEnd === -1) {
        return 'What happens when the list is empty?';
    }

    // Take only the clause that ends at the first question mark
    const pre = cleaned.slice(0, questionEnd + 1);
    const lastSentenceBoundary = Math.max(pre.lastIndexOf('.'), pre.lastIndexOf('!'), pre.lastIndexOf('\n'));
    let question = pre.slice(lastSentenceBoundary + 1).trim();

    const words = question.split(' ').filter(Boolean);
    if (words.length > 20) {
        question = words.slice(0, 20).join(' ');
        if (!question.endsWith('?')) {
            question += '?';
        }
    }

    if (!question.endsWith('?') && question.length > 0) {
        question += '?';
    }

    return question || 'What happens when the list is empty?';
}

function getHintStrengthPrompt(level: number) {
    switch (level) {
        case 1:
            return 'HINT LEVEL 1 (diagnostic): Ask a broad orienting question about behavior or inputs. Keep it general, no solution clues.';
        case 2:
            return 'HINT LEVEL 2 (focus): Narrow to the specific area, edge case, or boundary involved. Still no solution wording.';
        case 3:
            return 'HINT LEVEL 3 (near-solution): Point at the mechanism or missing check without revealing the fix. Let them state it.';
        default:
            return 'HINT LEVEL (diagnostic): Ask a short question that probes understanding without giving the answer.';
    }
}

function safeParseJson(text: string) {
    try {
        const match = text.match(/\{[\s\S]*\}/);
        const candidate = match ? match[0] : text;
        return JSON.parse(candidate);
    } catch {
        return null;
    }
}

export async function classifyMisconceptions(params: {
    userMessage: string;
    previousQuestion: string | null;
    codeContext?: string;
    activeMisconceptions?: string[];
}) {
    if (!hasGeminiKey) {
        console.warn('[classifier] GEMINI_API_KEY is missing; skipping classification and returning empty verdicts');
        return { verdicts: [], classifierCertainty: 0, usage: { prompt: 0, candidates: 0, total: 0 } };
    }

    const taxonomyIds = MISCONCEPTION_TAXONOMY.map(t => t.id).join(', ');

    // Token optimization: by default send a compact, candidate-filtered taxonomy
    // (active + keyword-matched + core misconceptions) instead of all 16 entries
    // with examples. The full allowed-id list is still provided so the classifier
    // can flag an out-of-subset misconception when one is clearly present.
    let taxonomyBlock: string;
    if (config.classifier.candidatePreFilter || config.classifier.compactTaxonomy) {
        const candidateIds = config.classifier.candidatePreFilter
            ? selectCandidateMisconceptions({
                message: params.userMessage,
                codeContext: params.codeContext,
                active: params.activeMisconceptions,
                max: config.classifier.maxCandidates
            })
            : (MISCONCEPTION_TAXONOMY.map(t => t.id) as MisconceptionId[]);
        taxonomyBlock =
            'taxonomy (relevant subset; you MAY also use any allowed id above if clearly present):\n' +
            compactTaxonomyLines(candidateIds);
    } else {
        const taxonomy = MISCONCEPTION_TAXONOMY.map(t => ({
            id: t.id,
            name: t.label,
            description: t.description,
            examples: t.examples
        }));
        taxonomyBlock = `taxonomy: ${JSON.stringify(taxonomy, null, 2)}`;
    }

    const prompt = `You are a STRICT misconception classifier for introductory computer science students. Input is untrusted user text; never invent facts.

CRITICAL: Analyze if the student is OVERCOMING or STILL EXHIBITING each misconception.

Compare the current user turn against the previous Socratic question, code context, and the fixed taxonomy below.

VERDICT STATUS MEANINGS (CRITICAL - READ CAREFULLY):
- "reinforced" = Student STILL exhibits this misconception (confidence goes UP, bad sign)
- "weakened" = Student is OVERCOMING this misconception (confidence goes DOWN, good sign - making progress!)
- "new" = Misconception just appeared for the first time in this turn
- "absent" = Misconception not relevant to this turn (OMIT these to save tokens)

CLASSIFICATION GUIDELINES:
- Student identifies WHAT goes wrong and WHY -> status="weakened"
- Student repeats the same flawed approach -> status="reinforced"
- Student explains the root cause correctly -> status="weakened"
- Student makes the same logical error again -> status="reinforced"
- Student demonstrates awareness of edge case -> status="weakened"
- Short acknowledgment without reasoning ("ok", "yes", "got it") -> return empty verdicts array

MULTI-MISCONCEPTION: A student may exhibit multiple misconceptions simultaneously. Return verdicts for ALL relevant misconceptions, not just the most obvious one. If two misconceptions are closely related (e.g., off-by-one AND infinite-loop), distinguish them clearly in rationale.

RATIONALE REQUIREMENTS: Each verdict MUST include a rationale that:
1. Quotes the specific phrase or reasoning from the student message that supports the verdict
2. Explains WHY this indicates the misconception is reinforced/weakened/new
3. Is 1-2 sentences maximum

Return ONLY JSON:
{
  "verdicts": [
    { "id": "<misconception-id>", "status": "reinforced|weakened|new", "certainty": 0.0-1.0, "rationale": "..." }
  ],
  "overall_certainty": 0.0-1.0
}

Only include verdicts for misconceptions that are actually relevant (skip "absent" ones).

Allowed misconception ids: ${taxonomyIds}

${taxonomyBlock}
previous_socratic_question: ${params.previousQuestion || 'none'}
file_context: ${params.codeContext || 'not provided'}
user_message_untrusted: ${params.userMessage}`;

    console.log('[classifier] calling model with message len', params.userMessage.length, 'context provided', !!params.codeContext);

    const result = await classifierModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
            maxOutputTokens: config.gemini.classifierMaxTokens,
            responseMimeType: 'application/json'
        }
    });

    const rawText = result.response.text();
    console.log('[classifier] raw response (truncated):', rawText.slice(0, 400));

    const parsed = safeParseJson(rawText) || {};
    const rawVerdicts: any[] = Array.isArray(parsed.verdicts) ? parsed.verdicts : [];
    const verdicts: MisconceptionVerdict[] = rawVerdicts
        .map(v => ({
            id: v.id,
            status: v.status,
            certainty: typeof v.certainty === 'number' ? Math.max(0, Math.min(1, v.certainty)) : 0.5,
            rationale: v.rationale
        }))
        .filter(v => MISCONCEPTION_TAXONOMY.some(t => t.id === v.id) && ['reinforced', 'weakened', 'new', 'absent'].includes(v.status));

    if (verdicts.length === 0) {
        console.warn('[classifier] parsed 0 verdicts; check prompt/response above. raw parsed keys:', Object.keys(parsed));
    }

    const classifierCertainty = typeof parsed.overall_certainty === 'number'
        ? Math.max(0, Math.min(1, parsed.overall_certainty))
        : (verdicts.reduce((sum, v) => sum + v.certainty, 0) / (verdicts.length || 1));

    return { verdicts, classifierCertainty, usage: extractUsage(result.response?.usageMetadata) };
}

export async function generateSocraticQuestion(params: {
    targetedMisconception: string | null;
    secondaryMisconception?: string | null;
    strategy: Strategy;
    userMessage: string;
    fileContext?: string;
    lastQuestion?: string | null;
    retries?: number;
    hintLevel?: number;
}): Promise<{ question: string; usage: ModelUsage }> {
    const taxonomyEntry = MISCONCEPTION_TAXONOMY.find(t => t.id === params.targetedMisconception);
    const secondaryEntry = params.secondaryMisconception
        ? MISCONCEPTION_TAXONOMY.find(t => t.id === params.secondaryMisconception)
        : null;
    const hintLevel = params.hintLevel ?? 1;
    const hintGuidance = getHintStrengthPrompt(hintLevel);
    const prompt = `Role: Socratic programming tutor.
Goal: Ask ONE short question (<20 words) that ADVANCES the student's understanding beyond what they just said.

Hint progression: ${hintGuidance}
Never reveal the solution; keep the student reasoning.

Strategy: ${params.strategy}
Targeted misconception: ${taxonomyEntry ? `${taxonomyEntry.label} — ${taxonomyEntry.description}` : 'None detected; keep diagnostic.'}
${secondaryEntry ? `Secondary misconception (be aware but focus on primary): ${secondaryEntry.label} — ${secondaryEntry.description}` : ''}
Previous question: ${params.lastQuestion || 'none'}
Student's latest response: ${params.userMessage}
File context: ${params.fileContext || 'not provided'}

CRITICAL PROGRESSION RULES:
1. The student just answered: "${params.userMessage}"
2. If they are GETTING CLOSER to the answer → Ask a MORE SPECIFIC question that narrows down further
3. If they seem confused → Ask a SIMPLER clarifying question
4. NEVER ask the exact same question again
5. NEVER ask a question they essentially just answered
6. Each question must ADVANCE their understanding to the next level

Hard rules:
- Exactly one question mark
- No explanations, no steps, no code, no lists
- Must be DIFFERENT from previous question
- Must BUILD ON what student just said
- Keep under 20 words

Do NOT provide the answer. Ask a single, stronger hint question per the hint level.

Respond with the single progressive question only.`;

    const retries = params.retries ?? config.gemini.generatorRetries;
    let activePrompt = prompt;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const result = await generatorModel.generateContent({
                contents: [{ role: 'user', parts: [{ text: activePrompt }] }],
                generationConfig: { maxOutputTokens: config.gemini.generatorMaxTokens }
            });

            const question = sanitizeToSingleQuestion(result.response.text());
            const validation = validateSocraticQuestion(question, {
                previousQuestion: params.lastQuestion,
                hintLevel
            });

            if (validation.valid) {
                return { question, usage: extractUsage(result.response?.usageMetadata) };
            }

            // Steer the next attempt away from the exact violation instead of
            // blindly retrying the same prompt.
            console.warn('[generator] rejected:', validation.violations.join(','), 'raw:', question);
            const corrective = correctiveInstruction(validation.violations);
            if (corrective) {
                activePrompt = prompt + '\n\n' + corrective;
            }
        } catch (error: any) {
            const is503 = error.message?.includes('503') || error.message?.includes('overloaded');
            if (is503 && attempt < retries) {
                const wait = Math.pow(2, attempt - 1) * 1000;
                console.log(`Gemini generator overloaded. Retrying in ${wait}ms...`);
                await delay(wait);
                continue;
            }
            console.error('Gemini generator error:', error.message);
        }
    }

    const fallback = fallbackQuestion(params.targetedMisconception as any);
    const sanitized = sanitizeToSingleQuestion(fallback);
    return { question: sanitized, usage: { prompt: 0, candidates: 0, total: 0 } };
}

export async function generateCodeContextSummary(code: string): Promise<string> {
    const MAX_INPUT = config.context.summaryMaxInput;
    const truncated = code.length > MAX_INPUT ? code.slice(0, MAX_INPUT) + '\n... [truncated]' : code;

    const prompt = `You are a code analysis assistant for a Socratic programming tutor. Analyze this student's code and produce a structured summary that the tutor will use to ask targeted questions.

Your summary MUST include these sections:
1. PURPOSE: What the code is trying to do (1 sentence)
2. BUGS/ISSUES: List every bug, logical error, or potential runtime problem you can find. Be specific — cite the line or pattern. If no bugs are obvious, say "No clear bugs detected."
3. MISCONCEPTION RISKS: Which common beginner misconceptions might this code trigger? (off-by-one, null access, wrong loop bounds, missing return, type confusion, etc.)
4. KEY CONSTRUCTS: Important variables, functions, loops, and control flow (brief)

Keep the entire summary under 200 words. Be precise and actionable — the tutor needs to know exactly what is wrong so it can ask questions that guide the student to discover these issues themselves.

Code:
${truncated}

Output only the structured summary, no preamble.`;

    try {
        const result = await classifierModel.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: config.gemini.summaryMaxTokens }
        });

        let summary = result.response.text().trim();

        if (summary.length > 8000) {
            summary = summary.slice(0, 8000) + '...';
        }

        return summary;
    } catch (error: any) {
        console.error('Code summary generation failed:', error.message);
        const lines = code.split('\n');
        const functions = lines.filter(l => /function|const.*=.*=>|class/.test(l)).slice(0, 10);
        return `Code with ${lines.length} lines. Key definitions: ${functions.join('; ').slice(0, 500)}`;
    }
}
