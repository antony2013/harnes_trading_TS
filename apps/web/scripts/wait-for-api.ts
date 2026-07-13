// Waits for the Elysia API to accept connections before Vite starts.
//
// `turbo dev` runs the api (`bun --watch`) and web (`vite dev`) concurrently with
// no ordering. Vite comes up faster than the API, so the dev proxy in
// vite.config.ts hits ECONNREFUSED on /stream, /market-quote, /agent until the
// API port opens. This gate lets Vite start only once the API is listening,
// removing those transient startup proxy errors. On API hot-reload restarts
// mid-session the browser's EventSource/fetch already retries on its own.

import net from 'node:net';

const HOST = process.env.API_HOST ?? 'localhost';
const PORT = Number(process.env.API_PORT ?? 3000);
const POLL_MS = 300;
const TIMEOUT_MS = Number(process.env.API_WAIT_TIMEOUT_MS ?? 60_000);

function probe(): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = net.connect({ host: HOST, port: PORT });
		const done = (ok: boolean) => {
			sock.destroy();
			resolve(ok);
		};
		sock.once('connect', () => done(true));
		sock.once('error', () => done(false));
	});
}

async function main() {
	const start = Date.now();
	while (Date.now() - start < TIMEOUT_MS) {
		if (await probe()) {
			console.log(
				`[wait-for-api] API ready at http://${HOST}:${PORT} (waited ${Date.now() - start}ms)`
			);
			return;
		}
		await new Promise((r) => setTimeout(r, POLL_MS));
	}
	console.warn(
		`[wait-for-api] API at http://${HOST}:${PORT} not ready after ${TIMEOUT_MS}ms — starting Vite anyway`
	);
}

main();