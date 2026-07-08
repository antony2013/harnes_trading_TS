<div class="hero">
	<h1>Harnesh<span class="dot">·</span>Trading</h1>
	<p class="lede">Live NIFTY 50 &amp; SENSEX feed is in the header above.</p>
	<p class="muted">
		Backend: <code>apps/api</code> on :3000 —
		<a href="http://localhost:3000/swagger" target="_blank" rel="noreferrer">Swagger</a>
	</p>
	<p class="cta"><a href="/chat">Open the desk →</a></p>
</div>

<style>
	.hero {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		text-align: center;
		gap: 0.5rem;
		padding: 4rem 1rem;
	}
	.hero h1 {
		margin: 0;
		font-family: var(--font-display);
		font-style: italic;
		font-weight: 400;
		font-size: var(--t-3xl);
		letter-spacing: 0.3px;
		line-height: 1.05;
		color: var(--paper);
	}
	.hero h1 .dot {
		color: var(--saffron);
		font-style: normal;
	}
	.lede {
		font-size: var(--t-md);
		color: var(--paper);
		margin: 0.3rem 0 0;
	}
	.muted {
		color: var(--paper-dim);
		font-family: var(--font-mono);
		font-size: var(--t-xs);
	}
	a {
		color: var(--saffron);
		text-decoration: none;
	}
	a:hover {
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	code {
		background: var(--ink-900);
		border: 1px solid var(--ink-line);
		padding: 0.1rem 0.35rem;
		border-radius: 3px;
		font-size: 0.9em;
		font-family: var(--font-mono);
	}
	.cta {
		margin-top: 1.2rem;
		font-family: var(--font-mono);
		font-size: var(--t-sm);
		letter-spacing: 0.4px;
	}
	.cta a {
		border: 1px solid var(--saffron);
		padding: 0.5rem 0.9rem;
		border-radius: var(--radius-sm);
	}
	.cta a:hover {
		background: var(--saffron-soft);
		text-decoration: none;
	}
</style>