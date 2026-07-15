# Web search setup (SearXNG + Crawl4AI)

The agent's optional `search` subagent needs two local services: **SearXNG** (meta-search) and **Crawl4AI** (page-to-markdown). Enable it in **Settings → Web search**.

## 1. SearXNG (already running on :8080)

SearXNG must expose `/search?format=json`. Verify:

```bash
curl 'http://localhost:8080/search?q=test&format=json'
```

You should get JSON with a `results` array. (Your SearXNG instance is already running on port 8080.)

## 2. Crawl4AI (run on :11235)

Crawl4AI is not set up yet. Run the server via Docker:

```bash
docker pull unclecode/crawl4ai:basic
docker run -d -p 11235:11235 --name crawl4ai unclecode/crawl4ai:basic
```

Verify the health endpoint:

```bash
curl http://localhost:11235/health
# {"status":"healthy", ...}
```

The server exposes `POST /crawl` (used by the `crawl_page` tool) and `GET /health` (used by the Settings → Test button).

## 3. Enable in the UI

1. Open **/settings** → **Web search**.
2. Toggle **Enable web search subagent**.
3. Confirm the URLs (defaults `http://localhost:8080` and `http://localhost:11235`).
4. Click **Test** — it pings SearXNG `/search` and Crawl4AI `/health` and reports reachability.
5. Click **Save**.

On the next chat, the main agent can delegate web research to the `search` subagent via `task()`.

## Notes

- Search is **off by default**; it's added to the agent only when enabled and saved.
- The `crawl_page` tool POSTs `{ url, browser_config: { headless: true }, crawler_config: { cache_mode: "BYPASS" } }` to `/crawl` and returns the cleaned markdown (truncated to 20 000 chars).
- Both tools never throw — if a service is down, they return a JSON error string the subagent can reason over.