## OpenShell execution environment (production)

Production runs the API + deepagent inside WSL2 so the `openshell` CLI is a local
subprocess and Docker (the compute backend) is available.

1. In WSL2 (Ubuntu): `curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh`
   (or `uv tool install -U openshell`). Verify: `openshell --version`.
2. Ensure Docker Desktop's WSL2 backend is running.
3. Build the sandbox image: `bash apps/deepagent/src/openshell/image/build.sh`
   -> tags `harnesh/agent-sandbox:ubuntu-lts`.
4. Provision an OpenShell gateway. The `openshell` CLI is a **client** —
   `openshell sandbox create/exec/delete` require an **active registered gateway**
   (a separate server that manages sandbox lifecycle through its compute driver).
   `uv tool install` does **not** provision one, so `openshell sandbox create` fails
   with `No active gateway` until you register + select a gateway:
   - Check: `openshell gateway list`.
   - Register a local plaintext gateway (an `http://` endpoint skips both mTLS
     client-cert lookup and browser auth, so **no certs needed**):
     `openshell gateway add http://127.0.0.1:8080 --local`.
   - Activate: `openshell gateway select <name>` (or set `OPENSHELL_GATEWAY`).
   - Diagnose prerequisites: `openshell doctor check`.
   The gateway server itself is a component the CLI does not ship — the
   `gateway` group only `add/remove/login/logout/select/info/list` (no
   `run`/`start`). See the upstream OpenShell docs for running one locally
   (Docker) or on Kubernetes (`helm install openshell
   oci://ghcr.io/nvidia/openshell/helm-chart`, experimental). Without an active
   gateway, the `shell` tool returns `[exit: -1] No active gateway …` and the
   agent surfaces it as a shell error; chat still works, just without the shell.
5. Select the openshell middleware in a production profile
   (`apps/deepagent/profiles/<provider>__<model>.jsonc` — see example).
6. `bun run dev` (from WSL2).

The tool bridge binds 127.0.0.1:<bridgePort> lazily on the first `shell` call
(per-process bearer token generated at agent build, baked into the sandbox env
so the lazy bind and the sandbox share one token); sandboxes reach it via the
host gateway (host.docker.internal). **Note: `host.docker.internal` resolves to
the host's localhost only on Docker Desktop** (which proxies host-localhost for
containers); a plain Linux Docker engine in WSL2 does NOT provide this mapping,
so the bridge would be unreachable from sandboxes without Docker Desktop's WSL2
backend (step 2). Sandboxes idle-reap after `openshell.idleTimeoutMs`. Author
files inside the sandbox; use the agent's `write_file`/`read_file` tools for
host-side final artifacts. (Host↔sandbox file upload/download via the `shell`
tool is a future feature, not in v1.)

v1 limitation: the bridge + workspace pool are process-singletons (first
config wins). Production is single-profile, so this is fine; multi-profile
support would require keying the singletons by profile/bridgePort.

Alpha caveat: OpenShell is v0.0.x alpha with no TS SDK; v1 integrates via the CLI
subprocess. The ExecutionBackend interface isolates us from CLI/SDK churn.