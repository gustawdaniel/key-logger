import sqlite3 from 'sqlite3';
import os from 'os';
import path from 'path';
import { getHistory, BACKEND } from '$lib/backend.js';

const homeDir = os.homedir();
const dbPath = path.join(homeDir, '.local', 'share', 'rust-keylogger', 'keylog.db');

export async function GET({ url }) {
    const limit = Number(url.searchParams.get('limit')) || 100;

    // ClickHouse backend
    if (BACKEND === 'clickhouse') {
        try {
            const rows = await getHistory(limit);
            return new Response(JSON.stringify(rows), {
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (e) {
            console.error('ClickHouse history error:', e);
            return new Response(JSON.stringify({ error: e.message }), { status: 500 });
        }
    }

    // SQLite backend (domyślny, lokalny)
    return new Promise((resolve) => {
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
            if (err) {
                console.error('Błąd otwarcia bazy (historia):', err);
                resolve(new Response(JSON.stringify({ error: err.message }), { status: 500 }));
                return;
            }
        });

        db.all(
            `SELECT * FROM (
                SELECT * FROM keystrokes ORDER BY timestamp DESC LIMIT ?
             ) ORDER BY timestamp ASC`,
            [limit],
            (err, rows) => {
                db.close();
                if (err) {
                    resolve(new Response(JSON.stringify({ error: err.message }), { status: 500 }));
                } else {
                    resolve(new Response(JSON.stringify(rows), {
                        headers: { 'Content-Type': 'application/json' }
                    }));
                }
            }
        );
    });
}
