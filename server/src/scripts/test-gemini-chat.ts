import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { chatWithGemini } from '../gemini';

async function testGeminiDirect() {
    console.log('Testing Gemini API with correct model...');
    console.log('API Key present:', !!process.env.GEMINI_API_KEY);

    try {
        const response = await chatWithGemini(
            [],
            "What is a binary search tree? Give me a one sentence hint.",
            ""
        );

        console.log('\n✅ SUCCESS!');
        console.log('Gemini Response:');
        console.log('─'.repeat(50));
        console.log(response);
        console.log('─'.repeat(50));
    } catch (err: any) {
        console.error('\n❌ FAILURE!');
        console.error('Error Message:', err.message);
        console.error('Full Error:', err);
    }
}

testGeminiDirect();
