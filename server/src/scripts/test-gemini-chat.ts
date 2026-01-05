import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { generateSocraticQuestion } from '../gemini';

async function testGeminiDirect() {
    console.log('Testing Gemini API with correct model...');
    console.log('API Key present:', !!process.env.GEMINI_API_KEY);

    try {
        const { question, usage } = await generateSocraticQuestion({
            targetedMisconception: 'off-by-one',
            strategy: 'diagnostic',
            userMessage: "What is a binary search tree?",
            sessionSummary: "Student asking about data structures",
            fileContext: ""
        });

        console.log('\n✅ SUCCESS!');
        console.log('Gemini Response:');
        console.log('─'.repeat(50));
        console.log(question);
        console.log('─'.repeat(50));
        console.log('Token Usage:', usage);
    } catch (err: any) {
        console.error('\n❌ FAILURE!');
        console.error('Error Message:', err.message);
        console.error('Full Error:', err);
    }
}

testGeminiDirect();
