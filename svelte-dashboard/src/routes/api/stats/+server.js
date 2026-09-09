import sqlite3 from 'sqlite3';
import os from 'os';
import path from 'path';
import { getAggregatedStats, BACKEND } from '$lib/backend.js';

const homeDir = os.homedir();
const dbPath = path.join(homeDir, '.local', 'share', 'rust-keylogger', 'keylog.db');

export async function GET({ url }) {
    const range = url.searchParams.get('range') || 'today';

    if (BACKEND === 'clickhouse') {
        try {
            const stats = await getAggregatedStats(range);
            return new Response(JSON.stringify(stats), {
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (e) {
            console.error('ClickHouse stats error:', e);
            return new Response(JSON.stringify({ error: e.message }), { status: 500 });
        }
    }

    // SQLite fallback dla lokalnego trybu dev
    return new Promise((resolve) => {
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
            if (err) {
                resolve(new Response(JSON.stringify({
                    totalPresses: 0, totalErrors: 0, printableChars: 0, errorRate: 0,
                    dailyActivity: [], hourlyActivity: [], topKeys: []
                }), { headers: { 'Content-Type': 'application/json' } }));
                return;
            }
        });

        let timeWhere = "";
        if (range === 'today') {
            timeWhere = "AND date(timestamp/1000, 'unixepoch', 'localtime') = date('now', 'localtime')";
        } else if (range === '7d') {
            timeWhere = "AND timestamp > (strftime('%s', 'now') - 7*86400) * 1000";
        } else if (range === '30d') {
            timeWhere = "AND timestamp > (strftime('%s', 'now') - 30*86400) * 1000";
        }

        const summaryQuery = `
            SELECT 
                count(CASE WHEN event_type = 'PRESS' THEN 1 END) as total,
                count(CASE WHEN event_type = 'PRESS' AND key_name IN ('BackSpace','Delete') THEN 1 END) as errors,
                count(CASE WHEN event_type = 'PRESS' AND key_name NOT IN ('Shift_L','Shift_R','Control_L','Control_R','Alt_L','Alt_R','Super_L','Super_R') THEN 1 END) as printable
            FROM keystrokes
            WHERE 1=1 ${timeWhere}
        `;

        const dailyQuery = `
            SELECT 
                date(timestamp/1000, 'unixepoch', 'localtime') as date_str,
                count(CASE WHEN event_type = 'PRESS' THEN 1 END) as count,
                count(CASE WHEN event_type = 'PRESS' AND key_name IN ('BackSpace','Delete') THEN 1 END) as errors
            FROM keystrokes
            WHERE timestamp > (strftime('%s', 'now') - 365*86400) * 1000
            GROUP BY date_str
            ORDER BY date_str ASC
        `;

        const hourlyQuery = `
            SELECT 
                cast(strftime('%H', timestamp/1000, 'unixepoch', 'localtime') as integer) as hour,
                count(CASE WHEN event_type = 'PRESS' THEN 1 END) as count
            FROM keystrokes
            WHERE 1=1 ${timeWhere}
            GROUP BY hour
            ORDER BY hour ASC
        `;

        const topKeysQuery = `
            SELECT key_name as name, count(*) as count 
            FROM keystrokes 
            WHERE event_type = 'PRESS' ${timeWhere}
            GROUP BY key_name 
            ORDER BY count DESC 
            LIMIT 25
        `;

        const dayHourlyQuery = `
            SELECT 
                date(timestamp/1000, 'unixepoch', 'localtime') as date_str,
                cast(strftime('%H', timestamp/1000, 'unixepoch', 'localtime') as integer) as hour,
                count(CASE WHEN event_type = 'PRESS' THEN 1 END) as count
            FROM keystrokes
            WHERE 1=1 ${timeWhere}
            GROUP BY date_str, hour
            ORDER BY date_str DESC, hour ASC
        `;

        db.get(summaryQuery, [], (err, summary) => {
            db.all(dailyQuery, [], (err2, dailyRows) => {
                db.all(hourlyQuery, [], (err3, hourlyRows) => {
                    db.all(dayHourlyQuery, [], (err4, dayHourlyRows) => {
                        db.all(topKeysQuery, [], (err5, topKeys) => {
                            db.close();
                            const total = summary?.total || 0;
                            const errors = summary?.errors || 0;
                            const printable = summary?.printable || 0;
                            resolve(new Response(JSON.stringify({
                                totalPresses: total,
                                totalErrors: errors,
                                printableChars: printable,
                                errorRate: total > 0 ? Number(((errors / total) * 100).toFixed(1)) : 0,
                                dailyActivity: (dailyRows || []).map(r => ({ date: r.date_str, count: r.count, errors: r.errors })),
                                hourlyActivity: (hourlyRows || []).map(r => ({ hour: r.hour, count: r.count })),
                                dayHourlyActivity: (dayHourlyRows || []).map(r => ({ date: r.date_str, hour: r.hour, count: r.count })),
                                topKeys: (topKeys || []).map(r => ({ name: r.name, count: r.count }))
                            }), { headers: { 'Content-Type': 'application/json' } }));
                        });
                    });
                });
            });
        });
    });
}
