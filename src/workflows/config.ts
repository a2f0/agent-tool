export interface WorkflowConfig {
  branch: { types: string[] | null; exempt: string[]; maxLength: number | null };
  commits: { signatures: "none" | "present" | "verified"; signatureHeaderFallback: boolean; rejectCoauthors: boolean; rejectClaudeAttribution: boolean; subjects: boolean };
  hooks: { files: { source: string; target: string; executable: boolean }[] };
  binaries: { allow: string[] };
}

export const WORKFLOW_DEFAULTS: WorkflowConfig = {
  branch: { types: null, exempt: ["main", "master"], maxLength: 72 },
  commits: { signatures: "none", signatureHeaderFallback: false, rejectCoauthors: true, rejectClaudeAttribution: false, subjects: false },
  hooks: { files: [] },
  binaries: { allow: [] },
};

export function relativeFile(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\\") &&
    !/[\x00-\x1f]/.test(value) && !value.split("/").some(part => !part || part === "." || part === "..");
}

export function validateWorkflowConfig(config: WorkflowConfig): void {
  const fail = (name: string): never => { throw new Error(`Invalid config setting '${name}'.`); };
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string" && item.length > 0);
  if (config.branch.types !== null && (!strings(config.branch.types) || !config.branch.types.length || config.branch.types.some(type => !/^[a-z][a-z0-9-]*$/.test(type)))) fail("branch.types");
  if (!strings(config.branch.exempt)) fail("branch.exempt");
  if (config.branch.maxLength !== null && (!Number.isSafeInteger(config.branch.maxLength) || config.branch.maxLength < 1)) fail("branch.maxLength");
  if (!["none", "present", "verified"].includes(config.commits.signatures)) fail("commits.signatures");
  if (typeof config.commits.rejectCoauthors !== "boolean") fail("commits.rejectCoauthors");
  if (typeof config.commits.subjects !== "boolean") fail("commits.subjects");
  if (typeof config.commits.signatureHeaderFallback !== "boolean") fail("commits.signatureHeaderFallback");
  if (typeof config.commits.rejectClaudeAttribution !== "boolean") fail("commits.rejectClaudeAttribution");
  if (!Array.isArray(config.hooks.files)) fail("hooks.files");
  const targets = new Set<string>();
  for (const entry of config.hooks.files) {
    if (!entry || typeof entry !== "object" || Object.keys(entry).some(key => !["source", "target", "executable"].includes(key)) || !relativeFile(entry.source) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entry.target) || typeof entry.executable !== "boolean" || targets.has(entry.target.toLowerCase())) fail("hooks.files");
    targets.add(entry.target.toLowerCase());
  }
  if (!strings(config.binaries.allow) || config.binaries.allow.some(pattern => pattern.startsWith("/") || pattern.includes("..") || pattern.includes("\\"))) fail("binaries.allow");
}
