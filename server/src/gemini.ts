
import { GoogleGenerativeAI } from '@google/generative-ai';
import { SYSTEM_PROMPT } from './systemPrompt';
import { metrics } from './metrics';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash-lite',
    systemInstruction: SYSTEM_PROMPT
});

async function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

export async function chatWithGemini(
    history: { role: string; parts: string }[],
    newMessage: string,
    codeContext?: string,
    retries = 3
) {
    let finalPrompt = `STUDENT MESSAGE:\n${newMessage}\n\nRespond with ONE short question (<20 words) tailored to their code. Nothing else.`;
    if (codeContext) {
        finalPrompt += `\n\n[Current Editor Context]:\n\`\`\`\n${codeContext}\n\`\`\``;
    }

    // Construct standard Gemini history format
    const chat = model.startChat({
        history: [
            ...history.map(h => ({
                role: h.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: h.parts }]
            }))
        ],
        generationConfig: {
            maxOutputTokens: 80,
        },
    });

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const result = await chat.sendMessage(finalPrompt);
            const text = sanitizeToSingleQuestion(result.response.text());

            // Metrics tracking
            if (text.toLowerCase().includes('i cannot provide full solutions') ||
                text.toLowerCase().includes('break it into smaller pieces')) {
                metrics.blockedPrompts.inc();
            }
            metrics.hintLevelDistribution.observe(1);

            return text;
        } catch (error: any) {
            const is503 = error.message?.includes('503') || error.message?.includes('overloaded');
            const isLastAttempt = attempt === retries;

            if (is503 && !isLastAttempt) {
                // Exponential backoff: 1s, 2s, 4s
                const waitTime = Math.pow(2, attempt - 1) * 1000;
                console.log(`Gemini API overloaded. Retrying in ${waitTime}ms... (attempt ${attempt}/${retries})`);
                await delay(waitTime);
                continue;
            }

            // Last attempt or non-503 error
            console.error('Gemini API Error:', {
                message: error.message,
                status: error.status,
                attempt: attempt
            });

            if (is503) {
                throw new Error('🚦 Google\'s AI is currently overloaded. Please wait a moment and try again. (This usually resolves in 30-60 seconds)');
            }

            throw new Error(error.message || 'Failed to generate response from Gemini');
        }
    }

    throw new Error('Failed after multiple retries');
}

export async function generateSessionSummary(messages: { role: string; parts: string }[]) {
    // A one-off prompt to summarize
    const prompt = `
        Based on the following chat history, generate a brief end-of-session summary for the student.
        Include:
        1. Concepts discussed.
        2. Key questions they asked.
        KEEP IT BRIEF.

        History:
        ${JSON.stringify(messages)}
    `;

    const result = await model.generateContent(prompt);
    return result.response.text();
}
