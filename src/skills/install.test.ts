import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { harnessNamed, HARNESSES } from "../harnesses";
import { BUNDLED_SKILL_REFERENCES, BUNDLED_SKILLS } from "./bundled";
import { bundledSkillFiles, checkSkills, installSkills } from "./install";

const roots: string[] = [];
function fixture(): string { const root = mkdtempSync(path.join(tmpdir(), "agent-tool-install-")); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("preview makes no changes; all installs one bundle for all harnesses", () => {
  const root = fixture();
  expect(installSkills(root, "all")).toHaveLength(bundledSkillFiles().reduce((total, [, files]) => total + files.length, 0) * 2);
  expect(existsSync(path.join(root, ".agents"))).toBe(false);
  installSkills(root, "all", true);
  for (const directory of [".agents/skills", ".claude/skills"]) {
    for (const [name, source] of Object.entries(BUNDLED_SKILLS)) expect(readFileSync(path.join(root, directory, name, "SKILL.md"), "utf8")).toBe(source);
  }
  expect(installSkills(root, "all", true).every(change => change.status === "unchanged")).toBe(true);
});
test("Hermes shares Codex ownership without extra directories or skill aliases", () => {
  const root = fixture();
  const wrapper = path.join(root, ".agents/skills/update-everything/SKILL.md");
  mkdirSync(path.dirname(wrapper), { recursive: true }); writeFileSync(wrapper, "repository-owned wrapper");
  expect(installSkills(root, "hermes").every(change => change.status === "create")).toBe(true);
  expect(existsSync(path.join(root, ".agent-tool-skills.json"))).toBe(false);
  installSkills(root, "hermes", true);
  const manifest = readFileSync(path.join(root, ".agent-tool-skills.json"), "utf8");
  expect(checkSkills(root, "hermes").every(change => change.status === "unchanged")).toBe(true);
  expect(installSkills(root, "codex", true).every(change => change.status === "unchanged")).toBe(true);
  expect(readFileSync(path.join(root, ".agent-tool-skills.json"), "utf8")).toBe(manifest);
  expect(existsSync(path.join(root, ".hermes"))).toBe(false);
  expect(existsSync(path.join(root, ".claude"))).toBe(false);
  expect(readFileSync(wrapper, "utf8")).toBe("repository-owned wrapper");
  const skill = path.join(root, ".agents/skills/ship-pr/SKILL.md");
  writeFileSync(skill, "local edit");
  expect(() => installSkills(root, "hermes", true)).toThrow("Locally edited");
  expect(() => checkSkills(root, "hermes")).toThrow("Locally edited");
  expect(readFileSync(skill, "utf8")).toBe("local edit");
});

test("skill consumers do not register new review providers", () => {
  expect(HARNESSES.map(harness => harness.name)).toEqual(["claude", "codex", "opencode"]);
  expect(() => harnessNamed("hermes")).toThrow("Unknown harness");
});

test("OpenCode-only installation uses its native discovery directory", () => {
  const root = fixture(); installSkills(root, "opencode", true);
  expect(existsSync(path.join(root, ".opencode/skills/cross-agent-review/SKILL.md"))).toBe(true);
});
test("one conflicting skill prevents all writes and preserves user edits", () => {
  const root = fixture(), file = path.join(root, ".claude/skills/ship-pr/SKILL.md");
  mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, "my skill");
  expect(() => installSkills(root, "all", true)).toThrow("unmanaged skill");
  expect(readFileSync(file, "utf8")).toBe("my skill");
  expect(existsSync(path.join(root, ".agents"))).toBe(false);
  expect(existsSync(path.join(root, ".agent-tool-skills.json"))).toBe(false);
});
test("managed updates succeed, while edits after installation are protected", () => {
  const root = fixture(); installSkills(root, "codex", true);
  const relative = ".agents/skills/ship-pr/SKILL.md", file = path.join(root, relative), manifestFile = path.join(root, ".agent-tool-skills.json");
  writeFileSync(file, "previous bundled version");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  manifest.files[relative] = createHash("sha256").update("previous bundled version").digest("hex");
  writeFileSync(manifestFile, JSON.stringify(manifest));
  expect(installSkills(root, "codex", true).find(change => change.path === relative)?.status).toBe("update");
  expect(readFileSync(file, "utf8")).toBe(BUNDLED_SKILLS["ship-pr"]);
  writeFileSync(file, "user edit");
  expect(() => installSkills(root, "codex", true)).toThrow("Locally edited");
});
test("refuses directory, file and dangling symlinks without following them", () => {
  for (const relative of [".agents", ".agents/skills/ship-pr/SKILL.md", ".agent-tool-skills.json"]) {
    const root = fixture(), target = fixture(), file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true }); symlinkSync(path.join(target, "missing"), file);
    expect(() => installSkills(root, "codex", true)).toThrow("symlink");
  }
});

