import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkSkillLinks, claudeConfigDirectories, linkSkills, planSkillLinks, skillSource, userSkillDirectories } from "./link";

const roots: string[] = [];
/** Real paths, since macOS temporary directories sit behind a `/var` link. */
function temporary(): string { const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agent-tool-link-"))); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function skill(directory: string, name = path.basename(directory)): string {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: A test skill.\n---\n\n# ${name}\n`);
  return directory;
}

/** A repository with one repository-owned skill and one managed skill installed for both harnesses. */
function repository(): string {
  const root = temporary();
  skill(path.join(root, "skills/space-cleanup"));
  skill(path.join(root, ".claude/skills/explicit-state-machines"));
  skill(path.join(root, ".agents/skills/explicit-state-machines"));
  return root;
}
const NAMES = ["space-cleanup", "explicit-state-machines"];

/** A home with `~/.claude` and a provisioned `~/.claude2` holding only a linked `settings.json`. */
function home(): string {
  const directory = temporary(), dotfiles = temporary();
  mkdirSync(path.join(directory, ".claude"));
  mkdirSync(path.join(directory, ".claude2"), { mode: 0o700 });
  writeFileSync(path.join(dotfiles, "settings.json"), "{}");
  symlinkSync(path.join(dotfiles, "settings.json"), path.join(directory, ".claude2/settings.json"));
  return directory;
}

const summary = (changes: { directory: string; skill: string; status: string }[], base: string) => changes.map(change => `${path.relative(base, change.directory)} ${change.skill} ${change.status}`);

describe("Claude Code config directory discovery", () => {
  test("finds CLAUDE_CONFIG_DIR, ~/.claude, and marked .claude directories, never files or unmarked ones", () => {
    const directory = home(), elsewhere = temporary();
    mkdirSync(path.join(directory, ".claude-work"));
    writeFileSync(path.join(directory, ".claude-work/.claude.json"), "{}");
    mkdirSync(path.join(directory, ".claude-empty"));
    writeFileSync(path.join(directory, ".claude-empty/notes.txt"), "no markers");
    writeFileSync(path.join(directory, ".claude.json"), "{}");
    writeFileSync(path.join(directory, ".claude.json.backup"), "{}");
    mkdirSync(path.join(directory, "claude3"));
    writeFileSync(path.join(directory, "claude3/settings.json"), "{}");
    mkdirSync(path.join(directory, ".config"));
    writeFileSync(path.join(directory, ".config/settings.json"), "{}");
    const at = (...names: string[]) => names.map(name => path.join(directory, name));
    expect(claudeConfigDirectories({ HOME: directory })).toEqual(at(".claude", ".claude-work", ".claude2"));
    expect(claudeConfigDirectories({ HOME: directory, CLAUDE_CONFIG_DIR: "" })).toEqual(at(".claude", ".claude-work", ".claude2"));
    // CLAUDE_CONFIG_DIR comes first and needs no markers; one that does not exist adds nothing.
    mkdirSync(path.join(elsewhere, "custom"));
    expect(claudeConfigDirectories({ HOME: directory, CLAUDE_CONFIG_DIR: path.join(elsewhere, "custom") })).toEqual([path.join(elsewhere, "custom"), ...at(".claude", ".claude-work", ".claude2")]);
    expect(claudeConfigDirectories({ HOME: directory, CLAUDE_CONFIG_DIR: path.join(elsewhere, "absent") })).toEqual(at(".claude", ".claude-work", ".claude2"));
    // CLAUDE_CONFIG_DIR naming a discovered directory, or a link to one, counts it once, in its first place.
    expect(claudeConfigDirectories({ HOME: directory, CLAUDE_CONFIG_DIR: path.join(directory, ".claude2") })).toEqual(at(".claude2", ".claude", ".claude-work"));
    symlinkSync(path.join(directory, ".claude2"), path.join(directory, ".claude3"));
    expect(claudeConfigDirectories({ HOME: directory })).toEqual(at(".claude", ".claude-work", ".claude2"));
    // ~/.claude counts only when it exists.
    rmSync(path.join(directory, ".claude"), { recursive: true });
    expect(claudeConfigDirectories({ HOME: directory })).toEqual(at(".claude-work", ".claude2"));
  });

  test("user skill directories start with ~/.agents/skills and count a linked skills directory once", () => {
    const directory = home();
    expect(userSkillDirectories({ HOME: directory })).toEqual([
      { harness: "agents", directory: path.join(directory, ".agents/skills") },
      { harness: "claude", directory: path.join(directory, ".claude/skills") },
      { harness: "claude", directory: path.join(directory, ".claude2/skills") },
    ]);
    mkdirSync(path.join(directory, ".claude/skills"));
    symlinkSync(path.join(directory, ".claude/skills"), path.join(directory, ".claude2/skills"));
    expect(userSkillDirectories({ HOME: directory }).map(item => item.directory)).toEqual([".agents/skills", ".claude/skills"].map(name => path.join(directory, name)));
    // Neither discovery nor planning creates anything.
    expect(existsSync(path.join(directory, ".agents"))).toBe(false);
  });
});

