import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

export interface RequiredCheck {
  name: string;
  workflow?: string;
}

export interface AgentToolConfig {
  schemaVersion: 1;
  subject: { conventional: boolean; maxLength: number; types: string[] };
  merge: { requireChecks: boolean; requiredChecks: RequiredCheck[] };
  review: { claudeModel: string | null; codexModel: string | null; opencodeModel: string; opencodeVariants: Record<string, string>; timeoutMs: number };
  versions: { packages: string[] | null };
  pr: { rejectClaudeBranding: boolean };
}

export const DEFAULT_CONFIG: AgentToolConfig = {
  schemaVersion: 1,
  subject: {
    conventional: true,
    maxLength: 72,
    types: ["feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert"],
  },
  merge: { requireChecks: true, requiredChecks: [] },
  review: { claudeModel: null, codexModel: null, opencodeModel: "deepseek/deepseek-v4-pro", opencodeVariants: { low: "low", medium: "medium", high: "high", xhigh: "max", max: "max" }, timeoutMs: 600_000 },
  versions: { packages: null },
  pr: { rejectClaudeBranding: false },
};

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], name: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown ${name} setting '${key}'.`);
  }
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string" && item.length > 0);
}

/** Data-only policy: never import repository JavaScript or commitlint code. */
export function parseConfig(source: string): AgentToolConfig {
  const input = object(JSON.parse(source), "config");
  keys(input, Object.keys(DEFAULT_CONFIG), "config");
  if (input.schemaVersion !== 1) throw new Error("Unsupported config schemaVersion; expected 1.");
  const result = structuredClone(DEFAULT_CONFIG);
  for (const section of ["subject", "merge", "review", "versions", "pr"] as const) {
    if (input[section] === undefined) continue;
    const settings = object(input[section], section);
    keys(settings, Object.keys(result[section]), section);
    Object.assign(result[section], settings);
  }
  const invalid = (setting: string): never => { throw new Error(`Invalid config setting '${setting}'.`); };
  if (typeof result.subject.conventional !== "boolean") invalid("subject.conventional");
  if (!Number.isSafeInteger(result.subject.maxLength) || result.subject.maxLength < 1) invalid("subject.maxLength");
  if (!strings(result.subject.types) || result.subject.types.length === 0 || result.subject.types.some(type => !/^[a-z]+$/.test(type))) invalid("subject.types");
  if (typeof result.merge.requireChecks !== "boolean") invalid("merge.requireChecks");
  if (!Array.isArray(result.merge.requiredChecks)) invalid("merge.requiredChecks");
  for (const check of result.merge.requiredChecks) {
    const entry = object(check, "merge.requiredChecks entry");
    keys(entry, ["name", "workflow"], "merge.requiredChecks entry");
    if (typeof check.name !== "string" || !check.name.trim() || (check.workflow !== undefined && (typeof check.workflow !== "string" || !check.workflow.trim()))) invalid("merge.requiredChecks");
  }
  for (const key of ["claudeModel", "codexModel"] as const) {
    if (result.review[key] !== null && (typeof result.review[key] !== "string" || !/^[^\s]+$/.test(result.review[key]!))) invalid(`review.${key}`);
  }
  const variants = object(result.review.opencodeVariants, "review.opencodeVariants");
  keys(variants, ["low", "medium", "high", "xhigh", "max"], "review.opencodeVariants");
  for (const value of Object.values(variants)) if (typeof value !== "string" || !/^[^\s]+$/.test(value)) invalid("review.opencodeVariants");
  if (typeof result.review.opencodeModel !== "string" || !/^[^\s/]+\/[^\s]+$/.test(result.review.opencodeModel)) invalid("review.opencodeModel");
  if (!Number.isSafeInteger(result.review.timeoutMs) || result.review.timeoutMs < 1000 || result.review.timeoutMs > 3_600_000) invalid("review.timeoutMs");
  if (result.versions.packages !== null) {
    if (!strings(result.versions.packages) || result.versions.packages.some(dir => path.isAbsolute(dir) || dir.includes("\\") || dir.split("/").some(part => !part || part === "." || part === ".."))) invalid("versions.packages");
  }
  if (typeof result.pr.rejectClaudeBranding !== "boolean") invalid("pr.rejectClaudeBranding");
  return result;
}

/** Explicit file wins; project policy is opt-in through agent-tool.json. */
export function loadConfig(rootDir: string = process.cwd()): AgentToolConfig {
  const explicit = process.env.AGENT_TOOL_CONFIG;
  const file = explicit ? path.resolve(explicit) : path.join(rootDir, "agent-tool.json");
  if (!existsSync(file)) {
    if (explicit) throw new Error(`Config file does not exist: ${file}`);
    return structuredClone(DEFAULT_CONFIG);
  }
  if (!lstatSync(file).isFile()) throw new Error(`Config must be a regular file: ${file}`);
  return parseConfig(readFileSync(file, "utf8"));
}
