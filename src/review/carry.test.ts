import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { commitAll, FRONTEND, git, mainOid, manifest, mergeMain, read, write } from "../version/version.testUtils";
import { versionPreparationFixture } from "../version/versionPreparation.testUtils";

type Fixture = ReturnType<typeof versionPreparationFixture>;

/** `review carry` against the local `main`, as the base. */
function carry(fixture: Fixture, reviewed: string, head: string, base = "main") {
  const result = fixture.run(["review", "carry", reviewed, head, "--base", base]);
  return { code: result.code, report: JSON.parse(result.stdout) as { ok: boolean; steps: { kind: string; ok: boolean; paths: string[]; reason: string | null }[]; reasons: string[] } };
}

const head = (fixture: Fixture) => git(fixture.rootDir, ["rev-parse", "HEAD"]);

/** A feature branch reviewed after `versions prepare`, then another PR that takes the same version lands on main. */
function reviewedWhileMainMoves(options: { lockfile?: boolean } = {}) {
  const fixture = versionPreparationFixture();
  const { rootDir } = fixture;
  if (options.lockfile === false) {
    write(rootDir, "agent-tool.json", `${JSON.stringify({ schemaVersion: 1, versions: { lockfile: null } })}\n`);
    commitAll(rootDir, "chore: version manifests only");
    git(rootDir, ["branch", "-f", "main", "HEAD"]);
  }
  write(rootDir, "packages/windowing/src/app.ts", "export const feature = 1;\n");
  commitAll(rootDir, "feat: feature");
  expect(fixture.prepare(mainOid(rootDir)).code).toBe(0);
  const reviewed = head(fixture);
  git(rootDir, ["checkout", "-q", "-b", "other", "main"]);
  write(rootDir, "packages/windowing/src/other.ts", "export const other = 1;\n");
  commitAll(rootDir, "feat: other");
  expect(fixture.prepare(mainOid(rootDir)).code).toBe(0);
  git(rootDir, ["checkout", "-q", "main"]);
  git(rootDir, ["merge", "-q", "--ff-only", "other"]);
  git(rootDir, ["checkout", "-q", "feature"]);
  return { fixture, rootDir, reviewed };
}

test("a clean base merge and a version bump carry the review", () => {
  const { fixture, rootDir, reviewed } = reviewedWhileMainMoves();
  expect(read(rootDir, FRONTEND)).toContain('"version": "0.7.102"');
  expect(mergeMain(rootDir)).toBe(0);
  expect(fixture.prepare(mainOid(rootDir)).code).toBe(0);
  expect(fixture.lockVersion("packages/windowing")).toBe("0.7.103");
  const { code, report } = carry(fixture, reviewed, head(fixture));
  expect(report).toMatchObject({ ok: true, reviewedHead: reviewed, head: head(fixture), base: { ref: "main", oid: mainOid(rootDir) }, reasons: [] });
  expect(report.steps.map(step => [step.kind, step.ok, step.paths])).toEqual([["base-merge", true, []], ["versions", true, ["bun.lock", FRONTEND]]]);
  expect(code).toBe(0);
  // Nothing changed is trivially carried.
  expect(carry(fixture, reviewed, reviewed).report).toMatchObject({ ok: true, steps: [] });
  // A bump that leaves the lockfile behind is not what versions prepare commits.
  git(rootDir, ["reset", "-q", "--hard", "HEAD^"]);
  write(rootDir, FRONTEND, manifest("frontend", "0.7.103"));
  commitAll(rootDir, "chore: bump package versions");
  expect(carry(fixture, reviewed, head(fixture)).report.steps[1]).toMatchObject({ kind: "versions", ok: false, reason: "leaves bun.lock recording another version of packages/windowing than its manifest." });
}, 60_000);

