# agent-tool

A standalone CLI for independent agent reviews, GitHub PR operations, package
version helpers, and portable skills for Claude Code, Codex, and OpenCode.
Extracted from the agent tooling in the projects under `~/github`.

The first implementation retains TypeScript and the existing regression suite.
Bun compiles the code and skill text into one executable, so installed users do
not need Node, Bun, TypeScript, or repository-local npm dependencies. The current
macOS ARM64 executable is approximately 58 MiB because it includes its runtime.
Rust remains a reasonable later implementation choice; it is not required for
Brew or Debian packaging. See [the design](docs/design.md) and
[extraction record](docs/extraction.md).

## Try it

Development and CI use Bun 1.4.2. The source CLI runs on Bun 1.3.11 or newer,
but `versions prepare` needs Bun 1.4 or newer on PATH to refresh workspace
versions in `bun.lock`. Runtime requires Git; GitHub commands also require
authenticated `gh`. Review requires an authenticated CLI for the chosen agent.

```sh
bun install --frozen-lockfile
bun run build
./dist/agent-tool --help
./dist/agent-tool doctor

# Point the installed tool at an existing project:
./dist/agent-tool --repo ../some-project review codex
# Review against an explicit local base without GitHub:
./dist/agent-tool --repo ../some-project review opencode high --base main

# Preview shared skills, then install them when ready:
./dist/agent-tool --repo ../some-project skills install
./dist/agent-tool --repo ../some-project skills install --apply
```

The same binary works when copied outside this repository. No sibling project
has to retain `packages/agent-tool` once its callers are migrated.

### Use as a package dependency

Projects can install the source CLI from npm as `@a2f0/agent-tool`:

```sh
bun add --dev --exact @a2f0/agent-tool
# or
npm install --save-dev --save-exact @a2f0/agent-tool
```

Run `bun run agent-tool --help` after adding a script such as
`"agent-tool": "agent-tool"`. The package exposes
`node_modules/.bin/agent-tool`; invoke it directly for commands containing an
empty positional argument, such as
`node_modules/.bin/agent-tool pr merge '' "$REVIEWED_SHA" "$REVIEW_BASE_REF"`.
The source package includes the CLI and embedded skills and needs no dependency
install scripts or compile step. The executable is TypeScript run by Bun, so Bun
must be on `PATH` wherever it runs, including npm projects and CI; without it,
the shell reports `env: bun: No such file or directory`. The standalone binary
described above remains available for use without Bun.

To use an unreleased commit, pin a full commit SHA from GitHub instead:

```json
{
  "devDependencies": {
    "@a2f0/agent-tool": "github:a2f0/agent-tool#<full-commit-sha>"
  }
}
```

npm records a GitHub dependency in `package-lock.json` as a `git+ssh` URL, but
`npm ci` installs this public repository without SSH credentials.

## Commands

| Command | Behavior |
| --- | --- |
| `review claude\|codex\|opencode [effort] [--base ref]` | Review committed HEAD using a pinned raw-file snapshot |
| `pr open [title]` | Open a same-repository PR; body from stdin; branch already pushed |
| `pr merge <subject-or-empty> <head-oid> <base-branch>` | Check CI and synchronously squash the reviewed HEAD |
| `versions plan\|bump\|check <base-oid>` | Plan, rewrite, or check package versions against an exact base |
| `versions prepare <base-oid>` | Bump, refresh `bun.lock`, validate, and commit versions; print a JSON receipt |
| `versions resolve-conflicts` | Resolve only version-field conflicts in configured manifests |
| `skills list` | List embedded portable skills |
| `skills install [--harness all\|claude\|codex\|opencode] [--apply]` | Preview by default; install or update managed skills |
| `skills check [--harness all\|claude\|codex\|opencode]` | Read-only CI check for current managed skills |
| `init` / `config show` | Create or inspect data-only project policy |
| `doctor` | Inspect local versions and required CLI flags without running a model |

Effort accepts `low`, `medium`, `high`, `xhigh`, and `max`. Defaults are `xhigh`
for Claude and `high` for Codex and OpenCode. Older camelCase action names remain
available; run `--help` for the compatibility list. The modern merge command
requires reviewed HEAD and base branch; legacy `squashMerge` also retains its
manual, unguarded form.