describe("skill sources", () => {
  test("each harness links its installed copy, otherwise the repository-owned skill", () => {
    const root = repository();
    expect(skillSource(root, "claude", "explicit-state-machines")).toBe(path.join(root, ".claude/skills/explicit-state-machines"));
    expect(skillSource(root, "agents", "explicit-state-machines")).toBe(path.join(root, ".agents/skills/explicit-state-machines"));
    for (const harness of ["claude", "agents"] as const) expect(skillSource(root, harness, "space-cleanup")).toBe(path.join(root, "skills/space-cleanup"));
    // A harness directory without SKILL.md falls back to skills/<name>.
    mkdirSync(path.join(root, ".claude/skills/space-cleanup"));
    expect(skillSource(root, "claude", "space-cleanup")).toBe(path.join(root, "skills/space-cleanup"));
  });

  test("a declared skill with no source, or one outside the repository, fails before anything is written", () => {
    const root = repository(), directory = home(), outside = temporary();
    expect(() => planSkillLinks(root, ["missing-skill"], { HOME: directory })).toThrow("Declared user skill 'missing-skill' has no SKILL.md in .agents/skills/missing-skill or skills/missing-skill.");
    // A source for one harness alone is still an error for the other.
    skill(path.join(root, ".agents/skills/codex-only"));
    expect(() => linkSkills(root, ["codex-only"], true, { HOME: directory })).toThrow("has no SKILL.md in .claude/skills/codex-only or skills/codex-only");
    symlinkSync(skill(path.join(outside, "escaped")), path.join(root, "skills/escaped"));
    expect(() => linkSkills(root, ["escaped"], true, { HOME: directory })).toThrow("resolves outside the repository");
    expect(existsSync(path.join(directory, ".agents"))).toBe(false);
    expect(existsSync(path.join(directory, ".claude/skills"))).toBe(false);
  });

  test("the targets reproduce hand-made links: managed skills per harness, repository-owned ones shared", () => {
    const root = repository(), directory = home();
    const targets = Object.fromEntries(planSkillLinks(root, NAMES, { HOME: directory }).map(change => [`${path.relative(directory, change.directory)} ${change.skill}`, path.relative(root, change.target)]));
    expect(targets).toEqual({
      ".agents/skills space-cleanup": "skills/space-cleanup",
      ".agents/skills explicit-state-machines": ".agents/skills/explicit-state-machines",
      ".claude/skills space-cleanup": "skills/space-cleanup",
      ".claude/skills explicit-state-machines": ".claude/skills/explicit-state-machines",
      ".claude2/skills space-cleanup": "skills/space-cleanup",
      ".claude2/skills explicit-state-machines": ".claude/skills/explicit-state-machines",
    });
  });
});

