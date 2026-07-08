<script lang="ts">
	import {
		agentSettings,
		loadSettings,
		fetchOllamaModels,
		saveSettings,
		testConnection,
		saving,
		testing,
		testResult,
		settingsError,
		PROVIDER_LABELS,
		DEFAULT_BASE_URL,
		type Provider
	} from '$lib/stores/agentSettings';
	import ModelSelect from './ModelSelect.svelte';

	const PROVIDERS: Provider[] = ['anthropic', 'openai', 'ollama', 'custom'];

	let provider = $state<Provider>('ollama');
	let baseUrl = $state('http://localhost:11434');
	let model = $state('');
	let apiKey = $state(''); // leave blank to keep existing

	// Seed from loaded settings once they arrive.
	let seeded = false;
	$effect(() => {
		const s = $agentSettings;
		if (s && !seeded) {
			seeded = true;
			provider = s.provider;
			baseUrl = s.baseUrl || DEFAULT_BASE_URL[s.provider];
			model = s.model;
			apiKey = '';
		}
	});

	function onProviderChange() {
		baseUrl = DEFAULT_BASE_URL[provider];
		model = '';
		if (provider === 'ollama') fetchOllamaModels(baseUrl);
	}

	function refreshOllama() {
		fetchOllamaModels(baseUrl);
	}

	function payload() {
		return { provider, baseUrl, model, apiKey };
	}

	let showKey = $state(false);
	const keyPlaceholder = $derived(
		$agentSettings?.hasKey ? `(kept: ${$agentSettings?.apiKey || '****'})` : 'paste API key'
	);
</script>

<div class="form">
	<label class="row">
		<span class="lbl">Provider</span>
		<select class="field" bind:value={provider} onchange={onProviderChange}>
			{#each PROVIDERS as p (p)}<option value={p}>{PROVIDER_LABELS[p]}</option>{/each}
		</select>
	</label>

	{#if provider === 'ollama' || provider === 'custom'}
		<label class="row">
			<span class="lbl">Base URL</span>
			<div class="inline">
				<input class="field" type="text" bind:value={baseUrl} />
				{#if provider === 'ollama'}<button type="button" class="btn ghost" onclick={refreshOllama}>↻ Models</button>{/if}
			</div>
		</label>
	{/if}

	{#if provider === 'anthropic' || provider === 'openai' || provider === 'custom'}
		<label class="row">
			<span class="lbl">API Key</span>
			<div class="inline">
				<input class="field" type={showKey ? 'text' : 'password'} placeholder={keyPlaceholder} bind:value={apiKey} />
				<button type="button" class="btn ghost" onclick={() => (showKey = !showKey)}>{showKey ? 'hide' : 'show'}</button>
			</div>
		</label>
	{/if}

	<label class="row">
		<span class="lbl">Model</span>
		<div class="model-row"><ModelSelect {provider} bind:value={model} /></div>
	</label>

	<div class="actions">
		<button class="btn" disabled={$testing || !model} onclick={() => testConnection(payload())}>
			{$testing ? 'Testing…' : 'Test connection'}
		</button>
		<button class="btn primary" disabled={$saving || !model} onclick={async () => { await saveSettings(payload()); }}>
			{$saving ? 'Saving…' : 'Save'}
		</button>
	</div>

	{#if $testResult}
		<div class="result" data-ok={$testResult.ok}>
			{$testResult.ok ? '✓' : '✗'} {$testResult.detail}
		</div>
	{/if}

	{#if $settingsError}
		<div class="result" data-ok="false">✗ {$settingsError}</div>
	{/if}
</div>

<style>
	.form { display: flex; flex-direction: column; gap: 1rem; }
	.row { display: flex; flex-direction: column; gap: 0.35rem; }
	.lbl { font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: #8a97b5; }
	.inline { display: flex; gap: 0.5rem; }
	.inline .field { flex: 1 1 auto; }
	.model-row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
	.field {
		width: 100%; padding: 0.45rem 0.6rem; background: #121a33;
		border: 1px solid #1e2740; border-radius: 8px; color: #e7ecf5; font-size: 14px;
	}
	.actions { display: flex; gap: 0.6rem; }
	.btn {
		padding: 0.5rem 0.9rem; border-radius: 8px; border: 1px solid #1e2740;
		background: #121a33; color: #e7ecf5; font-size: 14px; cursor: pointer;
	}
	.btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn.primary { background: linear-gradient(135deg, #4f8cff, #7a5cff); border: none; color: #fff; }
	.btn.ghost { background: transparent; }
	.result { font-size: 13px; padding: 0.5rem 0.7rem; border-radius: 8px; }
	.result[data-ok='true'] { background: rgba(34,197,94,0.12); color: #22c55e; }
	.result[data-ok='false'] { background: rgba(239,68,68,0.12); color: #ef4444; }
</style>