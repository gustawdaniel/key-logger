import sqlite3 from 'sqlite3';
import os from 'os';
import path from 'path';

const homeDir = os.homedir();
const dbPath = path.join(homeDir, '.local', 'share', 'rust-keylogger', 'keylog.db');

export async function GET({ url }) {
    // Pozwala na zdefiniowanie ile elementów z historii pobrać (domyślnie 50)
    const limit = Number(url.searchParams.get('limit')) || 50;

    return new Promise((resolve) => {
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
            if (err) {
                console.error('Błąd otwarcia bazy (historia):', err);
                resolve(new Response(JSON.stringify({ error: err.message }), { status: 500 }));
                return;
            }
        });

        // Pobieramy ostatnie klawisze w kolejności chronologicznej (najstarsze w limitowanym zestawie najpierw, jak do chata)
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
                        headers: {
                            'Content-Type': 'application/json'
                        }
                    }));
                }
            }
        );
    });
}
