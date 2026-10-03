import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BUNDLED_SKILLS } from "./bundled";
import { installSkills } from "./install";

const roots: string[] = [];
function fixture(): string { const root = mkdtempSync(path.join(tmpdir(), "agent-tool-install-")); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("preview makes no changes; all installs one bundle for all harnesses", () => {
  const root = fixture();
  expect(installSkills(root, "all")).toHaveLength(Object.keys(BUNDLED_SKILLS).length * 2);
  expect(existsSync(path.join(root, ".agents"))).toBe(false);
  installSkills(root, "all", true);
  for (const directory of [".agents/skills", ".claude/skills"]) {
    for (const [name, source] of Object.entries(BUNDLED_SKILLS)) expect(readFileSync(path.join(root, directory, name, "SKILL.md"), "utf8")).toBe(source);
  }
  expect(installSkills(root, "all", true).every(change => change.status === "unchanged")).toBe(true);
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
