import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { harnessNamed } from "../harnesses";
import { AGENT_TOOL_VERSION, manifestVersionCheck, validVersion, type CheckStatus } from "../system/manifestVersion";
import { BUNDLED_SKILL_REFERENCES, BUNDLED_SKILLS } from "./bundled";

export const SKILLS_MANIFEST = ".agent-tool-skills.json";
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

/** Every file each bundled skill installs, relative to its skill directory: `SKILL.md`, then its references. */
export function bundledSkillFiles(): [name: string, files: [relative: string, source: string][]][] {
  return Object.entries(BUNDLED_SKILLS).map(([name, source]) => [name, [["SKILL.md", source], ...Object.entries(BUNDLED_SKILL_REFERENCES[name] ?? {})]]);
}

/**
 * The ownership manifest: each managed file's hash and the agent-tool version whose install
 * wrote it. Manifests from releases before the version field lack it and stay readable; the
 * field is additive, so `schemaVersion` stays 1 and older releases still read newer manifests.
 */
interface SkillManifest { exists: boolean; agentToolVersion?: string; files: Record<string, string> }

function readManifest(root: string): SkillManifest {
  const file = safeDestination(root, SKILLS_MANIFEST);
  if (!existsSync(file)) return { exists: false, files: {} };
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (value.schemaVersion !== 1 || !value.files || typeof value.files !== "object" || Array.isArray(value.files) || Object.values(value.files).some(item => typeof item !== "string" || !/^[a-f0-9]{64}$/.test(item))) throw new Error("Invalid managed skill manifest.");
  if (value.agentToolVersion !== undefined && !validVersion(value.agentToolVersion)) throw new Error("Invalid managed skill manifest.");
  return { exists: true, ...(value.agentToolVersion === undefined ? {} : { agentToolVersion: value.agentToolVersion }), files: value.files };
}

/** Each managed file's change, then the manifest's, which every new agent-tool release updates. */
export function installSkills(rootDir: string, target: string, apply = false): SkillChange[] {
  const root = realpathSync(rootDir);
  // Hermes consumes shared skills, not the review adapter registry. OpenCode
  // discovers both default directories too; avoid additional duplicate bundles.
  const directories = target === "all" ? [".agents/skills", ".claude/skills"]
    : [target === "hermes" ? ".agents/skills" : harnessNamed(target).skillDirectory];
  const manifestFile = safeDestination(root, SKILLS_MANIFEST);
  const previous = readManifest(root).files;
  const pending: { file: string; relative: string; source: string; change: SkillChange }[] = [];
  for (const directory of directories) {
    for (const [name, sources] of bundledSkillFiles()) {
      for (const [inside, source] of sources) {
        const relative = `${directory}/${name}/${inside}`;
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
  }
  const files = { ...previous };
  for (const item of pending) files[item.relative] = hash(item.source);
  // Recording the version makes every upgrade change the manifest, so a committed sync is visible.
  const manifest = `${JSON.stringify({ schemaVersion: 1, agentToolVersion: AGENT_TOOL_VERSION, files }, null, 2)}\n`;
  const recorded = existsSync(manifestFile) ? readFileSync(manifestFile, "utf8") : undefined;
  const manifestChange: SkillChange = { path: SKILLS_MANIFEST, status: recorded === manifest ? "unchanged" : recorded === undefined ? "create" : "update" };
  // Preflight every destination before writing any files.
  if (apply) {
    for (const item of pending) if (item.change.status !== "unchanged") atomicWrite(item.file, item.source);
    if (manifestChange.status !== "unchanged") atomicWrite(manifestFile, manifest);
  }
  return [...pending.map(item => item.change), manifestChange];
}

const DIRECTORY_HARNESSES: Record<string, string> = { ".claude/skills": "claude", ".agents/skills": "codex", ".opencode/skills": "opencode" };

/**
 * Each `--harness` whose directory a repository's ownership manifest records,
 * or null without a manifest, so a check covers every installed directory,
 * OpenCode's included. An unrecognized directory adds `all`.
 */
export function installedSkillHarnesses(rootDir: string): string[] | null {
  const root = realpathSync(rootDir);
  if (!existsSync(safeDestination(root, SKILLS_MANIFEST))) return null;
  const directories = new Set(Object.keys(readManifest(root).files).map(file => file.split("/", 2).join("/")));
  return [...new Set([...directories].map(directory => DIRECTORY_HARNESSES[directory] ?? "all"))].sort();
}

/** One entry per managed file, then the manifest's own entry with its recorded and running versions. */
export interface SkillCheck { path: string; status: CheckStatus; recordedVersion?: string | null; currentVersion?: string }

/** The manifest's own check entry: whether it records the running agent-tool version. */
export function checkSkillsManifest(rootDir: string): SkillCheck {
  const manifest = readManifest(realpathSync(rootDir));
  return manifestVersionCheck(SKILLS_MANIFEST, manifest.exists, manifest.agentToolVersion);
}

/** Read-only CI gate: require current bundled bytes, their ownership records, and the installing version. */
export function checkSkills(rootDir: string, target: string): SkillCheck[] {
  const root = realpathSync(rootDir);
  const changes = installSkills(root, target).filter(change => change.path !== SKILLS_MANIFEST);
  const previous = readManifest(root).files;
  const files: SkillCheck[] = changes.map(change => {
    if (change.status === "create") return { path: change.path, status: "missing" };
    if (change.status === "update") return { path: change.path, status: "outdated" };
    if (!previous[change.path]) return { path: change.path, status: "unmanaged" };
    if (previous[change.path] !== hash(readFileSync(safeDestination(root, change.path), "utf8"))) return { path: change.path, status: "outdated" };
    return { path: change.path, status: "unchanged" };
  });
  return [...files, checkSkillsManifest(root)];
}
