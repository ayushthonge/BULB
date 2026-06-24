import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

async function testChatFlow() {
    const token = process.argv[2] || process.env.TEST_TOKEN;
    const serverUrl = process.argv[3] || 'http://localhost:3000';

    console.log('Testing /chat endpoint...');
    console.log('Server:', serverUrl);
    console.log('Token:', token ? token.substring(0, 8) + '...' : '(none — auth disabled)');

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    try {
        const response = await fetch(`${serverUrl}/chat`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                message: "I think arrays and linked lists are the same thing, right?",
                history: [],
                context: "int arr[10];\nstruct Node { int data; Node* next; };"
            })
        });

        const status = response.status;
        console.log(`Response Status: ${status}`);

        const body = await response.json();

        if (response.ok) {
            console.log('\n--- SUCCESS ---');
            console.log('Response:', body.response);
            console.log('Session:', body.session_id);
            console.log('Query:', body.query_id);
            console.log('Misconception:', body.targeted_misconception);
        } else {
            console.error('\n--- FAILURE ---');
            console.error('Error:', body);
        }
    } catch (err: any) {
        console.error('Network Error:', err.message);
        if (err.code === 'ECONNREFUSED') {
            console.error('HINT: Is the server running?');
        }
    }
}

testChatFlow();
