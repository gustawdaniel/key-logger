<script>
    const services = [
        {
            name: 'Grafana',
            description: 'Dashboardy telemetrii floty — temperatury, CPU, pamięć, sieć, keylogger analytics',
            url: 'http://orc:3000',
            port: 3000,
            icon: '📊',
            category: 'monitoring',
            status: 'primary',
            links: [
                { label: 'Fleet Command Center', url: 'http://orc:3000/d/fleet-telemetry' },
                { label: 'Host Deep Dive', url: 'http://orc:3000/d/host-deep-dive' },
                { label: '⌨️ Keyboard Analytics', url: 'http://orc:3000/d/keyboard-analytics' },
            ]
        },
        {
            name: 'SigNoz APM',
            description: 'Pełna observability: traces, logi, metryki. OpenTelemetry-native.',
            url: 'http://orc:8080',
            port: 8080,
            icon: '🪵',
            category: 'monitoring',
            status: 'primary',
            links: [
                { label: 'Dashboard', url: 'http://orc:8080' },
                { label: 'Logi', url: 'http://orc:8080/logs/logs-explorer' },
                { label: 'Metryki', url: 'http://orc:8080/metrics-explorer' },
            ]
        },
        {
            name: 'Keyboard Live View',
            description: 'Podgląd naciśnięć klawiatury w czasie rzeczywistym z analityką: CPM, error rate, top keys.',
            url: 'http://orc:3002',
            port: 3002,
            icon: '⌨️',
            category: 'tools',
            status: 'current',
            links: [
                { label: 'Live Text View', url: 'http://orc:3002/' },
                { label: 'Services Hub', url: 'http://orc:3002/services' },
            ]
        },
        {
            name: 'Perses',
            description: 'Alternatywny silnik dashboardów (CNCF) — GitOps-friendly, dashboard-as-code.',
            url: 'http://orc:8081',
            port: 8081,
            icon: '⚡',
            category: 'monitoring',
            status: 'secondary',
            links: [
                { label: 'Open Perses', url: 'http://orc:8081' },
            ]
        },
        {
            name: 'SigNoz MCP',
            description: 'MCP server dla AI asystentów — pozwala na zapytania do ClickHouse przez Claude/GPT.',
            url: 'http://orc:8000',
            port: 8000,
            icon: '🤖',
            category: 'tools',
            status: 'secondary',
            links: [
                { label: 'MCP API', url: 'http://orc:8000' },
            ]
        },
    ];

    const categories = {
        monitoring: { label: 'Monitoring & Observability', icon: '📡' },
        tools: { label: 'Tools & Automation', icon: '🔧' },
    };

    const statusColors = {
        primary: '#7c3aed',
        current: '#059669',
        secondary: '#374151',
    };
</script>

<svelte:head>
    <title>Services Hub — Homelab Command Center</title>
    <meta name="description" content="Centralized links to all homelab services on orc" />
</svelte:head>

