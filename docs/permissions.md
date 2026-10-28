# Permissions

Agents can run without blanket approval (`bypassPermissions` in Claude Code,
`--yolo` in Codex) when routine commands are allowed and the few consequential
ones still ask. agent-tool assigns each of its commands a permission class and
generates harness rules from that table, so the decision is made once, next to
the code, rather than in every harness configuration.

## What the rules protect

The rules keep a cooperating agent from taking a consequential step (merging,
publishing, deploying, adding third-party code, or changing its own permissions)
without the user seeing it first. They are not a sandbox. An allowed command
still runs repository code: tests and tools can do anything their source says,
and an agent that edits that source can change what an allowed command does.
Classes describe agent-tool's own commands and the executables a repository
classifies; they cannot see inside the programs those run. Review
such code like any other change, and keep credentials for consequential systems
out of agent sessions where that matters.

## Classes

| Class | Decision | Commands |
| --- | --- | --- |
| `read` | allow | Context, checks, listings, previews, diagnostics, and logs |
| `local` | allow | `bun install\|update\|remove\|test`, `bun x` for executables classified `local`, `branch create`, `versions`, `images build`, `review`, and applied skill or hook installs |
| `share` | allow | `branch push`, `pr open`, `pr threads reply\|resolve` |
| `release` | ask | `pr merge`, `repo cleanup --apply`, and direct `gh pr merge`, `npm publish`, `bun publish` |
| `intake` | ask | `bun add`, and direct `bun add`, `npm install`, `pnpm add`, `yarn add`, and `bunx`, `bun x`, `npx`, which can download a package |
| `policy` | ask | `permissions install --apply` |
| `exec` | ask | Executables classified `exec`: ones that run whatever file or command they are given |

Legacy action names, such as `squashMerge` and `openPr`, carry the class of the
command they alias. `run` and `run-group` execute arbitrary commands, so they
stay unclassified and keep the harness's default decision; do not add a broad
`agent-tool *` allow rule, which would include them. `src/permissions/catalog.ts` holds the
table; a test checks that every entry names a command the CLI accepts.

The direct package-manager and `gh` spellings are listed so that a raw command
cannot bypass its agent-tool form. They catch the common spellings, not every
alias: `bun install <name>` also adds a package, and asking for it would also
ask for every frozen install. Treat them as a guard rail, not a sandbox.

## Dependency commands

The `bun` commands make the dependency classes enforceable rather than
conventional. They work on the checkout's root package or a declared Bun
workspace, which share the root lockfile; a standalone nested package, which
would get a lockfile of its own, is refused. Each runs the Bun that the nearest
`.mise.toml` pins, from
`$MISE_DATA_DIR/installs/bun/<version>` (default `~/.local/share/mise`), so
agent shells need no `PATH` prefix. When the pinned install is missing, a `bun`
on `PATH` is used only if its version matches the pin (the mise install must
report the pinned version too), and a `bun` inside the
checkout, such as one in `node_modules/.bin`, is never run. Output goes to a private
log, as with `run`, and stdout is one JSON receipt with the resolved Bun, the
per-package changes, and each Bun invocation.

- `bun update <name[@version]>...` changes only dependencies that are already
  declared in `dependencies`, `devDependencies`, or `optionalDependencies`, from
  a registry version to a registry version or tag. It refuses undeclared names,
  workspace, alias, Git, URL, and path sources, packages declared in more than
  one of those sections, and packages named like a workspace, whose new version
  could resolve from the registry instead. Without a version it moves to `latest`, keeping an
  exact pin exact; an explicit version is written as given, exact versions with
  `--exact`. Peer ranges are a
  compatibility contract and are never rewritten.
- `bun remove <name>...` removes only declared names.
- `bun add <name@version>...` adds only names that are not declared, with an
  explicit registry or `workspace:` version. Use `--dev`, `--optional`, or
  `--peer` for one section, and `--exact` to pin exactly.
- `bun install` runs `bun install --frozen-lockfile` and requires an existing
  `bun.lock`, because a first install resolves whatever `package.json` names.

