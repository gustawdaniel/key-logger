<script>
    import { onMount, onDestroy } from 'svelte';

    /** @type {Array<any>} */
    let keystrokes = $state([]);
    
    /** @type {string} */
    let currentWord = $state('');
    
    /** @type {Array<string>} */
    let words = $state([]);

    /** @type {number} */
    let cpm = $state(0);
    
    /** @type {Object.<string, number>} */
    let keyStats = $state({});

    let eventSource = null;
    let lastKeyTime = 0;
    
    let cpmInterval;

    // --- ZAAWANSOWANE METRYKI ---
    let totalKeys = $state(0);
    let backspaceCount = $state(0);
    let errorRate = $derived(totalKeys > 0 ? ((backspaceCount / totalKeys) * 100).toFixed(1) : 0);
    
    // --- BUFOR TEKSTU ---
    let liveText = $state("");

    // Kopiuj-Wklej
    let isCtrlPressed = false;
    let lastCopyTime = 0;
    /** @type {Array<{time: number, flightMs: number}>} */
    let copyPasteHistory = $state([]);
    let avgPasteTime = $derived(
        copyPasteHistory.length > 0 
        ? (copyPasteHistory.reduce((a,b)=>a+b.flightMs, 0) / copyPasteHistory.length / 1000).toFixed(2)
        : 0
    );

    // Wykres historii
    /** @type {Array<number>} */
    let speedHistory = $state(new Array(30).fill(0)); // 30 słupków (ostatnie 60 sekund)
    let currentIntervalKeys = 0;

    let lastId = 0;

    onMount(async () => {
        // 1. Najpierw pobierz historię
        try {
            const res = await fetch('/api/history?limit=100');
            if (res.ok) {
                const history = await res.json();
                history.forEach(processKey);
            }
        } catch(e) {
            console.error("Błąd ładowania historii:", e);
        }

        // 2. Podłącz strumień SSE na żywo (zaczynamy od największego pobranego ID)
        eventSource = new EventSource('/api/stream?lastId=' + lastId);
        
        eventSource.onmessage = (event) => {
            const newKey = JSON.parse(event.data);
            if (newKey.id > lastId) lastId = newKey.id;
            processKey(newKey);
        };

        eventSource.onerror = (err) => {
            console.error("SSE Error:", err);
        };

        // 3. Obliczanie statystyk w czasie rzeczywistym
        cpmInterval = setInterval(() => {
            calculateCPM();
            
            // Rejestruj historyczne interwały (2-sekundowe ticki)
            speedHistory = [...speedHistory.slice(1), currentIntervalKeys * 30]; // Ekstrapolacja do CPM z 2 sek
            currentIntervalKeys = 0;

        }, 2000);
    });

    onDestroy(() => {
        if (eventSource) eventSource.close();
        if (cpmInterval) clearInterval(cpmInterval);
    });

    function processKey(keyData) {
        // Zliczamy statystyki użycia klawiszy tylko dla PRESS
        if (keyData.event_type === 'PRESS') {
            keyStats[keyData.key_name] = (keyStats[keyData.key_name] || 0) + 1;
            totalKeys++;
            currentIntervalKeys++;
            
            // ERROR RATE
            if (keyData.key_name === 'BackSpace') backspaceCount++;

            // COPY PASTE DETECTION
            if (keyData.key_name === 'Control_L' || keyData.key_name === 'Control_R') {
                isCtrlPressed = true;
            } else if (isCtrlPressed && keyData.key_name === 'c') {
                lastCopyTime = keyData.timestamp;
            } else if (isCtrlPressed && keyData.key_name === 'v') {
                if (lastCopyTime > 0) {
                    const flightMs = keyData.timestamp - lastCopyTime;
                    if (flightMs < 60000) { // Zignoruj jeśli wkleił po godzinie
                        copyPasteHistory = [{time: keyData.timestamp, flightMs}, ...copyPasteHistory].slice(0, 5);
                    }
                    lastCopyTime = 0; // reset
                }
            }

            // Rekonstrukcja słów i ciągłego bufora
            const now = keyData.timestamp;
            const isBreak = (now - lastKeyTime > 800) || ['space', 'Return'].includes(keyData.key_name);
            
            if (isBreak) {
                if (currentWord.trim().length > 0) {
                    words = [currentWord, ...words].slice(0, 50);
                }
                currentWord = '';
            }
            
            let char = "";
            const name = keyData.key_name;
            if (name.length === 1) {
                char = name;
            } else if (name === 'space') { char = ' '; }
            else if (name === 'Return') { char = '\n'; }
            else if (name === 'comma') { char = ','; }
            else if (name === 'period') { char = '.'; }
            else if (name === 'minus') { char = '-'; }
            else if (name === 'slash') { char = '/'; }
            else if (name === 'equal') { char = '='; }
            else if (name === 'semicolon') { char = ';'; }
            else if (name === 'apostrophe') { char = '\''; }
            else if (name === 'BackSpace') {
                currentWord = currentWord.slice(0, -1);
                liveText = liveText.slice(0, -1);
            }
            
            if (char) {
                currentWord += char;
                liveText += char;
            }
            if (liveText.length > 2000) liveText = liveText.slice(-2000);

            lastKeyTime = now;
        } else if (keyData.event_type === 'RELEASE') {
            if (keyData.key_name === 'Control_L' || keyData.key_name === 'Control_R') {
                isCtrlPressed = false;
            }
        }

        // Zawsze dodawaj do strumienia surowych klawiszy
        keystrokes = [keyData, ...keystrokes].slice(0, 200); // historia ost. 200 logów
    }

    function calculateCPM() {
        const now = Date.now();
        const oneMinuteAgo = now - 60000;
        
        // Policz wciskane klawisze w ostatniej minucie
        let count = 0;
        for (const k of keystrokes) {
            if (k.event_type === 'PRESS' && k.timestamp > oneMinuteAgo) {
                count++;
            }
            if (k.timestamp < oneMinuteAgo) break;
        }
        cpm = count;
    }
