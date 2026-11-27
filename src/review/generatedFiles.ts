import path from "node:path";

import metadata from "../../package.json";
import { generatedPermissionFiles } from "../permissions/install";
import { managedSkillFiles } from "../skills/manifest";
import { readRegularFile } from "../system/files";

/**
 * Changed files that agent-tool's installs wrote into the reviewed repository, which the
 * repository cannot edit by hand. The manifests come from the snapshot under review, so they only
 * select among the paths whose snapshot bytes match what this release installs; no path is copied
 * from them unchecked and any hand-edited or forged entry stays under normal review.
 */
export interface GeneratedFiles {
  /** Managed skill files `.agent-tool-skills.json` records, sorted. */
  readonly skills: readonly string[];
  /** Rule files `.agent-tool-permissions.json` records: whole, or holding only the recorded rules beside the repository's own settings. */
  readonly permissions: readonly { readonly path: string; readonly whole: boolean }[];
}

export const NO_GENERATED_FILES: GeneratedFiles = { skills: [], permissions: [] };

/**
 * True when the snapshot is agent-tool's own package, where generated copies are the output of
 * the code under review. The package name survives forks, renames, and local reviews without
 * GitHub; anything but an exact match counts as another repository.
 */
export function isAgentToolRepository(root: string): boolean {
  try {
    const read = readRegularFile(path.join(root, "package.json"));
    if (read.status !== "file") return false;
    const value: unknown = JSON.parse(read.contents);
    return !!value && typeof value === "object" && (value as { name?: unknown }).name === metadata.name;
  } catch {
    return false;
  }
}

/** A manifest's paths, or none when it is missing, unreadable, or not valid JSON for its format. */
function recorded<T>(read: () => T[]): T[] {
  try {
    return read();
  } catch {
    return [];
  }
}

/**
 * The changed paths agent-tool generated in the snapshot: managed skill files that
 * `.agent-tool-skills.json` records and the rule files `.agent-tool-permissions.json` records.
 * None in agent-tool's own repository, and none from a manifest that cannot be read.
 */
export function changedGeneratedFiles(snapshotRoot: string, changedPaths: readonly string[]): GeneratedFiles {
  if (isAgentToolRepository(snapshotRoot)) return NO_GENERATED_FILES;
  const changed = new Set(changedPaths);
  return {
    skills: recorded(() => managedSkillFiles(snapshotRoot)).filter(file => changed.has(file)).sort(),
    permissions: recorded(() => generatedPermissionFiles(snapshotRoot)).filter(file => changed.has(file.path)),
  };
}
