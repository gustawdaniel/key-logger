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
const CH_USER  = env.CLICKHOUSE_USER  ?? '';
const CH_PASS  = env.CLICKHOUSE_PASSWORD ?? '';
const CH_DB    = env.CLICKHOUSE_DB    ?? 'brain_events';

// In-memory cache dla ultra-szybkiego przełączania zakresów i zakładek
const statsMemoryCache = new Map();
const STATS_CACHE_TTL_MS = {
    today: 45 * 1000,      // 45s dla dzisiejszego dnia (częsta aktualizacja)
    '7d':  3 * 60 * 1000,  // 3m dla ostatnich 7 dni
    '30d': 10 * 60 * 1000, // 10m dla 30 dni
    all:   15 * 60 * 1000  // 15m dla całego roku
};

/**
 * Wykonaj zapytanie do ClickHouse przez HTTP API (format JSONEachRow).
 * @param {string} sql
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function clickhouseQuery(sql) {
    const url = `${CH_URL}/?query=${encodeURIComponent(sql)}&default_format=JSONEachRow&database=${CH_DB}`;
    const headers = { 'X-ClickHouse-Format': 'JSONEachRow' };
    if (CH_USER) headers['X-ClickHouse-User'] = CH_USER;
    if (CH_PASS) headers['X-ClickHouse-Key'] = CH_PASS;
    const res = await fetch(url, { headers });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`ClickHouse error ${res.status}: ${text}`);
    }
    const text = await res.text();
    if (!text.trim()) return [];
    return text.trim().split('\n').map(line => JSON.parse(line));
}

/**
 * Pobierz listę aktywnych maszyn (host) z ostatnich 7 dni.
 * @returns {Promise<Array<{host: string, count: number, latest_ts: string, latest_time: string}>>}
 */
export async function getHosts() {
    if (BACKEND === 'clickhouse') {
        const rows = await clickhouseQuery(`
            SELECT
                host,
                sum(count)                  AS count,
                toString(max(date))         AS latest_ts,
                toString(max(date))         AS latest_time
            FROM ${CH_DB}.keystroke_hourly
            WHERE date >= today() - 7
              AND host != ''
            GROUP BY host
            ORDER BY count DESC
            SETTINGS max_threads = 2, max_execution_time = 10
        `);
        return rows.map(r => ({
            host: r.host,
            count: Number(r.count),
            latest_ts: String(r.latest_ts),
            latest_time: r.latest_time
        }));
    }
    return [{ host: 'local', count: 0, latest_ts: '0', latest_time: 'now' }];
}

/**
 * Pobierz historię ostatnich naciśnięć klawiatury.
 * @param {number} limit
 * @param {string} host — 'all' | 'mac' | 'rog'
 * @returns {Promise<Array<{id: number, unique_id: string, ts_nano: string, host: string, timestamp: number, event_type: string, key_name: string, keycode: number}>>}
 */
export async function getHistory(limit = 150, host = 'all') {
    if (BACKEND === 'clickhouse') {
        const safeLimit = Math.min(Math.max(Number(limit) || 150, 10), 2000);
        const cleanHost = String(host || 'all').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
        let hostClause = '';
        if (cleanHost && cleanHost !== 'all') {
            hostClause = `AND host = '${cleanHost}'`;
        }

        const rows = await clickhouseQuery(`
            SELECT
                toString(toUnixTimestamp64Nano(ts))               AS ts_nano,
                toInt64(toUnixTimestamp64Milli(ts))               AS ts_ms,
                host,
                cityHash64(toString(ts), host, key_name)          AS row_id,
                event_type,
                key_name,
                keycode
            FROM ${CH_DB}.keystrokes
            WHERE 1=1
              ${hostClause}
              AND ts >= now() - INTERVAL 24 HOUR
            ORDER BY ts DESC
            LIMIT ${safeLimit}
            SETTINGS max_threads = 2, max_execution_time = 20
        `);
        // Odwróć do chronologicznego
        return rows.reverse().map(r => ({
            id:         Number(r.row_id),
            unique_id:  `${r.host || 'unknown'}_${r.row_id}_${r.ts_nano}`,
            ts_nano:    String(r.ts_nano),
            host:       r.host || '',
            timestamp:  Number(r.ts_ms || 0),
            event_type: r.event_type,
            key_name:   r.key_name,
            keycode:    Number(r.keycode),
        }));
    }
    // SQLite — obsługiwane przez oryginalny +server.js
    return null;
}

