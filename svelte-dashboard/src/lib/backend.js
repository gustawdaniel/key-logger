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

const SHIFT_MAP = {
    '1': '!', '2': '@', '3': '#', '4': '$', '5': '%',
    '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
    'minus': '_', 'equal': '+', 'bracketleft': '{', 'bracketright': '}',
    'semicolon': ':', 'apostrophe': '"', 'grave': '~', 'backslash': '|',
    'comma': '<', 'period': '>', 'slash': '?', 'question': '?', 'underscore': '_',
    '/': '?', ';': ':', '\'': '"', '[': '{', ']': '}', '\\': '|', '`': '~', '-': '_', '=': '+'
};

const NORMAL_MAP = {
    'space': ' ', 'Return': '\n', 'Tab': '\t', 'comma': ',', 'period': '.',
    'minus': '-', 'slash': '/', 'equal': '=', 'semicolon': ';',
    'apostrophe': '\'', 'grave': '`', 'backslash': '\\',
    'bracketleft': '[', 'bracketright': ']'
};

const ALTGR_MAP = {
    'a': 'ą', 'c': 'ć', 'e': 'ę', 'l': 'ł', 'n': 'ń', 'o': 'ó', 's': 'ś', 'x': 'ź', 'z': 'ż',
    'A': 'Ą', 'C': 'Ć', 'E': 'Ę', 'L': 'Ł', 'N': 'Ń', 'O': 'Ó', 'S': 'Ś', 'X': 'Ź', 'Z': 'Ż'
};

function classifyThought(text) {
    const t = text.trim();
    if (t.startsWith('git ') || t.startsWith('docker ') || t.startsWith('ssh ') || t.startsWith('cd ') ||
        t.startsWith('npm ') || t.startsWith('cargo ') || t.startsWith('apt ') || t.startsWith('systemctl ') ||
        t.startsWith('curl ') || t.startsWith('sudo ') || t.startsWith('ls ') || t.startsWith('cat ') ||
        t.startsWith('grep ') || t.startsWith('make ') || t.startsWith('python') || t.startsWith('node ') ||
        t.startsWith('df ') || t.startsWith('ps ') || t.startsWith('vim ') || t.startsWith('nvim ') || t.startsWith('nano ')) {
        return { category: 'shell', icon: '💻', label: 'Shell Command' };
    }
    if (/[{}();=><\[\]]/.test(t) && (t.includes('const ') || t.includes('function') || t.includes('import ') || t.includes('SELECT ') || t.includes('return ') || t.includes('class '))) {
        return { category: 'code', icon: '📝', label: 'Code & Syntax' };
    }
    if (t.includes('?') || t.length > 35 || /\b(zobacz|jak|czy|powiedz|zrób|napraw|wyjaśnij|błąd|dlaczego|proszę|chcę|stworzyć|zaproponuj|wejdź|why|how|please|error|what|suggest)\b/i.test(t)) {
        return { category: 'prompt', icon: '💬', label: 'AI Prompt / Question' };
    }
    return { category: 'note', icon: '⚡', label: 'Thought / Note' };
}

import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Pobierz listę zabronionych fraz/haseł z lokalnego pliku konfiguracyjnego blacklist.txt.
 * @returns {string[]}
 */
export function getBlacklist() {
    const customPath = process.env.KEYLOGGER_BLACKLIST_PATH;
    const candidates = [
        customPath,
        path.join(os.homedir(), '.config', 'rust-keylogger', 'blacklist.txt'),
        path.join(os.homedir(), '.config', 'keylogger', 'blacklist.txt'),
        '/app/config/blacklist.txt',
        '/root/.config/rust-keylogger/blacklist.txt'
    ].filter(Boolean);

    for (const p of candidates) {
        try {
            if (fs.existsSync(p)) {
                const content = fs.readFileSync(p, 'utf8');
                return content
                    .split('\n')
                    .map(line => line.trim())
                    .filter(line => line && !line.startsWith('#'));
            }
        } catch {
            // ignoruj błędy braku uprawnień lub pliku
        }
    }
    return [];
}

/**
 * Zamaskuj zabronione hasła i poufne tokeny.
 * @param {string} text
 * @param {string[]} blacklist
 * @returns {string}
 */
export function sanitizeText(text, blacklist) {
    if (!text || !blacklist || blacklist.length === 0) return text;
    let sanitized = text;
    for (const secret of blacklist) {
        if (!secret) continue;
        const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(escaped, 'g');
        sanitized = sanitized.replace(re, '[REDACTED]');
    }
    return sanitized;
}

