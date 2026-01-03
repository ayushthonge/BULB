
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function getTestToken() {
    const email = `test.user.${Date.now()}@gmail.com`;
    const password = 'Password123!';

    console.log(`Attempting to sign up user: ${email}...`);

    try {
        const { data, error } = await supabase.auth.signUp({
            email,
            password,
        });

        if (error) {
            console.error('FULL ERROR:', JSON.stringify(error, null, 2));
            return;
        }

        if (data.session) {
            console.log('\n--- SUCCESS ---');
            console.log('Access Token:');
            console.log(data.session.access_token);
            console.log('\nUser ID:', data.user?.id);
        } else if (data.user) {
            console.log('\nUser created but no session returned. Email confirmation might be required.');
            console.log('User ID:', data.user.id);

            // Try signing in immediately
            const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
                email,
                password
            });

            if (signInData.session) {
                console.log('\n--- SUCCESS (after sign in) ---');
                console.log('Access Token:');
                console.log(signInData.session.access_token);
            } else {
                console.log('Could not sign in successfully:');
                console.log(JSON.stringify(signInError, null, 2));
            }
        }
    } catch (err) {
        console.error('Unexpected error:', err);
    }
}

getTestToken();
