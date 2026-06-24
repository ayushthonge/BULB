import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('neon.tech') ? { rejectUnauthorized: false } : undefined,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
});

pool.on('error', (err: Error) => {
    console.error('Unexpected database pool error:', err.message);
});

export async function dbInsert(table: string, data: Record<string, any>): Promise<void> {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const placeholders = keys.map((_, i) => `$${i + 1}`);

    const query = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders.join(', ')})`;

    try {
        await pool.query(query, values);
    } catch (err: any) {
        console.error(`dbInsert(${table}) failed:`, err.message);
        throw err;
    }
}

export async function dbUpdate(
    table: string,
    data: Record<string, any>,
    where: Record<string, any>
): Promise<void> {
    const dataKeys = Object.keys(data);
    const dataValues = Object.values(data);
    const setClauses = dataKeys.map((key, i) => `${key} = $${i + 1}`);

    const whereKeys = Object.keys(where);
    const whereValues = Object.values(where);
    const whereClauses = whereKeys.map((key, i) => `${key} = $${dataKeys.length + i + 1}`);

    const query = `UPDATE ${table} SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')}`;

    try {
        await pool.query(query, [...dataValues, ...whereValues]);
    } catch (err: any) {
        console.error(`dbUpdate(${table}) failed:`, err.message);
        throw err;
    }
}

export async function dbSelectOne(
    table: string,
    columns: string,
    where: Record<string, any>
): Promise<any | null> {
    const whereKeys = Object.keys(where);
    const whereValues = Object.values(where);
    const whereClauses = whereKeys.map((key, i) => `${key} = $${i + 1}`);

    const query = `SELECT ${columns} FROM ${table} WHERE ${whereClauses.join(' AND ')} LIMIT 1`;

    try {
        const result = await pool.query(query, whereValues);
        return result.rows[0] || null;
    } catch (err: any) {
        console.error(`dbSelectOne(${table}) failed:`, err.message);
        throw err;
    }
}

export { pool };