/**
 * Zrekonstruuj strumień zdarzeń klawiatury w spójne bloki myśli, polecenia shella i prompty AI.
 * @param {Array<{ts_ms: number, event_type: string, key_name: string, keycode: number}>} events
 * @param {string} dateStr
 */
export function reconstructJournal(events, dateStr) {
    const blacklist = getBlacklist();
    let isShift = false, isAltGr = false, isCtrl = false;
    const rawChunks = [];
    let currentChars = [];
    let startTs = 0, lastTs = 0;
    let lastEvent = null;

    for (const r of events) {
        // Pomijaj identyczne duplikaty w oknie 5ms
        if (lastEvent && (r.ts_ms - lastEvent.ts_ms) < 5 && r.key_name === lastEvent.key_name && r.event_type === lastEvent.event_type) {
            continue;
        }
        lastEvent = r;

        const name = r.key_name;
        if (name === 'Shift_L' || name === 'Shift_R') {
            isShift = (r.event_type === 'PRESS');
            continue;
        }
        if (name === 'ISO_Level3_Shift' || name === 'Mode_switch' || name === 'Alt_R') {
            isAltGr = (r.event_type === 'PRESS');
            continue;
        }
        if (name === 'Control_L' || name === 'Control_R') {
            isCtrl = (r.event_type === 'PRESS');
            continue;
        }
        if (name === 'Alt_L' || name === 'Super_L' || name === 'Super_R') continue;

        if (r.event_type !== 'PRESS') continue;

        const gap = lastTs > 0 ? (r.ts_ms - lastTs) / 1000 : 0;
        if (gap > 4.5) {
            if (currentChars.length > 0) {
                const rawText = currentChars.join('').trim();
                const text = sanitizeText(rawText, blacklist);
                if (text.length >= 5) {
                    rawChunks.push({ startTs, endTs: lastTs, text });
                }
                currentChars = [];
            }
            startTs = r.ts_ms;
        } else if (currentChars.length === 0) {
            startTs = r.ts_ms;
        }
        lastTs = r.ts_ms;

        let char = '';
        if (name === 'BackSpace') {
            if (currentChars.length > 0) currentChars.pop();
            continue;
        } else if (name === 'Delete') {
            continue;
        } else if (name === 'Return') {
            char = '\n';
        } else if (name === 'space') {
            char = ' ';
        } else if (name === 'Tab') {
            char = '  ';
        } else if (isAltGr && ALTGR_MAP[name.toLowerCase()]) {
            char = isShift ? (ALTGR_MAP[name.toUpperCase()] || ALTGR_MAP[name.toLowerCase()].toUpperCase()) : ALTGR_MAP[name.toLowerCase()];
        } else if (isShift) {
            if (SHIFT_MAP[name]) char = SHIFT_MAP[name];
            else if (name.length === 1) char = name.toUpperCase();
        } else {
            if (NORMAL_MAP[name]) char = NORMAL_MAP[name];
            else if (name.length === 1) char = name.toLowerCase();
        }

        if (char) currentChars.push(char);
    }

    if (currentChars.length > 0) {
        const rawText = currentChars.join('').trim();
        const text = sanitizeText(rawText, blacklist);
        if (text.length >= 5) {
            rawChunks.push({ startTs, endTs: lastTs, text });
        }
    }

    // Formatowanie chunków i kategoryzacja
    const chunks = rawChunks.map((c, idx) => {
        const meta = classifyThought(c.text);
        const durationSec = Math.max(1, Math.round((c.endTs - c.startTs) / 1000));
        const words = c.text.split(/\s+/).filter(Boolean).length;
        const startTimeStr = new Date(c.startTs).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const endTimeStr = new Date(c.endTs).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        return {
            id: idx + 1,
            startTs: c.startTs,
            endTs: c.endTs,
            startTimeStr,
            endTimeStr,
            durationSec,
            text: c.text,
            words,
            chars: c.text.length,
            category: meta.category,
            icon: meta.icon,
            categoryLabel: meta.label
        };
    });

    // Grupowanie w sesje (przerwa > 25 min tworzy nową sesję)
    const sessions = [];
    let currentSession = null;

    for (const ch of chunks) {
        if (!currentSession || (ch.startTs - currentSession.endTs) > 25 * 60 * 1000) {
            if (currentSession) {
                sessions.push(currentSession);
            }
            const hour = new Date(ch.startTs).getHours();
            let sLabel = 'Session';
            if (hour < 6) sLabel = '🌙 Nocny Hackathon';
            else if (hour < 12) sLabel = '🌅 Poranny Blok Skupienia';
            else if (hour < 17) sLabel = '☀️ Popołudniowy Deep Work';
            else if (hour < 21) sLabel = '🌆 Wieczorna Praca';
            else sLabel = '🌙 Nocna Sesja';

            currentSession = {
                id: sessions.length + 1,
                label: sLabel,
                startTs: ch.startTs,
                endTs: ch.endTs,
                startTimeStr: ch.startTimeStr,
                endTimeStr: ch.endTimeStr,
                chunks: [ch]
            };
        } else {
            currentSession.endTs = ch.endTs;
            currentSession.endTimeStr = ch.endTimeStr;
            currentSession.chunks.push(ch);
        }
    }
    if (currentSession) sessions.push(currentSession);

    // Generowanie gotowego Markdownu dla LLM
    let llmPrompt = `# Dziennik Pracy i Klawiatury — ${dateStr}\n\n`;
    llmPrompt += `> **Polecenie dla Asystenta AI:**\n`;
    llmPrompt += `> Poniżej znajduje się chronologiczny wykaz zrekonstruowanych myśli, promptów AI, poleceń terminala oraz kodu wpisanego przeze mnie na klawiaturze w dniu **${dateStr}**.\n`;
    llmPrompt += `>\n`;
    llmPrompt += `> **Twoje zadanie:**\n`;
    llmPrompt += `> 1. Wyjaśnij zwięźle i konkretnie: **co właściwie dzisiaj robiłem i nad czym pracowałem?**\n`;
    llmPrompt += `> 2. Pogrupuj działania w logiczne wątki i projekty (np. DevOps & Kontenery, Backend API, Frontend & UI, Rozwiązywanie błędów, Analiza danych).\n`;
    llmPrompt += `> 3. Podsumuj dzień w punktach (Executive Summary / TL;DR) wraz z kluczowymi osiągniętymi rezultatami.\n\n`;
    llmPrompt += `---\n\n`;

    for (const s of sessions) {
        llmPrompt += `## ${s.label} [${s.startTimeStr.slice(0, 5)} – ${s.endTimeStr.slice(0, 5)}] (${s.chunks.length} myśli)\n\n`;
        for (const ch of s.chunks) {
            if (ch.category === 'shell') {
                llmPrompt += `- **[${ch.startTimeStr}]** (Polecenie Shell):\n  \`\`\`bash\n  ${ch.text}\n  \`\`\`\n`;
            } else if (ch.category === 'prompt') {
                llmPrompt += `- **[${ch.startTimeStr}]** (Prompt / Zapytanie AI):\n  "${ch.text.replace(/"/g, '\\"')}"\n\n`;
            } else {
                llmPrompt += `- **[${ch.startTimeStr}]** (${ch.categoryLabel}):\n  ${ch.text}\n\n`;
            }
        }
        llmPrompt += `\n`;
    }

    const totalWords = chunks.reduce((acc, c) => acc + c.words, 0);

    return {
        date: dateStr,
        totalChunks: chunks.length,
        totalWords,
        sessions,
        chunks,
        llmPromptMarkdown: sanitizeText(llmPrompt, blacklist)
    };
}

