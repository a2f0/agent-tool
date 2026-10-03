# Repository guidance

Resolve the GitHub repository with `gh repo view --json nameWithOwner` and use
its reported identity for GitHub commands. Work on a feature branch, use
conventional commits, and preserve unrelated edits. Do not force-push or add
attribution footers. Do not create GitHub issues without an explicit request.

Use the canonical skills in `skills/` to ship this package. Run the source CLI
with `bun src/index.ts`; invoke it directly when passing an empty merge subject.
Project title and required CI policy is in `agent-tool.json`.

Validate changes with `bun run typecheck`, `bun test`,
`bun scripts/smoke-package.ts`, `bun run build`, and
`bun scripts/smoke.ts dist/agent-tool`. The build regenerates embedded skills
from `skills/*/SKILL.md`; commit `src/skills/bundled.ts` with skill changes.
CI also verifies Linux Debian packaging. Preserve the review snapshot,
read-only tool permissions, pinned-base checks, and exact-head merge behavior.

When handling review feedback, reply in its original review thread through
`POST /repos/{owner}/{repo}/pulls/comments/{comment_id}/replies` and resolve
only fully addressed findings. There is no production deployment for this
package; consumers pin the merged Git commit.
