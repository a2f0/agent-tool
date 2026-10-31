# Shared repository workflows

These commands provide the mechanics used by the portable shipping skills and
repository hooks. Their stdout is JSON; exit zero means the operation or check
succeeded. Mutation commands do not infer authorization. Use the repository's
pinned agent-tool and preserve its validation, review, and deployment policy.

## Branches

```sh
agent-tool branch check "${GITHUB_HEAD_REF:-$GITHUB_REF_NAME}"
agent-tool branch check feat/search chore/cleanup
agent-tool branch check --pre-push < /tmp/push-refs
agent-tool branch create chore/maintenance --base main --remote origin
agent-tool branch status
agent-tool branch push <reviewed-head-oid> --remote origin
```

`check` accepts multiple names and always checks native Git ref validity. Naming
policy is opt-in: adding a `branch` section enables it unless `enforce: false` is
explicit. With no section only Git ref rules apply, preserving existing branch
conventions. Set `enforce: true` when enabling policy in a full `init` config.
With no names it checks the attached branch; detached HEAD is an error,
so CI supplies the actual PR or destination branch without a checkout mutation.
`--pre-push` reads Git's four-field hook stdin, validates every non-deleted
`refs/heads/` destination, and skips tag refs. Preserve stdin in the hook if other
guards also need it. Explicit names work for callers that already parse ref tuples. Policy in `agent-tool.json` is:

```json
{
  "schemaVersion": 1,
  "branch": {
    "types": ["feat", "fix", "chore", "cleanup"],
    "exempt": ["main", "staging"],
    "maxLength": 50
  }
}
```

`types: null` uses `subject.types`. When naming is enabled, defaults are `types: null`, exempt
`main`/`master`, and 72 characters. Set `maxLength: null` for no policy length
cap. List custom default branches explicitly in exemptions. Git restrictions
still apply to exempt names; `feat/foo..bar` and `.lock` segments never pass.
Topics accept lowercase letters, numbers, dots, underscores, dashes, and nested
slash segments.

`create` requires a clean checkout, checks local and remote name collisions,
fetches the selected remote base branch, verifies it did not move, and creates
with `--no-track`. Omit `--base` to use GitHub's discovered default branch.
`--remote` names a configured remote and defaults to `origin`. No automatic
stashing or branch replacement occurs. `push` requires a full expected HEAD,
a clean feature branch, and one explicit remote push destination. It runs normal
Git hooks and verifies local branch, local HEAD, and remote HEAD afterward. A
hook-created commit invalidates the result and requires review. Neither command
uses a force push.

## Commit and binary checks

```sh
agent-tool commits check --range main..HEAD
agent-tool commits check --message-file .git/COMMIT_EDITMSG
agent-tool commits check --range "$local_oid" --exclude "$remote_oid" --exclude-remotes origin
agent-tool checks binaries --staged
agent-tool checks binaries --range main...HEAD
agent-tool checks binaries --all
agent-tool checks binaries --from-upstream
```

Commit checks enumerate the specified revision/range. Repeat `--exclude` to
exclude reachable revisions; `--exclude-remotes <name>` excludes that remote's
tracking refs. A malformed or unavailable revision fails instead of passing an
empty list. Policy is explicit:

```json
{
  "schemaVersion": 1,
  "commits": {
    "signatures": "present",
    "signatureHeaderFallback": false,
    "rejectCoauthors": true,
    "rejectClaudeAttribution": false,
    "subjects": false
  }
}
```

`signatures` defaults to `none`. `present` accepts Git statuses G/U/E/X/Y/R,
rejecting missing or provably bad signatures. `verified` accepts G/U, which
establish cryptographic validity even when the local trust level is unknown.
`signatureHeaderFallback: true` additionally accepts N only when the raw commit
contains a nonempty gpgsig or gpgsig-sha256 header; this preserves existing
presence-only policies on machines without signature verifier configuration.
It never accepts B. Machine-readable commit checks suppress signature display
regardless of `log.showSignature`; signature verification still runs.
`rejectCoauthors` defaults to true and reads Git trailers;
repositories permitting human coauthors can set it false and opt into
`rejectClaudeAttribution`, which rejects Claude/Anthropic attribution lines.
`subjects` opts into the shared subject validator for each commit, stripping the
GitHub PR-number suffix before length checks.
`--message-file` applies the same attribution and optional subject rules to a
commit-msg hook's file; signature policy applies only to existing commits in a
range. It never rewrites messages and does not print message contents.

