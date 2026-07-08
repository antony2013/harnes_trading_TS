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
		padding: 0.5rem 0.65rem;
		background: var(--ink-950);
		border: 1px solid var(--ink-line);
		border-radius: var(--radius-sm);
		color: var(--paper);
		font-family: var(--font-mono);
		font-size: var(--t-sm);
	}
	.field:focus {
		outline: none;
		border-color: var(--saffron-line);
		box-shadow: 0 0 0 3px var(--saffron-soft);
	}
	.link {
		background: none;
		border: none;
		color: var(--saffron);
		font-family: var(--font-mono);
		font-size: var(--t-2xs);
		letter-spacing: 0.3px;
		cursor: pointer;
		padding: 0.25rem 0;
	}
	.link:hover {
		text-decoration: underline;
		text-underline-offset: 2px;
	}
</style>