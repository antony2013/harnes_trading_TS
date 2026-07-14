<script lang="ts">
	import { onMount } from 'svelte';
	import { loadSettings, fetchOllamaModels, agentSettings } from '$lib/stores/agentSettings';
	import { loadOpenShell } from '$lib/stores/agentOpenshell';
	import ProviderForm from '$lib/components/agent/ProviderForm.svelte';
	import OpenShellForm from '$lib/components/agent/OpenShellForm.svelte';

	onMount(async () => {
		await loadSettings();
		if ($agentSettings?.provider === 'ollama') {
			fetchOllamaModels($agentSettings.baseUrl || 'http://localhost:11434');
		}
		await loadOpenShell();
	});
</script>

<svelte:head><title>Agent settings — Harnesh Trading</title></svelte:head>

<div class="page">
	<h1>Agent model settings</h1>
	<p class="muted">Pick an LLM provider, configure it, test, then save. The agent uses this for the next chat.</p>
	<section class="card"><ProviderForm /></section>

	<h2>OpenShell sandbox</h2>
	<p class="muted">Optional: give the agent a persistent shell tool in a Docker sandbox (one per chat workspace).</p>
	<section class="card"><OpenShellForm /></section>
</div>

<style>
	.page { max-width: 580px; margin: 0 auto; padding: 2.5rem 1rem; }
	h1 {
		font-family: var(--font-display);
		font-style: italic;
		font-weight: 400;
		font-size: var(--t-2xl);
		line-height: 1.1;
		margin: 0 0 0.4rem;
		color: var(--paper);
	}
	h2 {
		font-family: var(--font-display);
		font-style: italic;
		font-weight: 400;
		font-size: var(--t-xl);
		margin: 2rem 0 0.4rem;
		color: var(--paper);
	}
	.muted { color: var(--paper-dim); margin: 0 0 1.75rem; font-size: var(--t-sm); }
	.card {
		background: var(--ink-900);
		border: 1px solid var(--ink-line);
		border-radius: var(--radius);
		padding: 1.25rem;
	}
</style>