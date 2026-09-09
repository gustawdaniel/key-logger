<script>
	import favicon from '$lib/assets/favicon.svg';
	import '../app.css';
	import { page } from '$app/stores';

	let { children } = $props();
	
	const navLinks = [
		{ href: '/', label: '⌨️ Live View', title: 'Podgląd klawiatury na żywo' },
		{ href: '/services', label: '🏠 Services Hub', title: 'Wszystkie serwisy homelabu' },
	];
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" />
</svelte:head>

<nav class="top-nav">
	<div class="nav-brand">
		<span class="brand-icon">🎹</span>
		<span class="brand-name">KeyLogger</span>
	</div>
	<div class="nav-links">
		{#each navLinks as link}
			<a
				href={link.href}
				title={link.title}
				class="nav-link"
				class:active={$page.url.pathname === link.href}
			>
				{link.label}
			</a>
		{/each}
		<a href="http://orc:3000/d/keyboard-analytics" target="_blank" rel="noopener"
		   class="nav-link nav-external" title="Grafana Keyboard Analytics Dashboard">
			📊 Grafana ↗
		</a>
	</div>
</nav>

{@render children()}

<style>
	:global(*) {
		box-sizing: border-box;
	}
	:global(body) {
		margin: 0;
		font-family: 'Inter', system-ui, sans-serif;
		background: #0a0a0f;
		color: #e2e8f0;
	}

	.top-nav {
		position: sticky;
		top: 0;
		z-index: 100;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.6rem 1.5rem;
		background: rgba(10, 10, 15, 0.85);
		backdrop-filter: blur(12px);
		border-bottom: 1px solid rgba(255,255,255,0.06);
	}

	.nav-brand {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		text-decoration: none;
		font-weight: 700;
		font-size: 1rem;
		color: #e2e8f0;
	}

	.brand-icon {
		font-size: 1.2rem;
	}

	.brand-name {
		background: linear-gradient(135deg, #a78bfa, #38bdf8);
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		background-clip: text;
	}

	.nav-links {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}

	.nav-link {
		padding: 0.4rem 0.85rem;
		border-radius: 8px;
		text-decoration: none;
		color: #94a3b8;
		font-size: 0.85rem;
		font-weight: 500;
		transition: all 0.15s;
		border: 1px solid transparent;
	}

	.nav-link:hover {
		background: rgba(255,255,255,0.06);
		color: #e2e8f0;
	}

	.nav-link.active {
		background: rgba(124, 58, 237, 0.15);
		border-color: rgba(124, 58, 237, 0.3);
		color: #c4b5fd;
	}

	.nav-external {
		color: #64748b;
		font-size: 0.8rem;
	}

	.nav-external:hover {
		color: #94a3b8;
	}
</style>
