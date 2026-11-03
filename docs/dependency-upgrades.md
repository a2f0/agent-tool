# Dependency upgrades

Keep the development Bun version in `.mise.toml` aligned with `package.json`'s
`packageManager`. CI installs that pin with mise; its separate minimum-runtime
job continues to check the version in `engines.bun`. Node/npm setup remains
explicit in the trusted-publishing workflow.

Invoke `update-dependencies` in Claude Code, Codex, OpenCode, or Hermes to inventory and
upgrade package dependencies, runtimes, mise tools, Actions, native toolchains,
Ansible, Terraform providers/modules, and other repository-owned pins. It reads
official migration guides, upgrades coupled dependencies together, resolves
deprecations, and records validated, constrained, and skipped upgrades. It follows
the repository's existing upgrade skills and support policy. Dependency-update
execution continues through `ship-pr`: independent review, PR, required CI, merge,
and verification of normal merge-triggered publishing or deployment. Explicit
inventory-only, local-change, or open-PR-only requests keep that narrower scope.
Natural-language requests to update everything use this same shared skill; a
repository-owned `update-everything` wrapper remains authoritative for its extra
steps. See [portable skills](reference.md#portable-skills) for Hermes discovery,
trust, and the distinction between a coordinating harness and a review provider.

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
bundle dry run alone does not prove remote resource safety. The shipping default
does not waive preview gates or authorize standalone infrastructure applies,
deployments, or global tool changes.
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

## Current compatibility constraints

- Keep Bun's minimum runtime at 1.3.11 while version preparation requires 1.4+.
  CI exercises the minimum separately; development-only parallel test flags must
  not reach that job. Revisit the minimum only with a supported-runtime migration
  and package/shared-workflow smoke evidence.
- `@types/node` owns the `undici-types ~8.9.0` range. Bun's wildcard also accepts
  that shared resolution; retain it rather than forcing the newest incompatible
  minor through an override. Refresh through Bun and recheck the owner's range
  when updating `@types/bun` or `@types/node` ([upstream metadata](https://registry.npmjs.org/@types/node/latest)).
- happy-dom owns `entities ^7.0.1`, `whatwg-mimetype ^3.0.0`, and
  `@types/whatwg-mimetype ^3.0.2`. Newer majors are not compatible targets merely
  because they exist. Revisit after an owning happy-dom upgrade permits them,
  with the DOM/gallery tests and final advisory audit
  ([upstream metadata](https://registry.npmjs.org/happy-dom/latest)).

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
