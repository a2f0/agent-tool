# agent-tool

A CLI for independent agent code reviews, guarded GitHub PR operations, package
version management, and portable skills for Claude Code, Codex, and OpenCode.

- **Review** a committed branch with a different agent than the one that wrote
  it, using a pinned, read-only snapshot.
- **Ship** pull requests: open them, check CI, and squash-merge only the exact
  reviewed commit.
- **Version** packages: bump changed packages against an exact base and keep
  `bun.lock` in sync.
- **Share skills**: install the same workflow instructions where each harness
  discovers them, and check them in CI.

## Install

### From npm

```sh
bun add --dev --exact @a2f0/agent-tool
# or
npm install --save-dev --save-exact @a2f0/agent-tool
```

The package ships the TypeScript source and embedded skills, with no install
scripts or build step. Bun runs the executable, so Bun must be on `PATH`
wherever it runs, including npm projects and CI; without it, the shell reports
`env: bun: No such file or directory`.

Add a script such as `"agent-tool": "agent-tool"` and run
`bun run agent-tool --help`. For a command with an empty positional argument,
invoke `node_modules/.bin/agent-tool` directly, for example
`node_modules/.bin/agent-tool pr merge '' "$REVIEWED_SHA" "$REVIEW_BASE_REF"`.

To use an unreleased commit, pin its full SHA from GitHub:

```json
{
  "devDependencies": {
    "@a2f0/agent-tool": "github:a2f0/agent-tool#<full-commit-sha>"
  }
}
```

npm records a GitHub dependency in `package-lock.json` as a `git+ssh` URL, but
`npm ci` installs this public repository without SSH credentials.

### Standalone executable

Bun compiles the CLI and its skills into one executable that needs no Node, Bun,
or npm dependencies at runtime:

```sh
bun install --frozen-lockfile
bun run build
./dist/agent-tool --help
```

