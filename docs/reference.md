# CLI reference

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
- **Render brand images**: build app icons, splash screens, favicons, and store
  graphics from the SVGs in `assets/brand/`, with every size and destination
  declared in `agent-tool.json`.
- **Compact output**: run noisy commands with full private logs and bounded
  diagnostics, keeping routine output out of an agent's context.

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

For repository workflow commands added alongside these interfaces, see
[shared workflows](workflows.md).

| Command | Behavior |
| --- | --- |
| `run [--label text] [--max-bytes N] [--tail-lines N] -- <command> [args...]` | Run with full local logs and compact results; preserve exit status |
| `logs <file> [--max-bytes N] [--tail-lines N]` | Inspect a bounded, terminal-safe tail of a local file |
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
| `images list [target...]` | List the files each image target writes, without rendering |
| `images build [target...] [--out dir]` | Render image targets from `assets/brand/*.svg`; `--out` redirects one target |
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

### Compact command output

```sh
agent-tool run --label tests -- bun test
agent-tool run --label build -- npm run build
agent-tool run --label checks -- sh -c 'npm run lint && npm test'
agent-tool logs /path/from/receipt/output.log --max-bytes 8192 --tail-lines 80
```

`run` executes the argv after `--` directly, without a shell, in the current
directory (or `--repo`), with inherited environment and stdin. Use an explicit
shell only when the command needs shell syntax. The child receives regular files
for stdout and stderr, so interactive/TTY programs should run directly. This
works outside Git and does not depend on project policy or a package manager.
Use it for finite commands; long-running servers need their own lifecycle.

Both streams go directly to one private log: even gigabytes of output do not
accumulate in the runner's memory. On completion, stdout contains one JSON
receipt with `status`, `exitCode`, `signal`, `durationMs`, `outputBytes`, and
`log` (plus an optional label of at most 120 characters). Command arguments and
environment are not copied to the receipt. A success emits no log content;
failure adds a terminal-control-stripped tail on stderr. The default tail is at
most 4096 bytes and 40 lines, with explicit limits up to 65536 bytes and 1000
lines. Limits bound the excerpt after decoding too, including one huge line or
invalid UTF-8; receipt metadata is additional. A command's numeric status is
preserved, missing executables return 127, and other launch failures return 126.
On macOS/Linux, SIGINT, SIGTERM, and SIGHUP are forwarded to the child process
group, with SIGKILL escalation after five seconds; the runner then terminates by
the original signal. Children that create a separate session escape that group;
SIGKILL of the runner cannot be intercepted. The command is not a sandbox.

Logs live in unique `agent-tool-run-*` directories under the system temporary
directory, with mode 0700 directories and 0600 files. They are retained until you
remove the specific directory reported by the receipt or the OS cleans temporary
files. Remove task logs after investigation; long or repeated commands can use
substantial disk space. There is no automatic age sweep or disk quota. Logs are
complete, raw, and may contain secrets; terminal cleanup is not secret redaction.
`logs` reads any explicitly supplied regular local file, including symlink targets;
it does not authenticate a file as an agent-tool artifact.

Use bounded log inspection or scoped searches for a failure, required warnings,
coverage, timing assertions, or build artifacts; do not reread successful suite
logs wholesale. Success means the command exited zero, not that its logs contain
no warnings. Keep structured output and decisions visible: run `review`,
`versions prepare`, audit reports, and infrastructure plan guards directly.
Review commands retain full reviewer stderr in separate private
`agent-tool-review-log-*` directories and show bounded stderr on failure, while
always displaying the final findings and verdict. Empty reviewer logs are removed.
The bundled shipping, review, and dependency skills use this distinction.

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

### Images

`images` declares named targets of brand images rendered from SVG sources in
`assets/brand/`. Each output names its file, pixel size or variants (such as
Android densities or `@2x`/`@3x`), and the layers composed into it:

```json
{
  "schemaVersion": 1,
  "images": {
    "targets": {
      "ios": {
        "dir": "ios/App/Assets.xcassets",
        "outputs": [
          {
            "path": "AppIcon.appiconset/AppIcon.png",
            "size": 1024,
            "opaque": true,
            "layers": [{ "source": "background", "fit": "cover" }, { "source": "logo", "scale": 0.7 }]
          }
        ]
      }
    }
  }
}
```

`agent-tool images build ios` writes PNG, ICO, SVG, and Android color resource
outputs with a bundled WebAssembly renderer, so builds need no ImageMagick or
librsvg and render identically on every machine. See the
[image reference](images.md) for every setting.

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

Invoke `update-dependencies` to upgrade repository-owned dependencies, runtimes,
and tool pins with compatibility checks and safe infrastructure previews.
See the [dependency upgrade guide](dependency-upgrades.md) for advisory
checks, preview limits, the Terraform plan guard, and maintaining upgrade records.

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

See [development guidance](development.md) for the pinned toolchain, source and
script layout, reproducible validation, and generated skill-bundle requirements.

## Releases

See [shipping and release](development.md#shipping-and-release) for npm trusted
publishing, exact-commit/tarball verification, standalone archives, Homebrew formula
and Debian packaging. Artifact workflows do not create a hosted tap or APT repo.

## Further reading

- [Design](design.md): component boundaries and implementation choices.
- [Images](images.md): brand image sources, targets, and output settings.
- [Development](development.md): reproducible validation and release procedures.
- [Extraction record](extraction.md): the projects this tool was extracted
  from.