test("check is read-only and detects missing skills and ownership records", () => {
  const root = fixture();
  expect(checkSkills(root, "all").every(change => change.status === "missing")).toBe(true);
  expect(existsSync(path.join(root, ".agents"))).toBe(false);
  installSkills(root, "all", true);
  expect(checkSkills(root, "all").every(change => change.status === "unchanged")).toBe(true);
  unlinkSync(path.join(root, ".agent-tool-skills.json"));
  expect(checkSkills(root, "all").every(change => change.status === "unmanaged")).toBe(true);
  expect(existsSync(path.join(root, ".agent-tool-skills.json"))).toBe(false);
});

test("check detects stale managed content without updating and rejects user edits", () => {
  const root = fixture(); installSkills(root, "all", true);
  const relative = ".agents/skills/ship-pr/SKILL.md", file = path.join(root, relative), manifestFile = path.join(root, ".agent-tool-skills.json");
  writeFileSync(file, "old bundle");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  manifest.files[relative] = createHash("sha256").update("old bundle").digest("hex");
  writeFileSync(manifestFile, JSON.stringify(manifest));
  expect(checkSkills(root, "all").find(change => change.path === relative)?.status).toBe("outdated");
  expect(readFileSync(file, "utf8")).toBe("old bundle");
  writeFileSync(file, "user edit");
  expect(() => checkSkills(root, "all")).toThrow("Locally edited");
});

