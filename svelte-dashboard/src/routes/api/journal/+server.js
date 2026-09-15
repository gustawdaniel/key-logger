import sqlite3 from 'sqlite3';
import os from 'os';
import path from 'path';
import { getDailyJournal, reconstructJournal, BACKEND } from '$lib/backend.js';

const homeDir = os.homedir();
const dbPath = path.join(homeDir, '.local', 'share', 'rust-keylogger', 'keylog.db');

export async function GET({ url }) {
    const todayStr = new Date().toISOString().slice(0, 10);
    const dateStr = url.searchParams.get('date') || todayStr;

    const isRaw = url.searchParams.get('format') === 'raw' || url.searchParams.get('raw') === 'true';

    if (BACKEND === 'clickhouse') {
        try {
            const journal = await getDailyJournal(dateStr);
            if (isRaw) {
                return new Response(journal?.llmPromptMarkdown || '', {
                    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
                });
            }
            return new Response(JSON.stringify(journal), {
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (e) {
            console.error('ClickHouse journal error:', e);
            if (isRaw) {
                return new Response(`Błąd ClickHouse: ${e.message}`, {
                    status: 500,
                    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
                });
            }
            return new Response(JSON.stringify({ error: e.message }), { status: 500 });
        }
    }

    // SQLite fallback dla trybu lokalnego
    return new Promise((resolve) => {
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
            if (err) {
                resolve(new Response(JSON.stringify({
                    date: dateStr,
                    totalChunks: 0,
                    totalWords: 0,
                    sessions: [],
                    chunks: [],
                    llmPromptMarkdown: ''
                }), { headers: { 'Content-Type': 'application/json' } }));
                return;
            }
        });

        const query = `
            SELECT 
                timestamp as ts_ms,
                event_type,
                key_name,
                keycode
            FROM keystrokes
            WHERE date(timestamp/1000, 'unixepoch', 'localtime') = ?
            ORDER BY timestamp ASC, id ASC
        `;

        const datesQuery = `
            SELECT DISTINCT date(timestamp/1000, 'unixepoch', 'localtime') as date_str
            FROM keystrokes
            ORDER BY date_str DESC
            LIMIT 30
        `;

        db.all(query, [dateStr], (err, rows) => {
            if (err) {
                db.close();
                resolve(new Response(JSON.stringify({ error: err.message }), { status: 500 }));
                return;
            }

            db.all(datesQuery, [], (errDates, dateRows) => {
                db.close();
                const availableDates = (dateRows || []).map(r => r.date_str).filter(Boolean);
                const journal = reconstructJournal(rows || [], dateStr);
                journal.availableDates = availableDates;

                if (isRaw) {
                    resolve(new Response(journal?.llmPromptMarkdown || '', {
                        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
                    }));
                    return;
                }

                resolve(new Response(JSON.stringify(journal), {
                    headers: { 'Content-Type': 'application/json' }
                }));
            });
        });
    });
}
