# Development

Use the Bun version from `.mise.toml` and TypeScript from the lockfile. In an agent
shell, prepend `~/.local/share/mise/installs/bun/<version>/bin` to PATH; do not run
`mise trust` to activate the checkout. Install with `bun install --frozen-lockfile`.

## Layout

Shared implementation lives under `src/` by domain: `workflows/` for repository
mechanics, `pr/` and `git/` for existing GitHub guards, `release/` for registry
logic, `commands/` for execution receipts, and `review/`, `version/`, `skills/`,
`images/`, and `screenshots/` for their respective APIs. Tests live beside
implementation. `screenshots/gallery.ts`, `gallery.css`, and `manifest.ts` are
browser entry points that the package exports; they import nothing from Node
or Bun, and `tsconfig.browser.json`, part of `typecheck`, checks them with the
strictest settings consumers use, since consumers compile the shipped source.

Repository scripts are grouped by purpose: `scripts/build/` generates the skill
bundle, `scripts/testing/` contains installed/compiled package smoke checks,
`scripts/release/` builds distributable artifacts, and `scripts/checks/` contains
the historical extraction inventory helper. Canonical portable skills live in
`skills/`. Do not install generated copies over those sources.

README explains purpose, setup, and normal use. AGENTS.md contains operational
requirements. Reference documents hold reusable command contracts and maintenance
procedures. Run-specific inventories, review findings, timings, and publish
receipts belong in the PR; private logs and generated artifacts remain local.

### Module layering

Modules import only from their own layer or a lower one, and never in a cycle,
including through type-only imports. The `graph` section of `agent-tool.json`
names the layer each module belongs to, and `bun src/index.ts graph check`
(in the verify run group and CI) enforces both; add a new top-level module to
its layers. A test asserts the real configuration passes.

1. Primitives: `git/`, `system/` (PATH lookup outside the repository, Bun workspace
   discovery, and link-refusing atomic file writes, shared by several domains), `workflows/core.ts`
   (process, Git, and `gh` helpers and argument parsing), `workflows/config.ts`,
   `permissions/catalog.ts`, `images/config.ts`, `screenshots/config.ts`, and
   `graph/config.ts`. They
   import nothing above themselves.
2. Configuration: `config.ts`, which parses `agent-tool.json` from the primitive
   schemas.
3. Domains: `bun/`, `commands/`, `dependencies/`, `graph/`, `images/`,
   `permissions/`, `pr/`, `processes/`, `release/`, `review/`, `screenshots/`,
   `skills/`, `version/`, and `harnesses.ts`.
   Domains may use each other without cycles.
4. Workflows: the rest of `workflows/`, which compose domains into repository
   commands such as `branch`, `pr`, `hooks`, and `repo`.
5. Entry points: `cli.ts` (command dispatch), `index.ts`, `runAgentToolAction.ts`,
   and `doctor.ts`.
6. Repository scripts in `scripts/`, which may import any `src/` module.

Production modules never import `*.test.ts` or `*.testUtils.ts` files, which the
published package omits.

## Validation

```sh
bun run agent:run --label typecheck -- bun run typecheck
bun run agent:run --label graph -- bun src/index.ts graph check
bun run agent:run --label tests -- bun test --parallel=2
bun run agent:run --label package-smoke -- bun scripts/testing/smoke-package.ts
bun run agent:run --label build -- bun run build
bun run agent:run --label compiled-smoke -- bun scripts/testing/smoke.ts dist/agent-tool
```

Tests run as isolated files across two worker processes with `--parallel=2`,
since most of their time goes to spawning the CLI against disposable
repositories. CPU-count concurrency can oversubscribe subprocesses on shared
hosts and turn the unchanged five-second test limits into scheduling failures.
The bounded command retains the complete test scope and every assertion; plain
`bun test` still runs the same suite serially. Keep each test file independent
of the others, with its own temporary directories and stubs.

Build regenerates `src/skills/bundled.ts`; commit it with canonical skill changes.
After running `bun run generate`, the same six checks can run together with
`bun src/index.ts run-group scripts/testing/verify.json`, recording source-bound
timings and receipts. Generation runs first so a build does not change the source
fingerprint while validation is in progress.
The package smoke installs an npm tarball into a temporary project. Compiled
smoke runs all three review adapters through local stubs with Bun and Node absent
from PATH; no live model calls are made. CI runs these checks on Linux/macOS,
tests the minimum supported Bun runtime, and builds Debian packaging on Linux.
Local source integration tests use disposable Git repositories, bare remotes,
and API stubs to check guard behavior without mutating GitHub. Dependency-mode
integration tests use real Bun installs against a loopback registry with real
package tarballs; the manager and lockfile writer are never stubbed. Set
`AGENT_TOOL_TEST_BUN` to the owning manager's absolute executable when testing a
separate minimum CLI runtime, and `AGENT_TOOL_TEST_CLI` to an installed package's
`src/index.ts` to exercise the same fixtures against a packed consumer. These are
test-only selectors, not production overrides for the pinned-manager guard.
The package smoke runs those same fixtures through the installed tarball and
checks each of the four skill harnesses. Pass `npm` to
`bun scripts/testing/smoke-package.ts npm` for a Node/npm consumer install and
`npm exec` check, with the intended Node/npm on PATH. Running package smoke on
Bun 1.3.11 also needs `AGENT_TOOL_TEST_BUN` pointing at the development pin,
since the resolved-update capability requires a newer owning manager even
though its CLI runs on the supported minimum. CI records that executable before
switching runtimes; it does not widen the consumer's production pin.

The `agent:run` and `agent:logs` package scripts run the source CLI's `run` and
`logs` commands. Inspect the runner's bounded failure tail,
`bun run agent:logs <log>`, or targeted searches for warnings, timings, and
required artifacts. A zero exit does not prove an absence of warnings. Keep
review findings, version decisions, and policy diagnostics directly visible.

## Shipping and release

Use the canonical `skills/ship-pr/SKILL.md`, `agent-tool.json`, and source CLI
`bun src/index.ts`. Each shipped root package change prepares a patch bump against
the pinned base. The merge-triggered `Publish npm package` workflow uses
`release plan package.json --github-output` and npm trusted publishing. Verify
the exact merge commit and tarball using:

```sh
bun src/index.ts release verify @a2f0/agent-tool <version> <merge-oid> --workflow 'Publish npm package'
```

The publisher may coalesce pending runs; a consumer waits for the first published
release that actually contains its needed API and checks the tarball before
pinning. Version listing propagation can lag a successful workflow.

Standalone builds remain explicit local artifact operations:

```sh
bun scripts/release/build.ts a2f0/agent-tool
scripts/release/package-deb.sh dist/agent-tool-<version>-linux-x64/bin/agent-tool amd64
```

The manual `Release artifacts` workflow uploads archives, a Homebrew formula,
and Debian packages as workflow artifacts. There is no hosted Homebrew tap or
signed APT repository. To offer `brew install <owner>/<tap>/agent-tool`, host the
archives at the formula's URLs and publish `agent-tool.rb` in that tap. Installing
with `apt install agent-tool` by name requires a signed APT repository; local
packages can be installed with `sudo apt install ./dist/agent-tool_<version>_amd64.deb`.
See [dependency maintenance](dependency-upgrades.md) for upgrades.
