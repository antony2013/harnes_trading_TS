import adapter from '@sveltejs/adapter-auto';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
			// If your environment is not supported, or you settled on a specific environment, switch out the adapter.
			// See https://svelte.dev/docs/kit/adapters for more information about adapters.
			adapter: adapter()
		})
	],
	// Dev-only proxy to the Elysia API (apps/api on :3000). Keeps the browser
	// same-origin so the SSE EventSource + fetch avoid CORS. For production,
	// route these via an adapter-level proxy or env-driven origin instead.
	server: {
		proxy: {
			'/stream': {
				target: 'http://localhost:3000',
				changeOrigin: true
			},
			'/market-quote': {
				target: 'http://localhost:3000',
				changeOrigin: true
			},
			'/agent': {
				target: 'http://localhost:3000',
				changeOrigin: true
			}
		}
	}
});