A successful review exit means a complete review was returned, including a
`VERDICT:` line. BLOCKER or MAJOR findings still require action. The review CLI
does not repair, push, or merge; the coordinating skills orchestrate that work.

## Project configuration

Run `agent-tool init` in a project to create `agent-tool.json`. Existing policy
files are never overwritten. Missing settings use defaults; misspelled keys,
invalid types, and unknown schema versions fail before work begins. Global
`--config <file>` or `AGENT_TOOL_CONFIG` selects an explicit policy file, useful
when reviewing a feature checkout with policy supplied from a trusted source.

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
    "lockfile": "bun.lock",
    "validate": [["bun", "run", "lint", "--", "--staged"]],
    "commitMessage": "chore: bump package versions"
  },
  "pr": { "rejectClaudeBranding": true }
}
```

The default title policy uses conventional commits and a 72-character limit.
No commitlint binary or JavaScript config is executed. Required CI names are
project settings; default policy requires reported checks, rejects unsuccessful
checks, and allows intentionally skipped optional jobs. A named required check
must succeed. Configure explicit required names for shipping.

The OpenCode model default preserves the source projects' fallback provider; set
it to a model your account supports. `opencodeVariants` overrides mappings for
the supplied levels, with unspecified entries passed through unchanged. Claude
and Codex use their CLI defaults unless a model is configured.

Version helpers discover committed `package.json` workspaces when
`versions.packages` is null, or use the configured relative package directories;
`.` names the repository's root package, which then changes with any file,
including files in other configured packages.
They preserve deliberate major/minor releases and bump changed packages one
patch past the base. `plan`, `bump`, and `check` do not regenerate lockfiles or
commit changes.

`versions prepare` owns the whole sequence before a review snapshot. It needs a
clean worktree on an attached branch with the exact base already merged. It
rewrites versions and, when `versions.lockfile` is `"bun.lock"` (the default),
runs `bun install --lockfile-only --ignore-scripts`. It then verifies that
`bun.lock` records every workspace version, because Bun before 1.4 exits
successfully without refreshing them. Each `versions.validate` command runs
without a shell against the staged result; commands resolve on PATH outside
the repository. The commit uses `versions.commitMessage` and runs the project's
commit hooks, and must reproduce the prepared tree. Set `versions.lockfile` to
null for projects without a Bun lockfile. On success it prints a JSON receipt
with `baseOid`, `startHead`, `headOid`, `committed`, `lockfileChanged`, and the
rewritten `versions`. A failure before the commit restores the manifests,
lockfile, and index unless HEAD or other paths changed; otherwise it preserves
that state for inspection. Repeating against the same base creates no commit.

## Portable skills

Canonical instructions live once in `skills/`. The build embeds them, and the
installer places the same bytes where each harness discovers them:

| Target | Project discovery directory |
| --- | --- |
| Claude Code | `.claude/skills` |
| Codex | `.agents/skills` |
| OpenCode alone | `.opencode/skills` |
| All three | `.agents/skills` and `.claude/skills`; OpenCode discovers both |

Discovery paths follow the official [Codex](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills),
[Claude Code](https://code.claude.com/docs/en/skills), and
[OpenCode](https://opencode.ai/docs/skills/) documentation. Restart the harness
if new skills do not appear. OpenCode may see identical names through both
compatibility paths; the installed instructions are identical.

The bundle provides `cross-agent-review`, `open-pr`, `squash-merge`, `ship-pr`, and
`reset`. The installer tracks ownership with `.agent-tool-skills.json`, previews
changes without writing, and rejects unmanaged or locally edited files and
symlink destinations. Preserve existing project-specific skills before
migration rather than overwriting them. Project validation and setup commands
stay in repository guidance; the shared skills make no package-manager or
application-layout assumptions. The installer is project-scoped; it does not
modify global harness settings, MCP configuration, or authentication.

To normalize consumers, install the bundled skills and keep project validation,
review-bot rules, and deployment checks in `AGENTS.md`. Put title and required CI
settings in `agent-tool.json` instead of copying the shipping workflow. After a
dependency update, run `agent-tool skills install --apply` and commit the updated
skills with `.agent-tool-skills.json`. Run `agent-tool skills check` in hooks and
CI: it fails for missing, outdated, unmanaged, or locally edited skills without
writing anything. Use the same `--harness` when installing and checking a single
harness. Existing unmanaged skills must be preserved or deliberately migrated
before installation; there is no force-overwrite mode.

## Review guarantees and limits

The extraction retains exact base/head snapshots, base-commit review policy,
raw Git blob materialization, collision/path validation, text diffs without
external drivers, snapshot cleanup, verdict gating, and one retry for incomplete
successful output. Git hooks and replace objects are disabled for helper Git
operations. Reviewer executables must resolve outside the project, and reviews
have configurable timeouts. Modern review rejects HEAD drift before returning.

Claude uses safe mode and read-only tools. Codex uses an ephemeral session,
snapshot-scoped filesystem permissions, no model-command environment
inheritance, disabled hosted web search, and final-message capture. OpenCode uses
a neutral directory, pure mode, inline permissions denying every tool by default,
and specific read-only allowances. Unknown/unsupported CLI flags fail the run;
there is no fallback that silently removes those protections.

These are different harness protections, not a uniform OS isolation guarantee.
Claude and OpenCode rely on their tool permission implementations. The launcher
still uses local authentication and a host environment; the stronger
credential-stripped macOS preflight from `stealth` has not been ported. A verdict
is a completion marker, not proof that a model's findings are correct.

GitHub atomically enforces expected HEAD during merging, but this mutation has
no atomic expected-base precondition. Skills recheck base freshness; repository
protection must enforce stricter concurrent-update requirements. With
`merge.requireStrictBaseFreshness`, `pr merge` refuses unless the base's
effective rules include an active repository ruleset requiring strict status
checks that the authenticated actor can never bypass. GitHub then rejects a
head that no longer contains the latest base. Classic branch protection is not
inspected. Fork reviews
can resolve upstream PR bases; the PR-opening helper initially supports
same-repository branches.

## Packages and verification

```sh
bun run typecheck
bun test
bun scripts/smoke-package.ts
bun run build
bun scripts/smoke.ts dist/agent-tool

