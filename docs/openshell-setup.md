## OpenShell execution environment (production)

Production runs the API + deepagent inside WSL2 so the `openshell` CLI is a local
subprocess and Docker (the compute backend) is available.

1. In WSL2 (Ubuntu): `curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh`
   (or `uv tool install -U openshell`). Verify: `openshell --version`.
2. Ensure Docker Desktop's WSL2 backend is running.
3. Build the sandbox image: `bash apps/deepagent/src/openshell/image/build.sh`
   -> tags `harnesh/agent-sandbox:ubuntu-lts`.
4. Select the openshell middleware in a production profile
   (`apps/deepagent/profiles/<provider>__<model>.jsonc` — see example).
5. `bun run dev` (from WSL2).

The tool bridge binds 127.0.0.1:<bridgePort> lazily on the first `shell` call
(per-process bearer token generated at agent build, baked into the sandbox env
so the lazy bind and the sandbox share one token); sandboxes reach it via the
host gateway (host.docker.internal). Sandboxes idle-reap after
`openshell.idleTimeoutMs`. Author files inside the sandbox; export final
artifacts to the host workspace via `shell`'s `download`.

v1 limitation: the bridge + workspace pool are process-singletons (first
config wins). Production is single-profile, so this is fine; multi-profile
support would require keying the singletons by profile/bridgePort.

Alpha caveat: OpenShell is v0.0.x alpha with no TS SDK; v1 integrates via the CLI
subprocess. The ExecutionBackend interface isolates us from CLI/SDK churn.