/**
 * Pobierz zrekonstruowany dziennik myśli i promptów dla podanego dnia.
 * @param {string} dateStr - format YYYY-MM-DD
 */
export async function getDailyJournal(dateStr) {
    if (BACKEND === 'clickhouse') {
        const [rows, dateRows] = await Promise.all([
            clickhouseQuery(`
                SELECT
                    toInt64(timestamp / 1000000)          AS ts_ms,
                    attributes_string['event_type']       AS event_type,
                    attributes_string['key_name']         AS key_name,
                    toInt32(attributes_number['keycode']) AS keycode
                FROM ${CH_DB}.logs_v2
                WHERE attributes_string['log_type'] = 'keystroke'
                  AND toDate(fromUnixTimestamp64Nano(timestamp), 'Europe/Warsaw') = '${dateStr}'
                ORDER BY timestamp ASC
            `),
            clickhouseQuery(`
                SELECT DISTINCT toString(toDate(fromUnixTimestamp64Nano(timestamp), 'Europe/Warsaw')) AS date_str
                FROM ${CH_DB}.logs_v2
                WHERE attributes_string['log_type'] = 'keystroke'
                ORDER BY date_str DESC
                LIMIT 30
            `)
        ]);
        const journal = reconstructJournal(rows, dateStr);
        journal.availableDates = dateRows.map(r => r.date_str).filter(Boolean);
        return journal;
    }
    return null;
}

export { BACKEND };
