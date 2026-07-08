import { writable, get } from 'svelte/store';

export interface ToolStep {
	type: 'tool_call' | 'tool_result';
	name: string;
	data: unknown;
}

export interface ChatMessage {
	id: string;
	role: 'user' | 'assistant';
	content: string;
	tools?: ToolStep[];
}

export const messages = writable<ChatMessage[]>([]);
export const streaming = writable(false);
export const chatError = writable<string | null>(null);

let controller: AbortController | null = null;
let currentAssistantId: string | null = null;

function patchAssistant(patch: (a: ChatMessage) => ChatMessage): void {
	const id = currentAssistantId;
	if (!id) return;
	messages.update((m) => m.map((msg) => (msg.id === id ? patch(msg) : msg)));
}
function appendText(t: string): void {
	patchAssistant((a) => ({ ...a, content: a.content + t }));
}
function pushTool(step: ToolStep): void {
	patchAssistant((a) => ({ ...a, tools: [...(a.tools ?? []), step] }));
}

function handleBlock(block: string): void {
	let event = 'message';
	let data = '';
	for (const line of block.split('\n')) {
		if (line.startsWith('event:')) event = line.slice(6).trim();
		else if (line.startsWith('data:')) data += line.slice(5).trim();
	}
	let payload: any = {};
	try {
		payload = JSON.parse(data);
	} catch {
		return;
	}
	if (event === 'token' && typeof payload.text === 'string') appendText(payload.text);
	else if (event === 'tool_call') pushTool({ type: 'tool_call', name: payload.name, data: payload.input });
	else if (event === 'tool_result') pushTool({ type: 'tool_result', name: payload.name, data: payload.output });
	else if (event === 'error') {
		appendText(`\n\n⚠️ ${payload.message ?? 'error'}`);
		chatError.set(payload.message ?? 'error');
	}
	// 'done' is a no-op; stream end is handled by the reader loop.
}

export async function sendMessage(text: string): Promise<void> {
	const trimmed = text.trim();
	if (!trimmed || get(streaming)) return;
	chatError.set(null);

	const userId = crypto.randomUUID();
	const assistantId = crypto.randomUUID();
	currentAssistantId = assistantId;

	const history = get(messages)
		.filter((m) => m.content.trim().length > 0)
		.map((m) => ({ role: m.role, content: m.content }));
	const bodyMessages = [...history, { role: 'user' as const, content: trimmed }];

	messages.update((m) => [
		...m,
		{ id: userId, role: 'user', content: trimmed },
		{ id: assistantId, role: 'assistant', content: '', tools: [] }
	]);

	streaming.set(true);
	controller = new AbortController();
	try {
		const res = await fetch('/agent/chat', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ messages: bodyMessages }),
			signal: controller.signal
		});
		if (!res.ok || !res.body) {
			let msg = `HTTP ${res.status}`;
			try {
				const j = await res.json();
				if (j?.message) msg = j.message;
			} catch {}
			patchAssistant((a) => ({ ...a, content: `⚠️ ${msg}` }));
			chatError.set(msg);
			return;
		}
		const reader = res.body.getReader();
		const dec = new TextDecoder();
		let buf = '';
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += dec.decode(value, { stream: true });
			let idx: number;
			while ((idx = buf.indexOf('\n\n')) >= 0) {
				const block = buf.slice(0, idx);
				buf = buf.slice(idx + 2);
				handleBlock(block);
			}
		}
	} catch (err: any) {
		if (err?.name !== 'AbortError') {
			patchAssistant((a) => ({ ...a, content: a.content || `⚠️ ${err?.message ?? 'stream failed'}` }));
			chatError.set(err?.message ?? 'stream failed');
		}
	} finally {
		streaming.set(false);
		controller = null;
		// If the assistant message never received any tokens or tool steps
		// (e.g. Stop pressed before the first token, or an abort), remove the
		// dangling empty "thinking…" bubble. A message that received content
		// or tool steps must be preserved.
		if (currentAssistantId) {
			const id = currentAssistantId;
			const cur = get(messages).find((m) => m.id === id);
			if (cur && cur.content === '' && (!cur.tools || cur.tools.length === 0)) {
				messages.update((m) => m.filter((msg) => msg.id !== id));
			}
		}
		currentAssistantId = null;
	}
}

export function stop(): void {
	controller?.abort();
}

export function clear(): void {
	if (get(streaming)) return;
	messages.set([]);
	chatError.set(null);
}