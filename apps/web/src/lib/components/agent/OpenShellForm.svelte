<script lang="ts">
	import {
		openshellSettings,
		openshellSaving,
		openshellTesting,
		openshellTestResult,
		openshellError,
		loadOpenShell,
		saveOpenShell,
		testOpenShell,
		DEFAULT_OPENSHELL,
		type OpenShellSettings
	} from '$lib/stores/agentOpenshell';

	let enabled = $state(false);
	let image = $state(DEFAULT_OPENSHELL.image);
	let idleTimeoutMs = $state(DEFAULT_OPENSHELL.idleTimeoutMs);
	let bridgePort = $state(DEFAULT_OPENSHELL.bridgePort);
	let executionTimeoutMs = $state(DEFAULT_OPENSHELL.executionTimeoutMs);

	let seeded = false;
	$effect(() => {
		const s = $openshellSettings;
		if (s && !seeded) {
			seeded = true;
			enabled = s.enabled;
			image = s.image;
			idleTimeoutMs = s.idleTimeoutMs;
			bridgePort = s.bridgePort;
			executionTimeoutMs = s.executionTimeoutMs;
		}
	});

	const idleMin = $derived(Math.round(idleTimeoutMs / 60000));
	const execSec = $derived(Math.round(executionTimeoutMs / 1000));

	function payload(): OpenShellSettings {
		return { enabled, image, idleTimeoutMs, bridgePort, executionTimeoutMs };
	}

	async function onSave() {
		await saveOpenShell(payload());
	}
</script>

<div class="form">
	<label class="row toggle">
		<span class="lbl">Enable OpenShell sandbox</span>
		<input type="checkbox" bind:checked={enabled} />
	</label>
	<p class="hint">
		When enabled, the agent gets a <code>shell</code> tool that runs commands in a persistent Linux Docker sandbox (one per chat workspace).
		Requires Docker Desktop running. See <a href="https://github.com/harnesh-trading-ts" target="_blank" rel="noreferrer">openshell setup</a>.
	</p>

	<label class="row">
		<span class="lbl">Image</span>
		<input class="field" type="text" bind:value={image} disabled={!enabled} />
	</label>

	<label class="row">
		<span class="lbl">Idle timeout ({idleMin} min)</span>
		<input class="field" type="number" min="1" bind:value={idleTimeoutMs} disabled={!enabled} />
	</label>

	<label class="row">
		<span class="lbl">Bridge port</span>
		<input class="field" type="number" min="0" bind:value={bridgePort} disabled={!enabled} />
	</label>

	<label class="row">
		<span class="lbl">Execution timeout ({execSec} s)</span>
		<input class="field" type="number" min="1" bind:value={executionTimeoutMs} disabled={!enabled} />
	</label>

	<div class="actions">
		<button class="btn" disabled={$openshellTesting || !enabled} onclick={testOpenShell}>
			{$openshellTesting ? 'Testing…' : 'Test Docker'}
		</button>
		<button class="btn primary" disabled={$openshellSaving} onclick={onSave}>
			{$openshellSaving ? 'Saving…' : 'Save'}
		</button>
	</div>

	{#if $openshellTestResult}
		<div class="result" data-ok={$openshellTestResult.ok}>
			{$openshellTestResult.ok ? '✓' : '✗'} {$openshellTestResult.detail}
		</div>
	{/if}

	{#if $openshellError}
		<div class="result" data-ok="false">✗ {$openshellError}</div>
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