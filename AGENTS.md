# Repository guidance

Resolve the GitHub repository with `gh repo view --json nameWithOwner` and use
its reported identity for GitHub commands. Work on a feature branch, use
conventional commits, and preserve unrelated edits. Do not force-push or add
attribution footers. Do not create GitHub issues without an explicit request.

Use the canonical skills in `skills/` to ship this package. Run the source CLI
with `bun src/index.ts`; invoke it directly when passing an empty merge subject.
Project title and required CI policy is in `agent-tool.json`.

Use Bun from `.mise.toml` for development. Agent shells should put the matching
`~/.local/share/mise/installs/bun/<version>/bin` first on `PATH` rather than
running `mise trust`.

Read [development guidance](docs/development.md) for layout, setup, validation,
and release procedures. Shared CLI contracts are in [workflows](docs/workflows.md)
and the [reference](docs/reference.md).

Follow [dependency upgrade guidance](docs/dependency-upgrades.md) for maintenance
records: keep current constraints in dedicated docs and run evidence in the PR;
keep README and this file concise.

Validate changes with `bun run typecheck`, `bun test`,
`bun scripts/testing/smoke-package.ts`, `bun run build`, and
`bun scripts/testing/smoke.ts dist/agent-tool`. The build regenerates embedded skills
from `skills/*/SKILL.md`; commit `src/skills/bundled.ts` with skill changes.
CI also verifies Linux Debian packaging. Preserve the review snapshot,
read-only tool permissions, pinned-base checks, and exact-head merge behavior.

When handling review feedback, reply in its original review thread with
`bun src/index.ts pr threads reply <comment-id> --body-file <file>`, and resolve
only fully addressed findings with
`bun src/index.ts pr threads resolve <thread-id>`. Each merge that bumps the
version deploys it to npm as `@a2f0/agent-tool`; after merging, verify the
"Publish npm package" workflow run for the merge commit and that npm lists the
version.

## Output capture

Run finite, noisy commands, such as installs, builds, tests, linters, and Git
commands that run hooks, through
`bun run agent:run --label <name> -- <command> [args...]`. It keeps complete
output in a private log, preserves the exit status, and prints a compact
receipt, with a bounded excerpt of the log on failure. Read more with
`bun run agent:logs <log-path>`, raising `--tail-lines` or `--max-bytes` as
needed, or with a targeted search of the log. A zero exit does not rule out
warnings: inspect required warnings, timings, and artifacts before accepting a
check. Run reviews, version preparation, audits, infrastructure previews, and
run-group checks directly so their results stay visible, and run interactive
tools and servers directly too. Never narrow a suite or silence warnings to
reduce output.

Both scripts run this checkout's source CLI, `bun src/index.ts run` and
`bun src/index.ts logs`, so they use the harness under development rather than
an installed release. [Development guidance](docs/development.md#validation)
lists each validation check in this form, for example
`bun run agent:run --label tests -- bun test`.