describe("skills link", () => {
  test("no declared skills plan nothing and read nothing from home", () => {
    expect(linkSkills(temporary(), [], true, { HOME: path.join(temporary(), "absent") })).toEqual({ applied: true, changes: [] });
    expect(checkSkillLinks(temporary(), [], { HOME: path.join(temporary(), "absent") })).toEqual({ ok: true, changes: [] });
  });

  test("previews, then creates every link and missing skills directory, then reports them unchanged", () => {
    const root = repository(), directory = home(), env = { HOME: directory };
    const preview = linkSkills(root, NAMES, false, env);
    expect(preview.applied).toBe(false);
    expect(preview.changes.every(change => change.status === "create")).toBe(true);
    expect(preview.changes[0]).toEqual({ skill: "space-cleanup", directory: path.join(directory, ".agents/skills"), path: path.join(directory, ".agents/skills/space-cleanup"), target: path.join(root, "skills/space-cleanup"), status: "create" });
    expect(existsSync(path.join(directory, ".agents"))).toBe(false);
    expect(existsSync(path.join(directory, ".claude/skills"))).toBe(false);
    expect(checkSkillLinks(root, NAMES, env).ok).toBe(false);

    expect(linkSkills(root, NAMES, true, env).applied).toBe(true);
    for (const name of [".agents/skills", ".claude/skills", ".claude2/skills"]) expect(statSync(path.join(directory, name)).mode & 0o777).toBe(0o700);
    for (const change of preview.changes) {
      expect(lstatSync(change.path).isSymbolicLink()).toBe(true);
      // Absolute real paths, so a link works from any directory.
      expect(readlinkSync(change.path)).toBe(change.target);
    }
    const check = checkSkillLinks(root, NAMES, env);
    expect(check.ok).toBe(true);
    expect(check.changes.map(change => change.status)).toEqual(Array(6).fill("unchanged"));
    expect(check.changes[0]!.current).toBe(path.join(root, "skills/space-cleanup"));
    expect(linkSkills(root, NAMES, true, env).changes.every(change => change.status === "unchanged")).toBe(true);
  });

  test("repairs dangling links and links to directories without SKILL.md in place", () => {
    const root = repository(), directory = home(), elsewhere = temporary(), env = { HOME: directory };
    const skills = path.join(directory, ".claude/skills");
    mkdirSync(skills);
    symlinkSync(path.join(elsewhere, "removed"), path.join(skills, "space-cleanup"));
    mkdirSync(path.join(elsewhere, "emptied"));
    symlinkSync(path.join(elsewhere, "emptied"), path.join(skills, "explicit-state-machines"));
    const plan = linkSkills(root, NAMES, false, env).changes.filter(change => change.directory === skills);
    expect(plan.map(change => [change.status, change.current])).toEqual([["repair", path.join(elsewhere, "removed")], ["repair", path.join(elsewhere, "emptied")]]);
    expect(checkSkillLinks(root, NAMES, env).ok).toBe(false);
    linkSkills(root, NAMES, true, env);
    expect(readlinkSync(path.join(skills, "space-cleanup"))).toBe(path.join(root, "skills/space-cleanup"));
    expect(readlinkSync(path.join(skills, "explicit-state-machines"))).toBe(path.join(root, ".claude/skills/explicit-state-machines"));
    // The temporary links are gone, and the old targets are untouched.
    expect(readdirSync(skills).sort()).toEqual(["explicit-state-machines", "space-cleanup"]);
    expect(existsSync(path.join(elsewhere, "emptied"))).toBe(true);
    expect(checkSkillLinks(root, NAMES, env).ok).toBe(true);
  });

  test("keeps links to the same skill in another clone, and that alone does not fail the check", () => {
    const root = repository(), directory = home(), clone = temporary(), env = { HOME: directory };
    linkSkills(root, NAMES, true, env);
    // Another clone of the repository, and a directory named otherwise whose SKILL.md names the skill.
    const skills = path.join(directory, ".claude/skills");
    for (const name of NAMES) unlinkSync(path.join(skills, name));
    symlinkSync(skill(path.join(clone, "skills/space-cleanup")), path.join(skills, "space-cleanup"));
    symlinkSync(skill(path.join(clone, "renamed"), "explicit-state-machines"), path.join(skills, "explicit-state-machines"));
    const check = checkSkillLinks(root, NAMES, env);
    expect(summary(check.changes, directory)).toEqual([
      ".agents/skills space-cleanup unchanged", ".agents/skills explicit-state-machines unchanged",
      ".claude/skills space-cleanup kept", ".claude/skills explicit-state-machines kept",
      ".claude2/skills space-cleanup unchanged", ".claude2/skills explicit-state-machines unchanged",
    ]);
    expect(check.ok).toBe(true);
    expect(linkSkills(root, NAMES, true, env).applied).toBe(true);
    expect(readlinkSync(path.join(skills, "space-cleanup"))).toBe(path.join(clone, "skills/space-cleanup"));
    expect(readlinkSync(path.join(skills, "explicit-state-machines"))).toBe(path.join(clone, "renamed"));
  });

  test("a file, a directory, or a link to another skill is a conflict that blocks every write", () => {
    const root = repository(), directory = home(), elsewhere = temporary(), env = { HOME: directory };
    for (const [occupant, setup] of [
      ["file", (file: string) => writeFileSync(file, "mine")],
      ["directory", (file: string) => skill(file)],
      ["other skill", (file: string) => symlinkSync(skill(path.join(elsewhere, "other-skill")), file)],
    ] as const) {
      const skills = path.join(directory, ".claude/skills"), file = path.join(skills, "space-cleanup");
      rmSync(path.join(directory, ".agents"), { recursive: true, force: true });
      rmSync(skills, { recursive: true, force: true });
      mkdirSync(skills);
      setup(file);
      const before = lstatSync(file);
      const result = linkSkills(root, NAMES, true, env);
      expect({ occupant, applied: result.applied, conflicts: result.changes.filter(change => change.status === "conflict").map(change => change.path) }).toEqual({ occupant, applied: false, conflicts: [file] });
      // Nothing was written anywhere, and the occupant is exactly as it was.
      expect(existsSync(path.join(directory, ".agents"))).toBe(false);
      expect(readdirSync(skills)).toEqual(["space-cleanup"]);
      expect(lstatSync(file).ino).toBe(before.ino);
      expect(checkSkillLinks(root, NAMES, env).ok).toBe(false);
    }
    expect(readlinkSync(path.join(directory, ".claude/skills/space-cleanup"))).toBe(path.join(elsewhere, "other-skill"));
  });

  test("never touches Claude Code's synced store or undeclared entries", () => {
    const root = repository(), directory = home(), env = { HOME: directory };
    const skills = path.join(directory, ".claude/skills");
    skill(path.join(skills, "synced/account-skill"));
    symlinkSync(path.join(directory, "gone"), path.join(skills, "undeclared-dangling"));
    writeFileSync(path.join(skills, "notes.txt"), "mine");
    const changes = linkSkills(root, NAMES, true, env).changes;
    expect(changes.some(change => change.path.includes("synced") || change.path.includes("undeclared") || change.path.includes("notes"))).toBe(false);
    expect(readdirSync(skills).sort()).toEqual(["explicit-state-machines", "notes.txt", "space-cleanup", "synced", "undeclared-dangling"]);
    expect(readdirSync(path.join(skills, "synced"))).toEqual(["account-skill"]);
    expect(readlinkSync(path.join(skills, "undeclared-dangling"))).toBe(path.join(directory, "gone"));
  });

  test("a skills path that is not a directory is refused", () => {
    const root = repository(), directory = home();
    writeFileSync(path.join(directory, ".claude2/skills"), "not a directory");
    expect(() => linkSkills(root, NAMES, true, { HOME: directory })).toThrow(`User skill directory is not a directory: ${path.join(directory, ".claude2/skills")}`);
    expect(existsSync(path.join(directory, ".agents"))).toBe(false);
  });

  test("links through CLAUDE_CONFIG_DIR and a linked skills directory once", () => {
    const root = repository(), directory = home(), custom = temporary(), env = { HOME: directory, CLAUDE_CONFIG_DIR: custom };
    mkdirSync(path.join(directory, ".claude/skills"));
    symlinkSync(path.join(directory, ".claude/skills"), path.join(directory, ".claude2/skills"));
    const result = linkSkills(root, NAMES, true, env);
    expect([...new Set(result.changes.map(change => change.directory))]).toEqual([path.join(directory, ".agents/skills"), path.join(custom, "skills"), path.join(directory, ".claude/skills")]);
    expect(readlinkSync(path.join(custom, "skills/explicit-state-machines"))).toBe(path.join(root, ".claude/skills/explicit-state-machines"));
    expect(checkSkillLinks(root, NAMES, env).ok).toBe(true);
  });
});