test("a version-field conflict resolved by versions resolve-conflicts carries the review", () => {
  const { fixture, rootDir, reviewed } = reviewedWhileMainMoves({ lockfile: false });
  // A third PR took the next version too, so the merge conflicts on the version line.
  git(rootDir, ["checkout", "-q", "main"]);
  write(rootDir, "packages/windowing/src/third.ts", "export const third = 1;\n");
  write(rootDir, FRONTEND, manifest("frontend", "0.7.103"));
  commitAll(rootDir, "feat: third");
  git(rootDir, ["checkout", "-q", "feature"]);
  expect(mergeMain(rootDir)).not.toBe(0);
  expect(fixture.run(["versions", "resolve-conflicts"]).code).toBe(0);
  git(rootDir, ["commit", "-q", "--no-edit"]);
  expect(fixture.prepare(mainOid(rootDir)).code).toBe(0);
  const { code, report } = carry(fixture, reviewed, head(fixture));
  expect(report.steps.map(step => [step.kind, step.ok, step.paths])).toEqual([["base-merge", true, [FRONTEND]], ["versions", true, [FRONTEND]]]);
  expect([code, report.ok]).toEqual([0, true]);
}, 60_000);

test("a conflict resolved by hand outside the version fields needs a new review", () => {
  const fixture = versionPreparationFixture();
  const { rootDir } = fixture;
  write(rootDir, "README.md", "feature\n");
  commitAll(rootDir, "docs: feature readme");
  const reviewed = head(fixture);
  git(rootDir, ["checkout", "-q", "main"]);
  write(rootDir, "README.md", "main\n");
  commitAll(rootDir, "docs: main readme");
  git(rootDir, ["checkout", "-q", "feature"]);
  expect(mergeMain(rootDir)).not.toBe(0);
  write(rootDir, "README.md", "feature and main\n");
  git(rootDir, ["add", "README.md"]);
  git(rootDir, ["commit", "-q", "--no-edit"]);
  const { code, report } = carry(fixture, reviewed, head(fixture));
  expect([code, report.ok]).toEqual([1, false]);
  expect(report.steps).toMatchObject([{ kind: "base-merge", ok: false, paths: ["README.md"], reason: "resolves conflicts outside the versioned manifests by hand: README.md." }]);
  // A clean merge whose tree was changed afterwards is refused too.
  git(rootDir, ["reset", "-q", "--hard", reviewed]);
  expect(mergeMain(rootDir)).not.toBe(0);
  git(rootDir, ["merge", "--abort"]);
  write(rootDir, "README.md", "main\n");
  commitAll(rootDir, "docs: take main's readme");
  const amended = head(fixture);
  expect(mergeMain(rootDir)).toBe(0);
  write(rootDir, "packages/agent-tool/src/app.ts", "export const sneaked = 1;\n");
  git(rootDir, ["add", "-A"]);
  git(rootDir, ["commit", "-q", "--amend", "--no-edit"]);
  expect(carry(fixture, amended, head(fixture)).report.steps).toMatchObject([{ kind: "base-merge", ok: false, reason: "differs from Git's own merge of its parents in packages/agent-tool/src/app.ts." }]);
}, 60_000);

test("a content edit hidden in a version commit needs a new review", () => {
  const { fixture, rootDir, reviewed } = reviewedWhileMainMoves({ lockfile: false });
  expect(mergeMain(rootDir)).toBe(0);
  const merged = head(fixture);
  write(rootDir, FRONTEND, manifest("frontend", "0.7.103"));
  write(rootDir, "packages/windowing/src/app.ts", "export const feature = 2;\n");
  commitAll(rootDir, "chore: bump package versions");
  let { code, report } = carry(fixture, reviewed, head(fixture));
  expect([code, report.ok]).toEqual([1, false]);
  expect(report.steps).toMatchObject([{ kind: "base-merge", ok: true }, { kind: "versions", ok: false, reason: "changes packages/windowing/src/app.ts, which is not a version field." }]);
  // An edit inside a manifest beyond its version field is refused as well.
  git(rootDir, ["reset", "-q", "--hard", merged]);
  write(rootDir, FRONTEND, manifest("frontend", "0.7.103", '\n  "license": "MIT",'));
  commitAll(rootDir, "chore: bump package versions");
  ({ code, report } = carry(fixture, reviewed, head(fixture)));
  expect(report.steps).toMatchObject([{ kind: "base-merge", ok: true }, { kind: "versions", ok: false, reason: `changes ${FRONTEND} beyond its version field.` }]);
  // So is a version that versions prepare would not choose, including a new minor release it would keep.
  for (const version of ["0.7.109", "0.8.0"]) {
    git(rootDir, ["reset", "-q", "--hard", merged]);
    write(rootDir, FRONTEND, manifest("frontend", version));
    commitAll(rootDir, "chore: bump package versions");
    expect(carry(fixture, reviewed, head(fixture)).report.steps[1]).toMatchObject({ kind: "versions", ok: false, reason: expect.stringContaining(`${FRONTEND} at ${version}, not 0.7.103`) });
  }
}, 60_000);

