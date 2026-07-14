import { writable } from 'svelte/store';

export interface OpenShellSettings {
	enabled: boolean;
	image: string;
	idleTimeoutMs: number;
	bridgePort: number;
	executionTimeoutMs: number;
}

export const DEFAULT_OPENSHELL: OpenShellSettings = {
	enabled: false,
	image: 'harnesh/agent-sandbox:ubuntu-lts',
	idleTimeoutMs: 1_800_000,
	bridgePort: 7777,
	executionTimeoutMs: 120_000
};

export const openshellSettings = writable<OpenShellSettings | null>(null);
export const openshellSaving = writable(false);
export const openshellTesting = writable(false);
export const openshellTestResult = writable<{ ok: boolean; detail: string } | null>(null);
export const openshellError = writable<string | null>(null);

export async function loadOpenShell(): Promise<void> {
	const res = await fetch('/agent/openshell');
	openshellSettings.set(await res.json());
}

export async function saveOpenShell(payload: OpenShellSettings): Promise<boolean> {
	openshellSaving.set(true);
	openshellError.set(null);
	openshellTestResult.set(null);
	try {
		const res = await fetch('/agent/openshell', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload)
		});
		if (!res.ok) {
			openshellError.set(`Save failed (${res.status})`);
			return false;
		}
		await loadOpenShell();
		return true;
	} finally {
		openshellSaving.set(false);
	}
}

export async function testOpenShell(): Promise<void> {
	openshellTesting.set(true);
	openshellTestResult.set(null);
	openshellError.set(null);
	try {
		const res = await fetch('/agent/openshell/test', { method: 'POST' });
		openshellTestResult.set(await res.json());
	} finally {
		openshellTesting.set(false);
	}
}