describe("skills link CLI", () => {
  const cli = path.resolve(import.meta.dir, "../index.ts");
  test("previews, applies, and checks for --repo with exit codes health reports can use", () => {
    const root = repository(), directory = home(), cwd = temporary();
    writeFileSync(path.join(root, "agent-tool.json"), JSON.stringify({ schemaVersion: 1, skills: { user: NAMES } }));
    const run = (...args: string[]) => {
      const result = spawnSync(process.execPath, [cli, "--repo", root, "skills", ...args], { cwd, encoding: "utf8", env: { ...process.env, HOME: directory, CLAUDE_CONFIG_DIR: "", AGENT_TOOL_CONFIG: "" } });
      return { status: result.status, output: result.stdout ? JSON.parse(result.stdout) : undefined, stderr: result.stderr };
    };
    const preview = run("link");
    expect(preview.status).toBe(0);
    expect(preview.output.applied).toBe(false);
    expect(Object.keys(preview.output.changes[0])).toEqual(["skill", "directory", "path", "target", "status"]);
    expect(run("check-links").status).toBe(1);
    expect(run("check-links", "--apply").stderr).toContain("read-only");
    expect(run("link", "--force").stderr).toContain("Unknown skills link argument '--force'.");
    const applied = run("link", "--apply");
    expect([applied.status, applied.output.applied]).toEqual([0, true]);
    const check = run("check-links");
    expect([check.status, check.output.ok]).toEqual([0, true]);
    // A conflict fails both forms and is left alone.
    unlinkSync(path.join(directory, ".claude2/skills/space-cleanup"));
    mkdirSync(path.join(directory, ".claude2/skills/space-cleanup"));
    expect(run("link", "--apply")).toMatchObject({ status: 1, output: { applied: false } });
    expect(run("check-links").status).toBe(1);
    expect(lstatSync(path.join(directory, ".claude2/skills/space-cleanup")).isDirectory()).toBe(true);
    // No declared skills: an empty result and exit 0 for both forms.
    writeFileSync(path.join(root, "agent-tool.json"), JSON.stringify({ schemaVersion: 1 }));
    expect(run("link", "--apply")).toMatchObject({ status: 0, output: { applied: true, changes: [] } });
    expect(run("check-links")).toMatchObject({ status: 0, output: { ok: true, changes: [] } });
    expect(readFileSync(path.join(root, "skills/space-cleanup/SKILL.md"), "utf8")).toContain("name: space-cleanup");
  }, 30_000);
});