test("a configured merge driver never runs, and a merge that relied on one needs a new review", () => {
  const fixture = versionPreparationFixture();
  const { rootDir } = fixture;
  const marker = `${rootDir}/.git/driver-ran`;
  write(rootDir, ".gitattributes", "README.md merge=custom\n");
  commitAll(rootDir, "chore: merge README.md with a custom driver");
  git(rootDir, ["branch", "-f", "main", "HEAD"]);
  git(rootDir, ["config", "merge.custom.driver", `touch ${marker}`]);
  write(rootDir, "README.md", "feature\n");
  const reviewed = commitAll(rootDir, "docs: feature readme");
  git(rootDir, ["checkout", "-q", "main"]);
  write(rootDir, "README.md", "main\n");
  commitAll(rootDir, "docs: main readme");
  git(rootDir, ["checkout", "-q", "feature"]);
  // The real merge ran the driver, which kept the branch's side.
  expect(mergeMain(rootDir)).toBe(0);
  expect(existsSync(marker)).toBe(true);
  rmSync(marker);
  const { code, report } = carry(fixture, reviewed, head(fixture));
  expect(existsSync(marker)).toBe(false);
  expect([code, report.ok]).toEqual([1, false]);
  expect(report.steps).toMatchObject([{ kind: "base-merge", ok: false, reason: "resolves conflicts outside the versioned manifests by hand: README.md." }]);
  // A driver in inherited command-line configuration, which outranks GIT_CONFIG_COUNT, is disabled too.
  git(rootDir, ["config", "--unset", "merge.custom.driver"]);
  for (const inherited of [{ GIT_CONFIG_PARAMETERS: `'merge.custom.driver'='touch ${marker}' 'merge.renormalize'='true'` }, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "merge.custom.driver", GIT_CONFIG_VALUE_0: `touch ${marker}` }] as Record<string, string>[]) {
    const result = fixture.run(["review", "carry", reviewed, head(fixture), "--base", "main"], rootDir, inherited);
    expect(existsSync(marker)).toBe(false);
    expect(JSON.parse(result.stdout).steps).toMatchObject([{ kind: "base-merge", ok: false }]);
  }
}, 60_000);

test("a merge of a branch the base does not contain needs a new review", () => {
  const fixture = versionPreparationFixture();
  const { rootDir } = fixture;
  const reviewed = head(fixture);
  git(rootDir, ["checkout", "-q", "-b", "side", "main"]);
  write(rootDir, "side.txt", "unreviewed\n");
  const side = commitAll(rootDir, "feat: side work");
  git(rootDir, ["checkout", "-q", "feature"]);
  git(rootDir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "merge", "-q", "--no-edit", "--no-ff", "side"]);
  const { code, report } = carry(fixture, reviewed, head(fixture));
  expect([code, report.ok]).toEqual([1, false]);
  expect(report.steps).toMatchObject([{ kind: "base-merge", ok: false, reason: `merges ${side}, which main (${mainOid(rootDir)}) does not contain.` }]);
}, 60_000);

test("a head that does not descend from the reviewed head needs a new review", () => {
  const fixture = versionPreparationFixture();
  const { rootDir } = fixture;
  write(rootDir, "README.md", "feature\n");
  const reviewed = commitAll(rootDir, "docs: feature readme");
  git(rootDir, ["commit", "-q", "--amend", "-m", "docs: rewritten"]);
  const { code, report } = carry(fixture, reviewed, head(fixture));
  expect([code, report.ok, report.steps]).toEqual([1, false, []]);
  expect(report.reasons).toEqual(["The new head does not descend from the reviewed head, so its history was rewritten (for example by a rebase)."]);
  // Other commits on top of the reviewed head are not carried either.
  git(rootDir, ["reset", "-q", "--hard", reviewed]);
  write(rootDir, "README.md", "more\n");
  commitAll(rootDir, "docs: more");
  expect(carry(fixture, reviewed, head(fixture)).report.steps).toMatchObject([{ kind: "versions", ok: false, reason: "changes README.md, which is not a version field." }]);
  expect(fixture.run(["review", "carry", reviewed, "HEAD"]).stderr).toContain("Usage: agent-tool review carry");
}, 60_000);