/**
 * Pobierz nowe zdarzenia od danego kursora (nanosekundy lub milisekundy).
 * @param {string|number} afterCursor — znacznik czasu (nanosekundy lub ms) ostatniego zdarzenia
 * @param {number} limit
 * @param {string} host — 'all' | 'mac' | 'rog'
 * @returns {Promise<Array>}
 */
export async function getNewEvents(afterCursor = 0, limit = 300, host = 'all') {
    if (BACKEND !== 'clickhouse') return null;

    const cleanHost = String(host || 'all').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    let hostClause = '';
    if (cleanHost && cleanHost !== 'all') {
        hostClause = `AND host = '${cleanHost}'`;
    }

    let tsMs;
    const strCursor = String(afterCursor || '0').trim();

    if (strCursor.length >= 18) {
        // Nanosekundy
        tsMs = Number(BigInt(strCursor) / 1_000_000n);
    } else if (strCursor.length >= 12) {
        // Milisekundy
        tsMs = Number(strCursor);
    } else {
        tsMs = Date.now() - 5000;
    }

    const rows = await clickhouseQuery(`
        SELECT
            toString(toUnixTimestamp64Nano(ts))               AS ts_nano,
            toInt64(toUnixTimestamp64Milli(ts))               AS ts_ms,
            host,
            cityHash64(toString(ts), host, key_name)          AS row_id,
            event_type,
            key_name,
            keycode
        FROM ${CH_DB}.keystrokes
        WHERE 1=1
          ${hostClause}
          AND ts >= fromUnixTimestamp64Milli(${tsMs})
        ORDER BY ts ASC
        LIMIT ${limit}
        SETTINGS max_threads = 2, max_execution_time = 15
    `);

    return rows.map(r => ({
        id:         Number(r.row_id),
        unique_id:  `${r.host || 'unknown'}_${r.row_id}_${r.ts_nano}`,
        ts_nano:    String(r.ts_nano),
        host:       r.host || '',
        timestamp:  Number(r.ts_ms || 0),
        event_type: r.event_type,
        key_name:   r.key_name,
        keycode:    Number(r.keycode),
    }));
}

/**
 * Pobierz zagregowane statystyki analityczne (hacker stats, git calendar, hourly distribution).
 * @param {string} range - 'today' | '7d' | '30d' | 'all'
 * @param {string} host - 'all' | 'mac' | 'rog'
 */
