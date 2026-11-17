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
 * One reading of the ownership manifest: its bytes (none without a manifest), each managed
 * file's hash, and the agent-tool version whose install wrote it. Manifests from releases
 * before the version field lack it and stay readable; the field is additive, so
 * `schemaVersion` stays 1 and older releases still read newer manifests.
 */
interface SkillManifest { raw?: string; agentToolVersion?: string; files: Record<string, string> }

function readManifest(root: string): SkillManifest {
  const file = safeDestination(root, SKILLS_MANIFEST);
  if (!existsSync(file)) return { files: {} };
  // Reading a FIFO or device would block a hook or CI; only a regular file can be a manifest.
  if (!lstatSync(file).isFile()) throw new Error(`Managed skill manifest is not a regular file: ${SKILLS_MANIFEST}`);
  const raw = readFileSync(file, "utf8");
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1 || !value.files || typeof value.files !== "object" || Array.isArray(value.files) || Object.values(value.files).some(item => typeof item !== "string" || !/^[a-f0-9]{64}$/.test(item))) throw new Error("Invalid managed skill manifest.");
  // The version is provenance, not ownership: an unusable one counts as none, which the check reports and the install replaces.
  return { raw, ...(validVersion(value.agentToolVersion) ? { agentToolVersion: value.agentToolVersion } : {}), files: value.files };
}

interface PlannedFile { file: string; relative: string; source: string; current?: string; change: SkillChange }
interface Plan { files: PlannedFile[]; manifestFile: string; manifest: string; manifestChange: SkillChange }

/** What installing one target would write, from one reading of the manifest; refuses before any write. */
function plan(root: string, target: string, recorded: SkillManifest): Plan {
  // Hermes consumes shared skills, not the review adapter registry. OpenCode
  // discovers both default directories too; avoid additional duplicate bundles.
  const directories = target === "all" ? [".agents/skills", ".claude/skills"]
    : [target === "hermes" ? ".agents/skills" : harnessNamed(target).skillDirectory];
  const manifestFile = safeDestination(root, SKILLS_MANIFEST);
  const planned: PlannedFile[] = [];
  for (const directory of directories) {
    for (const [name, sources] of bundledSkillFiles()) {
      for (const [inside, source] of sources) {
        const relative = `${directory}/${name}/${inside}`;
        const file = safeDestination(root, relative);
        let current: string | undefined;
        if (existsSync(file)) {
          if (!lstatSync(file).isFile()) throw new Error(`Skill destination is not a regular file: ${relative}`);
          current = readFileSync(file, "utf8");
          if (current !== source && hash(current) !== recorded.files[relative]) throw new Error(`Locally edited or unmanaged skill: ${relative}. Preserve it before installing.`);
        }
        planned.push({ file, relative, source, current, change: { path: relative, status: current === source ? "unchanged" : current === undefined ? "create" : "update" } });
      }
    }
  }
  const files = { ...recorded.files };
  for (const item of planned) files[item.relative] = hash(item.source);
  // Recording the version makes every upgrade change the manifest, so a committed sync is visible.
  const manifest = `${JSON.stringify({ schemaVersion: 1, agentToolVersion: AGENT_TOOL_VERSION, files }, null, 2)}\n`;
  const status = recorded.raw === manifest ? "unchanged" : recorded.raw === undefined ? "create" : "update";
  return { files: planned, manifestFile, manifest, manifestChange: { path: SKILLS_MANIFEST, status } };
}

/** Each managed file's change, then the manifest's, which every new agent-tool release updates. */
export function installSkills(rootDir: string, target: string, apply = false): SkillChange[] {
  const root = realpathSync(rootDir);
  const planned = plan(root, target, readManifest(root));
  // Preflight every destination before writing any files.
  if (apply) {
    for (const item of planned.files) if (item.change.status !== "unchanged") atomicWrite(item.file, item.source);
    if (planned.manifestChange.status !== "unchanged") atomicWrite(planned.manifestFile, planned.manifest);
  }
  return [...planned.files.map(item => item.change), planned.manifestChange];
}

const DIRECTORY_HARNESSES: Record<string, string> = { ".claude/skills": "claude", ".agents/skills": "codex", ".opencode/skills": "opencode" };

/** One entry per managed file, then the manifest's own entry with its recorded and running versions. */
export interface SkillCheck { path: string; status: CheckStatus; recordedVersion?: string | null; currentVersion?: string }

/** Each managed file of one target against the same reading of the manifest. */
function fileChecks(root: string, target: string, recorded: SkillManifest): SkillCheck[] {
  return plan(root, target, recorded).files.map(({ relative, current, change }): SkillCheck => {
    if (change.status === "create") return { path: relative, status: "missing" };
    if (change.status === "update") return { path: relative, status: "outdated" };
    if (!recorded.files[relative]) return { path: relative, status: "unmanaged" };
    if (recorded.files[relative] !== hash(current!)) return { path: relative, status: "outdated" };
    return { path: relative, status: "unchanged" };
  });
}

const versionCheck = (recorded: SkillManifest): SkillCheck => manifestVersionCheck(SKILLS_MANIFEST, recorded.raw !== undefined, recorded.agentToolVersion);

/** Read-only CI gate: require current bundled bytes, their ownership records, and the installing version. */
export function checkSkills(rootDir: string, target: string): SkillCheck[] {
  const root = realpathSync(rootDir);
  const recorded = readManifest(root);
  return [...fileChecks(root, target, recorded), versionCheck(recorded)];
}

/**
 * The push gate's check, or null without a manifest: every `--harness` whose directory the
 * manifest records, so it covers every installed directory, OpenCode's included (an
 * unrecognized directory adds `all`), then the manifest's own entry once, even when it records
 * no harness. One reading of the manifest serves them all.
 */
export function checkInstalledSkills(rootDir: string): { harnesses: string[]; changes: SkillCheck[] } | null {
  const root = realpathSync(rootDir);
  const recorded = readManifest(root);
  if (recorded.raw === undefined) return null;
  const directories = new Set(Object.keys(recorded.files).map(file => file.split("/", 2).join("/")));
  const harnesses = [...new Set([...directories].map(directory => DIRECTORY_HARNESSES[directory] ?? "all"))].sort();
  return { harnesses, changes: [...harnesses.flatMap(harness => fileChecks(root, harness, recorded)), versionCheck(recorded)] };
}
