import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { GRAPH_DEFAULTS, parseGraph, type GraphConfig } from "./graph/config";
import { parseImages, type ImagesConfig } from "./images/config";
import { CLASSES, type PermissionClass } from "./permissions/catalog";
import { parseScreenshots, SCREENSHOTS_DEFAULTS, type ScreenshotsConfig } from "./screenshots/config";
import { WORKFLOW_DEFAULTS, validateWorkflowConfig, type WorkflowConfig } from "./workflows/config";

export interface RequiredCheck {
  name: string;
  workflow?: string;
}

/** A declared push-gate step: run-group's step shape plus a visible reason when it may be slow. */
export interface PushGateStep { label: string; command: string[]; allowSlow?: string }
export interface PushGateConfig { steps: PushGateStep[]; budgetSeconds: number }

export interface AgentToolConfig extends WorkflowConfig {
  schemaVersion: 1;
  subject: { conventional: boolean; maxLength: number; types: string[]; lowercaseInitial: boolean; rejectTerminalPeriod: boolean; ignoreGenerated: boolean };
  merge: { requireChecks: boolean; requiredChecks: RequiredCheck[]; requireStrictBaseFreshness: boolean; checksTimeoutSeconds: number };
  review: { claudeModel: string | null; codexModel: string | null; opencodeModel: string; opencodeVariants: Record<string, string>; timeoutMs: number };
  versions: { packages: string[] | null; bundles: string[]; lockfile: "bun.lock" | null; validate: string[][]; commitMessage: string };
  pr: { rejectClaudeBranding: boolean };
  images: ImagesConfig;
  screenshots: ScreenshotsConfig;
  graph: GraphConfig;
  permissions: { executables: Record<string, PermissionClass> };
  /** Null when the repository declares no push gate. */
  pushGate: PushGateConfig | null;
}

export const DEFAULT_CONFIG: AgentToolConfig = {
  ...WORKFLOW_DEFAULTS,
  schemaVersion: 1,
  subject: {
    conventional: true,
    maxLength: 72,
    types: ["feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert"],
    lowercaseInitial: false,
    rejectTerminalPeriod: false,
    ignoreGenerated: false,
  },
  merge: { requireChecks: true, requiredChecks: [], requireStrictBaseFreshness: false, checksTimeoutSeconds: 900 },
  review: { claudeModel: null, codexModel: null, opencodeModel: "deepseek/deepseek-v4-pro", opencodeVariants: { low: "low", medium: "medium", high: "high", xhigh: "max", max: "max" }, timeoutMs: 600_000 },
  versions: { packages: null, bundles: [], lockfile: "bun.lock", validate: [], commitMessage: "chore: bump package versions" },
  pr: { rejectClaudeBranding: false },
  images: { targets: {} },
  screenshots: structuredClone(SCREENSHOTS_DEFAULTS),
  graph: structuredClone(GRAPH_DEFAULTS),
  permissions: { executables: {} },
  pushGate: null,
};

export const PUSH_GATE_BUDGET_SECONDS = 120;

