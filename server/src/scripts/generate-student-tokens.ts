import { readFileSync } from 'fs';
import crypto from 'crypto';
import { pool } from '../db';

/**
 * Reads a CSV/text file with one student email per line,
 * generates a 32-char hex token for each, inserts into whitelist_users,
 * and prints a CSV of email,token pairs for distribution.
 *
 * Usage: ts-node src/scripts/generate-student-tokens.ts students.csv
 */

async function main() {
    const filePath = process.argv[2];
    if (!filePath) {
        console.error('Usage: ts-node src/scripts/generate-student-tokens.ts <emails-file>');
        process.exit(1);
    }

    const raw = readFileSync(filePath, 'utf-8');
    const emails = raw
        .split('\n')
        .map(line => line.trim().toLowerCase())
        .filter(line => line && line.includes('@'));

    if (emails.length === 0) {
        console.error('No valid emails found in file.');
        process.exit(1);
    }

    console.log(`Found ${emails.length} emails. Generating tokens...`);
    console.log('email,token');

    for (const email of emails) {
        const token = crypto.randomBytes(16).toString('hex'); // 32-char hex
        try {
            await pool.query(
                `INSERT INTO whitelist_users (email, token, role, active)
                 VALUES ($1, $2, 'student', true)
                 ON CONFLICT (email) DO UPDATE SET token = $2, active = true`,
                [email, token]
            );
            console.log(`${email},${token}`);
        } catch (err: any) {
            console.error(`Failed for ${email}: ${err.message}`);
        }
    }

    await pool.end();
    console.log('\nDone.');
}

main();
