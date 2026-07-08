<script lang="ts">
	import { CURATED_MODELS, ollamaModels, type Provider } from '$lib/stores/agentSettings';

	let {
		provider,
		value = $bindable(),
		placeholder = 'Select or type a model'
	}: { provider: Provider; value: string; placeholder?: string } = $props();

	let custom = $state(false);
	const curated = $derived(CURATED_MODELS[provider] ?? []);
	const options = $derived(provider === 'ollama' ? $ollamaModels : curated);

	$effect(() => {
		// reset to dropdown mode whenever provider or options change.
		// Reading `options` (a $derived) tracks provider + ollamaModels/curated
		// as dependencies so this re-runs when they change.
		options;
		custom = false;
	});
</script>

{#if custom || (options.length === 0 && provider !== 'ollama')}
	<input
		class="field"
		type="text"
		placeholder={placeholder}
		bind:value
	/>
	{#if options.length > 0}
		<button type="button" class="link" onclick={() => (custom = false)}>use list</button>
	{/if}
{:else}
	<select class="field" bind:value>
		{#if !value}<option value="" disabled>{placeholder}</option>{/if}
		{#each options as m (m)}<option value={m}>{m}</option>{/each}
	</select>
	<button type="button" class="link" onclick={() => (custom = true)}>type manually</button>
{/if}

<style>
	.field {
		width: 100%;
		padding: 0.45rem 0.6rem;
		background: #121a33;
		border: 1px solid #1e2740;
		border-radius: 8px;
		color: #e7ecf5;
		font-size: 14px;
	}
	.link {
		background: none;
		border: none;
		color: #4f8cff;
		font-size: 12px;
		cursor: pointer;
		padding: 0.25rem 0;
	}
</style>