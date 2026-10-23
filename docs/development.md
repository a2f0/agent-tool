# Development

Use Bun 1.4.3 from `.mise.toml` and TypeScript from the lockfile. In an agent
shell, prepend `~/.local/share/mise/installs/bun/1.4.3/bin` to PATH; do not run
`mise trust` to activate the checkout. Install with `bun install --frozen-lockfile`.

## Layout

Shared implementation lives under `src/` by domain: `workflows/` for repository
mechanics, `pr/` and `git/` for existing GitHub guards, `release/` for registry
logic, `commands/` for execution receipts, and `review/`, `version/`, `skills/`,
and `images/` for their respective APIs. Tests live beside implementation.

Repository scripts are grouped by purpose: `scripts/build/` generates the skill
bundle, `scripts/testing/` contains installed/compiled package smoke checks,
`scripts/release/` builds distributable artifacts, and `scripts/checks/` contains
the historical extraction inventory helper. Canonical portable skills live in
`skills/`. Do not install generated copies over those sources.

README explains purpose, setup, and normal use. AGENTS.md contains operational
requirements. Reference documents hold reusable command contracts and maintenance
procedures. Run-specific inventories, review findings, timings, and publish
receipts belong in the PR; private logs and generated artifacts remain local.

## Validation

```sh
bun src/index.ts run --label typecheck -- bun run typecheck
bun src/index.ts run --label tests -- bun test
bun src/index.ts run --label package-smoke -- bun scripts/testing/smoke-package.ts
bun src/index.ts run --label build -- bun run build
bun src/index.ts run --label compiled-smoke -- bun scripts/testing/smoke.ts dist/agent-tool
```

Build regenerates `src/skills/bundled.ts`; commit it with canonical skill changes.
The package smoke installs an npm tarball into a temporary project. Compiled
smoke runs all three review adapters through local stubs with Bun and Node absent
from PATH; no live model calls are made. CI runs these checks on Linux/macOS,
tests the minimum supported Bun runtime, and builds Debian packaging on Linux.
Local source integration tests use disposable Git repositories, bare remotes,
and API stubs to check guard behavior without mutating GitHub.

Inspect the runner's bounded log tail or targeted searches for warnings, timings,
and required artifacts. A zero exit does not prove an absence of warnings. Keep
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
signed APT repository. See the [reference](reference.md#releases) for distribution
requirements and [dependency maintenance](dependency-upgrades.md) for upgrades.
