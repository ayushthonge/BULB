
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

async function getExistingUserToken() {
    const email = 'ayush.thonge_ug2025@ashoka.edu.in';
    const password = 'Ayush@Thonge72';

    console.log(`Attempting to sign in user: ${email}...`);

    const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
    });

    if (error) {
        console.error('Error signing in:', error.message);
        return;
    }

    if (data.session) {
        console.log('\n--- SUCCESS ---');
        console.log('Access Token:');
        console.log(data.session.access_token);
        console.log('\nUser ID:', data.user?.id);
    } else {
        console.log('Sign in successful but no session returned.');
    }
}

getExistingUserToken();
