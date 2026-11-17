import metadata from "../../package.json";

/**
 * The release whose installs wrote a repository's managed files. The skills and permissions
 * manifests record it, so every upgrade changes them and a committed sync shows in the diff.
 */
export const AGENT_TOOL_VERSION: string = metadata.version;

export type CheckStatus = "missing" | "outdated" | "unmanaged" | "unchanged";
export interface ManifestVersionCheck { path: string; status: CheckStatus; recordedVersion: string | null; currentVersion: string }

/** A recorded version in the package's release format: semantic versioning, such as `0.1.64` or `1.0.0-rc.1`. */
export function validVersion(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value);
}

/**
 * A manifest's own check entry: `missing` without a manifest, and `outdated` when it records
 * no version (it predates the field) or another release than the running one, so an upgrade
 * fails the check until the install runs, even when no managed file changed.
 */
export function manifestVersionCheck(path: string, exists: boolean, recorded: string | undefined): ManifestVersionCheck {
  const status = !exists ? "missing" : recorded === AGENT_TOOL_VERSION ? "unchanged" : "outdated";
  return { path, status, recordedVersion: recorded ?? null, currentVersion: AGENT_TOOL_VERSION };
}
