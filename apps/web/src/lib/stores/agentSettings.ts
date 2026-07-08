import { writable } from 'svelte/store';

export type Provider = 'anthropic' | 'openai' | 'openrouter' | 'ollama' | 'custom';

export interface AgentSettingsView {
	provider: Provider;
	baseUrl: string;
	model: string;
	apiKey: string; // masked from server
	hasKey: boolean;
}

export const PROVIDER_LABELS: Record<Provider, string> = {
	anthropic: 'Anthropic',
	openai: 'OpenAI',
	openrouter: 'OpenRouter',
	ollama: 'Ollama (local)',
	custom: 'OpenAI-compatible (custom)'
};

export const CURATED_MODELS: Partial<Record<Provider, string[]>> = {
	anthropic: ['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-1'],
	openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
	openrouter: [
		'anthropic/claude-3.5-sonnet',
		'meta-llama/llama-3.3-70b-instruct',
		'google/gemini-2.5-pro',
		'google/gemini-2.5-flash',
		'deepseek/deepseek-chat'
	]
};

export const DEFAULT_BASE_URL: Record<Provider, string> = {
	anthropic: '',
	openai: '',
	openrouter: 'https://openrouter.ai/api/v1',
	ollama: 'http://localhost:11434',
	custom: ''
};

export const agentSettings = writable<AgentSettingsView | null>(null);
export const ollamaModels = writable<string[]>([]);
export const saving = writable(false);
export const testing = writable(false);
export const testResult = writable<{ ok: boolean; detail: string } | null>(null);
export const settingsError = writable<string | null>(null);

export async function loadSettings(): Promise<void> {
	const res = await fetch('/agent/settings');
	agentSettings.set(await res.json());
}

export async function fetchOllamaModels(baseUrl: string): Promise<void> {
	const res = await fetch(`/agent/ollama/models?baseUrl=${encodeURIComponent(baseUrl)}`);
	if (res.ok) {
		const j = await res.json();
		ollamaModels.set(j.models ?? []);
	} else {
		ollamaModels.set([]);
	}
}

export async function saveSettings(payload: {
	provider: Provider;
	baseUrl: string;
	model: string;
	apiKey: string;
}): Promise<boolean> {
	saving.set(true);
	settingsError.set(null);
	testResult.set(null);
	try {
		const res = await fetch('/agent/settings', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload)
		});
		if (!res.ok) {
			settingsError.set(`Save failed (${res.status})`);
			return false;
		}
		await loadSettings();
		return true;
	} finally {
		saving.set(false);
	}
}

export async function testConnection(payload: {
	provider: Provider;
	baseUrl: string;
	model: string;
	apiKey: string;
}): Promise<void> {
	testing.set(true);
	testResult.set(null);
	settingsError.set(null);
	try {
		const res = await fetch('/agent/test', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload)
		});
		testResult.set(await res.json());
	} finally {
		testing.set(false);
	}
}