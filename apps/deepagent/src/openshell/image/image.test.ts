// apps/deepagent/src/openshell/image/image.test.ts
import { test, expect } from 'bun:test'

const RUN = !!process.env.OPENSHELL_AVAILABLE
const itIf = RUN ? test : test.skip

itIf('sandbox image: builds + has bash, curl, git, python3, uv, node, pnpm + wrappers', async () => {
  const { exitCode } = Bun.spawnSync(['bash', 'apps/deepagent/src/openshell/image/build.sh'], { cwd: process.cwd() })
  expect(exitCode).toBe(0)
  // smoke: run a command in the built image checking tool availability
  const smoke = Bun.spawnSync(['docker', 'run', '--rm', 'harnesh/agent-sandbox:ubuntu-lts', 'bash', '-lc',
    'set -e; command -v bash curl git python3 uv node pnpm; test -x /usr/local/bin/get_ltp'])
  expect(smoke.exitCode).toBe(0)
})