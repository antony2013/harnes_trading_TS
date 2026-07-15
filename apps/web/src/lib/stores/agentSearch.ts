import { writable } from 'svelte/store'

export interface SearchSettings {
	enabled: boolean;
	searxngBaseUrl: string;
	crawl4aiBaseUrl: string;
	maxResults: number;
	crawlTimeoutMs: number;
}

export const DEFAULT_SEARCH: SearchSettings = {
	enabled: false,
	searxngBaseUrl: 'http://localhost:8080',
	crawl4aiBaseUrl: 'http://localhost:11235',
	maxResults: 5,
	crawlTimeoutMs: 60_000
};

export const searchSettings = writable<SearchSettings | null>(null);
export const searchSaving = writable(false);
export const searchTesting = writable(false);
export const searchTestResult = writable<{ ok: boolean; detail: string } | null>(null);
export const searchError = writable<string | null>(null);

export async function loadSearch(): Promise<void> {
	const res = await fetch('/agent/search');
	searchSettings.set(await res.json());
}

export async function saveSearch(payload: SearchSettings): Promise<boolean> {
	searchSaving.set(true);
	searchError.set(null);
	searchTestResult.set(null);
	try {
		const res = await fetch('/agent/search', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload)
		});
		if (!res.ok) {
			searchError.set(`Save failed (${res.status})`);
			return false;
		}
		await loadSearch();
		return true;
	} finally {
		searchSaving.set(false);
	}
}

export async function testSearch(): Promise<void> {
	searchTesting.set(true);
	searchTestResult.set(null);
	searchError.set(null);
	try {
		const res = await fetch('/agent/search/test', { method: 'POST' });
		searchTestResult.set(await res.json());
	} finally {
		searchTesting.set(false);
	}
}