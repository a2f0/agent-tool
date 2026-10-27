# agent-tool

agent-tool is a command-line tool and a set of portable skills for repositories
where Claude Code, Codex, or OpenCode make the changes. It provides shared Git,
GitHub, review, validation, and release workflows: independent agent reviews of
a committed branch, guarded pushes and squash merges of the exact reviewed
commit, package versioning, brand image rendering, and compact output for noisy
commands. Repository policy stays in `agent-tool.json`; the portable skills
coordinate independently reviewed changes.

## Quick start

Install [Bun](https://bun.sh/) 1.3.11 or newer and Git, then in the project that
will use agent-tool:

```sh
bun add --dev --exact @a2f0/agent-tool
bun run agent-tool init
bun run agent-tool skills install --apply
bun run agent-tool doctor
```

Restart the agent harness after installing skills if its discovery cache needs
refreshing.

The npm package ships source and embedded skills with no install script. Bun runs
the executable, so npm projects also need Bun on PATH:

```sh
npm install --save-dev --save-exact @a2f0/agent-tool
```

Version preparation needs Bun 1.4 or newer. GitHub operations require an
authenticated `gh` supporting `pr checks --json`, and independent reviews require
an authenticated Claude Code, Codex, or OpenCode CLI. A compiled standalone
executable needs no Bun or Node at runtime.

Add `"agent-tool": "agent-tool"` to package scripts, or invoke
`node_modules/.bin/agent-tool` directly. Use the direct executable for an empty
positional argument. Global `--repo <directory>` and `--config <file>` select a
checkout and explicit policy file.

## Normal usage

```sh
agent-tool branch create chore/maintenance --base main --remote origin
agent-tool repo context
agent-tool run --label tests -- bun test
agent-tool review claude
agent-tool branch push <reviewed-head> --remote origin
agent-tool pr open 'chore: maintain repository' < /tmp/pr-body.txt
agent-tool pr checks --wait --head <reviewed-head>
agent-tool pr preflight <reviewed-head> <base-branch> <reviewed-base>
agent-tool pr merge 'chore: maintain repository' <reviewed-head> <base-branch>
```

The bundled `ship-pr` skill runs the full validation, versioning, independent
review, feedback, merge, cleanup, and deployment workflow from your agent
harness. The [CLI reference](docs/reference.md#commands) explains what a review
result means, and [shared workflows](docs/workflows.md) describes each
repository command's contract.

## Development

To work on agent-tool itself, install [mise](https://mise.jdx.dev/), then run
from a clone:

```sh
mise install
bun install --frozen-lockfile
bun src/index.ts --help
bun test
```

[Development](docs/development.md) covers the source layout, the full
validation suite, and release procedures.

## Documentation

- [Shared workflows](docs/workflows.md): branches, commit trust, copied hooks,
  PR checks/threads, cleanup, CI aggregate gates, release verification, durable
  validation receipts, and toolchain/protection diagnostics.
- [CLI reference](docs/reference.md): existing review, version, skill installation,
  command capture, configuration, and distribution contracts.
- [Development](docs/development.md): setup, source layout, validation, and release
  procedures for this package.
- [Images](docs/images.md): declarative brand sources and generated outputs.
- [Dependency maintenance](docs/dependency-upgrades.md): active compatibility
  constraints and the dependency-update workflow.
- [Design](docs/design.md) and [extraction history](docs/extraction.md): component
  boundaries, origins, and explicit implementation limits.

The tool does not execute repository JavaScript as policy, bypass Git hooks for
shipping mutations, discard local edits, or silently weaken required CI checks.
Project builds, tests, deployment previews, health checks, and specialized checks
remain repository commands.
