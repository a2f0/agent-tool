# Shared repository workflows

These commands provide the mechanics used by the portable shipping skills and
repository hooks. Their stdout is JSON; exit zero means the operation or check
succeeded. Mutation commands do not infer authorization. Use the repository's
pinned agent-tool and preserve its validation, review, and deployment policy.

Commands act on the repository Git finds from the working directory. Git
skips a `.git` it cannot open, such as an unreadable one or one missing `HEAD`,
and searches upward, so a checkout nested in another repository (a workspace's
`checkouts/<name>`) would resolve to the outer one. When a directory between
the resolved top level and the working directory has its own `.git`, commands
that read repository identity (`release verify` and every command that runs at
the checkout root) fail instead; rerun once the nested checkout is readable.

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
installation. The installer does not rewrite hook bodies. A push gate's `hooks
check` guard refuses a stale installed copy, which replaces the `cmp -s "$0"`
self-comparison hand-written hooks carried.

## Push gates

A push gate is the repository's `pre-push` hook, declared rather than written:
the hook body is one canonical file, and what it runs is data in
`agent-tool.json`. Pushing runs trust guards and quick static analysis only;
CI runs the tests and builds and is the authority. A CI failure is fixed with a
follow-up commit on the same branch.

```json
{
  "schemaVersion": 1,
  "hooks": {
    "files": [{ "source": "scripts/git/hooks/pre-push", "target": "pre-push", "executable": true }]
  },
  "pushGate": {
    "steps": [
      { "label": "lint", "command": ["bun", "run", "lint"] },
      { "label": "typecheck", "command": ["bun", "run", "typecheck"] },
      { "label": "models", "command": ["bun", "run", "check:models"], "allowSlow": "no CI job runs the model checks yet" }
    ],
    "budgetSeconds": 60
  }
}
```

- `steps` take run-group's step shape: a unique `label` of 1–120 characters
  and a nonempty `command` argv, run without a shell from the repository root.
  `allowSlow` is an optional, nonempty reason that lets `push-gate check`
  accept a step that runs tests or installs dependencies, so each exception is
  visible in review. Absent `steps` means none.
- `budgetSeconds` is a positive integer, default 120.
- Without a `pushGate` section the repository declares no gate.

```sh
agent-tool push-gate hook > scripts/git/hooks/pre-push
agent-tool hooks install --apply
agent-tool push-gate check
```

`push-gate hook` prints the one canonical hook body. Commit it byte for byte as
`scripts/git/hooks/pre-push`, keep it in `hooks.files` so `hooks install
--apply` copies it, and regenerate it when an agent-tool release changes it
(`push-gate check` says so). The body finds the repository root, takes `bun`
from `PATH` or else from `mise which bun` (GUI Git clients start hooks without
mise's shims), and otherwise explains what to install and exits 1. It then
runs `exec "$bun" "$root/node_modules/@a2f0/agent-tool/src/index.ts" push-gate
run --pre-push "$@"`, passing Git's stdin through.

`push-gate run --pre-push <remote> <url>` reads Git's four-field stdin once,
refuses a terminal stdin, and unsets Git's local environment variables
(`git rev-parse --local-env-vars`, such as `GIT_DIR` and `GIT_INDEX_FILE`)
after resolving the repository root, so steps that build fixture repositories
do not act on this one. It then runs, in order:

1. The built-in guards, from the same implementations as the standalone
   commands: `hooks check`; `skills check` and `permissions check` when
   `.agent-tool-skills.json` or `.agent-tool-permissions.json` exists, for
   the harnesses their manifests record; `branch check --pre-push`; and, for
   every pushed ref that is not a deletion, `commits check` and `checks
   binaries` over the commits that push adds. Every guard runs and reports;
   any failure refuses the push before a declared step starts.
2. The declared `steps`, through the run-group runner with the label
   `push-gate`, so every push leaves a source-bound report with per-step
   durations in `agent-tool runs list`. A failing step refuses the push with
   that step's exit status. A push that only deletes refs skips the steps.
3. A budget check: when the whole gate took longer than `budgetSeconds`, it
   warns on stderr with the three slowest steps and says to move them to CI.
   The warning never changes the exit status.

The commits a ref adds exclude the remote's old tip when this clone has that
commit, and that named remote's tracking refs (`--remotes=<remote>`), so
unsigned work committed on local `main` cannot ride along on a new branch. A
push to a URL, which names no remote, or over an advertised tip this clone
never fetched, scans the whole branch instead of subtracting some other
remote's refs: refusing a commit already published elsewhere is noise, while
letting one through is the failure that matters. Binaries are checked per
commit against its parent; a merge counts only paths that differ from every
parent, so a binary a merged base already carried is not charged to the push.

Steps check the working tree. CI is the authority, so the gate does not refuse
a push whose pushed commit is not the checked-out HEAD, or whose tree has
uncommitted or untracked changes; it warns that the steps checked something
other than what the push sends, and records it under `worktree`.

Steps that need the push itself, such as a per-commit message linter or a
changed-path classifier, read `AGENT_TOOL_PUSH_GATE`, the path of a private
JSON file that exists while the steps run:

```json
{
  "schemaVersion": 1,
  "remote": { "name": "origin", "url": "git@github.com:owner/repo.git" },
  "headOid": "<checked-out HEAD>",
  "worktreeMatchesPush": true,
  "refs": [
    {
      "localRef": "refs/heads/feat/x",
      "localOid": "<pushed oid>",
      "remoteRef": "refs/heads/feat/x",
      "remoteOid": "<remote's old oid, or zeros for a new ref>",
      "deleted": false,
      "scan": "new-on-remote",
      "reason": "New on the remote; excludes origin's tracking refs.",
      "revisions": ["<pushed oid>", "--not", "--remotes=origin"],
      "commits": ["<newest added commit>", "..."],
      "base": "<oid or null>",
      "range": "<base>..<pushed oid>"
    }
  ]
}
```

`remote.name` is null for a push to a URL. `scan` is `since-remote-tip`,
`new-on-remote`, `whole-branch`, or `deleted`; `reason` explains it.
`revisions` are the `git rev-list` arguments that select exactly the added
commits, and `commits` lists them newest first (empty for a deletion, or for a
push of commits the remote already has). `base` is the remote's old tip when
this clone has it, else the newest commit the destination already has when
there is exactly one (a branch that merged the moving base gets that base's
tip), else null for a whole-branch scan; `range` is `<base>..<localOid>`, or
just `localOid` when `base` is null, so tools that take a revision range or a
diff base can use it directly. Deleted refs keep `deleted: true` with no range.

The command prints one JSON report: `ok`, `remote`, `refs` (as above with
`commits` reduced to a count), `guards` (each with `name`, an optional `ref`,
`ok`, `durationMs`, and `details` or `error` when it failed), `steps` (null
when none ran, else the run-group `report` path, `status`, `durationMs`,
`error`, and each step's `label`, `status`, `durationMs`, and `log`),
`worktree`, `budget` (`seconds`, `elapsedMs`, `exceeded`, and the `slowest`
steps), `notes`, and `warnings`. Failures and warnings are also written to
stderr as `push-gate:` lines.

`push-gate check` is read-only, for CI and workspace audits. It fails when:

- `scripts/git/hooks/pre-push` is tracked but there is no `pushGate` section,
  or the section exists but the hook is not tracked;
- the tracked hook is not byte-identical to `push-gate hook`'s output;
- `hooks.files` does not install it as an executable `pre-push`;
- a step resolves to a test run or a dependency install and has no
  `allowSlow`, or names a run-group plan that cannot be read.

A repository with neither a section nor a tracked hook passes with a note that
it has no gate. Steps are resolved through `bun run`, `npm run`, `pnpm run`,
and `yarn` package scripts (with their `pre` and `post` scripts and appended
arguments), recursively, splitting shell strings at `&&`, `||`, `;`, `|`,
`&`, and newlines and following `cd`; through `sh -c` and `bash -c`; through
`bunx`, `npx`, `bun x`, and `agent-tool run -- <command>`; and through
`agent-tool run-group <plan>` plans. Workspace filters (`--filter`, `-r`,
`--workspace`) resolve to every workspace package that declares the script.
Test runs are `bun test`, `jest`, `vitest`, `mocha`, `ava`, `playwright
test`, `maestro`, `detox`, `node --test`, `pytest`, `python -m pytest`,
`rspec`, `go test`, `cargo test`, `deno test`, `swift test`, `xcodebuild
test`, Gradle `test` tasks, and `turbo` or `turbo run` with a task named
`test*`. Installs are `bun install|add|update|remove`, `npm
install|ci|update`, `pnpm install|add|update`, `yarn` alone or `yarn
install|add|up`, `agent-tool bun install`, and `pod`, `bundle`, or `pip
install`. Executables and script files are leaves: their contents are not
inspected. The report is:

```json
{
  "ok": false,
  "hook": { "path": "scripts/git/hooks/pre-push", "tracked": true, "canonical": true, "installed": true },
  "pushGate": { "declared": true, "budgetSeconds": 60 },
  "steps": [
    {
      "label": "check", "command": ["bun", "run", "check"], "allowSlow": null, "ok": false,
      "findings": [{ "kind": "test", "runner": "vitest run", "chain": ["bun run check", "package.json scripts.check: bun run lint && bun run test", "package.json scripts.test: vitest run", "vitest run"] }],
      "errors": []
    }
  ],
  "errors": ["Step 'check' runs a test run (vitest run): bun run check -> ... -> vitest run. Move it to CI, or give the step an allowSlow reason."],
  "notes": []
}
```

`canonical` is null when no hook is tracked. Findings of a step with
`allowSlow` are still listed, with that step's `ok` true.

## PR context, CI, and feedback

```sh
agent-tool repo context
agent-tool repo base-health
agent-tool pr context
agent-tool pr checks --wait --head <reviewed-head> --timeout 900 --interval 10
agent-tool pr cancel-runs --head <superseded-head>
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
`agent-tool.json`, or 900 seconds when that is unset. Each `gh` or `git` call
during a wait may run for the time left before the deadline, but at least 15
and at most 120 seconds; a call that runs longer is stopped and fails the wait,
so a hung call ends it instead of keeping it running forever.

