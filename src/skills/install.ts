import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { harnessNamed } from "../harnesses";
import { readRegularFile } from "../system/files";
import { AGENT_TOOL_VERSION, manifestVersionCheck, type CheckStatus } from "../system/manifestVersion";
import { bundledSkillFiles, DIRECTORY_HARNESSES, readSkillManifest, safeDestination, SKILLS_MANIFEST, type SkillManifest } from "./manifest";

const hash = (source: string) => createHash("sha256").update(source).digest("hex");

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
        const read = readRegularFile(file);
        if (read.status === "irregular") throw new Error(`Skill destination is not a regular file: ${relative}`);
        const current = read.status === "file" ? read.contents : undefined;
        if (current !== undefined && current !== source && hash(current) !== recorded.files[relative]) throw new Error(`Locally edited or unmanaged skill: ${relative}. Preserve it before installing.`);
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
  const planned = plan(root, target, readSkillManifest(root));
  // Preflight every destination before writing any files.
  if (apply) {
    for (const item of planned.files) if (item.change.status !== "unchanged") atomicWrite(item.file, item.source);
    if (planned.manifestChange.status !== "unchanged") atomicWrite(planned.manifestFile, planned.manifest);
  }
  return [...planned.files.map(item => item.change), planned.manifestChange];
}

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
  const recorded = readSkillManifest(root);
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
  const recorded = readSkillManifest(root);
  if (recorded.raw === undefined) return null;
  const directories = new Set(Object.keys(recorded.files).map(file => file.split("/", 2).join("/")));
  const harnesses = [...new Set([...directories].map(directory => DIRECTORY_HARNESSES[directory] ?? "all"))].sort();
  return { harnesses, changes: [...harnesses.flatMap(harness => fileChecks(root, harness, recorded)), versionCheck(recorded)] };
}
