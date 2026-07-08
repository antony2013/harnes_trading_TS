<script lang="ts">
	import { onMount } from 'svelte';
	import { loadSettings } from '$lib/stores/agentSettings';
	import ChatView from '$lib/components/agent/ChatView.svelte';
	onMount(() => loadSettings());
</script>

<svelte:head><title>Agent chat — Harnesh Trading</title></svelte:head>
<ChatView />