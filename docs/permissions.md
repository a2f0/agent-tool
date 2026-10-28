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
| `local` | allow | `bun install\|update\|remove`, `branch create`, `versions`, `images build`, `review`, and applied skill or hook installs |
| `share` | allow | `branch push`, `pr open`, `pr threads reply\|resolve` |
| `release` | ask | `pr merge`, `repo cleanup --apply`, and direct `gh pr merge`, `npm publish`, `bun publish` |
| `intake` | ask | `bun add`, and direct `bun add`, `npm install`, `pnpm add`, `yarn add` |
| `policy` | ask | `permissions install --apply` |

`run` and `run-group` execute arbitrary commands, so they stay unclassified and
keep the harness's default decision. `src/permissions/catalog.ts` holds the
table; a test checks that every entry names a command the CLI accepts.

The direct package-manager and `gh` spellings are listed so that a raw command
cannot bypass its agent-tool form. They catch the common spellings, not every
alias: `bun install <name>` also adds a package, and asking for it would also
ask for every frozen install. Treat them as a guard rail, not a sandbox.

## Dependency commands

The `bun` commands make the dependency classes enforceable rather than
conventional. Each runs the Bun that the nearest `.mise.toml` pins, from
`$MISE_DATA_DIR/installs/bun/<version>` (default `~/.local/share/mise`), so
agent shells need no `PATH` prefix. When the pinned install is missing, a `bun`
on `PATH` is used only if its version matches the pin. Output goes to a private
log, as with `run`, and stdout is one JSON receipt with the resolved Bun, the
per-package changes, and each Bun invocation.

- `bun update <name[@version]>...` changes only dependencies that are already
  declared in `dependencies`, `devDependencies`, or `optionalDependencies`, from
  a registry version to a registry version or tag. It refuses undeclared names,
  workspace, alias, Git, URL, and path sources, and packages declared in more
  than one of those sections. Without a version it moves to `latest`, keeping an
  exact pin exact; an explicit version is written as given. Peer ranges are a
  compatibility contract and are never rewritten.
- `bun remove <name>...` removes only declared names.
- `bun add <name@version>...` adds only names that are not declared, with an
  explicit registry or `workspace:` version. Use `--dev`, `--optional`, or
  `--peer` for one section, and `--exact` to pin exactly.
- `bun install` runs `bun install --frozen-lockfile` and requires an existing
  `bun.lock`, because a first install resolves whatever `package.json` names.

After Bun exits, the command compares `package.json` with its earlier state. If
Bun changed anything the verb does not allow (another dependency, another
section, any field outside the dependency sections, or a workspace root
manifest), or Bun failed, the command restores `package.json` and the lockfile
and exits 1 with the violations. A frozen install may change neither file, which
also covers the project's own lifecycle scripts. The files are restored too if
the manifest cannot be read afterward. `node_modules` is not restored; the next frozen
install rebuilds it. Updating a dependency can still bring new transitive
packages; the lockfile diff is where review sees them.

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