Every command requires an existing lockfile, and `update`, `remove`, and `add`
need the text `bun.lock`, since a binary `bun.lockb` cannot be checked. Before `update`, `remove`, or `add`
changes anything, it runs `bun install --frozen-lockfile --lockfile-only` and
stops if `package.json` declares something the lockfile does not cover, so a
hand-added package cannot be resolved as a side effect of an allowed change. They
also refuse while a version-pinned workspace reference no longer matches its
workspace, since Bun would fetch that name from the registry.
`versions prepare`, which refreshes the lockfile for bumped and new workspace
packages, likewise refuses when any third-party declaration, in any section of
any workspace, or a root catalog, override, or patch differs from what
`bun.lock` records, in either direction for root entries; a new workspace may
use only position-independent third-party specs the lockfile already records
(never a relative `file:` or `link:` source), only `workspace:`
specs count as local, and a dependency on a removed workspace is refused because
it would now resolve from the registry. After bumping, it also refuses when a
version-pinned reference that the workspace satisfied at its locked version no
longer matches it, resolving `catalog:` references through the root catalogs,
whether the bump was committed or prepared, for the same reason. Every other workspace manifest must stay
unchanged too, and no new workspace manifest may appear, so a lifecycle script
cannot edit a sibling package or create one for a later call to resolve.

After each Bun call, the command compares `package.json` with its earlier state. If
Bun changed anything the verb does not allow (another dependency, another
section, any field outside the dependency sections, or a workspace root
manifest, or a lockfile beside any workspace package), or Bun failed, the
command restores `package.json` and the lockfiles and exits 1 with the
violations. A frozen install may change neither file, which
also covers the project's own lifecycle scripts. The files are restored too if
the manifest cannot be read afterward. `node_modules` is not restored; the next frozen
install rebuilds it. Updating a dependency can still bring new transitive
packages; the lockfile diff is where review sees them.

## Tests and executables

```sh
agent-tool bun test --log -- src/app.test.ts
agent-tool bun x biome -- check src
```

`bun test` and `bun x` use the pinned Bun and put its directory first on `PATH`,
so a test or tool that calls `bun` gets the same version. The executable comes
first and options precede `--`, so harness rules can match its name as a
prefix; arguments for the command itself follow `--`. `--log` writes output to a
private log and prints a `run` receipt; without it, output stays visible.

`bun x` runs the package's or root's `node_modules/.bin/<name>` directly, only
when it is an executable file inside this checkout, so neither `PATH` nor Bun's
global cache can stand in for it; only executables that
`permissions.executables` in `agent-tool.json` classifies get a rule; any other
one keeps the harness default. Classify a whole executable by its riskiest
subcommand, and use `exec` for one that runs whatever file or command it is
given, such as `tsx`. While the recorded rules are stale, `bun x` refuses any
executable that is not currently classified as allowed, since an old rule
could still allow one that was reclassified or removed.

```json
{
  "schemaVersion": 1,
  "permissions": {
    "executables": { "biome": "local", "tsc": "read", "wrangler": "release", "tsx": "exec" }
  }
}
```

Package scripts are not classified yet. A script can run anything its commands,
hooks, and the scripts it calls name, and arguments a caller appends can change
what its last command does, so a rule that allowed scripts by default could not
be trusted. `bun run` and `agent:run` therefore keep the harness default.

## Generated rules

```sh
agent-tool permissions show --harness claude
agent-tool permissions install            # preview
agent-tool permissions install --apply
agent-tool permissions check              # CI
```

`install` writes two files and records what it owns in
`.agent-tool-permissions.json`:

- `.claude/settings.json` gains `permissions.allow` and `permissions.ask` entries
  for each class, for the `bun run agent-tool`, `node_modules/.bin/agent-tool`,
  and `agent-tool` spellings. Other settings and rules in the file are kept;
  reinstalling replaces only entries a previous install recorded. A command with
  an `--apply` form is allowed as a preview and asks with `--apply`.
- `.codex/rules/agent-tool.rules` holds prefix rules. Codex applies the most
  restrictive matching rule, so its `prompt` rules also override a broader user
  rule such as `prefix_rule(pattern=["gh"], decision="allow")`. Prefix rules
  cannot match a trailing flag, so a command with an `--apply` form prompts in
  every form. A locally edited rules file is refused rather than overwritten.

The rules take effect only outside bypass modes. Each harness also has limits
that the rules cannot change:

- Claude Code applies project `allow` rules only after the workspace is trusted;
  `ask` rules apply immediately. `ask` rules match past leading variable
  assignments and inside subshells, but an `allow` rule does not match a command
  that starts with an assignment such as `PATH=...`, so invoke agent-tool
  without one. Set `defaultMode` in user settings (project settings ignore
  `auto` and `bypassPermissions`); in `auto` mode, rules are checked before the
  classifier.
- Codex loads `<repo>/.codex/rules/` only when the project's `.codex/` layer is
  trusted. `allow` runs a command outside the sandbox without a prompt, which
  agent-tool's network commands need. A shell script is split into separate
  commands only when it is a plain chain joined by `&&`, `||`, `;`, or `|`;
  redirection (including `2>&1`), substitution, variables, and control flow make
  the whole script one opaque command that prompts.