Subject policy retains `conventional`, `maxLength`, and `types`, with optional
`lowercaseInitial`, `rejectTerminalPeriod`, and `ignoreGenerated` booleans (all
false by default). `ignoreGenerated` exempts Git's Merge/Revert, fixup!, squash!,
amend!, and Initial commit subjects only in `commits check`; human-authored PR
titles always use the full subject policy. These explicit checks do not execute
commitlint configuration; keep any additional project commitlint rules locally.

Binary checks use Git's binary numstat classification and NUL-delimited names,
including rename destinations. Deleted files are excluded. `--all` checks the
entire index; `--staged` checks its delta. The default `--from-upstream` finds
upstream, then `origin/$GITHUB_BASE_REF`, `origin/main`, or local `main`, and
compares the merge base to HEAD. Pass `--range` in CI or hooks when the exact
base is already known. `binaries.allow` is an array of repository-relative Bun
globs, defaulting to empty. Keep existing generated binary allowlists explicit.

## Installed hooks

Keep tracked hooks in `scripts/git/hooks/`, with helpers in their purpose's
script directory. Declare every copied file:

```json
{
  "schemaVersion": 1,
  "hooks": {
    "files": [
      { "source": "scripts/git/hooks/pre-push", "target": "pre-push", "executable": true },
      { "source": "scripts/checks/check-message.ts", "target": "check-message.ts", "executable": false }
    ]
  }
}
```

```sh
agent-tool hooks install
agent-tool hooks install --apply
agent-tool hooks check
# After inspecting an existing installation from a previous installer:
agent-tool hooks install --apply --adopt
```

Installation previews unless `--apply` is given. It copies tracked regular files,
uses `.agent-tool-hooks.json` in the destination to track hashes and ownership,
and rejects locally edited managed files. Unmanaged targets require explicit
`--adopt`; replacements and stale managed removals are backed up in a unique
private directory in the hook directory. Symlinks are backed up as symlinks and
replaced without writing their targets. Only files owned by this installer are
pruned; setting `hooks.files` to an empty array prunes the remaining managed files. Old installers' manifests are not assumed to establish ownership; remove
their stale hooks only after inspecting them separately.

Repository/worktree `core.hooksPath` is honored. An inherited global path is
overridden locally with the common Git directory's hooks, without modifying the
shared global directory. Linked worktrees share the default installation;
relative custom paths require installation in each worktree. Source/destination
overlap and tracked destination files are rejected, and the effective Git hook
path is checked before success. Run documented dependency setup before hooks
installation. Keep hook self-comparison checks when the project requires copied
hooks to refuse stale sources; the installer does not rewrite hook bodies.

## PR context, CI, and feedback

```sh
agent-tool repo context
agent-tool pr context
agent-tool pr checks --wait --head <reviewed-head> --timeout 900 --interval 10
agent-tool pr preflight <reviewed-head> <base-branch> <reviewed-base>
agent-tool pr threads list
agent-tool pr threads reply <comment-database-id> --body-file /tmp/reply.txt
agent-tool pr threads resolve <thread-node-id>
```

Context reports local HEAD, repository identity, PR identity, base branch, and
live base OID. Existing PRs resolve their own base repository, including fork
PRs. Without an open PR, repository context uses its discovered default branch.
`repo context --fetch` additionally fetches the base into a temporary ref and
returns its exact `fetchedBaseOid`; the temporary ref is removed afterward.
Integrate that commit and pin it for review. `liveBaseOid` is a separate current
observation, so a concurrently moving base remains visible.

Checks reuse merge policy and inspect every returned workflow/job/event entry.
No reported checks, missing required checks, and pending jobs keep waiting;
failed jobs fail immediately. Duplicate jobs from push/PR workflows must all
finish. A changed PR HEAD or state fails immediately. Timeout and interval are
seconds (interval 1–60, default 10); `--timeout 0` performs one observation.
Without `--timeout`, the wait is `merge.checksTimeoutSeconds` from
`agent-tool.json`, or 900 seconds when that is unset.
The read-only preflight additionally checks clean local state, exact local/PR
HEAD and branch, OPEN/non-draft/MERGEABLE/CLEAN state, no queued/automatic merge,
unchanged live base, base ancestry, configured strict rulesets, and explicit
package version policy. It returns the checked head/base/PR identifiers. Merge
still uses the existing atomic expected-HEAD mutation; no read-only check can
make GitHub's base comparison atomic.

