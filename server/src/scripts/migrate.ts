/**
 * Idempotent migration runner. Executes migrate.sql against DATABASE_URL.
 * The SQL uses CREATE TABLE / ADD COLUMN IF NOT EXISTS throughout, so it is
 * safe to run repeatedly (fresh installs and upgrades alike).
 *
 *   Dev/ops:  npm run migrate
 *   In image: node dist/scripts/migrate.js   (Dockerfile copies migrate.sql)
 */

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { pool } from '../db';

function resolveSqlPath(): string | null {
    const candidates = [
        path.resolve(__dirname, 'migrate.sql'),                 // ts-node (src) or copied next to dist
        path.resolve(__dirname, '../../src/scripts/migrate.sql'), // dist/scripts -> src/scripts
        path.resolve(process.cwd(), 'src/scripts/migrate.sql'),
        path.resolve(process.cwd(), 'dist/scripts/migrate.sql'),
    ];
    return candidates.find(p => existsSync(p)) || null;
}

async function main() {
    if (!process.env.DATABASE_URL) {
        console.error('DATABASE_URL is not set. Aborting migration.');
        process.exit(1);
    }

    const file = resolveSqlPath();
    if (!file) {
        console.error('Could not locate migrate.sql.');
        process.exit(1);
    }

    const sql = readFileSync(file, 'utf-8');
    console.log('Applying migrations from', file);
    try {
        await pool.query(sql);
        console.log('Migrations applied successfully.');
    } catch (err: any) {
        console.error('Migration failed:', err.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

main();