# Build macOS/Linux ARM64/x64 archives and a formula with real SHA-256 values:
bun scripts/release.ts a2f0/agent-tool

# On Linux with dpkg-deb; substitute your release version:
scripts/package-deb.sh dist/agent-tool-0.1.0-linux-x64/bin/agent-tool amd64
# Install a produced Debian package:
sudo apt install ./dist/agent-tool_0.1.0_amd64.deb
```

Release scripts create local artifacts; they do not publish anything. Put the
archives at the generated release URLs and the generated `agent-tool.rb` in a
Homebrew tap to support `brew install <owner>/<tap>/agent-tool`. A downloadable
`.deb` supports `apt install ./file.deb`; `apt install agent-tool` by name also
requires hosting a signed APT repository and configuring that source. Neither a
tap nor an APT repository is live yet. The GitHub release workflow builds and
uploads CI artifacts only.

### npm releases

ship-pr bumps the root `package.json` patch version on every merge, and the
[publish workflow](.github/workflows/npm-publish.yml) publishes each version
newer than npm's `latest` with
[trusted publishing](https://docs.npmjs.com/trusted-publishers) and provenance.
No npm token is stored. The job runs in the `npm` environment, which only
`main` can deploy to, and npm's trusted publisher names that environment and
`npm-publish.yml`. A deliberate major or minor bump in a PR is kept. Runs never
overlap, and when merges land together only the newest pending run starts, so
intermediate versions can be skipped on npm.

npm adds a trusted publisher only to a package that already exists, so the
first version was published by hand with `npm publish --ignore-scripts`. Until
a package exists, the workflow fails with that instruction rather than
attempting a publish npm would reject.

Standalone builds use [Bun's executable support](https://bun.sh/docs/bundler/executables).
The compiled smoke test invokes all three adapters through local stubs with Bun
and Node absent from PATH; it makes no paid model calls. CI checks source tests,
type checking, compiled smoke tests, and Debian packaging on Linux, plus source
and compiled checks on macOS.

See [the validation record](docs/validation.md) for observed results and the
limits of the local tests.
