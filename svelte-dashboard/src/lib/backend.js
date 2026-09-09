/**
 * backend.js — Adapter źródła danych (SQLite local vs ClickHouse remote).
 *
 * KEYLOGGER_BACKEND=sqlite  (domyślnie) → odpytuje lokalne SQLite przez API routes
 * KEYLOGGER_BACKEND=clickhouse           → odpytuje ClickHouse HTTP API
 *
 * Używany przez API routes +server.js po stronie serwera.
 */

import { env } from '$env/dynamic/private';

const BACKEND = env.KEYLOGGER_BACKEND ?? 'sqlite';
const CH_URL   = env.CLICKHOUSE_URL   ?? 'http://localhost:8123';
const CH_DB    = env.CLICKHOUSE_DB    ?? 'signoz_logs';

/**
 * Wykonaj zapytanie do ClickHouse przez HTTP API (format JSONEachRow).
 * @param {string} sql
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function clickhouseQuery(sql) {
    const url = `${CH_URL}/?query=${encodeURIComponent(sql)}&default_format=JSONEachRow&database=${CH_DB}`;
    const res = await fetch(url, { headers: { 'X-ClickHouse-Format': 'JSONEachRow' } });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`ClickHouse error ${res.status}: ${text}`);
    }
    const text = await res.text();
    if (!text.trim()) return [];
    return text.trim().split('\n').map(line => JSON.parse(line));
}

/**
 * Pobierz historię ostatnich naciśnięć klawiatury.
 * @param {number} limit
 * @returns {Promise<Array<{id: number, timestamp: number, event_type: string, key_name: string, keycode: number}>>}
 */
export async function getHistory(limit = 1000) {
    if (BACKEND === 'clickhouse') {
        const rows = await clickhouseQuery(`
            SELECT
                toInt64(attributes_number['row_id'])      AS id,
                toInt64(timestamp / 1000000)              AS ts_ms,
                attributes_string['event_type']           AS event_type,
                attributes_string['key_name']             AS key_name,
                toInt32(attributes_number['keycode'])     AS keycode
            FROM ${CH_DB}.logs_v2
            WHERE attributes_string['log_type'] = 'keystroke'
            ORDER BY timestamp DESC
            LIMIT ${limit}
        `);
        // Odwróć do chronologicznego
        return rows.reverse().map(r => ({
            id:         Number(r.id),
            timestamp:  Number(r.ts_ms || r.timestamp),
            event_type: r.event_type,
            key_name:   r.key_name,
            keycode:    Number(r.keycode),
        }));
    }
    // SQLite — obsługiwane przez oryginalny +server.js
    return null;
}

/**
 * Pobierz nowe zdarzenia od danego ID (polling dla SSE).
 * @param {number} afterRowId  — ID ostatniego zdarzenia z SQLite
 * @param {number} limit
 * @returns {Promise<Array>}
 */
export async function getNewEvents(afterRowId = 0, limit = 300) {
    if (BACKEND !== 'clickhouse') return null;

    let whereClause;
    if (afterRowId > 0) {
        whereClause = `attributes_number['row_id'] > ${afterRowId}`;
    } else {
        const tsNano = (BigInt(Date.now()) - 5000n) * 1_000_000n;
        whereClause = `timestamp > ${tsNano}`;
    }

    const rows = await clickhouseQuery(`
        SELECT
            toInt64(attributes_number['row_id'])      AS id,
            toInt64(timestamp / 1000000)              AS ts_ms,
            attributes_string['event_type']           AS event_type,
            attributes_string['key_name']             AS key_name,
            toInt32(attributes_number['keycode'])     AS keycode
        FROM ${CH_DB}.logs_v2
        WHERE attributes_string['log_type'] = 'keystroke'
          AND ${whereClause}
        ORDER BY timestamp ASC
        LIMIT ${limit}
    `);
    return rows.map(r => ({
        id:         Number(r.id),
        timestamp:  Number(r.ts_ms || r.timestamp),
        event_type: r.event_type,
        key_name:   r.key_name,
        keycode:    Number(r.keycode),
    }));
}

/**
 * Pobierz zagregowane statystyki analityczne (hacker stats, git calendar, hourly distribution).
 * @param {string} range - 'today' | '7d' | '30d' | 'all'
 */
