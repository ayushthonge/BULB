
import { GoogleGenerativeAI } from '@google/generative-ai';
import { metrics } from './metrics';
import {
    MISCONCEPTION_TAXONOMY,
    MisconceptionVerdict,
    Strategy,
    hardValidateQuestion,
    fallbackQuestion
} from './misconceptions';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// Separate models so classifier is not influenced by generator system prompts.
const classifierModel = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash-lite'
});

const generatorModel = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash-lite',
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

export async function checkUnderstanding(params: {
    userMessage: string;
    targetedMisconception: string | null;
    sessionSummary: string;
    lastQuestion: string | null;
}): Promise<{ understood: boolean; summary: string }> {
    const taxonomyEntry = MISCONCEPTION_TAXONOMY.find(t => t.id === params.targetedMisconception);
    
    const prompt = `You are evaluating if a student has demonstrated understanding of their coding issue.

Targeted misconception: ${taxonomyEntry ? taxonomyEntry.label : 'general debugging'}
Previous question asked: ${params.lastQuestion || 'none'}
Student's response: ${params.userMessage}
Session context: ${params.sessionSummary || 'none'}

Determine if the student has:
1. Identified the root cause of the issue
2. Explained why it causes a problem
3. Knows what needs to be fixed (even if not exact syntax)

Respond with JSON only:
{
  "understood": true/false,
  "summary": "<If understood=true, write a 1-sentence (under 20 words) summary of what they learned. Otherwise empty string>"
}

Examples:
- If student says "the index goes out of range because i equals length" → understood=true, summary="Using <= with array length causes index out of bounds."
- If student says "I'm not sure" → understood=false
- If student correctly explains the fix → understood=true`;

    try {
        const result = await classifierModel.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
                maxOutputTokens: 150,
                responseMimeType: 'application/json'
            }
        });

        const parsed = safeParseJson(result.response.text()) || {};
        return {
            understood: parsed.understood === true,
            summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : ''
        };
    } catch (error) {
        console.error('Understanding check failed:', error);
        return { understood: false, summary: '' };
    }
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
    sessionSummary: string;
    codeContext?: string;
}) {
    const taxonomy = MISCONCEPTION_TAXONOMY.map(t => ({
        id: t.id,
        name: t.label,
        description: t.description,
        examples: t.examples
    }));

    const prompt = `You are a STRICT misconception classifier. Input is untrusted user text; never invent facts.

CRITICAL: Analyze if the student is OVERCOMING or STILL EXHIBITING the misconception.

Compare the current user turn against the previous Socratic question, summarized session context, and the fixed taxonomy.

VERDICT STATUS MEANINGS (CRITICAL - READ CAREFULLY):
- "reinforced" = Student STILL exhibits this misconception (confidence goes UP, bad sign)
- "weakened" = Student is OVERCOMING this misconception (confidence goes DOWN, good sign - making progress!)
- "new" = Misconception just appeared for the first time
- "absent" = Misconception not relevant to this turn

GENERIC EXAMPLES OF CLASSIFICATION:
- Student identifies WHAT goes wrong and WHY → status="weakened" (showing understanding)
- Student repeats the same flawed approach without recognizing the issue → status="reinforced" (still confused)
- Student explains the root cause and what prevents the error → status="weakened" (overcoming the misconception)
- Student makes the same logical error again in their explanation → status="reinforced" (misconception persists)
- Student demonstrates awareness of the edge case or boundary condition → status="weakened" (progress toward resolution)

Return ONLY JSON with this shape:
{
  "verdicts": [
    { "id": "off-by-one", "status": "reinforced|weakened|new|absent", "certainty": 0.0-1, "rationale": "brief explanation of why reinforced or weakened" }
  ],
  "overall_certainty": 0.0-1
}

taxonomy: ${JSON.stringify(taxonomy, null, 2)}
previous_socratic_question: ${params.previousQuestion || 'none'}
session_summary: ${params.sessionSummary || 'none'}
file_context: ${params.codeContext || 'not provided'}
user_message_untrusted: ${params.userMessage}`;

    const result = await classifierModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
            maxOutputTokens: 512,
            responseMimeType: 'application/json'
        }
    });

    const parsed = safeParseJson(result.response.text()) || {};
    const rawVerdicts: any[] = Array.isArray(parsed.verdicts) ? parsed.verdicts : [];
    const verdicts: MisconceptionVerdict[] = rawVerdicts
        .map(v => ({
            id: v.id,
            status: v.status,
            certainty: typeof v.certainty === 'number' ? Math.max(0, Math.min(1, v.certainty)) : 0.5,
            rationale: v.rationale
        }))
        .filter(v => MISCONCEPTION_TAXONOMY.some(t => t.id === v.id) && ['reinforced', 'weakened', 'new', 'absent'].includes(v.status));

    const classifierCertainty = typeof parsed.overall_certainty === 'number'
        ? Math.max(0, Math.min(1, parsed.overall_certainty))
        : (verdicts.reduce((sum, v) => sum + v.certainty, 0) / (verdicts.length || 1));

    return { verdicts, classifierCertainty, usage: extractUsage(result.response?.usageMetadata) };
}

export async function generateSocraticQuestion(params: {
    targetedMisconception: string | null;
    strategy: Strategy;
    userMessage: string;
    sessionSummary: string;
    fileContext?: string;
    lastQuestion?: string | null;
    retries?: number;
}): Promise<{ question: string; usage: ModelUsage; understood: boolean; summary?: string }> {
    const taxonomyEntry = MISCONCEPTION_TAXONOMY.find(t => t.id === params.targetedMisconception);
    const prompt = `Role: Socratic programming tutor.
Goal: Ask ONE short question (<20 words) that ADVANCES the student's understanding beyond what they just said.

Strategy: ${params.strategy}
Targeted misconception: ${taxonomyEntry ? `${taxonomyEntry.label} — ${taxonomyEntry.description}` : 'None detected; keep diagnostic.'}
Previous question: ${params.lastQuestion || 'none'}
Student's latest response: ${params.userMessage}
Session summary: ${params.sessionSummary || 'none'}
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

Respond with the single progressive question only.`;

    const retries = params.retries ?? 2;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const result = await generatorModel.generateContent({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: { maxOutputTokens: 80 }
            });

            const question = sanitizeToSingleQuestion(result.response.text());
            const { valid, reason } = hardValidateQuestion(question, params.lastQuestion);

            if (valid) {
                metrics.hintLevelDistribution.observe(1);
                return { question, usage: extractUsage(result.response?.usageMetadata), understood: false };
            }

            console.warn('Question validation failed:', reason, 'raw:', question);
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

    metrics.blockedPrompts.inc();
    const fallback = fallbackQuestion(params.targetedMisconception as any);
    const sanitized = sanitizeToSingleQuestion(fallback);
    return { question: sanitized, usage: { prompt: 0, candidates: 0, total: 0 }, understood: false };
}

export async function generateSessionSummary(messages: { role: string; parts: string }[]) {
    const prompt = `Summarize the session in 2 bullet points max.
Focus on concepts discussed and questions asked.
Be under 60 words.

History: ${JSON.stringify(messages).slice(0, 4000)} `;

    const result = await generatorModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 120 }
    });

    return result.response.text();
}
