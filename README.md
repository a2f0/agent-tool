# agent-tool

Shared Git, GitHub, review, validation, and release workflows for repositories
coordinated by Claude Code, Codex, and OpenCode. Repository policy stays in
`agent-tool.json`; portable skills coordinate independently reviewed changes.

## Install

```sh
bun add --dev --exact @a2f0/agent-tool
# npm projects also need Bun on PATH to run the executable:
npm install --save-dev --save-exact @a2f0/agent-tool
```

The npm package ships source and embedded skills with no install script. It needs
Bun 1.3.11 or newer; version preparation needs Bun 1.4 or newer. Git is required,
and GitHub operations require an authenticated `gh` supporting `pr checks --json`.
Independent reviews require an authenticated Claude Code, Codex, or OpenCode CLI.
A compiled standalone executable needs no Bun or Node at runtime.

```sh
bun run agent-tool init
bun run agent-tool skills install --apply
bun run agent-tool doctor
```

Add `"agent-tool": "agent-tool"` to package scripts, or invoke
`node_modules/.bin/agent-tool` directly. Use the direct executable for an empty
positional argument. Global `--repo <directory>` and `--config <file>` select a
checkout and explicit policy file. Restart the agent harness after installing
skills if its discovery cache needs refreshing.

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

Use the `ship-pr` skill for the full validation, versioning, independent review,
feedback, merge, cleanup, and deployment workflow. A successful review process
means a complete review was returned; read its final verdict and address blocking
findings before shipping. Pushing and merging remain explicit authorized actions.

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
