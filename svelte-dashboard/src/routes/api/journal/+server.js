import os from 'os';
import path from 'path';
import fs from 'fs';
import { getDailyJournal, reconstructJournal, BACKEND } from '$lib/backend.js';

const homeDir = os.homedir();
const keylogDbPath = path.join(homeDir, '.local', 'share', 'rust-keylogger', 'keylog.db');
const voiceDbPath = path.join(homeDir, '.local', 'share', 'hyprwhspr', 'transcriptions.db');

/**
 * Bezpieczne wykonanie zapytania SELECT w SQLite zwracające Promise.
 */
async function queryDb(filePath, sql, params = []) {
    if (!fs.existsSync(filePath)) {
        return [];
    }
    const { default: sqlite3 } = await import('sqlite3');
    return new Promise((resolve) => {
        const db = new sqlite3.Database(filePath, sqlite3.OPEN_READONLY, (err) => {
            if (err) {
                resolve([]);
                return;
            }
        });
        db.all(sql, params, (err, rows) => {
            db.close();
            if (err) {
                resolve([]);
            } else {
                resolve(rows || []);
            }
        });
    });
}

export async function GET({ url }) {
    const todayStr = new Date().toISOString().slice(0, 10);
    const dateStr = url.searchParams.get('date') || todayStr;
    const isRaw = url.searchParams.get('format') === 'raw' || url.searchParams.get('raw') === 'true';
    const host = url.searchParams.get('host') || 'all';

    if (BACKEND === 'clickhouse') {
        try {
            const journal = await getDailyJournal(dateStr, host);
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

    // Tryb lokalny SQLite: równoległe pobranie naciśnięć klawiatury oraz transkrypcji mowy
    try {
        const keyQuery = `
            SELECT 
                timestamp as ts_ms,
                event_type,
                key_name,
                keycode
            FROM keystrokes
            WHERE date(timestamp/1000, 'unixepoch', 'localtime') = ?
            ORDER BY timestamp ASC, id ASC
        `;

        const keyDatesQuery = `
            SELECT DISTINCT date(timestamp/1000, 'unixepoch', 'localtime') as date_str
            FROM keystrokes
            ORDER BY date_str DESC
            LIMIT 30
        `;

        const voiceQuery = `
            SELECT
                id,
                CAST(started_timestamp * 1000 AS INTEGER) as ts_ms,
                transcription,
                window_class,
                window_title,
                duration_seconds,
                started_at,
                finished_at
            FROM transcriptions
            WHERE date(started_timestamp, 'unixepoch', 'localtime') = ?
            ORDER BY started_timestamp ASC
        `;

        const voiceDatesQuery = `
            SELECT DISTINCT date(started_timestamp, 'unixepoch', 'localtime') as date_str
            FROM transcriptions
            ORDER BY date_str DESC
            LIMIT 30
        `;

        const [keyRows, voiceRows, keyDates, voiceDates] = await Promise.all([
            queryDb(keylogDbPath, keyQuery, [dateStr]),
            queryDb(voiceDbPath, voiceQuery, [dateStr]),
            queryDb(keylogDbPath, keyDatesQuery),
            queryDb(voiceDbPath, voiceDatesQuery)
        ]);

        const allDates = Array.from(new Set([
            ...(keyDates || []).map(r => r.date_str),
            ...(voiceDates || []).map(r => r.date_str)
        ].filter(Boolean))).sort().reverse().slice(0, 30);

        const journal = reconstructJournal(keyRows, dateStr, voiceRows);
        journal.availableDates = allDates;

        if (isRaw) {
            return new Response(journal?.llmPromptMarkdown || '', {
                headers: { 'Content-Type': 'text/plain; charset=utf-8' }
            });
        }

        return new Response(JSON.stringify(journal), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (err) {
        console.error('SQLite journal error:', err);
        if (isRaw) {
            return new Response(`Błąd odczytu dziennika: ${err.message}`, {
                status: 500,
                headers: { 'Content-Type': 'text/plain; charset=utf-8' }
            });
        }
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }
}