</script>

<div class="dashboard-container">
    <header class="glow">
        <h1>[ NODE://KEY_MONITOR_SYS ]</h1>
        <div class="status-bar">
            <span>STATUS: <span class="glitch-effect" style="color: var(--text-main)">ACTIVE</span></span>
            <span>UPLINK: SECURE</span>
            <span>CPM: {cpm}</span>
        </div>
    </header>

    <div class="grid-layout">
        <!-- Panel 1: Surowy strumień -->
        <section class="panel raw-stream">
            <h2>> RAW_STREAM</h2>
            <div class="log-container">
                {#each keystrokes as key (key.id || Math.random())}
                    <div class="log-entry {key.event_type === 'PRESS' ? 'press' : 'release'}">
                        <span class="ts">[{new Date(key.timestamp).toISOString().split('T')[1].slice(0, 12)}]</span>
                        <span class="evt">{key.event_type}</span>
                        <span class="key glow">{key.key_name}</span>
                        <span class="code">(0x{key.keycode.toString(16).toUpperCase()})</span>
                    </div>
                {/each}
            </div>
        </section>

        <!-- Panel 2: Rekonstruktor słów / Live Terminal -->
        <section class="panel word-reconstructor">
            <h2>> DECODED_TERMINAL</h2>
            <div class="live-terminal-box">
                <span class="prompt">root@local:~# </span>
                <span class="typing glow">{liveText}<span class="cursor">_</span></span>
            </div>
            <div class="word-history">
                <div class="sub-header">-- ISOLATED WORDS --</div>
                {#each words as word}
                    <div class="word-entry">>> {word}</div>
                {/each}
            </div>
        </section>

        <!-- Panel 3: Metryki analityczne i Heatmap -->
        <section class="panel analytics">
            <h2>> DEEP_ANALYTICS</h2>
            <div class="metrics-grid">
                
                <div class="metric-card">
                    <span class="metric-title">ERROR RATE</span>
                    <span class="metric-val {errorRate > 10 ? 'text-alert glitch-effect' : 'glow'}">{errorRate}%</span>
                    <span class="metric-sub">{backspaceCount} / {totalKeys} keys</span>
                </div>

                <div class="metric-card">
                    <span class="metric-title">AVG COPY->PASTE</span>
                    <span class="metric-val glow">{avgPasteTime}s</span>
                    <span class="metric-sub">
                        {#each copyPasteHistory as cp}
                            [{(cp.flightMs / 1000).toFixed(1)}s] 
                        {/each}
                    </span>
                </div>
            </div>

            <!-- CSS GRAPH -->
            <div class="speed-graph">
                <span class="graph-title">SPEED HISTORY (CPM)</span>
                <div class="bars-container">
                    {#each speedHistory as height}
                        <div class="bar">
                            <div class="bar-fill" style="height: {Math.min(100, height / 3)}%"></div>
                        </div>
                    {/each}
                </div>
            </div>

            <div class="stats-grid">
                <span class="graph-title">FREQUENCY HEATMAP</span>
                {#each Object.entries(keyStats).sort((a,b) => b[1] - a[1]).slice(0, 10) as [name, count]}
                    <div class="stat-row">
                        <span class="stat-name">{name}</span>
                        <span class="stat-bar-container">
                            <div class="stat-bar" style="width: {Math.min(100, count * 2)}%"></div>
                        </span>
                        <span class="stat-count glow">{count}</span>
                    </div>
                {/each}
            </div>
        </section>
    </div>
</div>

<style>
    .dashboard-container {
        padding: 20px;
        height: 100vh;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
    }

    header {
        border-bottom: 2px solid var(--text-dim);
        padding-bottom: 10px;
        margin-bottom: 20px;
        display: flex;
        justify-content: space-between;
        align-items: flex-end;
    }

    h1 {
        margin: 0;
        font-size: 1.5rem;
        letter-spacing: 2px;
    }

    .status-bar {
        display: flex;
        gap: 30px;
        font-size: 0.9rem;
        color: var(--text-dim);
    }

    .grid-layout {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 20px;
        flex-grow: 1;
        min-height: 0;
    }

    .panel {
        border: 1px solid var(--text-dim);
        background: rgba(0, 30, 0, 0.1);
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .panel h2 {
        background: var(--text-dim);
        color: var(--bg-color);
        margin: 0;
        padding: 5px 10px;
        font-size: 1rem;
        text-transform: uppercase;
    }

    .log-container, .word-history, .stats-grid {
        padding: 10px;
        overflow-y: auto;
        flex-grow: 1;
        font-size: 0.85rem;
    }

    .log-entry {
        margin-bottom: 4px;
        display: flex;
        gap: 10px;
    }
    
    .log-entry.release {
        opacity: 0.6;
        color: var(--text-dim);
    }

    .log-entry .ts { color: #555; }
    .log-entry .evt { width: 60px; display: inline-block; }
    .log-entry .key { color: var(--text-main); font-weight: bold; width: 100px; display: inline-block; }
    .log-entry .code { color: #888; }

    .live-terminal-box {
        padding: 15px;
        border-bottom: 1px dashed var(--text-dim);
        font-size: 1rem;
        white-space: pre-wrap;
        word-break: break-all;
        flex: 1;
        overflow-y: auto;
        min-height: 100px;
    }

    .sub-header {
        color: #555;
        font-size: 0.7rem;
        margin-bottom: 10px;
    }

    .prompt {
        color: var(--text-dim);
    }

    .typing {
        color: #fff;
    }

    .cursor {
        animation: blink 1s step-end infinite;
    }

    @keyframes blink {
        50% { opacity: 0; }
    }

    .word-entry {
        margin-bottom: 8px;
        color: var(--text-main);
    }

    .stat-row {
        display: flex;
        align-items: center;
        margin-bottom: 10px;
        gap: 10px;
    }

    .stat-name {
        width: 80px;
        text-align: right;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .stat-bar-container {
        flex-grow: 1;
        height: 10px;
        background: #111;
        border: 1px solid #222;
    }

    .stat-bar {
        height: 100%;
        background: var(--text-dim);
    }

    .stats-grid {
        padding: 10px;
        font-size: 0.85rem;
        margin-top: 10px;
    }

    .metrics-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
        padding: 10px;
        border-bottom: 1px dashed var(--text-dim);
    }

    .metric-card {
        background: #0a110a;
        border: 1px solid var(--text-dim);
        padding: 10px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
    }

    .metric-title {
        font-size: 0.7rem;
        color: var(--text-dim);
    }

    .metric-val {
        font-size: 1.5rem;
        margin: 5px 0;
    }

    .metric-sub {
        font-size: 0.65rem;
        color: #555;
    }

    .speed-graph {
        padding: 10px;
        height: 100px;
        display: flex;
        flex-direction: column;
        border-bottom: 1px dashed var(--text-dim);
    }

    .graph-title {
        font-size: 0.7rem;
        color: var(--text-dim);
        margin-bottom: 5px;
        display: block;
    }

    .bars-container {
        display: flex;
        align-items: flex-end;
        height: 100%;
        gap: 2px;
    }

    .bar {
        flex-grow: 1;
        background: #111;
        height: 100%;
        position: relative;
    }

    .bar-fill {
        position: absolute;
        bottom: 0;
        width: 100%;
        background: var(--text-main);
    }

    .text-alert { color: var(--text-alert); }

</style>
