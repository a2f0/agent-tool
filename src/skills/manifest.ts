import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { readRegularFile } from "../system/files";
import { validVersion } from "../system/manifestVersion";
import { BUNDLED_SKILL_REFERENCES, BUNDLED_SKILLS } from "./bundled";

export const SKILLS_MANIFEST = ".agent-tool-skills.json";

/** The harness each skill directory an install writes belongs to. */
export const DIRECTORY_HARNESSES: Readonly<Record<string, string>> = { ".claude/skills": "claude", ".agents/skills": "codex", ".opencode/skills": "opencode" };

/** Refuse symlinks at every existing component, including dangling links. */
export function safeDestination(root: string, relative: string): string {
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
export interface SkillManifest { raw?: string; agentToolVersion?: string; files: Record<string, string> }

export function readSkillManifest(root: string): SkillManifest {
  // One descriptor, refusing links, FIFOs, and devices, so a hook or CI can be neither redirected nor stalled.
  const read = readRegularFile(safeDestination(root, SKILLS_MANIFEST));
  if (read.status === "missing") return { files: {} };
  if (read.status === "irregular") throw new Error(`Managed skill manifest is not a regular file: ${SKILLS_MANIFEST}`);
  const raw = read.contents;
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1 || !value.files || typeof value.files !== "object" || Array.isArray(value.files) || Object.values(value.files).some(item => typeof item !== "string" || !/^[a-f0-9]{64}$/.test(item))) throw new Error("Invalid managed skill manifest.");
  // The version is provenance, not ownership: an unusable one counts as none, which the check reports and the install replaces.
  return { raw, ...(validVersion(value.agentToolVersion) ? { agentToolVersion: value.agentToolVersion } : {}), files: value.files };
}

/**
 * The files the manifest records whose snapshot bytes match what the running release installs: a
 * bundled skill's file under a skill directory. Any edited, missing, unbundled, or older-release
 * entry is left out so a hand-edited skill file never hides behind the generated-files prompt
 * rule. Throws as an install would on an unusable manifest.
 */
export function managedSkillFiles(rootDir: string): string[] {
  const root = realpathSync(rootDir);
  const recorded = readSkillManifest(root);
  const installed = new Map(Object.keys(DIRECTORY_HARNESSES).flatMap(directory => bundledSkillFiles().flatMap(([name, files]) => files.map(([inside, source]): [string, string] => [`${directory}/${name}/${inside}`, source]))));
  return Object.keys(recorded.files).filter(file => {
    const expected = installed.get(file);
    if (expected === undefined) return false;
    try {
      const read = readRegularFile(safeDestination(root, file));
      return read.status === "file" && read.contents === expected;
    } catch {
      return false;
    }
  });
}