/** Same step rules as run-group plans, plus an optional non-empty `allowSlow` reason. */
function parsePushGate(value: unknown): PushGateConfig {
  const input = object(value, "pushGate");
  keys(input, ["steps", "budgetSeconds"], "pushGate");
  const invalid = (setting: string): never => { throw new Error(`Invalid config setting 'pushGate.${setting}'.`); };
  const budgetSeconds = input.budgetSeconds ?? PUSH_GATE_BUDGET_SECONDS;
  if (!Number.isSafeInteger(budgetSeconds) || (budgetSeconds as number) < 1 || (budgetSeconds as number) > 86400) invalid("budgetSeconds");
  const steps = input.steps ?? [];
  if (!Array.isArray(steps)) invalid("steps");
  const label = (text: unknown) => typeof text === "string" && text.length > 0 && text.length <= 120 && !/[\x00-\x1f]/.test(text);
  const labels = new Set<string>();
  const parsed = (steps as unknown[]).map(step => {
    const entry = object(step, "pushGate.steps entry");
    keys(entry, ["label", "command", "allowSlow"], "pushGate.steps entry");
    const { command, allowSlow } = entry;
    if (!label(entry.label) || labels.has(entry.label as string)) invalid("steps");
    if (!Array.isArray(command) || !command.length || !command.every(arg => typeof arg === "string" && !arg.includes("\0")) || !command[0]) invalid("steps");
    if (allowSlow !== undefined && (typeof allowSlow !== "string" || !allowSlow.trim() || /[\x00-\x1f]/.test(allowSlow))) invalid("steps");
    labels.add(entry.label as string);
    return { label: entry.label as string, command: [...command as string[]], ...(allowSlow === undefined ? {} : { allowSlow: allowSlow as string }) };
  });
  return { steps: parsed, budgetSeconds: budgetSeconds as number };
}

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
  for (const section of ["subject", "merge", "review", "versions", "pr", "branch", "commits", "hooks", "binaries", "permissions"] as const) {
    if (input[section] === undefined) continue;
    const settings = object(input[section], section);
    keys(settings, Object.keys(result[section]), section);
    Object.assign(result[section], settings);
  }
  if (input.images !== undefined) result.images = parseImages(input.images);
  if (input.screenshots !== undefined) result.screenshots = parseScreenshots(input.screenshots);
  if (input.graph !== undefined) result.graph = parseGraph(input.graph);
  if (input.pushGate !== undefined && input.pushGate !== null) result.pushGate = parsePushGate(input.pushGate);
  if (input.branch !== undefined && !Object.hasOwn(input.branch as object, "enforce")) result.branch.enforce = true;
  const invalid = (setting: string): never => { throw new Error(`Invalid config setting '${setting}'.`); };
  if (typeof result.subject.conventional !== "boolean") invalid("subject.conventional");
  for (const key of ["lowercaseInitial", "rejectTerminalPeriod", "ignoreGenerated"] as const) if (typeof result.subject[key] !== "boolean") invalid(`subject.${key}`);
  if (!Number.isSafeInteger(result.subject.maxLength) || result.subject.maxLength < 1) invalid("subject.maxLength");
  if (!strings(result.subject.types) || result.subject.types.length === 0 || result.subject.types.some(type => !/^[a-z]+$/.test(type))) invalid("subject.types");
  if (typeof result.merge.requireChecks !== "boolean") invalid("merge.requireChecks");
  if (!Array.isArray(result.merge.requiredChecks)) invalid("merge.requiredChecks");
  if (typeof result.merge.requireStrictBaseFreshness !== "boolean") invalid("merge.requireStrictBaseFreshness");
  // Same bounds as `--timeout`, which still overrides it on the command line.
  if (!Number.isSafeInteger(result.merge.checksTimeoutSeconds) || result.merge.checksTimeoutSeconds < 0 || result.merge.checksTimeoutSeconds > 86400) invalid("merge.checksTimeoutSeconds");
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
  // OpenCode 2 takes the model as provider/model#variant, so neither part may contain '#'.
  for (const value of Object.values(variants)) if (typeof value !== "string" || !/^[^\s#]+$/.test(value)) invalid("review.opencodeVariants");
  if (typeof result.review.opencodeModel !== "string" || !/^[^\s/#]+\/[^\s#]+$/.test(result.review.opencodeModel)) invalid("review.opencodeModel");
  if (!Number.isSafeInteger(result.review.timeoutMs) || result.review.timeoutMs < 1000 || result.review.timeoutMs > 3_600_000) invalid("review.timeoutMs");
  const packageDirs = (dirs: unknown): boolean => strings(dirs) && !dirs.some(dir => dir !== "." && (path.isAbsolute(dir) || dir.includes("\\") || dir.split("/").some(part => !part || part === "." || part === "..")));
  if (result.versions.packages !== null && !packageDirs(result.versions.packages)) invalid("versions.packages");
  if (!packageDirs(result.versions.bundles)) invalid("versions.bundles");
  if (result.versions.lockfile !== null && result.versions.lockfile !== "bun.lock") invalid("versions.lockfile");
  // Commands are argv arrays resolved on PATH outside the repository; no shell.
  if (!Array.isArray(result.versions.validate) || result.versions.validate.some(command => !strings(command) || command.length === 0 || !/^[\w.+-]+$/.test(command[0]!))) invalid("versions.validate");
  if (typeof result.versions.commitMessage !== "string" || !result.versions.commitMessage.trim() || /[\r\n]/.test(result.versions.commitMessage)) invalid("versions.commitMessage");
  if (typeof result.pr.rejectClaudeBranding !== "boolean") invalid("pr.rejectClaudeBranding");
  // Names become literal tokens in harness rules, so keep them free of rule syntax.
  const executables = object(result.permissions.executables, "permissions.executables");
  for (const [name, value] of Object.entries(executables)) if (!/^[\w.+-]+$/.test(name) || !(typeof value === "string" && Object.hasOwn(CLASSES, value))) invalid(`permissions.executables.${name}`);
  validateWorkflowConfig(result);
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
