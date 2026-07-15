<script lang="ts">
	import {
		searchSettings,
		searchSaving,
		searchTesting,
		searchTestResult,
		searchError,
		saveSearch,
		testSearch,
		DEFAULT_SEARCH,
		type SearchSettings
	} from '$lib/stores/agentSearch';

	let enabled = $state(false);
	let searxngBaseUrl = $state(DEFAULT_SEARCH.searxngBaseUrl);
	let crawl4aiBaseUrl = $state(DEFAULT_SEARCH.crawl4aiBaseUrl);
	let maxResults = $state(DEFAULT_SEARCH.maxResults);
	let crawlTimeoutMs = $state(DEFAULT_SEARCH.crawlTimeoutMs);

	let seeded = false;
	$effect(() => {
		const s = $searchSettings;
		if (s && !seeded) {
			seeded = true;
			enabled = s.enabled;
			searxngBaseUrl = s.searxngBaseUrl;
			crawl4aiBaseUrl = s.crawl4aiBaseUrl;
			maxResults = s.maxResults;
			crawlTimeoutMs = s.crawlTimeoutMs;
		}
	});

	const crawlSec = $derived(Math.round(crawlTimeoutMs / 1000));

	function payload(): SearchSettings {
		return { enabled, searxngBaseUrl, crawl4aiBaseUrl, maxResults, crawlTimeoutMs };
	}

	async function onSave() {
		await saveSearch(payload());
	}
</script>

<div class="form">
	<label class="row toggle">
		<span class="lbl">Enable web search subagent</span>
		<input type="checkbox" bind:checked={enabled} />
	</label>
	<p class="hint">
		When enabled, the agent gets a <code>search</code> subagent it can delegate to. It searches the web via
		<code>SearXNG</code> and reads pages via <code>Crawl4AI</code>. Requires both services running. See
		<a href="/docs/search-setup.md" target="_blank" rel="noreferrer">search setup</a>.
	</p>

	<label class="row">
		<span class="lbl">SearXNG base URL</span>
		<input class="field" type="text" bind:value={searxngBaseUrl} disabled={!enabled} />
	</label>

	<label class="row">
		<span class="lbl">Crawl4AI base URL</span>
		<input class="field" type="text" bind:value={crawl4aiBaseUrl} disabled={!enabled} />
	</label>

	<label class="row">
		<span class="lbl">Max results</span>
		<input class="field" type="number" min="1" bind:value={maxResults} disabled={!enabled} />
	</label>

	<label class="row">
		<span class="lbl">Crawl timeout ({crawlSec} s)</span>
		<input class="field" type="number" min="1000" bind:value={crawlTimeoutMs} disabled={!enabled} />
	</label>

	<div class="actions">
		<button class="btn" disabled={$searchTesting || !enabled} onclick={testSearch}>
			{$searchTesting ? 'Testing…' : 'Test'}
		</button>
		<button class="btn primary" disabled={$searchSaving} onclick={onSave}>
			{$searchSaving ? 'Saving…' : 'Save'}
		</button>
	</div>

	{#if $searchTestResult}
		<div class="result" data-ok={$searchTestResult.ok}>
			{$searchTestResult.ok ? '✓' : '✗'} {$searchTestResult.detail}
		</div>
	{/if}

	{#if $searchError}
		<div class="result" data-ok="false">✗ {$searchError}</div>
	{/if}
</div>

<style>
	.form { display: flex; flex-direction: column; gap: 1rem; }
	.row { display: flex; flex-direction: column; gap: 0.35rem; }
	.row.toggle { flex-direction: row; align-items: center; gap: 0.6rem; }
	.lbl {
		font-family: var(--font-mono);
		font-size: var(--t-2xs);
		text-transform: uppercase;
		letter-spacing: 0.6px;
		color: var(--paper-dim);
	}
	.hint {
		font-size: var(--t-sm);
		color: var(--paper-dim);
		margin: -0.4rem 0 0;
		line-height: 1.5;
	}
	.hint code {
		font-family: var(--font-mono);
		background: var(--ink-900);
		border: 1px solid var(--ink-line);
		border-radius: 3px;
		padding: 0.1rem 0.3rem;
	}
	.field {
		width: 100%;
		padding: 0.5rem 0.65rem;
		background: var(--ink-950);
		border: 1px solid var(--ink-line);
		border-radius: var(--radius-sm);
		color: var(--paper);
		font-family: var(--font-mono);
		font-size: var(--t-sm);
	}
	.field:disabled { opacity: 0.45; }
	.field:focus {
		outline: none;
		border-color: var(--saffron-line);
		box-shadow: 0 0 0 3px var(--saffron-soft);
	}
	.actions { display: flex; gap: 0.6rem; }
	.btn {
		padding: 0.5rem 0.9rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--ink-line);
		background: var(--ink-800);
		color: var(--paper);
		font-family: var(--font-mono);
		font-size: var(--t-xs);
		letter-spacing: 0.3px;
		cursor: pointer;
	}
	.btn:hover:not(:disabled) { border-color: var(--saffron-line); }
	.btn:disabled { opacity: 0.4; cursor: not-allowed; }
	.btn.primary {
		background: var(--saffron);
		border-color: var(--saffron);
		color: #1a1208;
		font-weight: 600;
		text-transform: uppercase;
	}
	.btn.primary:hover:not(:disabled) { background: #f29638; border-color: #f29638; }
	.result {
		font-family: var(--font-mono);
		font-size: var(--t-xs);
		padding: 0.5rem 0.7rem;
		border-radius: var(--radius-sm);
		border: 1px solid;
	}
	.result[data-ok='true'] {
		background: rgba(91, 201, 122, 0.12);
		color: var(--up);
		border-color: rgba(91, 201, 122, 0.4);
	}
	.result[data-ok='false'] {
		background: rgba(248, 84, 106, 0.12);
		color: var(--down);
		border-color: rgba(248, 84, 106, 0.4);
	}
</style>