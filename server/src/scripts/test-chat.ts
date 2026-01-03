
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
// import fetch from 'node-fetch'; // Using native fetch


// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function testChatFlow() {
    console.log('1. Authenticating with Supabase...');
    const email = 'ayush.thonge_ug2025@ashoka.edu.in';
    const password = 'Ayush@Thonge72';

    const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
    });

    if (error || !data.session) {
        console.error('Login Failed:', error?.message);
        return;
    }

    const token = data.session.access_token;
    console.log('Authentication Successful!');
    console.log('Token obtained (starts with):', token.substring(0, 15) + '...');

    console.log('\n2. Testing /chat endpoint...');

    try {
        const response = await fetch('http://localhost:3000/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                message: "Explain what a binary search tree is in one sentence.",
                history: [],
                context: "const bst = new BST();"
            })
        });

        const status = response.status;
        console.log(`Response Status: ${status}`);

        const body = await response.json();

        if (response.ok) {
            console.log('\n--- SUCCESS ---');
            console.log('Server Response:', body.response);
        } else {
            console.error('\n--- FAILURE ---');
            console.error('Server returned error:', body);
        }

    } catch (err: any) {
        console.error('Network or Script Error:', err.message);
        if (err.code === 'ECONNREFUSED') {
            console.error('HINT: Is the backend server running? (npm start in server directory)');
        }
    }
}

testChatFlow();
