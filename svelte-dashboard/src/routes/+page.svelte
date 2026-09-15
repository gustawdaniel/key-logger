<script>
    import { onMount, onDestroy } from 'svelte';

    // --- STAN APLIKACJI I MOTYW ---
    let theme = $state('matrix'); // 'matrix' | 'neon' | 'amber' | 'ghost'
    let activeTab = $state('terminal'); // 'terminal' | 'journal' | 'bursts' | 'stats' | 'raw'
    let textMode = $state('clean'); // 'clean' | 'raw'
    let soundEnabled = $state(false);

    // --- METRYKI GŁÓWNE ---
    let totalKeys = $state(0);
    let backspaceCount = $state(0);
    let errorRate = $derived(totalKeys > 0 ? ((backspaceCount / totalKeys) * 100).toFixed(1) : 0);
    let cpm = $state(0);           // Średnia krocząca 60s
    let instantCpm = $state(0);    // Błyskawiczna prędkość chwilowa (dynamic burst)
    let peakCpm = $state(0);       // Maksymalny osiągnięty pik sesji
    let lastLiveKeyTime = 0;       // Znacznik czasu ostatniego fizycznego uderzenia
    let tickId = 0;

    // --- MULTI-SCALE SPEED OSCILLOSCOPES (KASKADOWE HORYZONTY CZASOWE) ---
    let speedTimeframe = $state('cascade'); // '15s' | '2m' | '15m' | 'cascade'

    /** @type {Array<{id: number, time: string, cpm: number}>} */
    let speedHistory15s = $state(
        Array.from({ length: 36 }, (_, i) => ({ id: i, time: '--:--', cpm: 0 }))
    );
    /** @type {Array<{id: number, time: string, cpm: number}>} */
    let speedHistory2m = $state(
        Array.from({ length: 36 }, (_, i) => ({ id: i, time: '--:--', cpm: 0 }))
    );
    /** @type {Array<{id: number, time: string, cpm: number}>} */
    let speedHistory15m = $state(
        Array.from({ length: 36 }, (_, i) => ({ id: i, time: '--:--', cpm: 0 }))
    );

    // --- REKONSTRUKCJA CIĄGŁEGO TEKSTU ---
    let liveText = $state("");
    let rawTextStream = $state("");
    let terminalBox = $state();
    let burstsBox = $state();

    // --- GRUPOWANIE W BURSTY (SESJE PISANIA / ODSTĘPY CZASOWE) ---
    /**
     * @typedef {{
     *   id: number,
     *   startTime: string,
     *   startTs: number,
     *   endTs: number,
     *   durationMs: number,
     *   timeGapSec: number,
     *   text: string,
     *   rawTokens: string,
     *   keysCount: number,
     *   errorsCount: number,
     *   cpm: number,
     *   category: string,
     *   shortcuts: string[]
     * }} Burst
     */
    /** @type {Array<Burst>} */
    let bursts = $state([]);
    let currentBurst = null;
    let lastKeyTime = 0;

    // --- MODYFIKATORY I SKRÓTY ---
    let isShiftPressed = $state(false);
    let isCtrlPressed = $state(false);
    let isAltPressed = $state(false);
    let lastCopyTime = 0;
    /** @type {Array<{time: number, flightMs: number}>} */
    let copyPasteHistory = $state([]);
    let avgPasteTime = $derived(
        copyPasteHistory.length > 0 
        ? (copyPasteHistory.reduce((a,b)=>a+b.flightMs, 0) / copyPasteHistory.length / 1000).toFixed(2)
        : 0
    );

    // --- DYSTRYBUCJA CZASU LOTU (CADENCE SPECTRUM) ---
    let cadenceBuckets = $state({ fast: 0, steady: 0, pause: 0, stop: 0 }); // <100ms, 100-250ms, 250-800ms, >800ms
    let totalCadence = $derived(cadenceBuckets.fast + cadenceBuckets.steady + cadenceBuckets.pause + cadenceBuckets.stop || 1);
    let fastPct = $derived(Math.round((cadenceBuckets.fast / totalCadence) * 100));
    let steadyPct = $derived(Math.round((cadenceBuckets.steady / totalCadence) * 100));
    let pausePct = $derived(Math.round((cadenceBuckets.pause / totalCadence) * 100));
    let stopPct = $derived(Math.round((cadenceBuckets.stop / totalCadence) * 100));

    // --- STATYSTYKI ZAPLECZA ---
    let serverStats = $state(null);
    let statsRange = $state('today');
    let isLoadingDeep = $state(false);

    /** @type {Array<any>} */
    let keystrokes = $state([]);
    let lastId = 0;
    let eventSource = null;
    let cpmInterval = null;

    // --- SŁOWNIKI ZNAKÓW ---
    const SHIFT_MAP = {
        '1': '!', '2': '@', '3': '#', '4': '$', '5': '%',
        '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
        'minus': '_', 'equal': '+',
        'bracketleft': '{', 'bracketright': '}',
        'semicolon': ':', 'apostrophe': '"',
        'grave': '~', 'backslash': '|',
        'comma': '<', 'period': '>', 'slash': '?',
        '/': '?', ';': ':', '\'': '"', '[': '{', ']': '}',
        '\\': '|', '`': '~', '-': '_', '=': '+',
        'question': '?', 'exclam': '!', 'at': '@', 'numbersign': '#',
        'dollar': '$', 'percent': '%', 'asciicircum': '^', 'ampersand': '&',
        'asterisk': '*', 'parenleft': '(', 'parenright': ')', 'underscore': '_',
        'plus': '+', 'colon': ':', 'quotedbl': '"', 'asciitilde': '~',
        'bar': '|', 'less': '<', 'greater': '>'
    };

    const NORMAL_MAP = {
        'space': ' ', 'Return': '\n', 'Tab': '\t', 'comma': ',', 'period': '.',
        'minus': '-', 'slash': '/', 'equal': '=', 'semicolon': ';',
        'apostrophe': '\'', 'grave': '`', 'backslash': '\\',
        'bracketleft': '[', 'bracketright': ']'
    };

    // --- SYNTEZATOR DŹWIĘKÓW KLAWIATURY (MECHANICAL SWITCH) ---
    let audioCtx = null;
    function playKeySound() {
        if (!soundEnabled) return;
        try {
            if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const now = audioCtx.currentTime;
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(320 + Math.random() * 80, now);
            osc.frequency.exponentialRampToValueAtTime(80, now + 0.04);
            gain.gain.setValueAtTime(0.08, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start(now);
            osc.stop(now + 0.04);
        } catch (e) {
            // Audio context policy
        }
    }

    // --- AUTO-SCROLL ---
    $effect(() => {
        if (terminalBox && (liveText || rawTextStream)) {
            terminalBox.scrollTop = terminalBox.scrollHeight;
        }
        if (burstsBox && bursts.length) {
            burstsBox.scrollTop = burstsBox.scrollHeight;
        }
    });

    onMount(async () => {
        // 1. Pobierz głębszą historię początkową (1200 zdarzeń)
        await loadInitialHistory(1200);

        // 2. Pobierz zagregowane statystyki telemetryczne
        loadServerStats(statsRange);

        // 2b. Pobierz dziennik myśli i promptów dzisiejszego dnia
        loadJournal(journalDate);

        // 3. Połącz strumień SSE na żywo
        eventSource = new EventSource('/api/stream?lastId=' + lastId);
        eventSource.onmessage = (event) => {
            const newKey = JSON.parse(event.data);
            if (newKey.id > lastId) lastId = newKey.id;
            processKey(newKey, false);
        };

        // 4. Oscyloskop prędkości - szybkie próbkowanie co 300ms
        cpmInterval = setInterval(() => {
            calculateCPM();
        }, 300);
    });

    onDestroy(() => {
        if (eventSource) eventSource.close();
        if (cpmInterval) clearInterval(cpmInterval);
    });

    async function loadInitialHistory(limit = 1200) {
        try {
            const res = await fetch(`/api/history?limit=${limit}`);
            if (res.ok) {
                const history = await res.json();
                history.forEach(k => {
                    if (k.id > lastId) lastId = k.id;
                    processKey(k, true);
                });
                // Flush ostatniego oczekującego burstu z historii
                if (currentBurst && (currentBurst.text.trim() || currentBurst.shortcuts.length || currentBurst.errorsCount > 0)) {
                    currentBurst.endTs = lastKeyTime || currentBurst.startTs;
                    currentBurst.durationMs = Math.max(150, currentBurst.endTs - currentBurst.startTs);
                    currentBurst.cpm = Math.min(800, Math.round((currentBurst.keysCount / (currentBurst.durationMs / 60000)))) || 0;
                    currentBurst.category = inferBurstCategory(currentBurst.text, currentBurst.shortcuts);
                    bursts = [...bursts, currentBurst].slice(-150);
                    currentBurst = null;
                }
            }
        } catch (e) {
            console.error("Błąd ładowania historii:", e);
        }
    }

    async function loadDeepHistory() {
        isLoadingDeep = true;
        seenKeyIds.clear();
        lastKeySignature = '';
        bursts = [];
        currentBurst = null;
        totalKeys = 0;
        backspaceCount = 0;
        liveText = "";
        rawTextStream = "";
        cadenceBuckets = { fast: 0, steady: 0, pause: 0, stop: 0 };
        await loadInitialHistory(4000);
        isLoadingDeep = false;
    }

    async function loadServerStats(range) {
        statsRange = range;
        try {
            const res = await fetch(`/api/stats?range=${range}`);
            if (res.ok) {
                serverStats = await res.json();
            }
        } catch (e) {
            console.error("Błąd stats:", e);
        }
    }

    let seenKeyIds = new Set();
    let lastKeySignature = '';

    function processKey(keyData, isInitialHistory = false) {
        if (!keyData || !keyData.key_name) return;

        // 1. Odrzucenie duplikatów po ID
        if (keyData.id) {
            if (seenKeyIds.has(keyData.id)) return;
            seenKeyIds.add(keyData.id);
            if (seenKeyIds.size > 3000) {
                const arr = Array.from(seenKeyIds);
                seenKeyIds = new Set(arr.slice(-1500));
            }
        }

        // 2. Odrzucenie duplikatów po sygnaturze zdarzenia (ten sam timestamp, typ i klawisz)
        const sig = `${keyData.timestamp}_${keyData.event_type}_${keyData.keycode || keyData.key_name}`;
        if (sig === lastKeySignature) return;
        lastKeySignature = sig;

        const name = keyData.key_name;
        const now = keyData.timestamp;

        // Śledzenie modyfikatorów
        if (keyData.event_type === 'PRESS') {
            if (!isInitialHistory) {
                lastLiveKeyTime = Date.now();
                playKeySound();
            }

            if (name === 'Shift_L' || name === 'Shift_R') {
                isShiftPressed = true;
                keystrokes = [keyData, ...keystrokes].slice(0, 500);
                return;
            }
            if (name === 'Control_L' || name === 'Control_R') {
                isCtrlPressed = true;
                keystrokes = [keyData, ...keystrokes].slice(0, 500);
                return;
            }
            if (name === 'Alt_L' || name === 'Alt_R') {
                isAltPressed = true;
                keystrokes = [keyData, ...keystrokes].slice(0, 500);
                return;
            }

            totalKeys++;
            if (name === 'BackSpace' || name === 'Delete') backspaceCount++;

            // Mierzenie rytmu pisania (Cadence / Flight Time)
            if (lastKeyTime > 0) {
                const delta = now - lastKeyTime;
                if (delta > 20) {
                    if (delta < 100) cadenceBuckets.fast++;
                    else if (delta < 250) cadenceBuckets.steady++;
                    else if (delta < 800) cadenceBuckets.pause++;
                    else cadenceBuckets.stop++;
                }
            }

            // Kopiuj-Wklej
            if (isCtrlPressed && name === 'c') {
                lastCopyTime = now;
            } else if (isCtrlPressed && name === 'v') {
                if (lastCopyTime > 0) {
                    const flightMs = now - lastCopyTime;
                    if (flightMs < 60000) {
                        copyPasteHistory = [{ time: now, flightMs }, ...copyPasteHistory].slice(0, 5);
                    }
                    lastCopyTime = 0;
                }
            }

            // --- REKONSTRUKCJA ZNAKÓW ---
            let char = "";
            if (name === 'BackSpace') {
                liveText = liveText.slice(0, -1);
                rawTextStream += '⌫';
            } else if (name === 'space') {
                char = ' ';
                rawTextStream += ' ';
            } else if (name === 'Return') {
                char = '\n';
                rawTextStream += '\n';
            } else if (name === 'Tab') {
                char = '  ';
                rawTextStream += '  ';
            } else if (isShiftPressed) {
                if (SHIFT_MAP[name]) {
                    char = SHIFT_MAP[name];
                    rawTextStream += char;
                } else if (name.length === 1) {
                    char = name.toUpperCase();
                    rawTextStream += char;
                } else {
                    rawTextStream += `[${name}]`;
                }
            } else {
                if (NORMAL_MAP[name]) {
                    char = NORMAL_MAP[name];
                    rawTextStream += char;
                } else if (name.length === 1) {
                    char = name.toLowerCase();
                    rawTextStream += char;
                } else {
                    rawTextStream += `[${name}]`;
                }
            }

            if (char) {
                liveText += char;
            }
            if (liveText.length > 8000) liveText = liveText.slice(-8000);
            if (rawTextStream.length > 9000) rawTextStream = rawTextStream.slice(-9000);

            // --- GRUPOWANIE W BURSTY (SESJE PISANIA / ODSTĘPY CZASOWE) ---
            const timeGapMs = lastKeyTime > 0 ? (now - lastKeyTime) : 0;
            const isNewBurst = !currentBurst || timeGapMs > 1400 || name === 'Return';

            if (isNewBurst) {
                if (currentBurst && currentBurst.keysCount > 0) {
                    if (currentBurst.text.trim() || currentBurst.shortcuts.length || currentBurst.errorsCount > 0) {
                        currentBurst.endTs = lastKeyTime || now;
                        currentBurst.durationMs = Math.max(150, currentBurst.endTs - currentBurst.startTs);
                        currentBurst.cpm = Math.min(800, Math.round((currentBurst.keysCount / (currentBurst.durationMs / 60000)))) || 0;
                        currentBurst.category = inferBurstCategory(currentBurst.text, currentBurst.shortcuts);
                        bursts = [...bursts, currentBurst].slice(-150);
                    }
                }

                currentBurst = {
                    id: Date.now() + Math.random(),
                    startTime: new Date(now).toTimeString().split(' ')[0],
                    startTs: now,
                    endTs: now,
                    durationMs: 0,
                    timeGapSec: (timeGapMs / 1000).toFixed(1),
                    text: char || (name === 'BackSpace' ? '' : ''),
                    rawTokens: name === 'BackSpace' ? '⌫' : (char || `[${name}]`),
                    keysCount: 1,
                    errorsCount: (name === 'BackSpace' || name === 'Delete') ? 1 : 0,
                    cpm: 0,
                    category: 'Typing...',
                    shortcuts: isCtrlPressed ? [`Ctrl+${name}`] : (isAltPressed ? [`Alt+${name}`] : [])
                };
            } else {
                currentBurst.keysCount++;
                currentBurst.endTs = now;
                if (name === 'BackSpace' || name === 'Delete') {
                    currentBurst.errorsCount++;
                    currentBurst.text = currentBurst.text.slice(0, -1);
                    currentBurst.rawTokens += '⌫';
                } else if (char) {
                    currentBurst.text += char;
                    currentBurst.rawTokens += char;
                } else {
                    currentBurst.rawTokens += `[${name}]`;
                }

                if (isCtrlPressed) currentBurst.shortcuts.push(`Ctrl+${name}`);
                if (isAltPressed) currentBurst.shortcuts.push(`Alt+${name}`);
            }

            lastKeyTime = now;
        } else if (keyData.event_type === 'RELEASE') {
            if (name === 'Shift_L' || name === 'Shift_R') isShiftPressed = false;
            if (name === 'Control_L' || name === 'Control_R') isCtrlPressed = false;
            if (name === 'Alt_L' || name === 'Alt_R') isAltPressed = false;
        }

        keystrokes = [keyData, ...keystrokes].slice(0, 500);
    }

    function inferBurstCategory(text, shortcuts) {
        if (shortcuts && shortcuts.length) return '⌨️ Hotkey / Shortcut';
        const t = text.trim();
        if (t.startsWith('$') || t.startsWith('git ') || t.startsWith('docker ') || t.startsWith('ssh ') || t.startsWith('cd ') || t.startsWith('sudo ') || t.startsWith('ls ') || t.startsWith('curl ')) {
            return '💻 Shell Command';
        }
        if (/[{}();=><\[\]]/.test(t) && t.length > 5) {
            return '⚙️ Code / Logic';
        }
        if (t.length > 20 && t.includes(' ')) {
            return '💬 Text / Paragraph';
        }
        return '📝 Input / Token';
    }

    function calculateCPM() {
        const now = Date.now();
        const idleMs = now - (lastLiveKeyTime || 0);

        // 1. Natychmiastowa prędkość chwilowa (15s Oscilloscope - okno 1.2s)
        if (idleMs > 800) {
            if (idleMs > 1600) {
                instantCpm = 0;
            } else {
                instantCpm = Math.max(0, Math.round(instantCpm * 0.45));
            }
        } else {
            const instantWindow = now - 1200;
            let instantKeys = 0;
            for (const k of keystrokes) {
                if (k.event_type === 'PRESS' && k.timestamp > instantWindow) instantKeys++;
                if (k.timestamp < instantWindow) break;
            }
            instantCpm = Math.round((instantKeys / 1.2) * 60);
        }

        // 2. Średnia z 60 sekund
        const oneMinuteAgo = now - 60000;
        let minuteKeys = 0;
        for (const k of keystrokes) {
            if (k.event_type === 'PRESS' && k.timestamp > oneMinuteAgo) minuteKeys++;
            if (k.timestamp < oneMinuteAgo) break;
        }
        cpm = minuteKeys;

        if (instantCpm > peakCpm) peakCpm = instantCpm;

        // 3. Przesuwanie fali oscyloskopu 15s (co 300ms)
        tickId++;
        const timeStr = new Date(now).toTimeString().split(' ')[0].slice(3);
        speedHistory15s = [
            ...speedHistory15s.slice(-35),
            { id: tickId, time: timeStr, cpm: instantCpm }
        ];

        // 4. Przesuwanie fali makro 2-minutowej (co ~3.3 sekundy = co 11 ticków)
        if (tickId % 11 === 0) {
            const window2m = now - 10000;
            let count2m = 0;
            for (const k of keystrokes) {
                if (k.event_type === 'PRESS' && k.timestamp > window2m) count2m++;
                if (k.timestamp < window2m) break;
            }
            const cpm2m = Math.round((count2m / 10) * 60);
            speedHistory2m = [
                ...speedHistory2m.slice(-35),
                { id: tickId, time: timeStr, cpm: cpm2m }
            ];
        }

        // 5. Przesuwanie fali długookresowej 15-minutowej (co ~25 sekund = co 80 ticków)
        if (tickId % 80 === 0) {
            speedHistory15m = [
                ...speedHistory15m.slice(-35),
                { id: tickId, time: timeStr, cpm }
            ];
        }
    }

    // --- GENERATOR PEŁNEJ SIATKI GIT CONTRIBUTION (52 TYGODNIE x 7 DNI) ---
    function buildContributionMatrix(dailyActivity) {
        const activityMap = new Map();
        let totalKeystrokesYear = 0;
        let activeDaysCount = 0;
        let maxDayCount = 0;
        let busiestDate = '-';

        if (dailyActivity && Array.isArray(dailyActivity)) {
            for (const item of dailyActivity) {
                activityMap.set(item.date, item);
                totalKeystrokesYear += item.count;
                if (item.count > 0) activeDaysCount++;
                if (item.count > maxDayCount) {
                    maxDayCount = item.count;
                    busiestDate = item.date;
                }
            }
        }

        // Wygeneruj 52 tygodnie wstecz od dzisiaj (364 dni)
        const weeks = [];
        const today = new Date();
        const endDayOfWeek = today.getDay(); // 0 = Niedziela
        
        // Zacznij od niedzieli 52 tygodnie temu
        const startDate = new Date(today);
        startDate.setDate(today.getDate() - (52 * 7) + (6 - endDayOfWeek));

        const monthLabels = [];
        let lastMonth = -1;

        for (let w = 0; w < 52; w++) {
            const days = [];
            for (let d = 0; d < 7; d++) {
                const cur = new Date(startDate);
                cur.setDate(startDate.getDate() + (w * 7) + d);
                const dateStr = cur.toISOString().split('T')[0];
                const act = activityMap.get(dateStr);
                const count = act ? act.count : 0;
                const errors = act ? act.errors : 0;
                
                let level = 0;
                if (count > 4000) level = 4;
                else if (count > 1500) level = 3;
                else if (count > 300) level = 2;
                else if (count > 0) level = 1;

                days.push({
                    date: dateStr,
                    dayOfWeek: d,
                    count,
                    errors,
                    level,
                    isFuture: cur > today
                });

                if (d === 0 && cur.getMonth() !== lastMonth && cur <= today) {
                    lastMonth = cur.getMonth();
                    monthLabels.push({
                        weekIndex: w,
                        name: cur.toLocaleString('en-US', { month: 'short' })
                    });
                }
            }
            weeks.push(days);
        }

        return {
            weeks,
            monthLabels,
            totalKeystrokesYear,
            activeDaysCount,
            busiestDate,
            maxDayCount
        };
    }

    let gitMatrix = $derived(buildContributionMatrix(serverStats?.dailyActivity));

    let hoveredHour = $state(null);

    function buildDiurnalMatrix(dayHourlyRows) {
        if (!dayHourlyRows || !dayHourlyRows.length) return null;

        const byDate = new Map();
        for (const row of dayHourlyRows) {
            if (!byDate.has(row.date)) {
                byDate.set(row.date, []);
            }
            byDate.get(row.date).push(row);
        }

        let globalMaxHourly = 1;
        for (const row of dayHourlyRows) {
            if (row.count > globalMaxHourly) globalMaxHourly = row.count;
        }

        const days = [];
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

        for (const [dateStr, rows] of byDate.entries()) {
            const dObj = new Date(dateStr + 'T00:00:00');
            const dayOfWeek = isNaN(dObj.getDay()) ? '' : dayNames[dObj.getDay()];
            
            let dayTotal = 0;
            let activeHours = 0;
            let peakHour = 0;
            let peakCount = 0;

            const hours = Array.from({ length: 24 }, (_, h) => {
                const match = rows.find(r => r.hour === h);
                const count = match ? match.count : 0;
                dayTotal += count;
                if (count > 0) activeHours++;
                if (count > peakCount) {
                    peakCount = count;
                    peakHour = h;
                }

                let level = 0;
                if (count > 0) {
                    const ratio = count / globalMaxHourly;
                    if (ratio > 0.5) level = 4;
                    else if (ratio > 0.25) level = 3;
                    else if (ratio > 0.08) level = 2;
                    else level = 1;
                }

                const pct = count > 0 ? Math.max(12, Math.min(100, Math.round((count / globalMaxHourly) * 100))) : 0;

                return {
                    hour: h,
                    count,
                    level,
                    pct
                };
            });

            days.push({
                date: dateStr,
                dayOfWeek,
                total: dayTotal,
                activeHours,
                peakHour,
                peakCount,
                hours
            });
        }

        // Sort days descending (newest on top)
        days.sort((a, b) => b.date.localeCompare(a.date));

        const totalKeystrokes = days.reduce((sum, d) => sum + d.total, 0);
        const totalActiveDays = days.length;
        const maxDayTotal = Math.max(...days.map(d => d.total), 1);

        return {
            days,
            globalMaxHourly,
            totalKeystrokes,
            totalActiveDays,
            maxDayTotal
        };
    }

    let diurnalMatrix = $derived(buildDiurnalMatrix(serverStats?.dayHourlyActivity));

    // --- DZIENNIK DNIA & EKSPORT DLA LLM ---
    let journalDate = $state(new Date().toISOString().slice(0, 10));
    /** @type {any} */
    let journalData = $state(null);
    let isLoadingJournal = $state(false);
    let journalCategoryFilter = $state('all'); // 'all' | 'prompt' | 'shell' | 'code' | 'note'
    let journalSearchTerm = $state('');
    let copyFeedback = $state('');
    let showMarkdownDrawer = $state(false);
    let journalError = $state('');

    async function loadJournal(date = journalDate) {
        isLoadingJournal = true;
        journalError = '';
        try {
            const res = await fetch(`/api/journal?date=${date}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            journalData = data;
            journalDate = data.date || date;
        } catch (e) {
            console.error('Failed to load journal:', e);
            journalError = e.message;
        } finally {
            isLoadingJournal = false;
        }
    }

    async function copyLlmPrompt() {
        if (!journalData?.llmPromptMarkdown) return;
        try {
            await navigator.clipboard.writeText(journalData.llmPromptMarkdown);
            copyFeedback = '✅ SKOPIOWANO PROMPT DO SCHOWKA! (Wklej do Claude / ChatGPT / Gemini)';
            setTimeout(() => { copyFeedback = ''; }, 3500);
        } catch (e) {
            console.error('Copy failed:', e);
            copyFeedback = '❌ Błąd kopiowania do schowka';
            setTimeout(() => { copyFeedback = ''; }, 3000);
        }
    }

    async function copySingleChunk(text) {
        try {
            await navigator.clipboard.writeText(text);
            copyFeedback = '✅ Skopiowano fragment do schowka!';
            setTimeout(() => { copyFeedback = ''; }, 2000);
        } catch (e) {
            console.error(e);
        }
    }

    function downloadMarkdown() {
        if (!journalData?.llmPromptMarkdown) return;
        const blob = new Blob([journalData.llmPromptMarkdown], { type: 'text/markdown;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', `dziennik-pracy-${journalDate}.md`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    let countPrompts = $derived(journalData?.chunks?.filter(c => c.category === 'prompt').length || 0);
    let countShell = $derived(journalData?.chunks?.filter(c => c.category === 'shell').length || 0);
    let countCode = $derived(journalData?.chunks?.filter(c => c.category === 'code').length || 0);
    let countNote = $derived(journalData?.chunks?.filter(c => c.category === 'note').length || 0);

    let filteredJournalSessions = $derived.by(() => {
        if (!journalData?.sessions) return [];
        const q = journalSearchTerm.toLowerCase().trim();
        return journalData.sessions.map(s => {
            const matchingChunks = s.chunks.filter(c => {
                const catMatch = (journalCategoryFilter === 'all' || c.category === journalCategoryFilter);
                const textMatch = (!q || c.text.toLowerCase().includes(q));
                return catMatch && textMatch;
            });
            return { ...s, chunks: matchingChunks };
        }).filter(s => s.chunks.length > 0);
    });
</script>

<svelte:head>
    <title>Hacker Keystroke Command & Intelligence</title>
    <link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;600;700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
</svelte:head>

<div class="hacker-app theme-{theme}">
    <!-- Top Cyberpunk Bar -->
    <header class="cyber-header">
        <div class="sys-title">
            <span class="pulse-dot"></span>
            <span class="glitch-text" data-text="CYBER://KEYLOG_ANALYTICS">CYBER://KEYLOG_ANALYTICS</span>
            <span class="sec-badge">SEC_LEVEL_9</span>
        </div>

        <!-- Telemetry Pill Indicators -->
        <div class="header-metrics">
            <div class="pill"><span class="lbl">INSTANT:</span> <strong class="val-glow" class:pulse-high={instantCpm > 250}>{instantCpm} CPM</strong></div>
            <div class="pill"><span class="lbl">1-MIN AVG:</span> <strong class="val-glow">{cpm}</strong></div>
            <div class="pill"><span class="lbl">ERR_RATE:</span> <strong class="val-glow {errorRate > 10 ? 'err' : ''}">{errorRate}%</strong></div>
            <div class="pill"><span class="lbl">TOTAL_KEYS:</span> <strong class="val-glow">{totalKeys}</strong></div>
            <div class="pill"><span class="lbl">PASTE_LAG:</span> <strong class="val-glow">{avgPasteTime}s</strong></div>
        </div>

        <!-- Theme & Audio Controls -->
        <div class="header-controls">
            <button 
                class="ctrl-btn {soundEnabled ? 'active' : ''}" 
                onclick={() => { soundEnabled = !soundEnabled; if(soundEnabled) playKeySound(); }}
                title="Mechanical Switch Audio Feedback"
            >
                {soundEnabled ? '🔊 Mech Click' : '🔇 Mute'}
            </button>
            <div class="theme-select">
                <button class="theme-dot matrix {theme === 'matrix' ? 'active' : ''}" onclick={() => theme = 'matrix'} title="Matrix Green"></button>
                <button class="theme-dot neon {theme === 'neon' ? 'active' : ''}" onclick={() => theme = 'neon'} title="Cyber Neon"></button>
                <button class="theme-dot amber {theme === 'amber' ? 'active' : ''}" onclick={() => theme = 'amber'} title="Amber CRT"></button>
                <button class="theme-dot ghost {theme === 'ghost' ? 'active' : ''}" onclick={() => theme = 'ghost'} title="Ghost Blue"></button>
            </div>
        </div>
    </header>

    <!-- Navigation Tabs -->
    <nav class="view-tabs">
        <button class="tab-btn {activeTab === 'terminal' ? 'active' : ''}" onclick={() => activeTab = 'terminal'}>
            🖥️ Terminal Stream
        </button>
        <button class="tab-btn {activeTab === 'journal' ? 'active' : ''}" onclick={() => { activeTab = 'journal'; if (!journalData) loadJournal(); }}>
            📑 Day Journal & LLM Digest
        </button>
        <button class="tab-btn {activeTab === 'bursts' ? 'active' : ''}" onclick={() => activeTab = 'bursts'}>
            📦 Session Bursts & Chunks ({bursts.length})
        </button>
        <button class="tab-btn {activeTab === 'stats' ? 'active' : ''}" onclick={() => activeTab = 'stats'}>
            📊 Deep Intelligence & Heatmaps
        </button>
        <button class="tab-btn {activeTab === 'raw' ? 'active' : ''}" onclick={() => activeTab = 'raw'}>
            🔤 Packet Log Matrix
        </button>
    </nav>

    <!-- Main Content Area -->
    <main class="main-viewport">
        <!-- TAB 1: TERMINAL STREAM -->
        {#if activeTab === 'terminal'}
            <div class="tab-layout terminal-tab">
                <section class="panel terminal-panel">
                    <div class="panel-bar">
                        <span class="panel-tag">&gt; ROOT_SESSION_RECONSTRUCTOR</span>
                        <div class="mode-toggles">
                            <button class="mode-btn {textMode === 'clean' ? 'active' : ''}" onclick={() => textMode = 'clean'}>
                                🧹 Clean (evaluated abd)
                            </button>
                            <button class="mode-btn {textMode === 'raw' ? 'active' : ''}" onclick={() => textMode = 'raw'}>
                                🔤 Raw Stream (abc⌫d)
                            </button>
                        </div>
                    </div>
                    <div class="terminal-screen" bind:this={terminalBox}>
                        <div class="crt-scanline"></div>
                        <div class="terminal-body">
                            <span class="prompt-prefix">root@rog:~$</span>
                            <span class="terminal-text">{textMode === 'clean' ? liveText : rawTextStream}</span>
                            <span class="cursor-block">█</span>
                        </div>
                    </div>
                </section>

                <aside class="side-panel">
                    <!-- MULTI-SCALE DYNAMIC OSCILLOSCOPE (CPM) -->
                    <div class="panel-bar">
                        <span class="panel-tag">&gt; MULTI_SCALE_SPEED_OSCILLOSCOPE</span>
                        <div class="timeframe-toggles">
                            <button class="tf-btn {speedTimeframe === 'cascade' ? 'active' : ''}" onclick={() => speedTimeframe = 'cascade'}>Cascade (3-Tier)</button>
                            <button class="tf-btn {speedTimeframe === '15s' ? 'active' : ''}" onclick={() => speedTimeframe = '15s'}>15s Burst</button>
                            <button class="tf-btn {speedTimeframe === '2m' ? 'active' : ''}" onclick={() => speedTimeframe = '2m'}>2m Flow</button>
                            <button class="tf-btn {speedTimeframe === '15m' ? 'active' : ''}" onclick={() => speedTimeframe = '15m'}>15m Trend</button>
                        </div>
                    </div>
                    <div class="speed-chart-box">
                        <div class="speed-metrics-row">
                            <div class="speed-metric">
                                <span class="sm-lbl">INSTANT BURST</span>
                                <span class="sm-val glow-cpm" class:pulse-high={instantCpm > 250}>
                                    {instantCpm} <small>cpm</small>
                                </span>
                            </div>
                            <div class="speed-metric">
                                <span class="sm-lbl">EST. WPM</span>
                                <span class="sm-val">{(instantCpm / 5).toFixed(0)} <small>wpm</small></span>
                            </div>
                            <div class="speed-metric">
                                <span class="sm-lbl">PEAK MAX</span>
                                <span class="sm-val peak-val">{peakCpm} <small>cpm</small></span>
                            </div>
                        </div>

                        <!-- TIER 1: 15s Micro-Burst Waveform -->
                        {#if speedTimeframe === '15s' || speedTimeframe === 'cascade'}
                            <div class="wave-block">
                                <div class="wave-header">
                                    <span>⚡ 15s MICRO-BURST OSCILLOSCOPE (300ms TICK)</span>
                                    <span class="live-dot-pulse">● LIVE</span>
                                </div>
                                <div class="speed-bars-container micro">
                                    {#each speedHistory15s as point (point.id)}
                                        <div class="speed-bar-col" title="{point.time}: {point.cpm} CPM">
                                            <div 
                                                class="speed-bar {point.cpm > 320 ? 'ultra' : (point.cpm > 160 ? 'fast' : (point.cpm > 30 ? 'steady' : 'zero'))}"
                                                style="height: {Math.max(4, Math.min(100, (point.cpm / Math.max(peakCpm, 150)) * 100))}%"
                                            ></div>
                                        </div>
                                    {/each}
                                </div>
                            </div>
                        {/if}

                        <!-- TIER 2: 2m Macro-Flow Waveform -->
                        {#if speedTimeframe === '2m' || speedTimeframe === 'cascade'}
                            <div class="wave-block">
                                <div class="wave-header">
                                    <span>🌊 2-MINUTE MACRO-FLOW ENVELOPE (3.3s RES)</span>
                                    <span>AVG: {cpm} CPM</span>
                                </div>
                                <div class="speed-bars-container macro">
                                    {#each speedHistory2m as point (point.id)}
                                        <div class="speed-bar-col" title="{point.time}: {point.cpm} CPM">
                                            <div 
                                                class="speed-bar macro-bar {point.cpm > 250 ? 'ultra' : (point.cpm > 120 ? 'fast' : (point.cpm > 20 ? 'steady' : 'zero'))}"
                                                style="height: {Math.max(4, Math.min(100, (point.cpm / Math.max(peakCpm, 150)) * 100))}%"
                                            ></div>
                                        </div>
                                    {/each}
                                </div>
                            </div>
                        {/if}

                        <!-- TIER 3: 15m Long-Term Trend Waveform -->
                        {#if speedTimeframe === '15m' || speedTimeframe === 'cascade'}
                            <div class="wave-block">
                                <div class="wave-header">
                                    <span>🏔️ 15-MINUTE SESSION STAMINA (25s RES)</span>
                                    <span>TREND</span>
                                </div>
                                <div class="speed-bars-container trend">
                                    {#each speedHistory15m as point (point.id)}
                                        <div class="speed-bar-col" title="{point.time}: {point.cpm} CPM">
                                            <div 
                                                class="speed-bar trend-bar {point.cpm > 200 ? 'ultra' : (point.cpm > 100 ? 'fast' : (point.cpm > 10 ? 'steady' : 'zero'))}"
                                                style="height: {Math.max(4, Math.min(100, (point.cpm / Math.max(peakCpm, 150)) * 100))}%"
                                            ></div>
                                        </div>
                                    {/each}
                                </div>
                            </div>
                        {/if}
                    </div>

                    <!-- TYPING CADENCE SPECTRUM -->
                    <div class="panel-bar mt-sm">
                        <span class="panel-tag">&gt; TYPING_CADENCE_SPECTRUM</span>
                        <span class="cadence-timeframe">SESSION STREAM ({totalKeys} keys)</span>
                    </div>
                    <div class="cadence-box">
                        <div class="cadence-info-note">
                            ℹ️ Flight time (Δt) between consecutive keystrokes in active session:
                        </div>
                        <div class="cadence-item">
                            <div class="c-header">
                                <span>⚡ Flow Speed (&lt;100ms)</span>
                                <strong>{cadenceBuckets.fast} <small>({fastPct}%)</small></strong>
                            </div>
                            <div class="c-bar-bg"><div class="c-bar fast" style="width: {fastPct}%"></div></div>
                        </div>
                        <div class="cadence-item">
                            <div class="c-header">
                                <span>🎯 Steady Cadence (100-250ms)</span>
                                <strong>{cadenceBuckets.steady} <small>({steadyPct}%)</small></strong>
                            </div>
                            <div class="c-bar-bg"><div class="c-bar steady" style="width: {steadyPct}%"></div></div>
                        </div>
                        <div class="cadence-item">
                            <div class="c-header">
                                <span>🤔 Hesitation (250-800ms)</span>
                                <strong>{cadenceBuckets.pause} <small>({pausePct}%)</small></strong>
                            </div>
                            <div class="c-bar-bg"><div class="c-bar pause" style="width: {pausePct}%"></div></div>
                        </div>
                        <div class="cadence-item">
                            <div class="c-header">
                                <span>⏸️ Long Pauses (&gt;800ms)</span>
                                <strong>{cadenceBuckets.stop} <small>({stopPct}%)</small></strong>
                            </div>
                            <div class="c-bar-bg"><div class="c-bar stop" style="width: {stopPct}%"></div></div>
                        </div>
                    </div>

                    <!-- LIVE SHORTCUTS -->
                    <div class="panel-bar mt-sm"><span class="panel-tag">&gt; LIVE_SHORTCUTS</span></div>
                    <div class="shortcuts-log">
                        {#if copyPasteHistory.length === 0}
                            <div class="empty-state">No Copy-Paste sequences detected yet</div>
                        {:else}
                            {#each copyPasteHistory as cp}
                                <div class="shortcut-item">
                                    <span class="sc-badge">Ctrl+C → Ctrl+V</span>
                                    <span class="sc-val">{(cp.flightMs / 1000).toFixed(2)}s lag</span>
                                </div>
                            {/each}
                        {/if}
                    </div>
                </aside>
            </div>

        <!-- TAB: DAY JOURNAL & LLM CONTEXT EXPORT -->
        {:else if activeTab === 'journal'}
            <div class="tab-layout journal-tab">
                <!-- Top Journal Control Bar -->
                <section class="panel journal-header-panel">
                    <div class="journal-controls-top">
                        <div class="date-selector-group">
                            <span class="group-label">📅 DZIEŃ:</span>
                            <div class="date-quick-pills">
                                {#if journalData?.availableDates?.length}
                                    {#each journalData.availableDates.slice(0, 8) as d}
                                        <button 
                                            class="date-pill {journalDate === d ? 'active' : ''}" 
                                            onclick={() => { journalDate = d; loadJournal(d); }}
                                        >
                                            {d === new Date().toISOString().slice(0, 10) ? 'Dzisiaj (' + d + ')' : d}
                                        </button>
                                    {/each}
                                {:else}
                                    <button class="date-pill active">{journalDate}</button>
                                {/if}
                            </div>
                            <input 
                                type="date" 
                                class="date-picker-input" 
                                bind:value={journalDate} 
                                onchange={() => loadJournal(journalDate)} 
                            />
                            <button class="refresh-btn" onclick={() => loadJournal(journalDate)} title="Odśwież dane">
                                🔄
                            </button>
                        </div>

                        <!-- Main Actions -->
                        <div class="journal-actions-group">
                            {#if copyFeedback}
                                <div class="copy-toast glow-pulse">{copyFeedback}</div>
                            {/if}
                            <button 
                                class="action-btn-primary glow-btn" 
                                onclick={copyLlmPrompt}
                                disabled={!journalData || journalData.totalChunks === 0}
                                title="Kopiuj gotowy transkrypt ze wskazówkami dla AI do schowka"
                            >
                                <span class="btn-icon">📋</span>
                                <span class="btn-text">KOPIUJ PROMPT DLA LLM</span>
                            </button>
                            <button 
                                class="action-btn-secondary" 
                                onclick={downloadMarkdown}
                                disabled={!journalData || journalData.totalChunks === 0}
                                title="Pobierz plik Markdown (.md)"
                            >
                                💾 Pobierz .md
                            </button>
                            <a 
                                href="/api/journal/raw?date={journalDate}" 
                                target="_blank" 
                                rel="noreferrer"
                                class="action-btn-secondary raw-link-btn" 
                                title="Otwórz czysty, surowy tekst w nowej karcie (możesz skopiować przez Ctrl+A, Ctrl+C)"
                            >
                                📄 Surowy Tekst (Nowa Karta)
                            </a>
                            <button 
                                class="action-btn-secondary {showMarkdownDrawer ? 'active' : ''}" 
                                onclick={() => showMarkdownDrawer = !showMarkdownDrawer}
                                title="Podgląd wygenerowanego promptu Markdown"
                            >
                                {showMarkdownDrawer ? '🔼 Ukryj MD' : '👁️ Podgląd Promptu'}
                            </button>
                        </div>
                    </div>

                    <!-- Telemetry KPI Summary Cards -->
                    <div class="journal-kpi-grid">
                        <div class="kpi-card">
                            <span class="kpi-label">ROZPOZNANE MYŚLI</span>
                            <span class="kpi-val">{journalData?.totalChunks || 0}</span>
                            <span class="kpi-sub">duże, spójne chunki</span>
                        </div>
                        <div class="kpi-card">
                            <span class="kpi-label">WPISANE SŁOWA</span>
                            <span class="kpi-val">{journalData?.totalWords?.toLocaleString() || 0}</span>
                            <span class="kpi-sub">merytoryczna treść</span>
                        </div>
                        <div class="kpi-card">
                            <span class="kpi-label">BLOKI PRACY (SESJE)</span>
                            <span class="kpi-val">{journalData?.sessions?.length || 0}</span>
                            <span class="kpi-sub">przerwy &gt; 25 min</span>
                        </div>
                        <div class="kpi-card">
                            <span class="kpi-label">PROMPTY I ZAPYTANIA</span>
                            <span class="kpi-val prompt-glow">{countPrompts}</span>
                            <span class="kpi-sub">pytania i zapytania AI</span>
                        </div>
                        <div class="kpi-card">
                            <span class="kpi-label">POLECENIA SHELLA</span>
                            <span class="kpi-val shell-glow">{countShell}</span>
                            <span class="kpi-sub">narzędzia CLI i terminal</span>
                        </div>
                    </div>

                    <!-- Category Filter & Search Bar -->
                    <div class="journal-filter-bar">
                        <div class="filter-pills">
                            <button 
                                class="filter-pill {journalCategoryFilter === 'all' ? 'active' : ''}"
                                onclick={() => journalCategoryFilter = 'all'}
                            >
                                Wszystko ({journalData?.totalChunks || 0})
                            </button>
                            <button 
                                class="filter-pill prompt {journalCategoryFilter === 'prompt' ? 'active' : ''}"
                                onclick={() => journalCategoryFilter = 'prompt'}
                            >
                                💬 Prompty AI ({countPrompts})
                            </button>
                            <button 
                                class="filter-pill shell {journalCategoryFilter === 'shell' ? 'active' : ''}"
                                onclick={() => journalCategoryFilter = 'shell'}
                            >
                                💻 Shell ({countShell})
                            </button>
                            <button 
                                class="filter-pill code {journalCategoryFilter === 'code' ? 'active' : ''}"
                                onclick={() => journalCategoryFilter = 'code'}
                            >
                                📝 Kod ({countCode})
                            </button>
                            <button 
                                class="filter-pill note {journalCategoryFilter === 'note' ? 'active' : ''}"
                                onclick={() => journalCategoryFilter = 'note'}
                            >
                                ⚡ Notatki ({countNote})
                            </button>
                        </div>
                        <div class="search-box">
                            <span class="search-icon">🔍</span>
                            <input 
                                type="text" 
                                placeholder="Filtruj wpisy po słowie kluczowym..." 
                                bind:value={journalSearchTerm} 
                                class="search-input"
                            />
                            {#if journalSearchTerm}
                                <button class="clear-search" onclick={() => journalSearchTerm = ''}>✕</button>
                            {/if}
                        </div>
                    </div>
                </section>

                <!-- Collapsible Raw Prompt Markdown Drawer -->
                {#if showMarkdownDrawer && journalData?.llmPromptMarkdown}
                    <section class="panel markdown-drawer-panel">
                        <div class="panel-bar">
                            <span class="panel-tag">&gt; LLM_SYSTEM_PROMPT_PREVIEW ({journalData.llmPromptMarkdown.length} chars)</span>
                            <button class="mini-copy-btn" onclick={copyLlmPrompt}>
                                📋 Kopiuj pełny Markdown
                            </button>
                        </div>
                        <pre class="markdown-preview-block"><code>{journalData.llmPromptMarkdown}</code></pre>
                    </section>
                {/if}

                <!-- Chronological Timeline Sessions Feed -->
                <section class="panel journal-feed-panel">
                    <div class="panel-bar">
                        <span class="panel-tag">&gt; RECONSTRUCTED_CHRONOLOGICAL_STREAM // {journalDate}</span>
                        <span class="count-badge">{filteredJournalSessions.reduce((acc, s) => acc + s.chunks.length, 0)} wpisów w widoku</span>
                    </div>

                    <div class="journal-feed">
                        {#if isLoadingJournal}
                            <div class="journal-loading">
                                <div class="scanner-line"></div>
                                <p>⏳ Rekonstrukcja strumienia klawiatury dla {journalDate}...</p>
                            </div>
                        {:else if journalError}
                            <div class="journal-error">
                                <p>⚠️ Błąd ładowania dziennika: {journalError}</p>
                                <button onclick={() => loadJournal(journalDate)} class="retry-btn">Spróbuj ponownie</button>
                            </div>
                        {:else if filteredJournalSessions.length === 0}
                            <div class="empty-state">
                                📭 Brak zarejestrowanych myśli dla wybranych kryteriów w dniu {journalDate}.
                                {#if journalData?.availableDates?.length}
                                    <div class="empty-suggestions">
                                        Dostępne dni z zarejestrowaną historią:
                                        {#each journalData.availableDates.slice(0, 5) as d}
                                            <button class="suggest-date-btn" onclick={() => { journalDate = d; loadJournal(d); }}>{d}</button>
                                        {/each}
                                    </div>
                                {/if}
                            </div>
                        {:else}
                            {#each filteredJournalSessions as session (session.id)}
                                <div class="session-block">
                                    <div class="session-header">
                                        <div class="session-title">
                                            <span class="session-indicator"></span>
                                            <h3>{session.label}</h3>
                                            <span class="session-timerange">{session.startTimeStr.slice(0, 5)} – {session.endTimeStr.slice(0, 5)}</span>
                                        </div>
                                        <span class="session-count-badge">{session.chunks.length} wpisów</span>
                                    </div>

                                    <div class="session-chunks-grid">
                                        {#each session.chunks as chunk (chunk.id)}
                                            <div class="thought-card category-{chunk.category}">
                                                <div class="thought-header">
                                                    <div class="thought-badge {chunk.category}">
                                                        <span>{chunk.icon}</span>
                                                        <span>{chunk.categoryLabel}</span>
                                                    </div>
                                                    <div class="thought-meta">
                                                        <span class="thought-time">🕒 {chunk.startTimeStr}</span>
                                                        <span class="thought-duration">⏱️ {chunk.durationSec}s</span>
                                                        <span class="thought-words">{chunk.words} słów</span>
                                                    </div>
                                                    <button 
                                                        class="thought-copy-btn" 
                                                        onclick={() => copySingleChunk(chunk.text)}
                                                        title="Kopiuj ten wpis do schowka"
                                                    >
                                                        📋
                                                    </button>
                                                </div>

                                                <div class="thought-body">
                                                    {#if chunk.category === 'shell'}
                                                        <div class="terminal-command-box">
                                                            <span class="term-prompt">$</span>
                                                            <pre class="term-cmd"><code>{chunk.text}</code></pre>
                                                        </div>
                                                    {:else if chunk.category === 'prompt'}
                                                        <blockquote class="ai-prompt-box">
                                                            <p>{chunk.text}</p>
                                                        </blockquote>
                                                    {:else if chunk.category === 'code'}
                                                        <pre class="code-thought-box"><code>{chunk.text}</code></pre>
                                                    {:else}
                                                        <div class="general-thought-box">
                                                            <p>{chunk.text}</p>
                                                        </div>
                                                    {/if}
                                                </div>
                                            </div>
                                        {/each}
                                    </div>
                                </div>
                            {/each}
                        {/if}
                    </div>
                </section>
            </div>

        <!-- TAB 2: BURSTS & SESSION CHUNKS -->
        {:else if activeTab === 'bursts'}
            <div class="tab-layout bursts-tab">
                <section class="panel bursts-full-panel">
                    <div class="panel-bar">
                        <span class="panel-tag">&gt; TEMPORAL_BURST_SESSIONS (Separated by pause intervals &gt;1.4s)</span>
                        <div class="burst-controls">
                            <button class="load-deep-btn" onclick={loadDeepHistory} disabled={isLoadingDeep}>
                                {isLoadingDeep ? '⏳ Loading Deep History...' : '📥 Load Deep History (4000 events)'}
                            </button>
                            <span class="count-badge">{bursts.length} chunks</span>
                        </div>
                    </div>
                    <div class="bursts-feed" bind:this={burstsBox}>
                        {#if bursts.length === 0}
                            <div class="empty-state">Start typing to generate real-time burst chunks...</div>
                        {:else}
                            {#each bursts.slice().reverse() as b (b.id)}
                                <div class="burst-card">
                                    <div class="burst-meta">
                                        <div class="burst-ts">
                                            <span class="clock">🕒 {b.startTime}</span>
                                            {#if Number(b.timeGapSec) > 0}
                                                <span class="pause-tag">⏸️ +{b.timeGapSec}s pause</span>
                                            {/if}
                                        </div>
                                        <span class="burst-cat">{b.category}</span>
                                        <div class="burst-badges">
                                            <span class="b-stat"><strong>{b.keysCount}</strong> keys</span>
                                            <span class="b-stat"><strong>{b.cpm}</strong> CPM</span>
                                            {#if b.errorsCount > 0}
                                                <span class="b-stat err">⚠️ {b.errorsCount} corrections</span>
                                            {/if}
                                        </div>
                                    </div>
                                    <div class="burst-content">
                                        <div class="burst-clean">&gt; {b.text || '(empty / special keys)'}</div>
                                        {#if b.shortcuts.length}
                                            <div class="burst-shortcuts">
                                                {#each b.shortcuts as sc}
                                                    <span class="sc-pill">{sc}</span>
                                                {/each}
                                            </div>
                                        {/if}
                                    </div>
                                </div>
                            {/each}
                        {/if}
                    </div>
                </section>
            </div>

        <!-- TAB 3: DEEP INTELLIGENCE & GIT CONTRIBUTION MATRIX -->
        {:else if activeTab === 'stats'}
            <div class="tab-layout stats-tab">
                <div class="stats-top-bar">
                    <span class="stats-title">AGGREGATE TELEMETRY & CODING PATTERNS</span>
                    <div class="range-toggles">
                        <button class="range-btn {statsRange === 'today' ? 'active' : ''}" onclick={() => loadServerStats('today')}>Today</button>
                        <button class="range-btn {statsRange === '7d' ? 'active' : ''}" onclick={() => loadServerStats('7d')}>Last 7 Days</button>
                        <button class="range-btn {statsRange === '30d' ? 'active' : ''}" onclick={() => loadServerStats('30d')}>Last 30 Days</button>
                        <button class="range-btn {statsRange === 'all' ? 'active' : ''}" onclick={() => loadServerStats('all')}>All Time (Year)</button>
                    </div>
                </div>

                {#if serverStats}
                    <!-- FULL 52-WEEK GITHUB CONTRIBUTION HEATMAP MATRIX -->
                    <section class="panel mb-md">
                        <div class="panel-bar">
                            <span class="panel-tag">&gt; YEARLY_KEYSTROKE_HEATMAP (52-Week Contribution Matrix)</span>
                            <div class="heatmap-summary-tags">
                                <span class="h-badge">Year Total: <strong>{gitMatrix.totalKeystrokesYear.toLocaleString()}</strong> keys</span>
                                <span class="h-badge">Active Days: <strong>{gitMatrix.activeDaysCount}</strong></span>
                                <span class="h-badge">Busiest Day: <strong>{gitMatrix.busiestDate} ({gitMatrix.maxDayCount.toLocaleString()} keys)</strong></span>
                            </div>
                        </div>
                        
                        <div class="git-calendar-container">
                            <div class="git-month-labels">
                                {#each gitMatrix.monthLabels as m}
                                    <span class="git-month-lbl" style="left: calc({(m.weekIndex / 52) * 100}% + 28px)">{m.name}</span>
                                {/each}
                            </div>
                            
                            <div class="git-calendar-body">
                                <div class="git-day-labels">
                                    <span></span>
                                    <span>Mon</span>
                                    <span></span>
                                    <span>Wed</span>
                                    <span></span>
                                    <span>Fri</span>
                                    <span></span>
                                </div>

                                <div class="git-weeks-grid">
                                    {#each gitMatrix.weeks as week, wIdx}
                                        <div class="git-week-col">
                                            {#each week as day}
                                                <div 
                                                    class="git-cell lvl-{day.level} {day.isFuture ? 'future' : ''}"
                                                    title="{day.date}: {day.count.toLocaleString()} keystrokes ({day.errors} errors)"
                                                ></div>
                                            {/each}
                                        </div>
                                    {/each}
                                </div>
                            </div>

                            <div class="git-calendar-footer">
                                <div class="git-legend">
                                    <span>Less</span>
                                    <span class="git-cell lvl-0 inline"></span>
                                    <span class="git-cell lvl-1 inline"></span>
                                    <span class="git-cell lvl-2 inline"></span>
                                    <span class="git-cell lvl-3 inline"></span>
                                    <span class="git-cell lvl-4 inline"></span>
                                    <span>More</span>
                                </div>
                            </div>
                        </div>
                    </section>

                    <!-- RANWHEN-INSPIRED DIURNAL 24-HOUR MULTI-DAY ACTIVITY MATRIX -->
                    <section class="panel mb-md">
                        <div class="panel-bar">
                            <span class="panel-tag">&gt; 24H_HOURLY_TYPING_DISTRIBUTION (RANWHEN_DIURNAL_TIMELINE)</span>
                            {#if diurnalMatrix}
                                <div class="heatmap-summary-tags">
                                    <span class="h-badge">Recorded Days: <strong>{diurnalMatrix.totalActiveDays}</strong></span>
                                    <span class="h-badge">Peak Rate: <strong>{diurnalMatrix.globalMaxHourly.toLocaleString()}</strong> keys/hr</span>
                                    <span class="h-badge">Period Keys: <strong>{diurnalMatrix.totalKeystrokes.toLocaleString()}</strong></span>
                                </div>
                            {/if}
                        </div>

                        {#if diurnalMatrix && diurnalMatrix.days.length}
                            <div class="ranwhen-container">
                                <!-- Hour Labels Header (00..23) -->
                                <div class="ranwhen-header-row">
                                    <div class="rw-date-col-hdr">DATE / DAY</div>
                                    <div class="rw-hours-grid-hdr">
                                        {#each Array.from({length: 24}, (_, h) => h) as h}
                                            <div 
                                                role="presentation"
                                                class="rw-hour-lbl {hoveredHour === h ? 'col-highlight' : ''}"
                                                onmouseenter={() => hoveredHour = h}
                                                onmouseleave={() => hoveredHour = null}
                                                title="Hour {h.toString().padStart(2, '0')}:00"
                                            >
                                                {h.toString().padStart(2, '0')}
                                            </div>
                                        {/each}
                                    </div>
                                    <div class="rw-meta-col-hdr">DAY METRICS</div>
                                </div>

                                <!-- Day Rows -->
                                <div class="ranwhen-body">
                                    {#each diurnalMatrix.days as day}
                                        <div class="ranwhen-row">
                                            <div class="rw-date-col">
                                                <span class="rw-d-str">{day.date}</span>
                                                <span class="rw-d-dow">{day.dayOfWeek}</span>
                                            </div>

                                            <div class="rw-hours-grid">
                                                {#each day.hours as hData}
                                                    <div 
                                                        role="presentation"
                                                        class="rw-cell lvl-{hData.level} {hoveredHour === hData.hour ? 'col-highlight' : ''}"
                                                        onmouseenter={() => hoveredHour = hData.hour}
                                                        onmouseleave={() => hoveredHour = null}
                                                        title="{day.date} ({day.dayOfWeek}) @ {hData.hour.toString().padStart(2, '0')}:00–{hData.hour.toString().padStart(2, '0')}:59 — {hData.count.toLocaleString()} keys"
                                                    >
                                                        {#if hData.count > 0}
                                                            <div class="rw-cell-bar" style="height: {hData.pct}%"></div>
                                                        {:else}
                                                            <span class="rw-cell-empty">·</span>
                                                        {/if}
                                                    </div>
                                                {/each}
                                            </div>

                                            <div class="rw-meta-col">
                                                <span class="rw-m-total"><strong>{day.total.toLocaleString()}</strong> keys</span>
                                                <span class="rw-m-active">{day.activeHours}h act</span>
                                                {#if day.peakCount > 0}
                                                    <span class="rw-m-peak" title="Peak hour: {day.peakHour}:00 with {day.peakCount} keys">
                                                        Peak: {day.peakHour.toString().padStart(2,'0')}:00 ({day.peakCount > 999 ? (day.peakCount/1000).toFixed(1) + 'k' : day.peakCount})
                                                    </span>
                                                {/if}
                                            </div>
                                        </div>
                                    {/each}
                                </div>
                            </div>
                        {:else}
                            <div class="empty-state">No hourly activity recorded in selected timeframe.</div>
                        {/if}
                    </section>

                    <!-- Diurnal Aggregate Profile & Top Keys Grid -->
                    <div class="stats-split">
                        <section class="panel">
                            <div class="panel-bar">
                                <span class="panel-tag">&gt; DIURNAL_AGGREGATE_PROFILE (24H COMPOSITE SUM)</span>
                                {#if serverStats.hourlyActivity && serverStats.hourlyActivity.length}
                                    {@const maxHour = [...serverStats.hourlyActivity].sort((a,b)=>b.count - a.count)[0]}
                                    {#if maxHour && maxHour.count > 0}
                                        <span class="count-badge">Peak Time: <strong>{maxHour.hour}:00</strong> ({maxHour.count.toLocaleString()} keys)</span>
                                    {/if}
                                {/if}
                            </div>
                            <div class="hourly-bars">
                                {#each Array.from({length: 24}, (_, h) => {
                                    const match = serverStats.hourlyActivity.find(r => r.hour === h);
                                    const count = match ? match.count : 0;
                                    const maxVal = Math.max(...serverStats.hourlyActivity.map(r=>r.count), 1);
                                    const pct = count > 0 ? Math.max(6, Math.min(100, (count / maxVal) * 100)) : 0;
                                    return { hour: h, count, pct };
                                }) as hData}
                                    <div 
                                        role="presentation"
                                        class="hour-col {hoveredHour === hData.hour ? 'col-highlight-bar' : ''}" 
                                        title="{hData.hour}:00 — {hData.count.toLocaleString()} aggregate keystrokes"
                                        onmouseenter={() => hoveredHour = hData.hour}
                                        onmouseleave={() => hoveredHour = null}
                                    >
                                        <div 
                                            class="h-bar-fill" 
                                            style="height: {hData.pct}%"
                                        ></div>
                                        <span class="h-lbl">{hData.hour}</span>
                                    </div>
                                {/each}
                            </div>
                        </section>

                        <section class="panel">
                            <div class="panel-bar"><span class="panel-tag">&gt; KEY_FREQUENCY_LEADERBOARD</span></div>
                            <div class="keys-leaderboard">
                                {#each serverStats.topKeys.slice(0, 15) as key}
                                    <div class="key-row">
                                        <span class="k-name">{key.name}</span>
                                        <div class="k-bar-bg">
                                            <div class="k-bar" style="width: {Math.min(100, key.count / (serverStats.topKeys[0]?.count || 1) * 100)}%"></div>
                                        </div>
                                        <span class="k-count">{key.count}</span>
                                    </div>
                                {/each}
                            </div>
                        </section>
                    </div>
                {:else}
                    <div class="empty-state">Loading telemetry from database...</div>
                {/if}
            </div>

        <!-- TAB 4: RAW PACKET LOG MATRIX -->
        {:else if activeTab === 'raw'}
            <div class="tab-layout raw-tab">
                <section class="panel raw-full-panel">
                    <div class="panel-bar">
                        <span class="panel-tag">&gt; RAW_X11_EVENT_SOCKET_STREAM</span>
                        <span class="count-badge">{keystrokes.length} buffered</span>
                    </div>
                    <div class="raw-log-grid">
                        {#each keystrokes as key (key.id || Math.random())}
                            <div class="raw-row {key.event_type === 'PRESS' ? 'press' : 'release'}">
                                <span class="r-ts">[{new Date(key.timestamp).toISOString().slice(11, 23)}]</span>
                                <span class="r-evt {key.event_type}">{key.event_type}</span>
                                <span class="r-key">{key.key_name}</span>
                                <span class="r-code">0x{key.keycode.toString(16).toUpperCase().padStart(2, '0')}</span>
                            </div>
                        {/each}
                    </div>
                </section>
            </div>
        {/if}
    </main>
</div>

<style>
    /* ================= MOTYWY KOLORYSTYCZNE ================= */
    .theme-matrix {
        --bg-main: #040804;
        --bg-panel: rgba(6, 18, 6, 0.7);
        --border-color: #10b981;
        --border-dim: rgba(16, 185, 129, 0.25);
        --text-bright: #34d399;
        --text-dim: #059669;
        --text-ghost: #064e3b;
        --accent: #10b981;
        --alert: #ef4444;
        --glow: 0 0 10px rgba(16, 185, 129, 0.4);
    }
    .theme-neon {
        --bg-main: #090514;
        --bg-panel: rgba(18, 10, 36, 0.7);
        --border-color: #a855f7;
        --border-dim: rgba(168, 85, 247, 0.25);
        --text-bright: #38bdf8;
        --text-dim: #c084fc;
        --text-ghost: #4c1d95;
        --accent: #f43f5e;
        --alert: #fb7185;
        --glow: 0 0 12px rgba(168, 85, 247, 0.5);
    }
    .theme-amber {
        --bg-main: #0c0802;
        --bg-panel: rgba(24, 16, 4, 0.7);
        --border-color: #f59e0b;
        --border-dim: rgba(245, 158, 11, 0.25);
        --text-bright: #fbbf24;
        --text-dim: #d97706;
        --text-ghost: #78350f;
        --accent: #f59e0b;
        --alert: #ef4444;
        --glow: 0 0 10px rgba(245, 158, 11, 0.4);
    }
    .theme-ghost {
        --bg-main: #03080e;
        --bg-panel: rgba(6, 16, 28, 0.7);
        --border-color: #0284c7;
        --border-dim: rgba(2, 132, 199, 0.25);
        --text-bright: #38bdf8;
        --text-dim: #0284c7;
        --text-ghost: #0c4a6e;
        --accent: #38bdf8;
        --alert: #f43f5e;
        --glow: 0 0 10px rgba(56, 189, 248, 0.4);
    }

    .hacker-app {
        min-height: 100vh;
        background: var(--bg-main);
        color: var(--text-bright);
        font-family: 'Fira Code', 'Share Tech Mono', monospace;
        display: flex;
        flex-direction: column;
        box-sizing: border-box;
        padding: 1rem 1.5rem;
    }

    /* Header */
    .cyber-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding-bottom: 0.75rem;
        border-bottom: 1px solid var(--border-dim);
        gap: 1rem;
        flex-wrap: wrap;
    }

    .sys-title {
        display: flex;
        align-items: center;
        gap: 0.5rem;
    }

    .pulse-dot {
        width: 10px;
        height: 10px;
        background: var(--accent);
        border-radius: 50%;
        box-shadow: var(--glow);
        animation: pulse 1.5s infinite;
    }

    @keyframes pulse {
        0%, 100% { transform: scale(1); opacity: 1; }
        50% { transform: scale(1.3); opacity: 0.6; }
    }

    .glitch-text {
        font-size: 1.15rem;
        font-weight: 700;
        letter-spacing: 0.1em;
        text-shadow: var(--glow);
    }

    .sec-badge {
        font-size: 0.65rem;
        padding: 0.15em 0.5em;
        background: var(--text-ghost);
        color: var(--text-bright);
        border: 1px solid var(--border-dim);
        border-radius: 3px;
    }

    .header-metrics {
        display: flex;
        gap: 0.75rem;
        flex-wrap: wrap;
    }

    .pill {
        background: var(--bg-panel);
        border: 1px solid var(--border-dim);
        padding: 0.25rem 0.6rem;
        border-radius: 4px;
        font-size: 0.8rem;
    }

    .pill .lbl { color: var(--text-dim); margin-right: 0.3rem; }
    .val-glow { color: var(--text-bright); text-shadow: var(--glow); }
    .val-glow.err { color: var(--alert); text-shadow: 0 0 8px var(--alert); }

    .header-controls {
        display: flex;
        align-items: center;
        gap: 0.75rem;
    }

    .ctrl-btn {
        background: var(--bg-panel);
        border: 1px solid var(--border-dim);
        color: var(--text-dim);
        font-family: inherit;
        font-size: 0.75rem;
        padding: 0.3rem 0.6rem;
        border-radius: 4px;
        cursor: pointer;
        transition: all 0.2s;
    }
    .ctrl-btn.active, .ctrl-btn:hover {
        border-color: var(--border-color);
        color: var(--text-bright);
        box-shadow: var(--glow);
    }

    .theme-select {
        display: flex;
        gap: 5px;
    }
    .theme-dot {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        border: 2px solid transparent;
        cursor: pointer;
    }
    .theme-dot.matrix { background: #10b981; }
    .theme-dot.neon { background: #a855f7; }
    .theme-dot.amber { background: #f59e0b; }
    .theme-dot.ghost { background: #0284c7; }
    .theme-dot.active { border-color: #fff; transform: scale(1.2); }

    /* Tabs */
    .view-tabs {
        display: flex;
        gap: 0.5rem;
        margin: 1rem 0;
        border-bottom: 1px solid var(--border-dim);
        padding-bottom: 0.5rem;
        flex-wrap: wrap;
    }

    .tab-btn {
        background: transparent;
        border: 1px solid transparent;
        color: var(--text-dim);
        font-family: inherit;
        font-size: 0.85rem;
        padding: 0.4rem 0.8rem;
        border-radius: 4px;
        cursor: pointer;
        transition: all 0.2s;
    }
    .tab-btn:hover { color: var(--text-bright); background: var(--bg-panel); }
    .tab-btn.active {
        background: var(--bg-panel);
        border-color: var(--border-color);
        color: var(--text-bright);
        box-shadow: var(--glow);
    }

    /* Panels & Viewports */
    .main-viewport {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-height: 0;
    }

    .tab-layout {
        display: grid;
        gap: 1rem;
        flex: 1;
        min-height: 0;
    }
    .terminal-tab {
        grid-template-columns: minmax(0, 2fr) minmax(0, 1.25fr);
    }
    @media (max-width: 1100px) {
        .terminal-tab {
            grid-template-columns: 1fr;
        }
    }

    .panel {
        background: var(--bg-panel);
        border: 1px solid var(--border-dim);
        border-radius: 6px;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        min-width: 0;
    }

    .panel-bar {
        background: rgba(0,0,0,0.5);
        border-bottom: 1px solid var(--border-dim);
        padding: 0.4rem 0.75rem;
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 0.8rem;
        flex-wrap: wrap;
        gap: 0.5rem;
    }
    .panel-tag { font-weight: 700; color: var(--text-bright); }

    /* Terminal Screen */
    .terminal-screen {
        flex: 1;
        padding: 1rem;
        overflow-y: auto;
        font-size: 0.95rem;
        position: relative;
        min-height: 420px;
        line-height: 1.6;
    }

    .crt-scanline {
        position: absolute;
        inset: 0;
        background: linear-gradient(rgba(18, 16, 16, 0) 50%, rgba(0, 0, 0, 0.25) 50%);
        background-size: 100% 4px;
        pointer-events: none;
    }

    .prompt-prefix { color: var(--text-dim); margin-right: 0.5rem; }
    .terminal-text { white-space: pre-wrap; word-break: break-all; }
    .cursor-block { animation: blink 1s step-end infinite; color: var(--accent); }
    @keyframes blink { 50% { opacity: 0; } }

    /* Mode Toggles */
    .mode-toggles { display: flex; gap: 4px; }
    .mode-btn {
        background: #000;
        border: 1px solid var(--border-dim);
        color: var(--text-dim);
        font-family: inherit;
        font-size: 0.7rem;
        padding: 0.2rem 0.5rem;
        border-radius: 3px;
        cursor: pointer;
    }
    .mode-btn.active {
        background: var(--text-dim);
        color: #000;
        font-weight: bold;
    }

    /* Side Panel */
    .side-panel {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        min-width: 0;
        width: 100%;
        box-sizing: border-box;
    }

    /* Timeframe Toggles */
    .timeframe-toggles { display: flex; gap: 4px; }
    .tf-btn {
        background: rgba(0,0,0,0.5);
        border: 1px solid var(--border-dim);
        color: var(--text-dim);
        font-family: inherit;
        font-size: 0.65rem;
        padding: 0.15rem 0.4rem;
        border-radius: 3px;
        cursor: pointer;
    }
    .tf-btn.active {
        border-color: var(--border-color);
        color: var(--text-bright);
        background: var(--text-ghost);
    }

    /* Speed History Multi-Scale Box */
    .speed-chart-box {
        padding: 0.75rem 1rem 0.5rem;
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
        background: rgba(0,0,0,0.3);
        box-sizing: border-box;
        width: 100%;
    }
    .speed-metrics-row {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 0.5rem;
        background: rgba(0,0,0,0.4);
        padding: 0.4rem 0.6rem;
        border: 1px solid var(--border-dim);
        border-radius: 4px;
        text-align: center;
    }
    .speed-metric {
        display: flex;
        flex-direction: column;
        min-width: 0;
    }
    .sm-lbl { font-size: 0.65rem; color: var(--text-dim); letter-spacing: 0.05em; }
    .sm-val { font-size: 1.1rem; font-weight: 700; color: var(--text-bright); white-space: nowrap; }
    .sm-val small { font-size: 0.65rem; font-weight: normal; color: var(--text-dim); }
    .glow-cpm { text-shadow: var(--glow); }
    .glow-cpm.pulse-high { color: var(--accent); text-shadow: 0 0 12px var(--accent); }
    .peak-val { color: var(--accent); }

    .wave-block {
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
    }
    .wave-header {
        display: flex;
        justify-content: space-between;
        font-size: 0.62rem;
        color: var(--text-dim);
    }
    .live-dot-pulse { color: var(--text-bright); font-weight: bold; }

    .speed-bars-container {
        width: 100%;
        box-sizing: border-box;
        display: flex;
        align-items: flex-end;
        gap: 2px;
        border: 1px solid var(--border-dim);
        border-radius: 4px;
        padding: 4px 4px 2px;
        position: relative;
        overflow: hidden;
    }
    .speed-bars-container.micro {
        height: 55px;
        background: radial-gradient(circle at bottom, rgba(16, 185, 129, 0.08) 0%, rgba(0,0,0,0.7) 100%);
    }
    .speed-bars-container.macro {
        height: 42px;
        background: radial-gradient(circle at bottom, rgba(56, 189, 248, 0.08) 0%, rgba(0,0,0,0.7) 100%);
    }
    .speed-bars-container.trend {
        height: 36px;
        background: radial-gradient(circle at bottom, rgba(168, 85, 247, 0.08) 0%, rgba(0,0,0,0.7) 100%);
    }

    .speed-bars-container::before {
        content: '';
        position: absolute;
        top: 0; left: 0; right: 0; bottom: 0;
        background: repeating-linear-gradient(0deg, transparent, transparent 12px, rgba(255,255,255,0.03) 13px);
        pointer-events: none;
    }
    .speed-bar-col {
        flex: 1 1 0px;
        min-width: 0;
        height: 100%;
        display: flex;
        align-items: flex-end;
        position: relative;
        z-index: 1;
    }
    .speed-bar {
        width: 100%;
        border-radius: 2px 2px 0 0;
        transition: height 0.18s cubic-bezier(0.2, 0.8, 0.4, 1), background-color 0.2s;
    }
    .speed-bar.zero { background: rgba(255,255,255,0.05); }
    .speed-bar.steady { background: var(--border-color); opacity: 0.75; }
    .speed-bar.fast { background: var(--text-bright); box-shadow: var(--glow); }
    .speed-bar.ultra { background: var(--accent); box-shadow: 0 0 12px var(--accent); }

    .macro-bar.steady { background: #0284c7; }
    .macro-bar.fast { background: #38bdf8; }
    .macro-bar.ultra { background: #38bdf8; box-shadow: 0 0 8px #38bdf8; }

    .trend-bar.steady { background: #7c3aed; }
    .trend-bar.fast { background: #a855f7; }
    .trend-bar.ultra { background: #c084fc; box-shadow: 0 0 8px #c084fc; }

    /* Cadence Analyzer */
    .cadence-timeframe {
        font-size: 0.65rem;
        color: var(--text-dim);
    }
    .cadence-box { padding: 0.75rem 1rem; display: flex; flex-direction: column; gap: 0.6rem; }
    .cadence-info-note {
        font-size: 0.68rem;
        color: var(--text-dim);
        background: rgba(0,0,0,0.3);
        padding: 0.3rem 0.5rem;
        border-radius: 3px;
        border-left: 2px solid var(--border-color);
        margin-bottom: 0.2rem;
    }
    .c-header { display: flex; justify-content: space-between; font-size: 0.75rem; margin-bottom: 0.2rem; }
    .c-header small { color: var(--text-dim); }
    .c-bar-bg { height: 8px; background: rgba(0,0,0,0.6); border: 1px solid var(--border-dim); border-radius: 2px; overflow: hidden; }
    .c-bar { height: 100%; transition: width 0.3s; }
    .c-bar.fast { background: var(--text-bright); box-shadow: var(--glow); }
    .c-bar.steady { background: var(--accent); }
    .c-bar.pause { background: #f59e0b; }
    .c-bar.stop { background: var(--alert); }

    .shortcuts-log { padding: 0.75rem; display: flex; flex-direction: column; gap: 0.4rem; }
    .shortcut-item { display: flex; justify-content: space-between; font-size: 0.75rem; background: rgba(0,0,0,0.4); padding: 0.3rem 0.5rem; border-left: 2px solid var(--accent); }
    .sc-badge { font-weight: bold; }

    /* Bursts Tab */
    .burst-controls { display: flex; gap: 0.5rem; align-items: center; }
    .load-deep-btn {
        background: var(--bg-panel);
        border: 1px solid var(--border-color);
        color: var(--text-bright);
        font-family: inherit;
        font-size: 0.72rem;
        padding: 0.25rem 0.6rem;
        border-radius: 3px;
        cursor: pointer;
        transition: all 0.2s;
    }
    .load-deep-btn:hover {
        background: var(--border-color);
        color: #000;
        font-weight: bold;
    }
    .bursts-feed {
        padding: 1rem;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        min-height: 450px;
    }

    .burst-card {
        background: rgba(0,0,0,0.5);
        border: 1px solid var(--border-dim);
        border-left: 3px solid var(--border-color);
        border-radius: 4px;
        padding: 0.75rem;
    }

    .burst-meta {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 0.75rem;
        margin-bottom: 0.5rem;
        color: var(--text-dim);
        flex-wrap: wrap;
        gap: 0.5rem;
    }

    .burst-ts { display: flex; gap: 0.5rem; align-items: center; }
    .pause-tag { background: rgba(245, 158, 11, 0.15); color: #fbbf24; padding: 0.1em 0.4em; border-radius: 3px; font-size: 0.7rem; }
    .burst-cat { color: var(--text-bright); font-weight: 600; }
    .burst-badges { display: flex; gap: 0.5rem; }
    .b-stat { background: rgba(0,0,0,0.4); border: 1px solid var(--border-dim); padding: 0.1em 0.4em; border-radius: 3px; }
    .b-stat.err { border-color: var(--alert); color: var(--alert); }

    .burst-content { font-size: 0.9rem; line-height: 1.4; word-break: break-all; }
    .burst-clean { color: #fff; margin-bottom: 0.3rem; }
    .burst-shortcuts { display: flex; gap: 0.4rem; flex-wrap: wrap; }
    .sc-pill { background: var(--text-ghost); color: var(--text-bright); font-size: 0.7rem; padding: 0.1em 0.4em; border-radius: 3px; border: 1px solid var(--border-dim); }

    /* Stats Tab & Git Matrix */
    .stats-top-bar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 1rem;
        flex-wrap: wrap;
        gap: 0.5rem;
    }
    .stats-title { font-weight: 700; font-size: 1rem; color: var(--text-bright); }
    .range-toggles { display: flex; gap: 0.5rem; }
    .range-btn {
        background: var(--bg-panel);
        border: 1px solid var(--border-dim);
        color: var(--text-dim);
        font-family: inherit;
        font-size: 0.75rem;
        padding: 0.3rem 0.6rem;
        border-radius: 4px;
        cursor: pointer;
    }
    .range-btn.active {
        border-color: var(--border-color);
        color: var(--text-bright);
        box-shadow: var(--glow);
    }

    .heatmap-summary-tags {
        display: flex;
        gap: 0.5rem;
        flex-wrap: wrap;
    }
    .h-badge {
        font-size: 0.7rem;
        background: var(--text-ghost);
        color: var(--text-bright);
        padding: 0.15em 0.5em;
        border-radius: 3px;
        border: 1px solid var(--border-dim);
    }

    /* GitHub 52-Week Contribution Matrix */
    .git-calendar-container {
        padding: 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        overflow-x: auto;
    }
    .git-month-labels {
        height: 16px;
        position: relative;
        margin-left: 28px;
        margin-bottom: 4px;
    }
    .git-month-lbl {
        position: absolute;
        font-size: 0.65rem;
        color: var(--text-dim);
        transform: translateX(-50%);
    }
    .git-calendar-body {
        display: flex;
        gap: 6px;
        align-items: center;
    }
    .git-day-labels {
        display: grid;
        grid-template-rows: repeat(7, 12px);
        gap: 3px;
        font-size: 0.6rem;
        color: var(--text-dim);
        text-align: right;
        width: 24px;
    }
    .git-weeks-grid {
        display: flex;
        gap: 3px;
        flex: 1;
    }
    .git-week-col {
        display: grid;
        grid-template-rows: repeat(7, 12px);
        gap: 3px;
        flex: 1;
    }
    .git-cell {
        width: 100%;
        height: 12px;
        border-radius: 2px;
        border: 1px solid rgba(255,255,255,0.04);
        transition: transform 0.15s;
    }
    .git-cell:hover {
        transform: scale(1.4);
        z-index: 10;
        border-color: #fff;
    }
    .git-cell.lvl-0 { background: rgba(0,0,0,0.5); }
    .git-cell.lvl-1 { background: rgba(16, 185, 129, 0.25); border-color: rgba(16, 185, 129, 0.4); }
    .git-cell.lvl-2 { background: rgba(16, 185, 129, 0.55); border-color: rgba(16, 185, 129, 0.8); }
    .git-cell.lvl-3 { background: rgba(16, 185, 129, 0.85); box-shadow: 0 0 4px rgba(16, 185, 129, 0.5); }
    .git-cell.lvl-4 { background: #34d399; box-shadow: 0 0 8px #34d399; }
    .git-cell.future { opacity: 0.1; }

    .git-calendar-footer {
        display: flex;
        justify-content: flex-end;
        margin-top: 0.5rem;
    }
    .git-legend {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 0.65rem;
        color: var(--text-dim);
    }
    .git-cell.inline {
        width: 10px;
        height: 10px;
        display: inline-block;
    }

    /* ================= RANWHEN DIURNAL TIMELINE MATRIX ================= */
    .ranwhen-container {
        padding: 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
        overflow-x: auto;
    }

    .ranwhen-header-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding-bottom: 0.4rem;
        border-bottom: 1px solid var(--border-dim);
        font-size: 0.65rem;
        color: var(--text-dim);
        font-weight: 600;
        min-width: 900px;
    }

    .rw-date-col-hdr {
        width: 130px;
        flex-shrink: 0;
        letter-spacing: 0.05em;
    }

    .rw-hours-grid-hdr {
        flex: 1;
        display: grid;
        grid-template-columns: repeat(24, 1fr);
        gap: 3px;
        text-align: center;
    }

    .rw-hour-lbl {
        font-size: 0.65rem;
        color: var(--text-dim);
        padding: 2px 0;
        border-radius: 2px;
        cursor: pointer;
        transition: all 0.15s;
    }

    .rw-hour-lbl.col-highlight {
        color: var(--text-bright);
        background: rgba(255, 255, 255, 0.12);
        font-weight: bold;
        text-shadow: var(--glow);
    }

    .rw-meta-col-hdr {
        width: 220px;
        flex-shrink: 0;
        text-align: right;
        letter-spacing: 0.05em;
    }

    .ranwhen-body {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 900px;
    }

    .ranwhen-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 3px 0;
        border-radius: 3px;
        transition: background 0.15s;
    }

    .ranwhen-row:hover {
        background: rgba(255, 255, 255, 0.03);
    }

    .rw-date-col {
        width: 130px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 0.72rem;
    }

    .rw-d-str {
        color: var(--text-bright);
        font-weight: 600;
    }

    .rw-d-dow {
        font-size: 0.65rem;
        color: var(--text-dim);
        background: rgba(0, 0, 0, 0.4);
        padding: 1px 4px;
        border-radius: 3px;
        border: 1px solid var(--border-dim);
    }

    .rw-hours-grid {
        flex: 1;
        display: grid;
        grid-template-columns: repeat(24, 1fr);
        gap: 3px;
        height: 24px;
    }

    .rw-cell {
        height: 100%;
        border-radius: 2px;
        border: 1px solid rgba(255, 255, 255, 0.05);
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
        align-items: center;
        position: relative;
        overflow: hidden;
        cursor: pointer;
        transition: transform 0.1s, border-color 0.1s;
    }

    .rw-cell:hover {
        transform: scale(1.18);
        z-index: 10;
        border-color: #fff !important;
        box-shadow: var(--glow);
    }

    .rw-cell.col-highlight {
        border-color: var(--border-color);
        background: rgba(255, 255, 255, 0.06);
    }

    .rw-cell.lvl-0 {
        background: rgba(0, 0, 0, 0.45);
    }

    .rw-cell.lvl-1 {
        background: rgba(16, 185, 129, 0.15);
        border-color: rgba(16, 185, 129, 0.35);
    }

    .rw-cell.lvl-2 {
        background: rgba(16, 185, 129, 0.35);
        border-color: rgba(16, 185, 129, 0.6);
    }

    .rw-cell.lvl-3 {
        background: rgba(16, 185, 129, 0.65);
        border-color: rgba(16, 185, 129, 0.9);
        box-shadow: 0 0 6px rgba(16, 185, 129, 0.4);
    }

    .rw-cell.lvl-4 {
        background: var(--text-bright);
        border-color: #fff;
        box-shadow: 0 0 10px var(--text-bright);
    }

    .rw-cell-bar {
        width: 100%;
        background: var(--accent);
        opacity: 0.85;
        border-radius: 1px 1px 0 0;
        transition: height 0.3s;
    }

    .rw-cell-empty {
        font-size: 0.65rem;
        color: rgba(255, 255, 255, 0.12);
        line-height: 24px;
    }

    .rw-meta-col {
        width: 220px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 6px;
        font-size: 0.68rem;
    }

    .rw-m-total {
        color: var(--text-bright);
    }

    .rw-m-active {
        color: var(--text-dim);
        background: var(--text-ghost);
        padding: 1px 4px;
        border-radius: 2px;
        border: 1px solid var(--border-dim);
    }

    .rw-m-peak {
        color: #fbbf24;
        background: rgba(245, 158, 11, 0.12);
        padding: 1px 4px;
        border-radius: 2px;
        border: 1px solid rgba(245, 158, 11, 0.3);
    }

    .col-highlight-bar {
        background: rgba(255, 255, 255, 0.08);
        border-radius: 2px;
    }

    /* Hourly Bars */
    .stats-split {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 1rem;
    }
    @media (max-width: 900px) {
        .stats-split { grid-template-columns: 1fr; }
    }

    .hourly-bars {
        display: flex;
        align-items: flex-end;
        height: 160px;
        padding: 1rem;
        gap: 4px;
    }
    .hour-col {
        flex: 1;
        height: 100%;
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
        align-items: center;
        gap: 4px;
    }
    .h-bar-fill {
        width: 100%;
        background: var(--text-bright);
        border-radius: 2px 2px 0 0;
        transition: height 0.5s;
    }
    .h-lbl { font-size: 0.6rem; color: var(--text-dim); }

    .keys-leaderboard {
        padding: 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        max-height: 250px;
        overflow-y: auto;
    }
    .key-row { display: flex; align-items: center; gap: 0.5rem; font-size: 0.75rem; }
    .k-name { width: 70px; text-align: right; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; }
    .k-bar-bg { flex: 1; height: 8px; background: rgba(0,0,0,0.5); border-radius: 2px; overflow: hidden; }
    .k-bar { height: 100%; background: var(--accent); }
    .k-count { width: 45px; text-align: right; font-weight: bold; }

    /* Raw Tab */
    .raw-log-grid {
        padding: 1rem;
        max-height: 550px;
        overflow-y: auto;
        font-size: 0.8rem;
    }
    .raw-row {
        display: flex;
        gap: 1rem;
        padding: 0.25rem 0.5rem;
        border-bottom: 1px solid rgba(255,255,255,0.04);
    }
    .raw-row.release { opacity: 0.5; }
    .r-ts { color: var(--text-dim); width: 110px; }
    .r-evt { width: 70px; font-weight: bold; }
    .r-evt.PRESS { color: var(--text-bright); }
    .r-evt.RELEASE { color: var(--text-dim); }
    .r-key { color: #fff; width: 120px; }
    .r-code { color: var(--text-dim); }

    .empty-state { padding: 2rem; text-align: center; color: var(--text-dim); font-size: 0.85rem; }
    .count-badge { background: var(--text-ghost); font-size: 0.7rem; padding: 0.1em 0.5em; border-radius: 3px; }
    .mt-sm { margin-top: 0.5rem; }
    .mb-md { margin-bottom: 1rem; }

    /* ================= DZIENNIK DNIA & EKSPORT DLA LLM ================= */
    .journal-tab {
        display: flex;
        flex-direction: column;
        gap: 1rem;
        flex: 1;
        min-height: 0;
    }

    .journal-header-panel {
        background: var(--bg-panel);
        border: 1px solid var(--border-dim);
        border-radius: 6px;
    }

    .journal-controls-top {
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        gap: 0.75rem;
        padding: 0.75rem 1rem;
        background: rgba(0,0,0,0.5);
        border-bottom: 1px solid var(--border-dim);
    }

    .date-selector-group {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 0.5rem;
    }
    .group-label {
        font-size: 0.75rem;
        font-weight: 700;
        color: var(--text-dim);
    }

    .date-quick-pills {
        display: flex;
        flex-wrap: wrap;
        gap: 0.35rem;
    }

    .date-pill {
        background: rgba(0,0,0,0.4);
        border: 1px solid var(--border-dim);
        color: var(--text-dim);
        padding: 0.25rem 0.6rem;
        border-radius: 4px;
        font-size: 0.75rem;
        font-family: inherit;
        cursor: pointer;
        transition: all 0.2s;
    }
    .date-pill:hover {
        border-color: var(--text-bright);
        color: var(--text-bright);
    }
    .date-pill.active {
        background: var(--text-ghost);
        border-color: var(--border-color);
        color: var(--text-bright);
        box-shadow: var(--glow);
        font-weight: 700;
    }

    .date-picker-input {
        background: rgba(0,0,0,0.6);
        border: 1px solid var(--border-dim);
        color: var(--text-bright);
        padding: 0.2rem 0.5rem;
        border-radius: 4px;
        font-family: 'Share Tech Mono', monospace;
        font-size: 0.75rem;
        color-scheme: dark;
    }

    .refresh-btn {
        background: transparent;
        border: 1px solid var(--border-dim);
        border-radius: 4px;
        padding: 0.2rem 0.5rem;
        cursor: pointer;
        color: var(--text-dim);
        transition: all 0.2s;
    }
    .refresh-btn:hover {
        border-color: var(--text-bright);
        transform: rotate(45deg);
    }

    .journal-actions-group {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 0.6rem;
        position: relative;
    }

    .action-btn-primary {
        background: linear-gradient(135deg, rgba(16,185,129,0.35), rgba(6,78,59,0.7));
        border: 1px solid var(--border-color);
        color: var(--text-bright);
        padding: 0.45rem 1.1rem;
        border-radius: 4px;
        font-family: inherit;
        font-size: 0.8rem;
        font-weight: 700;
        letter-spacing: 0.5px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        box-shadow: 0 0 12px var(--border-dim);
        transition: all 0.2s ease;
    }
    .action-btn-primary:hover:not(:disabled) {
        transform: translateY(-1px);
        box-shadow: 0 0 20px var(--border-color);
        filter: brightness(1.15);
    }
    .action-btn-primary:disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }

    .action-btn-secondary {
        background: rgba(0,0,0,0.4);
        border: 1px solid var(--border-dim);
        color: var(--text-dim);
        padding: 0.45rem 0.85rem;
        border-radius: 4px;
        font-family: inherit;
        font-size: 0.78rem;
        cursor: pointer;
        text-decoration: none;
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        transition: all 0.2s;
    }
    .action-btn-secondary:hover:not(:disabled) {
        border-color: var(--text-bright);
        color: var(--text-bright);
    }
    .action-btn-secondary.active {
        background: var(--text-ghost);
        border-color: var(--border-color);
        color: var(--text-bright);
    }
    .action-btn-secondary:disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }

    .copy-toast {
        position: absolute;
        top: -38px;
        right: 0;
        background: var(--text-bright);
        color: #040804;
        font-weight: 800;
        font-size: 0.75rem;
        padding: 0.35rem 0.75rem;
        border-radius: 4px;
        box-shadow: 0 0 15px var(--glow);
        z-index: 10;
        white-space: nowrap;
        pointer-events: none;
        animation: toastSlide 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }

    @keyframes toastSlide {
        from { opacity: 0; transform: translateY(6px); }
        to { opacity: 1; transform: translateY(0); }
    }

    .journal-kpi-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 1rem;
        padding: 0.8rem 1rem;
        background: rgba(0,0,0,0.3);
        border-bottom: 1px solid var(--border-dim);
    }
    .kpi-card {
        display: flex;
        flex-direction: column;
        gap: 2px;
    }
    .kpi-label {
        font-size: 0.65rem;
        color: var(--text-dim);
        font-weight: 700;
        letter-spacing: 0.5px;
    }
    .kpi-val {
        font-size: 1.4rem;
        font-weight: 800;
        color: var(--text-bright);
        line-height: 1.2;
    }
    .kpi-sub {
        font-size: 0.65rem;
        color: var(--text-ghost);
    }
    .prompt-glow {
        color: #38bdf8 !important;
        text-shadow: 0 0 10px rgba(56,189,248,0.5);
    }
    .shell-glow {
        color: #34d399 !important;
        text-shadow: 0 0 10px rgba(52,211,153,0.5);
    }

    .journal-filter-bar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        gap: 0.75rem;
        padding: 0.6rem 1rem;
        background: rgba(0,0,0,0.4);
    }

    .filter-pills {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
    }
    .filter-pill {
        background: transparent;
        border: 1px solid var(--border-dim);
        color: var(--text-dim);
        padding: 0.2rem 0.6rem;
        border-radius: 3px;
        font-size: 0.75rem;
        cursor: pointer;
        transition: all 0.2s;
    }
    .filter-pill.active {
        background: var(--text-ghost);
        border-color: var(--border-color);
        color: var(--text-bright);
        font-weight: 700;
    }
    .filter-pill.prompt.active {
        border-color: #38bdf8;
        color: #38bdf8;
        box-shadow: 0 0 8px rgba(56,189,248,0.4);
    }
    .filter-pill.shell.active {
        border-color: #10b981;
        color: #34d399;
        box-shadow: 0 0 8px rgba(16,185,129,0.4);
    }
    .filter-pill.code.active {
        border-color: #f59e0b;
        color: #fbbf24;
        box-shadow: 0 0 8px rgba(245,158,11,0.4);
    }
    .filter-pill.note.active {
        border-color: #c084fc;
        color: #d8b4fe;
        box-shadow: 0 0 8px rgba(192,132,252,0.4);
    }

    .search-box {
        display: flex;
        align-items: center;
        position: relative;
    }
    .search-icon {
        position: absolute;
        left: 8px;
        font-size: 0.75rem;
        color: var(--text-dim);
        pointer-events: none;
    }
    .search-input {
        background: rgba(0,0,0,0.6);
        border: 1px solid var(--border-dim);
        color: var(--text-bright);
        padding: 0.3rem 1.6rem 0.3rem 1.8rem;
        border-radius: 4px;
        font-family: inherit;
        font-size: 0.75rem;
        width: 220px;
        transition: width 0.2s, border-color 0.2s;
    }
    .search-input:focus {
        width: 280px;
        border-color: var(--border-color);
        outline: none;
        box-shadow: var(--glow);
    }
    .clear-search {
        position: absolute;
        right: 6px;
        background: transparent;
        border: none;
        color: var(--text-dim);
        cursor: pointer;
        font-size: 0.75rem;
    }

    .markdown-drawer-panel {
        border: 1px solid var(--border-color);
        background: #040804;
        margin-bottom: 0.5rem;
    }
    .markdown-preview-block {
        margin: 0;
        padding: 1rem;
        max-height: 280px;
        overflow-y: auto;
        font-family: 'Fira Code', 'Share Tech Mono', monospace;
        font-size: 0.75rem;
        line-height: 1.5;
        color: var(--text-bright);
        white-space: pre-wrap;
        background: rgba(0,0,0,0.7);
    }
    .mini-copy-btn {
        background: transparent;
        border: 1px solid var(--border-dim);
        color: var(--text-bright);
        font-size: 0.75rem;
        padding: 0.2rem 0.5rem;
        border-radius: 3px;
        cursor: pointer;
    }
    .mini-copy-btn:hover {
        background: var(--text-ghost);
        border-color: var(--border-color);
    }

    .journal-feed-panel {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-height: 400px;
    }
    .journal-feed {
        padding: 1rem;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
        max-height: calc(100vh - 350px);
    }

    .session-block {
        border: 1px solid var(--border-dim);
        border-radius: 6px;
        background: rgba(0,0,0,0.3);
        overflow: hidden;
    }
    .session-header {
        background: rgba(0,0,0,0.6);
        border-bottom: 1px solid var(--border-dim);
        padding: 0.6rem 1rem;
        display: flex;
        justify-content: space-between;
        align-items: center;
    }
    .session-title {
        display: flex;
        align-items: center;
        gap: 0.75rem;
    }
    .session-indicator {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--border-color);
        box-shadow: var(--glow);
    }
    .session-title h3 {
        margin: 0;
        font-size: 0.9rem;
        font-weight: 700;
        color: var(--text-bright);
    }
    .session-timerange {
        font-size: 0.75rem;
        color: var(--text-dim);
    }
    .session-count-badge {
        background: var(--text-ghost);
        border: 1px solid var(--border-dim);
        font-size: 0.7rem;
        padding: 0.15rem 0.5rem;
        border-radius: 3px;
        color: var(--text-bright);
    }

    .session-chunks-grid {
        padding: 0.75rem;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
    }

    .thought-card {
        background: rgba(10, 16, 12, 0.5);
        border: 1px solid rgba(255,255,255,0.06);
        border-left: 4px solid var(--text-dim);
        border-radius: 4px;
        padding: 0.75rem 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        transition: transform 0.15s, border-color 0.15s, box-shadow 0.15s;
    }
    .thought-card:hover {
        transform: translateX(2px);
        border-color: rgba(255,255,255,0.15);
        box-shadow: 0 4px 15px rgba(0,0,0,0.4);
    }
    .thought-card.category-prompt {
        border-left-color: #38bdf8;
        background: rgba(8, 24, 38, 0.45);
    }
    .thought-card.category-shell {
        border-left-color: #10b981;
        background: rgba(6, 24, 14, 0.45);
    }
    .thought-card.category-code {
        border-left-color: #f59e0b;
        background: rgba(30, 20, 6, 0.45);
    }
    .thought-card.category-note {
        border-left-color: #c084fc;
        background: rgba(24, 12, 36, 0.45);
    }

    .thought-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 0.5rem;
        flex-wrap: wrap;
    }
    .thought-badge {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        font-size: 0.7rem;
        font-weight: 700;
        padding: 0.15rem 0.5rem;
        border-radius: 3px;
        text-transform: uppercase;
    }
    .thought-badge.prompt {
        background: rgba(56,189,248,0.15);
        color: #38bdf8;
        border: 1px solid rgba(56,189,248,0.3);
    }
    .thought-badge.shell {
        background: rgba(16,185,129,0.15);
        color: #34d399;
        border: 1px solid rgba(16,185,129,0.3);
    }
    .thought-badge.code {
        background: rgba(245,158,11,0.15);
        color: #fbbf24;
        border: 1px solid rgba(245,158,11,0.3);
    }
    .thought-badge.note {
        background: rgba(192,132,252,0.15);
        color: #c084fc;
        border: 1px solid rgba(192,132,252,0.3);
    }

    .thought-meta {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        font-size: 0.7rem;
        color: var(--text-dim);
    }
    .thought-copy-btn {
        background: transparent;
        border: 1px solid var(--border-dim);
        border-radius: 3px;
        color: var(--text-dim);
        padding: 0.2rem 0.45rem;
        cursor: pointer;
        font-size: 0.75rem;
        transition: all 0.2s;
    }
    .thought-copy-btn:hover {
        border-color: var(--text-bright);
        color: var(--text-bright);
        transform: scale(1.05);
    }

    .terminal-command-box {
        background: #040608;
        border: 1px solid rgba(16,185,129,0.3);
        border-radius: 4px;
        padding: 0.6rem 0.8rem;
        display: flex;
        align-items: flex-start;
        gap: 0.5rem;
        font-family: 'Fira Code', monospace;
        font-size: 0.85rem;
    }
    .term-prompt {
        color: #10b981;
        font-weight: bold;
        user-select: none;
    }
    .term-cmd {
        margin: 0;
        color: #6ee7b7;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: inherit;
    }

    .ai-prompt-box {
        margin: 0;
        padding: 0.6rem 0.9rem;
        background: rgba(56,189,248,0.06);
        border-left: 3px solid #38bdf8;
        border-radius: 0 4px 4px 0;
        font-size: 0.9rem;
        color: #f0f9ff;
        line-height: 1.55;
        word-break: break-word;
    }
    .ai-prompt-box p {
        margin: 0;
        white-space: pre-wrap;
    }

    .code-thought-box {
        margin: 0;
        padding: 0.6rem 0.8rem;
        background: #08080a;
        border: 1px solid rgba(245,158,11,0.3);
        border-radius: 4px;
        font-family: 'Fira Code', monospace;
        font-size: 0.85rem;
        color: #fef3c7;
        white-space: pre-wrap;
        word-break: break-word;
    }

    .general-thought-box {
        margin: 0;
        padding: 0.3rem 0;
        font-size: 0.9rem;
        color: #e2e8f0;
        line-height: 1.55;
        word-break: break-word;
    }
    .general-thought-box p {
        margin: 0;
        white-space: pre-wrap;
    }

    .journal-loading, .journal-error {
        padding: 3rem;
        text-align: center;
        color: var(--text-dim);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1rem;
    }
    .scanner-line {
        width: 120px;
        height: 3px;
        background: var(--text-bright);
        box-shadow: var(--glow);
        animation: scanPulse 1.2s infinite ease-in-out;
    }
    @keyframes scanPulse {
        0% { opacity: 0.3; width: 40px; }
        50% { opacity: 1; width: 160px; }
        100% { opacity: 0.3; width: 40px; }
    }

    .suggest-date-btn {
        background: var(--text-ghost);
        border: 1px solid var(--border-dim);
        color: var(--text-bright);
        padding: 0.2rem 0.5rem;
        border-radius: 3px;
        margin: 0.2rem;
        cursor: pointer;
    }
    .suggest-date-btn:hover {
        border-color: var(--text-bright);
    }
</style>