test("check detects stale manifest hashes and missing files for the selected harness", () => {
  const root = fixture(); installSkills(root, "all", true);
  const relative = ".claude/skills/ship-pr/SKILL.md", file = path.join(root, relative), manifestFile = path.join(root, ".agent-tool-skills.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  manifest.files[relative] = "0".repeat(64);
  writeFileSync(manifestFile, JSON.stringify(manifest));
  expect(checkSkills(root, "claude").find(change => change.path === relative)?.status).toBe("outdated");
  expect(checkSkills(root, "codex").every(change => change.status === "unchanged")).toBe(true);
  unlinkSync(file);
  expect(checkSkills(root, "claude").find(change => change.path === relative)?.status).toBe("missing");
});

const REFERENCE = ".agents/skills/explicit-state-machines/references/patterns.md";

test("skills ship their Markdown references beside SKILL.md, each with its own ownership record", () => {
  expect(Object.keys(BUNDLED_SKILL_REFERENCES["explicit-state-machines"] ?? {})).toEqual(["references/lessons.md", "references/patterns.md"]);
  for (const files of Object.values(BUNDLED_SKILL_REFERENCES)) for (const file of Object.keys(files)) expect(file).toMatch(/^references\/[a-z0-9-]+\.md$/);
  const root = fixture();
  const changes = installSkills(root, "all", true);
  const fileCount = bundledSkillFiles().reduce((total, [, files]) => total + files.length, 0);
  expect(changes).toHaveLength(fileCount * 2);
  for (const directory of [".agents/skills", ".claude/skills"]) {
    for (const [name, files] of bundledSkillFiles()) for (const [inside, source] of files) expect(readFileSync(path.join(root, directory, name, inside), "utf8")).toBe(source);
  }
  const manifest = JSON.parse(readFileSync(path.join(root, ".agent-tool-skills.json"), "utf8"));
  expect(manifest.schemaVersion).toBe(1);
  expect(manifest.files[REFERENCE]).toBe(createHash("sha256").update(BUNDLED_SKILL_REFERENCES["explicit-state-machines"]!["references/patterns.md"]!).digest("hex"));
  expect(checkSkills(root, "all").every(change => change.status === "unchanged")).toBe(true);
  // The agents/openai.yaml and other non-Markdown files never ship.
  expect(existsSync(path.join(root, ".agents/skills/explicit-state-machines/agents"))).toBe(false);
});

test("a consumer installed before references existed sees only the new files as missing", () => {
  const root = fixture(); installSkills(root, "codex", true);
  const manifestFile = path.join(root, ".agent-tool-skills.json");
  // Rebuild the old layout: no explicit-state-machines skill and no references.
  rmSync(path.join(root, ".agents/skills/explicit-state-machines"), { recursive: true });
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  for (const key of Object.keys(manifest.files)) if (key.includes("/explicit-state-machines/")) delete manifest.files[key];
  writeFileSync(manifestFile, JSON.stringify(manifest));
  const missing = checkSkills(root, "codex").filter(change => change.status !== "unchanged");
  expect(missing.every(change => change.status === "missing")).toBe(true);
  expect(missing.map(change => change.path).sort()).toEqual([
    ".agents/skills/explicit-state-machines/SKILL.md",
    ".agents/skills/explicit-state-machines/references/lessons.md",
    REFERENCE,
  ]);
  expect(installSkills(root, "codex", true).filter(change => change.status !== "unchanged").every(change => change.status === "create")).toBe(true);
  expect(checkSkills(root, "codex").every(change => change.status === "unchanged")).toBe(true);
});

test("references update when managed and refuse local edits, unmanaged files and symlinks", () => {
  const root = fixture(); installSkills(root, "codex", true);
  const file = path.join(root, REFERENCE), manifestFile = path.join(root, ".agent-tool-skills.json");
  const source = BUNDLED_SKILL_REFERENCES["explicit-state-machines"]!["references/patterns.md"]!;
  writeFileSync(file, "previous bundled reference");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  manifest.files[REFERENCE] = createHash("sha256").update("previous bundled reference").digest("hex");
  writeFileSync(manifestFile, JSON.stringify(manifest));
  expect(checkSkills(root, "codex").find(change => change.path === REFERENCE)?.status).toBe("outdated");
  expect(installSkills(root, "codex", true).find(change => change.path === REFERENCE)?.status).toBe("update");
  expect(readFileSync(file, "utf8")).toBe(source);
  writeFileSync(file, "user edit");
  expect(() => installSkills(root, "codex", true)).toThrow(`Locally edited or unmanaged skill: ${REFERENCE}`);
  expect(() => checkSkills(root, "codex")).toThrow("Locally edited");
  expect(readFileSync(file, "utf8")).toBe("user edit");

  // An unmanaged reference file blocks every write, including the manifest.
  const fresh = fixture(), unmanaged = path.join(fresh, REFERENCE);
  mkdirSync(path.dirname(unmanaged), { recursive: true }); writeFileSync(unmanaged, "mine");
  expect(() => installSkills(fresh, "codex", true)).toThrow("unmanaged skill");
  expect(existsSync(path.join(fresh, ".agents/skills/ship-pr"))).toBe(false);
  expect(existsSync(path.join(fresh, ".agent-tool-skills.json"))).toBe(false);

  // A symlinked references directory is refused without writing through it.
  const linked = fixture(), elsewhere = fixture();
  mkdirSync(path.join(linked, ".agents/skills/explicit-state-machines"), { recursive: true });
  symlinkSync(elsewhere, path.join(linked, ".agents/skills/explicit-state-machines/references"));
  expect(() => installSkills(linked, "codex", true)).toThrow("Refusing skill destination symlink");
  expect(() => checkSkills(linked, "codex")).toThrow("symlink");
  expect(readdirSync(elsewhere)).toEqual([]);
  expect(existsSync(path.join(linked, ".agent-tool-skills.json"))).toBe(false);
});
