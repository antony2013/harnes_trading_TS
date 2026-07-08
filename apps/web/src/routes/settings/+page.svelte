<script lang="ts">
	import { onMount } from 'svelte';
	import { loadSettings, fetchOllamaModels, agentSettings } from '$lib/stores/agentSettings';
	import ProviderForm from '$lib/components/agent/ProviderForm.svelte';

	onMount(async () => {
		await loadSettings();
		if ($agentSettings?.provider === 'ollama') {
			fetchOllamaModels($agentSettings.baseUrl || 'http://localhost:11434');
		}
	});
</script>

<svelte:head><title>Agent settings — Harnesh Trading</title></svelte:head>

<div class="page">
	<h1>Agent model settings</h1>
	<p class="muted">Pick an LLM provider, configure it, test, then save. The agent uses this for the next chat.</p>
	<section class="card"><ProviderForm /></section>
</div>

<style>
	.page { max-width: 560px; margin: 0 auto; padding: 2rem 1rem; }
	h1 { font-size: 1.5rem; margin: 0 0 0.25rem; }
	.muted { color: #8a97b5; margin: 0 0 1.5rem; }
	.card {
		background: #0b1020; border: 1px solid #1e2740; border-radius: 12px; padding: 1.25rem;
	}
</style>