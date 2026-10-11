# Dependency upgrades

Invoke `update-dependencies` in Claude Code, Codex, or OpenCode to inventory and
upgrade package dependencies, runtimes, mise tools, Actions, native toolchains,
Ansible, Terraform providers/modules, and other repository-owned pins. It reads
official migration guides, upgrades coupled dependencies together, resolves
deprecations, and records validated, constrained, and skipped upgrades. It follows
the repository's existing upgrade skills and support policy.

Read-only advisory checks cover baseline and candidate lockfiles, including
resolved transitive and native dependencies. The skill traces findings to their
owning dependency and prefers an upstream-supported fix. A scoped security patch
override requires compatibility evidence, a regression check of the affected
integration, and a documented removal condition; blind audit fixes and blanket
compatibility overrides are excluded. Remaining advisories and audit limits are
reported explicitly. For published packages, the skill also checks tarballs and
consumer installs with their documented supported managers, including override
syntax and runtime requirements.

The skill requires a dry run before any infrastructure mutation, including ones
triggered by hooks or CI on push/merge. Resource destruction or replacement, and
previews that cannot establish safety, skip the affected upgrade group. A Wrangler
bundle dry run alone does not prove remote resource safety. The skill does not
itself authorize deployment or shipping; use `ship-pr` when requested.
For Wrangler, the skill treats remote D1 migration listing as potentially
mutating and holds deployment when a migration is pending or the upload cannot
be proven to match the validated preview artifacts.

For a full refreshed Terraform saved plan, export its private JSON and screen it:

```sh
terraform show -json /private/path/upgrade.tfplan > /private/path/upgrade.json
agent-tool dependencies check-terraform-plan /private/path/upgrade.json
```

The check returns JSON with `ok`, `issues`, and `resourceActions`, and exits 1 for
unsafe or unsupported plans. It rejects delete and replacement actions, unknown
actions, destructive drift, incomplete/deferred plans, unpassed checks, and opaque
provider action invocations. It requires JSON format 1.x and `complete: true`
(available from Terraform 1.8); older plans without completeness evidence fail.
OpenTofu's current JSON format omits `complete` and is not accepted; report that
limitation rather than fabricating the field.
Missing `resource_changes` is valid for a complete empty or output-only plan;
removing an output is not a resource deletion. Invalid JSON fails without echoing
the input. The command never applies or contacts a backend and prints no attribute
values. It cannot establish plan freshness, environment/identity, provider or
provisioner side effects, or authorization; inspect those before deploying and
apply the exact approved saved plan. Keep state and plans out of Git.

## Maintenance records

The [update-dependencies skill](../skills/update-dependencies/SKILL.md) defines
where upgrade information belongs. Each upgrade PR holds its inventory, version
changes, audit and validation results, preview summaries, and skipped work. An
existing sweep issue can hold the repository ledger when the user requested it;
recording evidence does not authorize creating issues.

Maintain current constraints, override rationale, unresolved advisories, and
reusable procedures in an existing maintenance document, or create
`docs/dependency-upgrades.md` when there is substantive guidance to retain.
Include the source and removal or revisit check for each constraint. Read and
reconcile those notes on every upgrade, removing resolved entries and linking
the PR for history. README and AGENTS.md need only a concise link. Full logs,
credentials, state, and plan contents stay out of public records.