Every observation also compares the head with the live tip of the PR's base
branch through GitHub's compare API, asking again only after the base moves,
and reports it as `behind` and `base` (`branch`, `liveOid`, `behindBy`,
`behind`). The base branch is reread each time, so a retargeted PR is compared
with its new base. A moved base is reported, not acted on: the wait continues
on the head's checks and passes when they are green. Integrate the base only
when GitHub reports a conflict, when `versions check` fails against the live
base, or when the repository opts in with `merge.requireStrictBaseFreshness`.
Under that policy a head that lacks the live base cannot ship as reviewed, so
waiting stops at once with `behind: true`, `ok: false`, a `reason`, and exit
status 1, whatever the checks show; `--allow-behind` then keeps waiting and
passes on green checks, still reporting `behind`.

`pr cancel-runs --head <oid>` cancels the queued and in-progress GitHub Actions
runs of that commit on the PR's branch, reporting each as `cancelled`,
`finished` (it completed first), or `failed` (exit status 1). It cancels the
PR's current head only under `merge.requireStrictBaseFreshness` and only while
that head is behind its live base; otherwise the current head can still merge,
so it never loses its CI. Same-repository PRs only; a commit with 1,000 or
more runs is refused rather than partly cancelled.
The read-only preflight additionally checks clean local state, exact local/PR
HEAD and branch, OPEN/non-draft/MERGEABLE/CLEAN state (a conflict,
`CONFLICTING` or `DIRTY`, says to integrate the base; `UNKNOWN` is reread for
up to ten seconds while GitHub computes it), no queued/automatic merge, that
the reviewed head contains the reviewed base, passing checks, and explicit
package version policy. A base that moved since review is acceptable: the
reviewed head stays bound through `expectedHeadOid`, and when
`versions.packages` is configured the versions must still be current against
the live base, which preflight fetches, because two merges that take the same
version merge cleanly but the second cannot publish. With
`merge.requireStrictBaseFreshness` the live base must equal the reviewed base
and configured strict rulesets are checked, as before. Preflight returns the
checked head/base/PR identifiers with `liveBaseOid`, `baseMoved`, and
`strictBaseFreshness`. `pr merge` runs the same preflight itself before
sending the merge, against the base branch it fetches at that moment, so a
skipped, failed, or stale preflight never leads to a merge; under the strict
policy the head must contain that fetched base. Merge still uses the existing
atomic expected-HEAD mutation; no read-only check can make GitHub's base
comparison atomic, and without the strict policy none is needed. Neither preflight nor merge gates on unresolved review threads: declined findings stay unresolved by policy, so read them with
`pr threads list`.