Thread listing paginates both threads and comments. Replies use the original
review comment's REST `/replies` route after verifying its PR membership;
without `--body-file`, body text comes from stdin. Resolution verifies thread
membership and is idempotent. The command cannot judge whether a finding was
addressed; resolve only fully addressed findings under repository review policy.

## Checkout cleanup

```sh
agent-tool repo cleanup <PR-number> <shipped-head>
agent-tool repo cleanup <PR-number> <shipped-head> --apply
agent-tool repo cleanup <PR-number> <shipped-head> --apply --keep-branch
```

Cleanup previews by default and requires a confirmed MERGED same-repository PR
at the exact shipped HEAD. It preserves dirty or unrelated branches, rejects
local/remote feature branches that moved, fetches the default branch, verifies
it contains the merge commit, and only fast-forwards an existing local default.
`--keep-branch` updates the checkout while preserving both feature refs.
Otherwise it removes the matching local branch, even after a squash merge or
when the remote branch is already absent, and deletes the matching remote ref
through GitHub REST, avoiding pre-push hooks. Local pruning uses the confirmed
PR and exact shipped commit rather than Git's ancestry-based merged-branch test.
If the feature branch is checked out in another worktree, cleanup fails after
updating the default branch and preserves both feature refs. GitHub's DELETE ref
API has no atomic expected-OID argument: the ref is rechecked before deletion,
but a concurrent update between those calls remains a limitation. Cleanup
reports completed steps if a later step fails; `deleted-local-branch` records a
local deletion, while an already absent branch needs no deletion step. Verify the
local feature ref is absent before reporting pruning complete. Dependency/hook
setup and live deployment checks remain repository-specific steps after cleanup. Fork cleanup
requires explicit manual remote handling and is refused by this command.

## Process teardown

```sh
agent-tool proc start --label site -- bun run dev
agent-tool proc list
agent-tool proc stop <id>
agent-tool teardown
agent-tool teardown --apply
```

Work is not finished while it leaves processes running. `proc start` runs a
long-lived command (a dev server, a static server for measurements, a watcher)
in the current directory, in its own process group, with output in a private
`agent-tool-proc-*` log, and records it under the Git common directory
(`agent-tool/processes/`), so every worktree, session and harness of the clone
sees it. It prints a JSON receipt with the record `id`, `pid` and `log`; a
command that exits within its first 300 ms is reported with its exit status, and
one that cannot start returns 127 or 126 without a record. Processes a quickly
exiting command leaves in its group (`sh -c 'server &'`) stay recorded. Children see
`AGENT_TOOL_PROCESS=<id>`. `--keep` marks a process the user asked to keep
running past the work.

`proc list` reads each record against the live process table: `running` while
the leader runs, `orphaned` when only its children remain, `exited`, or
`replaced` when the leader's pid now names a different process (its start time
differs), which is never signalled. Members are the group plus live descendants
that left it; their listening TCP ports come from `lsof`, and zombies count as
exited. `proc start`, `proc stop` and `teardown --apply` remember the members
they see, by pid and start time, so a descendant that left the group is still
stopped after its parent exits. Once the leader has gone, its pid and group id
can be reused, so a member counts only when it was remembered or carries the
record's `AGENT_TOOL_PROCESS`; macOS hides that variable for protected system
binaries. `proc list` and `teardown` without `--apply` write nothing. `proc stop` sends
SIGTERM to the group and to members outside it, SIGKILL after the grace period
(five seconds by default), and removes the record once nothing remains.

`teardown` reports, for the repository holding the working directory:

- `leftover`: recorded processes still running without `--keep`;
- `kept`: those started with `--keep`;
- `finished`: records whose processes have ended;
- `untracked`: other processes whose working directory is inside the
  repository, with their listening ports, excluding agent-tool's own ancestors
  (the harness and shell that ran it) and pipeline siblings that do not listen;
- `worktrees`: worktrees added to the repository, which may need removing;
- `unavailable`: inspections that could not run (`lsof` missing or failing);
- `skipped`: record files that could not be read.

It exits 1 while a leftover runs, an untracked process listens on a port, or an
inspection is unavailable or a record unreadable, since a running process could
then go unseen. `proc start` refuses to start anything when `ps` cannot run.
`--apply` stops leftovers and removes finished records; it never signals
untracked processes or kept ones, and never removes worktrees, since they may be
someone else's. Stop those deliberately, then run `teardown` again. Processes
that change directory out of the repository and leave the recorded group's
process tree after their parent exits are invisible to it. From a matrix-style
workspace, run it per checkout with `--repo <checkout>`.

