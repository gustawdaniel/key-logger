import os from 'os';
import path from 'path';
import { getNewEvents, BACKEND } from '$lib/backend.js';

const homeDir = os.homedir();
const dbPath = path.join(homeDir, '.local', 'share', 'rust-keylogger', 'keylog.db');

export function GET({ url }) {
    const rawLastTs = url.searchParams.get('lastTs');
    const rawLastId = url.searchParams.get('lastId');
    const host = url.searchParams.get('host') || 'all';
    let lastId = parseInt(rawLastId || '0', 10);

    // ========== ClickHouse SSE (polling) ==========
    if (BACKEND === 'clickhouse') {
        let timer;
        const seenUids = new Set();
        let currentCursor = rawLastTs || (rawLastId && Number(rawLastId) > 1000000000000 ? rawLastId : '0');

        const stream = new ReadableStream({
            start(controller) {
                let isPolling = false;
                async function poll() {
                    if (isPolling) return;
                    isPolling = true;
                    try {
                        const rows = await getNewEvents(currentCursor, 150, host);
                        if (rows && rows.length > 0) {
                            for (const row of rows) {
                                const uid = row.unique_id || `${row.host}_${row.id}_${row.ts_nano}`;
                                if (seenUids.has(uid)) continue;
                                seenUids.add(uid);
                                if (seenUids.size > 1000) {
                                    const arr = Array.from(seenUids);
                                    seenUids.clear();
                                    arr.slice(-500).forEach(id => seenUids.add(id));
                                }

                                if (row.ts_nano) {
                                    currentCursor = row.ts_nano;
                                }
                                const data = `data: ${JSON.stringify(row)}\n\n`;
                                controller.enqueue(new TextEncoder().encode(data));
                            }
                        }
                    } catch (e) {
                        console.error('ClickHouse stream error:', e);
                    } finally {
                        isPolling = false;
                    }
                }
                poll(); // pierwsze wywołanie od razu
                timer = setInterval(poll, 150); // szybki polling co 150ms (zbieżny z lokalnym SQLite)
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
        async start(controller) {
            const { default: sqlite3 } = await import('sqlite3');
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