<div class="hub">
    <header class="hub-header">
        <div class="header-glow"></div>
        <div class="header-content">
            <div class="header-icon">🏠</div>
            <div>
                <h1>Services Hub</h1>
                <p class="subtitle">Homelab Command Center — <span class="host">orc</span> (10.0.0.50 / 100.72.165.110)</p>
            </div>
        </div>
        <a href="/" class="back-btn">← Live View</a>
    </header>

    {#each Object.entries(categories) as [catKey, cat]}
        <section class="category">
            <h2 class="category-title">{cat.icon} {cat.label}</h2>
            <div class="cards">
                {#each services.filter(s => s.category === catKey) as svc}
                    <article class="card" class:card-current={svc.status === 'current'}>
                        <div class="card-header">
                            <div class="card-icon">{svc.icon}</div>
                            <div class="card-meta">
                                <h3 class="card-name">{svc.name}</h3>
                                <span class="card-port">:{svc.port}</span>
                            </div>
                            {#if svc.status === 'current'}
                                <span class="badge-current">This App</span>
                            {/if}
                        </div>
                        <p class="card-desc">{svc.description}</p>
                        <div class="card-links">
                            <a href={svc.url} target="_blank" rel="noopener" class="btn-primary">
                                Open {svc.name} ↗
                            </a>
                            {#if svc.links.length > 1}
                                <div class="quick-links">
                                    {#each svc.links.slice(1) as link}
                                        <a href={link.url} target="_blank" rel="noopener" class="btn-link">
                                            {link.label}
                                        </a>
                                    {/each}
                                </div>
                            {/if}
                        </div>
                    </article>
                {/each}
            </div>
        </section>
    {/each}

    <footer class="hub-footer">
        <p>Stack: SigNoz · Grafana · ClickHouse · Incus · Tailscale · Rust</p>
    </footer>
</div>

<style>
    :global(body) {
        background: #0a0a0f;
        color: #e2e8f0;
        font-family: 'Inter', system-ui, sans-serif;
        margin: 0;
    }

    .hub {
        min-height: 100vh;
        padding: 0 0 4rem;
    }

    /* Header */
    .hub-header {
        position: relative;
        overflow: hidden;
        padding: 2.5rem 2rem;
        background: linear-gradient(135deg, #13111c 0%, #1a0a2e 50%, #0d1117 100%);
        border-bottom: 1px solid rgba(124, 58, 237, 0.3);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1.5rem;
    }

    .header-glow {
        position: absolute;
        top: -60%;
        left: -10%;
        width: 50%;
        height: 200%;
        background: radial-gradient(ellipse, rgba(124, 58, 237, 0.15) 0%, transparent 70%);
        pointer-events: none;
    }

    .header-content {
        display: flex;
        align-items: center;
        gap: 1rem;
        z-index: 1;
    }

    .header-icon {
        font-size: 2.5rem;
        filter: drop-shadow(0 0 12px rgba(124, 58, 237, 0.7));
    }

    h1 {
        margin: 0;
        font-size: 2rem;
        font-weight: 700;
        background: linear-gradient(135deg, #a78bfa, #38bdf8);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
    }

    .subtitle {
        margin: 0.25rem 0 0;
        color: #94a3b8;
        font-size: 0.9rem;
    }

    .host {
        font-family: 'JetBrains Mono', monospace;
        color: #a78bfa;
        background: rgba(124, 58, 237, 0.1);
        padding: 0.1em 0.4em;
        border-radius: 4px;
    }

    .back-btn {
        z-index: 1;
        padding: 0.5rem 1rem;
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 8px;
        color: #94a3b8;
        text-decoration: none;
        font-size: 0.85rem;
        transition: all 0.2s;
        white-space: nowrap;
    }
    .back-btn:hover {
        background: rgba(255,255,255,0.1);
        color: #e2e8f0;
    }

    /* Categories */
    .category {
        max-width: 1200px;
        margin: 2.5rem auto 0;
        padding: 0 2rem;
    }

    .category-title {
        font-size: 1rem;
        font-weight: 600;
        color: #64748b;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        margin: 0 0 1rem;
        padding-bottom: 0.5rem;
        border-bottom: 1px solid rgba(255,255,255,0.06);
    }

    .cards {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
        gap: 1.25rem;
    }

    /* Card */
    .card {
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 16px;
        padding: 1.5rem;
        transition: all 0.25s ease;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
    }

    .card:hover {
        background: rgba(255,255,255,0.06);
        border-color: rgba(124, 58, 237, 0.4);
        transform: translateY(-2px);
        box-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(124,58,237,0.1);
    }

    .card-current {
        border-color: rgba(5, 150, 105, 0.4);
        background: rgba(5, 150, 105, 0.05);
    }

    .card-current:hover {
        border-color: rgba(5, 150, 105, 0.7);
    }

    .card-header {
        display: flex;
        align-items: center;
        gap: 0.75rem;
    }

    .card-icon {
        font-size: 2rem;
        flex-shrink: 0;
    }

    .card-meta {
        flex: 1;
    }

    h3.card-name {
        margin: 0;
        font-size: 1.1rem;
        font-weight: 600;
        color: #f1f5f9;
    }

    .card-port {
        font-family: 'JetBrains Mono', monospace;
        font-size: 0.75rem;
        color: #64748b;
    }

    .badge-current {
        font-size: 0.7rem;
        padding: 0.2em 0.6em;
        background: rgba(5, 150, 105, 0.2);
        color: #34d399;
        border: 1px solid rgba(5, 150, 105, 0.4);
        border-radius: 99px;
        font-weight: 600;
        white-space: nowrap;
    }

    .card-desc {
        margin: 0;
        font-size: 0.85rem;
        color: #94a3b8;
        line-height: 1.5;
        flex: 1;
    }

    .card-links {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }

    .btn-primary {
        display: block;
        text-align: center;
        padding: 0.6rem 1rem;
        background: linear-gradient(135deg, rgba(124,58,237,0.3), rgba(56,189,248,0.2));
        border: 1px solid rgba(124,58,237,0.4);
        border-radius: 10px;
        color: #c4b5fd;
        text-decoration: none;
        font-size: 0.85rem;
        font-weight: 600;
        transition: all 0.2s;
    }

    .btn-primary:hover {
        background: linear-gradient(135deg, rgba(124,58,237,0.5), rgba(56,189,248,0.3));
        border-color: rgba(124,58,237,0.7);
        color: #e0d2fe;
    }

    .card-current .btn-primary {
        background: linear-gradient(135deg, rgba(5,150,105,0.3), rgba(16,185,129,0.2));
        border-color: rgba(5,150,105,0.4);
        color: #6ee7b7;
    }

    .quick-links {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
    }

    .btn-link {
        padding: 0.3rem 0.7rem;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 6px;
        color: #94a3b8;
        text-decoration: none;
        font-size: 0.78rem;
        transition: all 0.15s;
    }

    .btn-link:hover {
        background: rgba(255,255,255,0.09);
        color: #e2e8f0;
    }

    /* Footer */
    .hub-footer {
        text-align: center;
        margin-top: 4rem;
        padding-top: 2rem;
        border-top: 1px solid rgba(255,255,255,0.05);
        color: #374151;
        font-size: 0.78rem;
    }
</style>
