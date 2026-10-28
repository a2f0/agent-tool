# Permissions

Agents can run without blanket approval (`bypassPermissions` in Claude Code,
`--yolo` in Codex) when routine commands are allowed and the few consequential
ones still ask. agent-tool assigns each of its commands a permission class and
generates harness rules from that table, so the decision is made once, next to
the code, rather than in every harness configuration.

## Classes

| Class | Decision | Commands |
| --- | --- | --- |
| `read` | allow | Context, checks, listings, previews, diagnostics, and logs |
| `local` | allow | `bun install\|update\|remove\|test`, `bun run` for scripts that do not ask, `branch create`, `versions`, `images build`, `review`, and applied skill or hook installs |
| `share` | allow | `branch push`, `pr open`, `pr threads reply\|resolve` |
| `release` | ask | `pr merge`, `repo cleanup --apply`, release-named scripts, and direct `gh pr merge`, `npm publish`, `bun publish` |
| `intake` | ask | `bun add`, and direct `bun add`, `npm install`, `pnpm add`, `yarn add`, and `bunx`, `bun x`, `npx`, which can download a package |
| `policy` | ask | `permissions install --apply` |
| `exec` | ask | Package scripts that run whatever their arguments name, such as `agent:run` (`agent-tool run`) or a bare `agent-tool` |

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

## Scripts and executables

```sh
agent-tool bun run check --log
agent-tool bun run build --cwd packages/web -- --mode staging
agent-tool bun test --log -- src/app.test.ts
agent-tool bun x biome -- check src
```

`bun run`, `bun test`, and `bun x` use the pinned Bun and put its directory
first on `PATH`, so a script that calls `bun` gets the same version. The script
or executable comes first and options precede `--`, so harness rules can match
the name as a prefix; arguments for the command itself follow `--`. `--log`
writes output to a private log and prints a `run` receipt; without it, output
stays visible, which suits commands whose JSON drives a decision.

`bun run` accepts only scripts declared in the root package or a declared
workspace, never a file path. When arguments follow `--`, it classifies the
script's last command with them appended, following calls into other scripts,
and refuses one that would ask, such as `npm install` given a package name. Most scripts are `local`. A script whose name has
a `deploy`, `publish`, `release`, `destroy`, `apply`, `secret`, `upload`, or
`submit` segment is `release` and asks. So does one whose commands, split at
`&&`, `||`, `;`, `|`, `&`, and newlines and read past leading `NAME=value`
assignments, run an agent-tool command that asks
(in last position, where a caller can append arguments, its stricter form or,
for a partial command such as `agent-tool permissions`, the strictest command it
can become), call a script or executable that asks through `agent-tool bun`, add
or download a package (`intake`, including `bunx`/`npx` without `--no-install`,
dry run or not, judged by the runner's own options), run such a command through
`agent-tool run -- <command>` or a `run-group` plan step (an unreadable plan
asks), or publish, merge, or deploy with `npm`, `bun`, `gh`,
`wrangler`, or `terraform` (`release`; a `--dry-run` is exempt except in last
position, where a caller can append `--dry-run=false`), and one that runs
an asking script with `<manager> run`; a call with arguments to an `exec`
script is classified as the command it expands to, and a called script's own
`pre` and `post` hooks count, or whose `pre` or `post` hook asks, by its
commands or by configuration. Bun appends a script's arguments to its last command, so a script ending
in a bare agent-tool, `agent-tool run` without a `--` command, a bare
`run-group`, or a bare shell or interpreter is `exec`, as is one that ends by
running such a script without arguments; one ending in another bare CLI takes
that CLI's class from `permissions.executables`. In agent-tool's own checkout,
its `bin` source path counts as agent-tool. A script name has one rule across all workspaces, so any
workspace's definition can make it ask. `agent-tool.json` overrides all of
this. `bun x` runs only an executable installed in this checkout's
`node_modules/.bin` (`bun x --no-install`, never Bun's global cache), and only
executables that `agent-tool.json` classifies get a rule; any other one keeps
the harness default.

```json
{
  "schemaVersion": 1,
  "permissions": {
    "scripts": { "build:*": "local", "db:reset": "release" },
    "executables": { "biome": "local", "tsc": "read", "wrangler": "release" }
  }
}
```

An exact script name wins over a `*` pattern, and a longer pattern over a
shorter one. Classify a whole executable by its riskiest subcommand; to allow a
safe subcommand of a risky tool, wrap it in a script. `permissions install`
reads every declared script, so adding one that asks makes `permissions check`
fail until the rules are regenerated.

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