The executable works when copied anywhere. See [Releases](#releases) for
platform archives, a Homebrew formula, and Debian packages.

### Requirements

- Git.
- An authenticated GitHub CLI (`gh`) for `pr` commands. `pr merge` needs a
  `gh` whose `pr checks` supports `--json`; gh 2.45, still shipped by some
  distributions, fails with `unknown flag: --json`.
- An authenticated CLI for each agent you review with: `claude`, `codex`, or
  `opencode`.
- Bun 1.3.11 or newer to run the npm package.
- Bun 1.4 or newer on `PATH` for `versions prepare`, with either install,
  because it refreshes workspace versions in `bun.lock`.

Run `agent-tool doctor` to report installed versions and the flags the tool needs
from each CLI, such as `gh pr checks --json` for merging, without calling a model.

## Quick start

These examples call `agent-tool` from `PATH`. With the npm package, use
`bun run agent-tool` or `node_modules/.bin/agent-tool` instead.

```sh
# Review the current branch with an independent agent:
agent-tool review codex
# Review another checkout against a local base, without GitHub:
agent-tool --repo ../some-project review opencode high --base main

# Create project policy, then preview and install the shared skills:
agent-tool init
agent-tool skills install
agent-tool skills install --apply
```

## Commands

| Command | Behavior |
| --- | --- |
| `review claude\|codex\|opencode [effort] [--base ref]` | Review committed HEAD using a pinned raw-file snapshot |
| `pr open [title]` | Open a same-repository PR; body from stdin; branch already pushed |
| `pr merge <subject-or-empty> <head-oid> <base-branch>` | Check CI and synchronously squash the reviewed HEAD |
| `versions plan\|bump\|check <base-oid>` | Plan, rewrite, or check package versions against an exact base |
| `versions prepare <base-oid>` | Bump, refresh `bun.lock`, validate, and commit versions; print a JSON receipt |
| `versions resolve-conflicts` | Resolve only version-field conflicts in configured manifests |
| `dependencies check-terraform-plan <json-file>` | Read-only screening for destructive or incomplete Terraform JSON plans |
| `skills list` | List embedded portable skills |
| `skills install [--harness all\|claude\|codex\|opencode] [--apply]` | Preview by default; install or update managed skills |
| `skills check [--harness all\|claude\|codex\|opencode]` | Read-only CI check for current managed skills |
| `init` / `config show` | Create or inspect data-only project policy |
| `doctor` | Inspect local versions and required CLI flags without running a model |

Global options are `--repo <directory>` and `--config <file>`. Effort accepts
`low`, `medium`, `high`, `xhigh`, and `max`; the default is `xhigh` for Claude
and `high` for Codex and OpenCode. Legacy camelCase action names, listed in
`--help`, remain available. Legacy `squashMerge` also accepts a manual form
without a reviewed HEAD; prefer `pr merge`.

A successful review exit means a complete review was returned, ending in a
`VERDICT:` line. BLOCKER or MAJOR findings still require action. The review
command does not repair, push, or merge; the shipping skills coordinate that
work.

## Configuration

`agent-tool init` creates `agent-tool.json` and never overwrites an existing
file. Missing settings use defaults; misspelled keys, invalid types, and unknown
schema versions fail before any work begins. `--config <file>` or
`AGENT_TOOL_CONFIG` selects an explicit policy file, for example to review a
feature checkout with policy from a trusted source.

```json
{
  "schemaVersion": 1,
  "subject": { "conventional": true, "maxLength": 50 },
  "merge": {
    "requiredChecks": [{ "name": "CI gate", "workflow": "CI" }],
    "requireStrictBaseFreshness": true
  },
  "review": {
    "claudeModel": null,
    "codexModel": null,
    "opencodeModel": "deepseek/deepseek-v4-pro",
    "opencodeVariants": { "xhigh": "max" },
    "timeoutMs": 600000
  },
  "versions": {
    "packages": ["packages/api", "packages/client"],
    "bundles": ["packages/client"],
    "lockfile": "bun.lock",
    "validate": [["bun", "run", "lint", "--", "--staged"]],
    "commitMessage": "chore: bump package versions"
  },
  "pr": { "rejectClaudeBranding": true }
}
```

The policy is data only: no commitlint binary or JavaScript config runs.

- **`subject`**: commit and PR titles default to conventional commits with a
  72-character limit.
- **`merge`**: by default a PR must report at least one check, and every check
  must succeed or be skipped. Named required checks must succeed; configure
  them before shipping.
- **`review`**: Claude and Codex use their CLI defaults unless a model is set.
  Set `opencodeModel` to a model your account supports. `opencodeVariants`
  replaces the default effort-to-variant map (`xhigh` to `max`); an effort
  level missing from the map is passed to OpenCode unchanged.

### Versions

Version helpers use the configured package directories, or discover committed
`package.json` workspaces when `versions.packages` is null. `.` names the
repository's root package, which then counts as changed when any file changes,
including files in other configured packages. A changed package moves one patch
past the base; a deliberate major or minor bump is kept. `plan`, `bump`, and
`check` neither regenerate lockfiles nor commit.

`versions.bundles` names versioned packages whose published artifact includes
the workspace packages they depend on. Such a package also counts as changed
when any workspace package it reaches through `workspace:` ranges in
`dependencies` changes, directly or transitively; an alias range such as
`workspace:crypto@*` names its target. `devDependencies` and
`peerDependencies` do not count. A bundled package whose only change is its
version does not move the bundle.

`versions prepare` runs the whole sequence before a review snapshot:

1. It requires a clean worktree on an attached branch with the exact base
   already merged.
2. It rewrites versions and, when `versions.lockfile` is `"bun.lock"` (the
   default), runs `bun install --lockfile-only --ignore-scripts`. It then
   verifies that `bun.lock` records every workspace version, because Bun before
   1.4 exits successfully without refreshing them. Set `versions.lockfile` to
   null for projects without a Bun lockfile.
3. Each `versions.validate` command runs without a shell against the staged
   result. Commands resolve on `PATH` outside the repository.
4. It commits with `versions.commitMessage`, running the project's commit hooks,
   and requires the commit to reproduce the prepared tree.

On success it prints a JSON receipt with `baseOid`, `startHead`, `headOid`,
`committed`, `lockfileChanged`, and the rewritten `versions`. A failure before
the commit restores the manifests, lockfile, and index, unless HEAD or other
paths changed, in which case it leaves that state for inspection. Repeating
against the same base creates no commit.

## Portable skills

Canonical skills live in `skills/`. The build embeds them, and the installer
writes the same bytes where each harness discovers them:

| Target | Project discovery directory |
| --- | --- |
| Claude Code | `.claude/skills` |
| Codex | `.agents/skills` |
| OpenCode alone | `.opencode/skills` |
| All three | `.agents/skills` and `.claude/skills`; OpenCode discovers both |

Discovery paths follow the [Codex](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills),
[Claude Code](https://code.claude.com/docs/en/skills), and
[OpenCode](https://opencode.ai/docs/skills/) documentation. Restart the harness
if new skills do not appear. OpenCode may list identical skills from both
paths.

The bundle provides `cross-agent-review`, `open-pr`, `squash-merge`, `ship-pr`,
`reset`, and `update-dependencies`. They make no package-manager or project-layout
assumptions:

- Keep validation commands, review-bot rules, and deployment checks in the
  project's `AGENTS.md`.
- Keep title and required-check policy in `agent-tool.json`.

The installer is project-scoped and does not touch global harness settings, MCP
configuration, or authentication. It records ownership in
`.agent-tool-skills.json`, previews changes unless `--apply` is given, and
refuses to overwrite unmanaged files, locally edited skills, or symlinks; there
is no force mode. After updating the dependency, run
`agent-tool skills install --apply` and commit the skills with
`.agent-tool-skills.json`. Run `agent-tool skills check` in hooks and CI; it
fails for missing, outdated, unmanaged, or edited skills without writing
anything. Use the same `--harness` for install and check.

### Dependency upgrades

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

## Review guarantees and limits

Reviews run against exact base and head snapshots. Review policy comes from the
base commit. Files are materialized from raw Git blobs with collision and path
validation, and diffs are text-only without external drivers. Snapshots are
cleaned up, output must end in a verdict, and an incomplete but successful run
is retried once. Helper Git operations disable hooks and replace objects.
Reviewer executables must resolve outside the project, reviews time out, and a
review is rejected if HEAD moves before it returns.

Each harness runs with its own read-only protections:

- **Claude**: safe mode and read-only tools.
- **Codex**: an ephemeral session, snapshot-scoped filesystem permissions, no
  inherited environment for model commands, hosted web search disabled, and
  final-message capture.
- **OpenCode**: a neutral directory, pure mode, and inline permissions that
  deny every tool except specific read-only ones.

Unknown or unsupported CLI flags fail the run instead of silently dropping a
protection. These are harness-level protections, not uniform OS isolation:
Claude and OpenCode rely on their own permission implementations, and every
reviewer runs with local authentication in the host environment. A verdict
shows that a review completed, not that its findings are correct.

`pr merge` binds the squash to the reviewed HEAD through GitHub's atomic
expected-HEAD check. GitHub has no equivalent expected-base check, so the skills
recheck the base, and repository protection must enforce stricter freshness.
With `merge.requireStrictBaseFreshness`, `pr merge` refuses unless an active
repository ruleset that the authenticated actor cannot bypass requires strict
status checks on the base. Classic branch protection is not inspected. Reviews
can resolve fork PR bases; `pr open` supports same-repository branches.

## Development

Development and all build/release workflows use Bun 1.4.2 and TypeScript 7.0.2.
The compiler is used through `tsc`; this repository does not depend on its removed
JavaScript compiler API. Runtime consumers still support Bun 1.3.11 or newer;
CI also runs the installed-package smoke and plan-guard tests on that minimum.

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun scripts/smoke-package.ts
bun run build
bun scripts/smoke.ts dist/agent-tool
```

`bun run build` regenerates `src/skills/bundled.ts` from `skills/*/SKILL.md`;
commit it with skill changes. The package smoke test installs the packed npm
tarball into a temporary project. The compiled smoke test drives all three
review adapters through local stubs with Bun and Node absent from `PATH`, and
makes no model calls. CI runs these checks on Linux and macOS and builds a
Debian package on Linux.

## Releases

### npm

`ship-pr` bumps the root `package.json` patch version on each merge, and the
[publish workflow](.github/workflows/npm-publish.yml) publishes each version
newer than npm's `latest` using
[trusted publishing](https://docs.npmjs.com/trusted-publishers), with
provenance and no stored npm token. The publish job runs in the `npm`
environment, which only `main` can deploy to; npm's trusted publisher names
that environment and `npm-publish.yml`. Runs never overlap, and when merges land
together only the newest pending run starts, so intermediate versions may never
reach npm. npm adds a trusted publisher only to an existing package, so the
first version was published by hand; the workflow fails with that instruction
when the package is missing from npm.

### Standalone archives and packages

```sh
# macOS and Linux ARM64/x64 archives, and a Homebrew formula with SHA-256 values:
bun scripts/release.ts a2f0/agent-tool

# A Debian package (Linux with dpkg-deb); substitute the release version:
scripts/package-deb.sh dist/agent-tool-<version>-linux-x64/bin/agent-tool amd64
sudo apt install ./dist/agent-tool_<version>_amd64.deb
```

These scripts only create local artifacts. The manually triggered
`Release artifacts` workflow runs them and uploads the archives, the formula,
and amd64 and arm64 Debian packages as workflow artifacts. To offer
`brew install <owner>/<tap>/agent-tool`, host the archives at the formula's
URLs and publish `agent-tool.rb` in a tap. `apt install agent-tool` by name also
requires a signed APT repository. Neither a tap nor an APT repository exists
yet.

## Further reading

- [Design](docs/design.md): component boundaries and implementation choices.
- [Validation record](docs/validation.md): observed test results and their
  limits.
- [Extraction record](docs/extraction.md): the projects this tool was extracted
  from.
