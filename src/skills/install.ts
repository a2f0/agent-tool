import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { harnessNamed } from "../harnesses";
import { BUNDLED_SKILLS } from "./bundled";

const MANIFEST = ".agent-tool-skills.json";
const hash = (source: string) => createHash("sha256").update(source).digest("hex");

/** Refuse symlinks at every existing component, including dangling links. */
function safeDestination(root: string, relative: string): string {
  if (path.isAbsolute(relative) || relative.split("/").some(part => !part || part === "." || part === "..")) throw new Error(`Unsafe skill destination '${relative}'.`);
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Refusing skill destination symlink: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return current;
}

function atomicWrite(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.agent-tool-${process.pid}.tmp`;
  try {
    writeFileSync(temporary, contents, { flag: "wx", mode: 0o644 });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export interface SkillChange { path: string; status: "create" | "update" | "unchanged" }

export function installSkills(rootDir: string, target: string, apply = false): SkillChange[] {
  const root = realpathSync(rootDir);
  // OpenCode discovers both of these directories; avoid a third duplicate.
  const directories = target === "all" ? [".agents/skills", ".claude/skills"] : [harnessNamed(target).skillDirectory];
  const manifestFile = safeDestination(root, MANIFEST);
  let previous: Record<string, string> = {};
  if (existsSync(manifestFile)) {
    const value = JSON.parse(readFileSync(manifestFile, "utf8"));
    if (value.schemaVersion !== 1 || !value.files || typeof value.files !== "object" || Array.isArray(value.files) || Object.values(value.files).some(item => typeof item !== "string" || !/^[a-f0-9]{64}$/.test(item))) throw new Error("Invalid managed skill manifest.");
    previous = value.files;
  }
  const pending: { file: string; relative: string; source: string; change: SkillChange }[] = [];
  for (const directory of directories) {
    for (const [name, source] of Object.entries(BUNDLED_SKILLS)) {
      const relative = `${directory}/${name}/SKILL.md`;
      const file = safeDestination(root, relative);
      let current: string | undefined;
      if (existsSync(file)) {
        if (!lstatSync(file).isFile()) throw new Error(`Skill destination is not a regular file: ${relative}`);
        current = readFileSync(file, "utf8");
        if (current !== source && hash(current) !== previous[relative]) throw new Error(`Locally edited or unmanaged skill: ${relative}. Preserve it before installing.`);
      }
      pending.push({ file, relative, source, change: { path: relative, status: current === source ? "unchanged" : current === undefined ? "create" : "update" } });
    }
  }
  // Preflight every destination before writing any files.
  if (apply) {
    const files = { ...previous };
    for (const item of pending) {
      if (item.change.status !== "unchanged") atomicWrite(item.file, item.source);
      files[item.relative] = hash(item.source);
    }
    atomicWrite(manifestFile, `${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`);
  }
  return pending.map(item => item.change);
}