export async function getAggregatedStats(range = 'today', host = 'all') {
    if (BACKEND === 'clickhouse') {
        const cleanHost = String(host || 'all').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
        const cacheKey = `${range}_${cleanHost}`;
        const cached = statsMemoryCache.get(cacheKey);
        const ttl = STATS_CACHE_TTL_MS[range] || 30000;
        if (cached && (Date.now() - cached.ts) < ttl) {
            return cached.data;
        }

        let dateFilter = '';
        if (range === 'today') {
            dateFilter = "date = today()";
        } else if (range === '7d') {
            dateFilter = "date >= today() - 7";
        } else if (range === '30d') {
            dateFilter = "date >= today() - 30";
        } else {
            dateFilter = "date >= today() - 365";
        }

        let hostFilter = '';
        if (cleanHost && cleanHost !== 'all') {
            hostFilter = `AND host = '${cleanHost}'`;
        }

        const [summaryRows, dailyRows, dayHourlyRows, hourlyRows, topKeysRows] = await Promise.all([
            clickhouseQuery(`
                SELECT
                    sumIf(count, event_type = 'PRESS') AS total_presses,
                    sumIf(count, event_type = 'PRESS' AND is_error = 1) AS total_errors,
                    sumIf(count, event_type = 'PRESS' AND is_printable = 1) AS printable_chars
                FROM ${CH_DB}.keystroke_hourly
                WHERE ${dateFilter}
                  ${hostFilter}
            `),
            clickhouseQuery(`
                SELECT
                    toString(date) AS date_str,
                    sumIf(count, event_type = 'PRESS') AS cnt,
                    sumIf(count, event_type = 'PRESS' AND is_error = 1) AS errors
                FROM ${CH_DB}.keystroke_hourly
                WHERE date >= today() - 365
                  ${hostFilter}
                GROUP BY date
                ORDER BY date ASC
            `),
            clickhouseQuery(`
                SELECT
                    toString(date) AS date_str,
                    hour,
                    sumIf(count, event_type = 'PRESS') AS cnt
                FROM ${CH_DB}.keystroke_hourly
                WHERE ${dateFilter}
                  ${hostFilter}
                GROUP BY date_str, hour
                ORDER BY date_str DESC, hour ASC
            `),
            clickhouseQuery(`
                SELECT
                    hour,
                    sumIf(count, event_type = 'PRESS') AS cnt
                FROM ${CH_DB}.keystroke_hourly
                WHERE ${dateFilter}
                  ${hostFilter}
                GROUP BY hour
                ORDER BY hour ASC
            `),
            clickhouseQuery(`
                SELECT
                    key_name,
                    sum(count) AS cnt
                FROM ${CH_DB}.keystroke_hourly
                WHERE ${dateFilter} AND event_type = 'PRESS'
                  ${hostFilter}
                GROUP BY key_name
                ORDER BY cnt DESC
                LIMIT 25
            `)
        ]);

        const summary = summaryRows[0] || {};
        const total = Number(summary.total_presses || 0);
        const errors = Number(summary.total_errors || 0);
        const printable = Number(summary.printable_chars || 0);

        const result = {
            totalPresses: total,
            totalErrors: errors,
            printableChars: printable,
            errorRate: total > 0 ? Number(((errors / total) * 100).toFixed(1)) : 0,
            dailyActivity: dailyRows.map(r => ({ date: r.date_str, count: Number(r.cnt), errors: Number(r.errors) })),
            hourlyActivity: hourlyRows.map(r => ({ hour: Number(r.hour), count: Number(r.cnt) })),
            dayHourlyActivity: dayHourlyRows.map(r => ({ date: r.date_str, hour: Number(r.hour), count: Number(r.cnt) })),
            topKeys: topKeysRows.map(r => ({ name: r.key_name, count: Number(r.cnt) }))
        };

        statsMemoryCache.set(cacheKey, { data: result, ts: Date.now() });
        return result;
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
 * Zrekonstruuj strumień zdarzeń klawiatury oraz nagrań głosowych w spójne bloki myśli, polecenia shella, prompty AI i notatki głosowe.
 * @param {Array<{ts_ms: number, event_type: string, key_name: string, keycode: number}>} events
 * @param {string} dateStr
 * @param {Array<{id?: number|string, ts_ms?: number, started_timestamp?: number, duration_seconds?: number, transcription: string, window_class?: string, window_title?: string}>} [voiceEntries=[]]
 */
export function reconstructJournal(events, dateStr, voiceEntries = []) {
    const blacklist = getBlacklist();
    let isShift = false, isAltGr = false, isCtrl = false;
    const rawChunks = [];
    let currentChars = [];
    let startTs = 0, lastTs = 0;
    let currentHost = '';
    let lastEvent = null;
    let totalPresses = 0;
    const hostPresses = {};

    for (const r of events) {
        const evtHost = r.host || 'local';
        // Pomijaj identyczne duplikaty w oknie 5ms na tym samym hoście
        if (lastEvent && (r.ts_ms - lastEvent.ts_ms) < 5 && r.key_name === lastEvent.key_name && r.event_type === lastEvent.event_type && evtHost === (lastEvent.host || 'local')) {
            continue;
        }
        lastEvent = r;

        if (r.event_type === 'PRESS') {
            totalPresses++;
            hostPresses[evtHost] = (hostPresses[evtHost] || 0) + 1;
        }

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
        const hostSwitched = currentHost && evtHost !== currentHost;
        if (gap > 4.5 || hostSwitched) {
            if (currentChars.length > 0) {
                const rawText = currentChars.join('').trim();
                const text = sanitizeText(rawText, blacklist);
                if (text.length >= 5) {
                    rawChunks.push({ startTs, endTs: lastTs, text, host: currentHost || evtHost });
                }
                currentChars = [];
            }
            if (hostSwitched) {
                isShift = false;
                isAltGr = false;
                isCtrl = false;
            }
            startTs = r.ts_ms;
            currentHost = evtHost;
        } else if (currentChars.length === 0) {
            startTs = r.ts_ms;
            currentHost = evtHost;
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
            rawChunks.push({ startTs, endTs: lastTs, text, host: currentHost || 'local' });
        }
    }

    const fmtTime = (ts) => new Date(ts).toLocaleTimeString('pl-PL', {
        timeZone: 'Europe/Warsaw',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });

    // Formatowanie chunków z klawiatury
    const keyChunks = rawChunks.map((c, idx) => {
        const meta = classifyThought(c.text);
        const durationSec = Math.max(1, Math.round((c.endTs - c.startTs) / 1000));
        const words = c.text.split(/\s+/).filter(Boolean).length;
        const startTimeStr = fmtTime(c.startTs);
        const endTimeStr = fmtTime(c.endTs);

        return {
            id: idx + 1,
            host: c.host || 'local',
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
            categoryLabel: meta.label,
            windowClass: '',
            windowTitle: ''
        };
    });

    // Formatowanie chunków z transkrypcji mowy
    const voiceChunks = (voiceEntries || []).map((v, idx) => {
        const cleanText = sanitizeText((v.transcription || '').trim(), blacklist);
        const durationSec = Math.max(1, Math.round(Number(v.duration_seconds || 1)));
        const startTs = Number(v.ts_ms || (v.started_timestamp ? Math.round(v.started_timestamp * 1000) : 0));
        const endTs = startTs + (durationSec * 1000);
        const startTimeStr = fmtTime(startTs);
        const endTimeStr = fmtTime(endTs);
        const words = cleanText.split(/\s+/).filter(Boolean).length;

        return {
            id: `v-${v.id || idx + 1}`,
            host: v.host || 'local',
            startTs,
            endTs,
            startTimeStr,
            endTimeStr,
            durationSec,
            text: cleanText,
            words,
            chars: cleanText.length,
            category: 'voice',
            icon: '🎙️',
            categoryLabel: 'Notatka Głosowa / Mowa',
            windowClass: v.window_class || '',
            windowTitle: v.window_title || ''
        };
    }).filter(v => v.text.length > 0 && v.startTs > 0);

    // Połączenie i sortowanie chronologiczne wszystkich wpisów
    const allChunks = [...keyChunks, ...voiceChunks].sort((a, b) => a.startTs - b.startTs);
    allChunks.forEach((c, idx) => {
        c.displayId = idx + 1;
    });

    // Grupowanie w sesje (przerwa > 25 min tworzy nową sesję)
    const sessions = [];
    let currentSession = null;

    for (const ch of allChunks) {
        if (!currentSession || (ch.startTs - currentSession.endTs) > 25 * 60 * 1000) {
            if (currentSession) {
                sessions.push(currentSession);
            }
            const hour = Number(ch.startTimeStr.slice(0, 2));
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
            if (ch.endTs > currentSession.endTs) {
                currentSession.endTs = ch.endTs;
                currentSession.endTimeStr = ch.endTimeStr;
            }
            currentSession.chunks.push(ch);
        }
    }
    if (currentSession) sessions.push(currentSession);

    const totalWords = allChunks.reduce((acc, c) => acc + c.words, 0);
    const totalVoiceDurationSec = voiceChunks.reduce((acc, v) => acc + v.durationSec, 0);
    const hostSummaryStr = Object.entries(hostPresses)
        .map(([h, cnt]) => `${h}: ${cnt} klawiszy`)
        .join(', ');

    // Generowanie gotowego Markdownu dla LLM
    let llmPrompt = `# Dziennik Pracy, Klawiatury i Notatek Głosowych — ${dateStr}\n\n`;
    llmPrompt += `- **Łączna liczba naciśnięć klawiszy (Keylogger PRESS):** ${totalPresses}${hostSummaryStr ? ` (${hostSummaryStr})` : ''}\n`;
    llmPrompt += `- **Zrekonstruowane bloki tekstu / myśli:** ${allChunks.length} (${totalWords} słów w ${sessions.length} sesjach)\n\n`;
    llmPrompt += `---\n\n`;

    for (const s of sessions) {
        llmPrompt += `## ${s.label} [${s.startTimeStr.slice(0, 5)} – ${s.endTimeStr.slice(0, 5)}] (${s.chunks.length} wpisów)\n\n`;
        for (const ch of s.chunks) {
            const hostBadge = ch.host && ch.host !== 'local' ? ` [${ch.host}]` : '';
            if (ch.category === 'voice') {
                const winContext = ch.windowClass ? ` [Aplikacja: ${ch.windowClass}]` : '';
                const dur = ch.durationSec ? ` (${ch.durationSec}s)` : '';
                llmPrompt += `- **[${ch.startTimeStr}]**${hostBadge} (🎙️ Notatka Głosowa / Mowa${winContext}${dur}):\n  "${ch.text.replace(/"/g, '\\"')}"\n\n`;
            } else if (ch.category === 'shell') {
                llmPrompt += `- **[${ch.startTimeStr}]**${hostBadge} (Polecenie Shell):\n  \`\`\`bash\n  ${ch.text}\n  \`\`\`\n`;
            } else if (ch.category === 'prompt') {
                llmPrompt += `- **[${ch.startTimeStr}]**${hostBadge} (Prompt / Zapytanie AI):\n  "${ch.text.replace(/"/g, '\\"')}"\n\n`;
            } else {
                llmPrompt += `- **[${ch.startTimeStr}]**${hostBadge} (${ch.categoryLabel}):\n  ${ch.text}\n\n`;
            }
        }
        llmPrompt += `\n`;
    }

    return {
        date: dateStr,
        totalPresses,
        hostPresses,
        totalChunks: allChunks.length,
        totalWords,
        totalVoiceCount: voiceChunks.length,
        totalVoiceDurationSec,
        sessions,
        chunks: allChunks,
        llmPromptMarkdown: sanitizeText(llmPrompt, blacklist)
    };
}

export async function getDailyJournal(dateStr, host = 'all') {
    if (BACKEND === 'clickhouse') {
        const cleanHost = String(host || 'all').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
        let hostClause = '';
        if (cleanHost && cleanHost !== 'all') {
            hostClause = `AND host = '${cleanHost}'`;
        }

        const [rows, dateRows] = await Promise.all([
            clickhouseQuery(`
                SELECT
                    toInt64(toUnixTimestamp64Milli(ts))   AS ts_ms,
                    host,
                    event_type,
                    key_name,
                    keycode
                FROM ${CH_DB}.keystrokes
                WHERE 1=1
                  ${hostClause}
                  AND toDate(ts, 'Europe/Warsaw') = toDate('${dateStr}')
                ORDER BY ts ASC
                SETTINGS max_threads = 2, max_execution_time = 30
            `),
            clickhouseQuery(`
                SELECT DISTINCT toString(date) AS date_str
                FROM ${CH_DB}.keystroke_hourly
                WHERE date >= today() - 30
                ORDER BY date_str DESC
                LIMIT 30
                SETTINGS max_threads = 2, max_execution_time = 5
            `).catch(() => [])
        ]);
        const journal = reconstructJournal(rows, dateStr, []);
        journal.availableDates = (dateRows || []).map(r => r.date_str).filter(Boolean);
        return journal;
    }
    return null;
}

export { BACKEND };