## CI aggregate gates

The aggregate job must run with `if: always()`. Pass GitHub's `needs` JSON to:

```sh
agent-tool ci gate /tmp/needs.json --policy scripts/checks/ci-gate.json
```

Use `-` for stdin. Without policy every supplied job must succeed and an empty
set fails. A policy can require missing jobs, explicitly permit skipping, and
bind conditional jobs to a successful scope job's exact string output:

```json
{
  "required": ["changes", "lint", "test"],
  "allowSkipped": [],
  "conditional": [
    { "job": "native", "source": "changes", "output": "native" }
  ]
}
```

`true` requires success; `false` requires skipped. Missing/unknown outputs,
failed scope jobs, and incorrectly skipped required jobs fail. Repository path
classification and job selection stay in the repository.

## Release decisions and verification

```sh
agent-tool release plan package.json --github-output
agent-tool release verify @owner/package 1.2.3 <merge-oid> --workflow 'Publish npm package'
```

Plan reads npm's public registry, pins scoped registry resolution too, and
publishes only an unpublished stable x.y.z newer than `latest`. It refuses
private packages unless `--allow-private-source` is explicit. That option supports
private source workspaces whose build generates a publishable consumer manifest;
the repository must still validate the generated package before publishing. It
does not rewrite the source or artifact. Plan requires first publication to be handled explicitly when
no existing registry package is found. `--github-output` appends only
`publish=true|false` to the Actions output file; without it no file is written.
The command does not publish. Install the pinned agent-tool before running it;
agent-tool itself can invoke the source CLI before dependency installation.

Verify waits for the latest workflow run matching the exact merge SHA, then
polls npm for the requested version. A failed publishing workflow fails
immediately; propagation delays keep polling. It verifies package identity,
registry gitHead when present, SHA-512 tarball integrity, and the package.json
inside the tarball. Tarballs must come from HTTPS registry.npmjs.org, are capped
at 100 MiB, and are read with `tar -xzOf` without extraction to disk. `tar` must
be on PATH. Reports include workflow URL and artifact integrity. Timeout and
interval use the same options as PR checks. Project-specific deploy previews,
health checks, trusted-publishing credentials, and release artifacts remain local.

## Durable validation groups

```json
{
  "label": "verify",
  "steps": [
    { "label": "types", "command": ["bun", "run", "typecheck"] },
    { "label": "tests", "command": ["bun", "test"] }
  ]
}
```

Relative run-group plan paths are resolved from the repository root, including
when invoked from a subdirectory; child steps also run from that root.

```sh
agent-tool run-group scripts/testing/verify.json
agent-tool runs list --head <tested-head>
agent-tool runs list --branch chore/maintenance --since 2026-10-01
```

Steps run sequentially through the same private-log runner as `run`, preserving
exit status and hooks. The report records HEAD/tree/branch plus staged, tracked,
and nonignored untracked content fingerprints before/after, monotonic durations,
and per-step log receipts. Every step is recorded as running before launch;
a killed coordinator leaves an incomplete record, never a passed group. A child
signal fails its step and finalizes the group report. Group stdout is one JSON
report containing the per-step receipts. Failure
stops subsequent steps, and source changes invalidate a zero-exit command.
Reports are atomically updated under the common Git directory's
`agent-tool/runs/`, persist across branch cleanup, and are not committed.
Ignored dependencies/build outputs are excluded from source fingerprints. Dirty
submodules are refused because a parent Git diff cannot fingerprint their contents.
Applications must retain richer artifact/test-plan completeness checks; a
process exit alone does not establish that every expected task ran. Reports
and private logs have no automatic pruning; remove inspected local artifacts
when no longer needed.

## Diagnostics

`toolchain check` compares simple numeric `.mise.toml` pins with executables
actually resolved on PATH. It reports expected/resolved/actual versions and
fails unsupported pin syntax instead of claiming compatibility. It does not
install tools or activate mise. Put pinned installations first on PATH.

`policy check` reads classic branch protection and the default branch's effective
rules, then compares required check contexts with `merge.requiredChecks`. It
never changes protection. Workflow names and conditional aggregate dependencies
still require inspection of repository YAML; an API check context alone cannot
prove the workflow-to-job mapping. A classic-protection 404 is reported as absent
or unavailable, while effective rules are queried independently.