Thread listing paginates both threads and comments. Replies use the original
review comment's REST `/replies` route after verifying its PR membership;
without `--body-file`, body text comes from stdin. Resolution verifies thread
membership and is idempotent. The command cannot judge whether a finding was
addressed; resolve only fully addressed findings under repository review policy.

## Default-branch health

```sh
agent-tool repo base-health
agent-tool repo base-health --branch release --limit 50
agent-tool --repo checkouts/project repo base-health
```

With base freshness opt-in, two PRs that each passed CI can break the default
branch together, so shipping starts by reading its CI. `repo base-health` reads
GitHub only and runs nothing locally. `--branch` defaults to the repository's
default branch; `--limit` (1–100, default 30) is how many of the branch's most
recent push-triggered workflow runs it reads, and also caps the merges listed
in the breaking range and the merged and open PRs it reads. Each call is one
page, so a report takes a bounded number of GitHub calls: the tip, the runs,
the tip's check runs when `merge.requiredChecks` is set, and, only when red,
the failing runs' jobs, one comparison, and two PR listings.

It prints one JSON report and exits 0 whatever the status:

```json
{
  "repo": "owner/repo",
  "branch": "main",
  "status": "red",
  "tip": { "oid": "<live tip>", "hasRuns": true },
  "inProgress": false,
  "workflows": [
    { "name": "CI", "runId": 300, "url": "...", "headOid": "<tip>", "onTip": true, "status": "completed", "conclusion": "failure", "outcome": "failing" }
  ],
  "requiredChecks": [
    { "name": "verify", "workflow": "CI", "outcome": "failing", "conclusion": "failure", "url": "..." }
  ],
  "failingJobs": [
    { "workflow": "CI", "runId": 300, "runUrl": "...", "headOid": "<tip>", "job": "verify", "jobId": 31, "url": "...", "conclusion": "failure" }
  ],
  "lastGreen": { "oid": "<last commit where the failing workflows passed>", "workflows": ["CI"] },
  "breakingRange": {
    "from": "<lastGreen.oid>", "to": "<tip>", "truncated": false,
    "merges": [{ "oid": "<commit>", "subject": "feat: two (#8)", "pr": { "number": 8, "title": "feat: two", "url": "...", "headOid": "<PR head>" } }]
  },
  "openRepairs": [{ "number": 9, "title": "fix: repair verify", "url": "...", "references": ["300"] }],
  "limit": 30,
  "notes": []
}
```