export async function getAggregatedStats(range = 'today') {
    if (BACKEND === 'clickhouse') {
        let timeFilter = '';
        if (range === 'today') {
            timeFilter = "AND toDate(fromUnixTimestamp64Nano(timestamp)) = today()";
        } else if (range === '7d') {
            timeFilter = "AND timestamp > toInt64(toUnixTimestamp(now() - INTERVAL 7 DAY)) * 1000000000";
        } else if (range === '30d') {
            timeFilter = "AND timestamp > toInt64(toUnixTimestamp(now() - INTERVAL 30 DAY)) * 1000000000";
        }

        // 1. Podsumowanie
        const summaryRows = await clickhouseQuery(`
            SELECT
                countIf(attributes_string['event_type'] = 'PRESS') AS total_presses,
                countIf(attributes_string['key_name'] IN ('BackSpace', 'Delete') AND attributes_string['event_type'] = 'PRESS') AS total_errors,
                countIf(attributes_string['key_name'] NOT IN ('Shift_L','Shift_R','Control_L','Control_R','Alt_L','Alt_R','Super_L','Super_R') AND attributes_string['event_type'] = 'PRESS') AS printable_chars
            FROM ${CH_DB}.logs_v2
            WHERE attributes_string['log_type'] = 'keystroke'
              ${timeFilter}
        `);

        // 2. Dystrybucja dzienna (Git Calendar style - 365 dni)
        const dailyRows = await clickhouseQuery(`
            SELECT
                toDate(fromUnixTimestamp64Nano(timestamp)) AS date_str,
                countIf(attributes_string['event_type'] = 'PRESS') AS count,
                countIf(attributes_string['key_name'] IN ('BackSpace','Delete') AND attributes_string['event_type'] = 'PRESS') AS errors
            FROM ${CH_DB}.logs_v2
            WHERE attributes_string['log_type'] = 'keystroke'
              AND timestamp > toInt64(toUnixTimestamp(now() - INTERVAL 365 DAY)) * 1000000000
            GROUP BY date_str
            ORDER BY date_str ASC
        `);

        // 3. Dystrybucja godzinowa z podziałem na poszczególne dni (ranwhen diurnal matrix)
        const dayHourlyRows = await clickhouseQuery(`
            SELECT
                toDate(fromUnixTimestamp64Nano(timestamp)) AS date_str,
                toHour(fromUnixTimestamp64Nano(timestamp)) AS hour,
                countIf(attributes_string['event_type'] = 'PRESS') AS count
            FROM ${CH_DB}.logs_v2
            WHERE attributes_string['log_type'] = 'keystroke'
              ${timeFilter}
            GROUP BY date_str, hour
            ORDER BY date_str DESC, hour ASC
        `);

        // 4. Zagregowana dystrybucja godzinowa (24h sum)
        const hourlyRows = await clickhouseQuery(`
            SELECT
                toHour(fromUnixTimestamp64Nano(timestamp)) AS hour,
                countIf(attributes_string['event_type'] = 'PRESS') AS count
            FROM ${CH_DB}.logs_v2
            WHERE attributes_string['log_type'] = 'keystroke'
              ${timeFilter}
            GROUP BY hour
            ORDER BY hour ASC
        `);

        // 5. Top 25 klawiszy
        const topKeysRows = await clickhouseQuery(`
            SELECT
                attributes_string['key_name'] AS key_name,
                count() AS count
            FROM ${CH_DB}.logs_v2
            WHERE attributes_string['log_type'] = 'keystroke'
              AND attributes_string['event_type'] = 'PRESS'
              ${timeFilter}
            GROUP BY key_name
            ORDER BY count DESC
            LIMIT 25
        `);

        const summary = summaryRows[0] || {};
        const total = Number(summary.total_presses || 0);
        const errors = Number(summary.total_errors || 0);
        const printable = Number(summary.printable_chars || 0);

        return {
            totalPresses: total,
            totalErrors: errors,
            printableChars: printable,
            errorRate: total > 0 ? Number(((errors / total) * 100).toFixed(1)) : 0,
            dailyActivity: dailyRows.map(r => ({ date: r.date_str, count: Number(r.count), errors: Number(r.errors) })),
            hourlyActivity: hourlyRows.map(r => ({ hour: Number(r.hour), count: Number(r.count) })),
            dayHourlyActivity: dayHourlyRows.map(r => ({ date: r.date_str, hour: Number(r.hour), count: Number(r.count) })),
            topKeys: topKeysRows.map(r => ({ name: r.key_name, count: Number(r.count) }))
        };
    }

    return null;
}

export { BACKEND };
