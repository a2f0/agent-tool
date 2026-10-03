# Extraction record

The read-only inventory examined 27 top-level project directories under
`~/github`, found 12 repository-local `packages/agent-tool` implementations,
and found the older `tearleads.old/scripts/agents/tooling/agentTool.ts` lineage.
[inventory.json](inventory.json) records source/skill hashes, checked-out commit
IDs, and tooling working-tree status. Rerun it with:

```sh
python3 scripts/inventory.py ~/github --output docs/inventory.json
```

The inventory reads known tooling/skill locations and skips dependency, build,
and secret directories. The extraction did not modify sibling projects.

| Source | Contribution or observed difference |
| --- | --- |
| `tearleads2` | Primary implementation and regression tests; dynamic workspace discovery and version helpers |
| `tearleads`, `tearleads3`, `tearleads6`, `tearleads7` | Three-reviewer review/PR core and coordinating workflows |
| `tearleads4`, `tearleads5` | Related version-helper variants |
| `commandsnippets` | OpenCode default-deny permissions including MCP tools; different required CI policy |
| `a2f0.net`, `devopsrockstars` | Two-reviewer variants and differing title/CI conventions |
| `stealth`, `stealth2` | More extensive executable/credential trust and macOS sandbox/preflight work; reviewed base/head merge policy |
| `skyline` | Existing shared `.agents` skills with Claude links; project-independent setup assumptions |
| `rn-sandbox`, `tearleads.old` | Additional maintenance and legacy workflows, retained as inventory evidence |

The source of truth was the checked-out source, with its commit and content
hashes recorded, rather than an assumption that similarly named checkouts were
identical. Variants should be compared before future migrations.

## Extracted behavior

The initial portable core retains pinned Git review inputs, raw tracked-file
snapshots, filesystem collision validation, policy from the trusted base,
verdict gating/retry, three reviewer invocations, PR title validation,
subject-only synchronous squash merging, reviewed HEAD enforcement, CI gates,
version planning/bumping/checking, and version-only merge conflict resolution.

Repository policy changes into JSON: title length/types, CI names/workflows,
reviewer models/variants/timeouts, package directories, and optional PR branding
restrictions. The compiled launcher eliminates running a feature checkout's
TypeScript tool package. Helper Git operations disable hooks. Executable lookup
rejects workspace binaries, and modern review checks HEAD after execution.

The five core coordinating skills were rewritten from the existing workflows
into short harness-neutral instructions. They retain reviewed-head identity,
blocking-finding repair/re-review, fallback disclosure, CI/base freshness,
confirmed-merge cleanup, and user-work preservation, while leaving project
validation and setup in repository guidance.

## Deliberately deferred behavior

`prepareVersions` in `tearleads2` and `tearleads4` invokes a Bun install,
repository-specific `lint:source-shape`, and commits version/lockfile changes.
Its initial extracted suite failed five cases under the available Bun 1.3.11
because workspace version bumps did not refresh existing lockfile entries.
This auto-committing helper is not exported here. The non-committing version
helpers are included; callers own package-manager-specific lockfile updates and
validation.

`stealth`'s credential-free preflight, full reviewer credential/environment
allowlisting, and stricter GitHub protection-policy interpretation are not
ported wholesale. Its preflight depends on macOS Seatbelt and trusted local
runtime/library discovery. The first release exposes the actual narrower
harness protections and does not claim equivalent OS isolation.

Application-specific skills such as protocol-security-audit, greenfield-reset,
mobile upgrades, infrastructure bootstrap, and the preen collection remain
project-specific. They can become separate packs later with explicit dependency
and policy contracts. Copying every project skill into a global installation
would preserve application coupling rather than remove it.

The legacy Octokit-based CLI also has a broader GitHub management surface:
issues/sub-issues, labels, review-thread replies/resolution, security alerts,
workflow reruns/cancellation/artifacts, and Gemini review coordination. Those
handlers are inventoried but are not part of this initial review/PR extraction.
They are suitable candidates for a separate GitHub operations module. Its
infrastructure wrappers, editor-title changes, project refresh scripts, and
check-run approval recovery need separate project/operator contracts rather
than becoming implicit steps in the portable review tool.

The source repositories examined did not supply root LICENSE files in the
locations checked. This repo does not select a new public license on the
owner's behalf; release licensing remains a distribution decision.