`status` is closed: `red` when any workflow's latest run or any required check
on the tip failed (any conclusion other than success, skipped, or neutral,
including cancelled and timed out); otherwise `no-ci` when no push-triggered
workflow ran on the branch within the window, so the repository lacks CI on
pushes to it; otherwise `pending` while a run or required check is unfinished;
otherwise `green`. Each workflow is represented by its latest push run on the
branch, `onTip` saying whether that run is on the tip: a merge that path
filters skip neither hides nor clears a failure, and `tip.hasRuns` false says
the tip's runs have not started or were skipped. A required check absent from
the tip, such as a PR-only job, is `missing` and decides nothing.

When red, `failingJobs` lists each failing job with its run and job links, and
a failing required check outside those runs by its own link. `lastGreen` is the
oldest of the failing workflows' last passing runs in the window, so
`breakingRange` covers every one of them: each commit from there to the tip,
oldest first and at most `--limit`, with the PR that merged it, matched by
merge commit or else by its `(#123)` or merge-commit subject. Without a
passing run in the window both are null and a note says to raise `--limit`.
`openRepairs` lists open PRs whose title or body cites a failing run or job id,
so a second session finds a repair already under way; a repair PR names the
failing run in its body for that reason.

## Checkout cleanup

```sh
agent-tool repo cleanup <PR-number> <shipped-head>
agent-tool repo cleanup <PR-number> <shipped-head> --apply
agent-tool repo cleanup <PR-number> <shipped-head> --apply --keep-branch
```

Cleanup previews by default and requires a confirmed MERGED same-repository PR
at the exact shipped HEAD. It refuses a PR whose head is the default branch or
a `branch.exempt` branch, since those are shared rather than feature branches;
that guard is why the `--apply` form runs without approval (class `share` in
[permissions](permissions.md)). It preserves dirty or unrelated branches, rejects
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
command that exits within its first 300 ms is reported with its exit status (or
`signal`, exiting 128 plus its number), and
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
record's `AGENT_TOOL_PROCESS`, even if it detached after the initial snapshot;
macOS hides that variable for protected system binaries. `proc list` and
`teardown` without `--apply` write nothing. `proc stop` sends
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
someone else's. Stop those deliberately, then run `teardown` again. An unrecorded
descendant that outlives its parent, leaves the group, and clears or hides its
ownership tag cannot be recovered by ownership inspection. If it also changes
out of the repository, cwd inspection cannot report it either. From a matrix-style
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
immediately; propagation delays keep polling, including a listed version whose
tarball still returns 404 or 410, and time out with the last reason. It verifies package identity,
registry gitHead when present, SHA-512 tarball integrity, and the package.json
inside the tarball. Tarballs must come from HTTPS registry.npmjs.org, are capped
at 100 MiB, and are read with `tar -xzOf` without extraction to disk. `tar` must
be on PATH. Reports include workflow URL and artifact integrity. Timeout and
interval use the same options and per-call limits as PR checks; without
`--timeout` it waits 3600 seconds, since publishing runs can take most of an
hour before npm propagation. Project-specific deploy previews,
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
SIGINT, SIGTERM, or SIGHUP to the coordinator is forwarded to the running step,
starts no further step, and finalizes the report as failed (`Interrupted by
<signal>.`) before the coordinator terminates by that signal. A signal handled
after the group has finished changes neither its report nor its exit status. A SIGKILLed
coordinator leaves an incomplete record, never a passed group. A child
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
