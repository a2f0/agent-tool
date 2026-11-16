import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { packageDirectories } from "../system/workspace";

/** A test run or dependency install that a push-gate step reaches, with the chain that led to it. */
export interface StepFinding { kind: "test" | "install"; runner: string; chain: string[] }
export interface StepResolution { findings: StepFinding[]; errors: string[] }

const MAX_DEPTH = 32;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const WRAPPERS = new Set(["exec", "command", "time", "nohup", "nice"]);
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "fi", "done", "esac"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Per tool: options that take a separate value (`--name=value` needs no entry) and options that select workspaces. */
interface Tool { values: Set<string>; workspaces: Set<string> }
const tool = (values: string[], workspaces: string[] = []): Tool => ({ values: new Set(values), workspaces: new Set(workspaces) });
const TOOLS = {
  bun: tool(["--cwd", "--filter", "-F", "--env-file", "--preload", "-r", "--config", "-c", "--shell", "--elide-lines"], ["--filter", "-F", "--workspaces"]),
  npm: tool(["--prefix", "--workspace", "-w", "--registry", "--cache", "--userconfig"], ["--workspace", "-w", "--workspaces", "-ws"]),
  pnpm: tool(["-C", "--dir", "--filter", "-F", "--reporter"], ["--filter", "-F", "--recursive", "-r"]),
  yarn: tool(["--cwd"]),
  exec: tool(["-p", "--package", "-c", "--call"]),
  turbo: tool(["--filter", "-F", "--concurrency", "--cache-dir", "--output-logs", "--log-order", "--log-prefix", "--env-mode", "--ui", "--cache", "--profile", "--graph", "--summarize"]),
} as const;
const INSTALLS: Record<"bun" | "npm" | "pnpm" | "yarn", string[]> = {
  bun: ["install", "i", "add", "a", "update", "remove", "rm"],
  npm: ["install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall", "add", "ci", "clean-install", "ic", "install-clean", "isntall-clean", "update", "up", "upgrade", "install-test", "it", "install-ci-test", "cit"],
  pnpm: ["install", "i", "add", "update", "up", "upgrade", "install-test", "it"],
  yarn: ["install", "add", "up", "upgrade", "upgrade-interactive"],
};

interface Context { root: string; seen: Set<string>; findings: StepFinding[]; errors: string[] }

/**
 * Follow a declared push-gate step through package scripts, shell strings,
 * and `agent-tool run-group` plans to every test runner or dependency install
 * it reaches. Executables and script files are leaves: their contents are not
 * inspected. Workspace filters resolve to every workspace package declaring
 * the script, which can over-report but never misses one.
 */
export function resolveStep(root: string, command: string[]): StepResolution {
  const context: Context = { root, seen: new Set(), findings: [], errors: [] };
  visit(context, command, root, [display(command)], 0);
  return { findings: context.findings, errors: context.errors };
}

export function display(argv: string[]): string { return argv.map(arg => /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`).join(" "); }
function report(context: Context, kind: StepFinding["kind"], runner: string, chain: string[]): void {
  context.findings.push({ kind, runner, chain: chain.at(-1) === runner ? chain : [...chain, runner] });
}

/** Skip leading options, consuming the separate value of the ones that take one; returns the options seen. */
function options(argv: string[], spec: Tool): { rest: string[]; seen: Map<string, string | true> } {
  const seen = new Map<string, string | true>();
  let index = 0;
  while (index < argv.length && argv[index]!.startsWith("-") && argv[index] !== "--") {
    const value = argv[index]!;
    const equals = value.indexOf("=");
    if (equals > 0) seen.set(value.slice(0, equals), value.slice(equals + 1));
    else if (spec.values.has(value) && index + 1 < argv.length) { seen.set(value, argv[index + 1]!); index++; }
    else seen.set(value, true);
    index++;
  }
  return { rest: argv.slice(index), seen };
}

function directoryOption(cwd: string, seen: Map<string, string | true>): string {
  for (const name of ["--cwd", "--prefix", "-C", "--dir"]) { const value = seen.get(name); if (typeof value === "string") return path.resolve(cwd, value); }
  return cwd;
}
const workspaceScoped = (seen: Map<string, string | true>, spec: Tool) => [...seen.keys()].some(name => spec.workspaces.has(name));

function scripts(directory: string): Record<string, unknown> | null {
  const file = path.join(directory, "package.json");
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as { scripts?: unknown };
    return value.scripts && typeof value.scripts === "object" && !Array.isArray(value.scripts) ? value.scripts as Record<string, unknown> : {};
  } catch { return null; }
}

/**
 * Run a package script as its manager would: `pre<name>`, the script with its
 * arguments appended, then `post<name>`. An unknown name runs `fallback`, the
 * executable or file of that name, when the manager does so.
 */
/** Workspace packages from `package.json` workspaces and from pnpm's `pnpm-workspace.yaml`. */
function workspaceDirectories(context: Context): string[] {
  const directories = new Set(packageDirectories(context.root));
  const file = path.join(context.root, "pnpm-workspace.yaml");
  if (!existsSync(file)) return [...directories];
  let patterns: unknown;
  try { patterns = (Bun.YAML.parse(readFileSync(file, "utf8")) as { packages?: unknown } | null)?.packages; }
  catch (error) { context.errors.push(`Cannot read pnpm-workspace.yaml: ${(error as Error).message}`); return [...directories]; }
  const list = (Array.isArray(patterns) ? patterns : []).filter((pattern): pattern is string => typeof pattern === "string");
  const excluded = list.filter(pattern => pattern.startsWith("!")).map(pattern => new Bun.Glob(pattern.slice(1).replace(/\/$/, "")));
  for (const pattern of list.filter(pattern => !pattern.startsWith("!"))) {
    for (const match of new Bun.Glob(`${pattern.replace(/\/$/, "")}/package.json`).scanSync({ cwd: context.root, onlyFiles: true })) {
      const relative = path.dirname(match);
      if (!match.split("/").includes("node_modules") && !excluded.some(glob => glob.match(relative))) directories.add(path.join(context.root, relative));
    }
  }
  return [...directories];
}

function runScript(context: Context, name: string, args: string[], directory: string, workspaces: boolean, chain: string[], depth: number, fallback: string[] | null): void {
  const directories = workspaces ? workspaceDirectories(context).filter(dir => typeof scripts(dir)?.[name] === "string") : [directory];
  let found = false;
  for (const dir of directories) {
    const table = scripts(dir);
    for (const script of [`pre${name}`, name, `post${name}`]) {
      const body = table?.[script];
      if (typeof body !== "string") continue;
      if (script === name) found = true;
      const key = `${dir}\0${script}`;
      if (context.seen.has(key)) continue;
      const manifest = path.relative(context.root, path.join(dir, "package.json")) || "package.json";
      const text = script === name && args.length ? `${body} ${display(args)}` : body;
      context.seen.add(key);
      visitShell(context, text, dir, [...chain, `${manifest} scripts.${script}: ${text}`], depth + 1);
      context.seen.delete(key);
    }
  }
  if (!found && fallback) visit(context, fallback, directory, chain, depth + 1);
}

function visit(context: Context, input: string[], cwd: string, chain: string[], depth: number): void {
  if (depth > MAX_DEPTH) { context.errors.push(`Resolution deeper than ${MAX_DEPTH} levels: ${chain.join(" -> ")}`); return; }
  const argv = [...input];
  while (argv.length && (ASSIGNMENT.test(argv[0]!) || WRAPPERS.has(argv[0]!))) argv.shift();
  if (argv[0] === "env") { argv.shift(); while (argv.length && (argv[0]!.startsWith("-") || ASSIGNMENT.test(argv[0]!))) argv.shift(); }
  if (!argv.length) return;
  // `npx vitest@4` names the runner with a version selector.
  const name = path.basename(argv[0]!).replace(/(?<=.)@[^@/]*$/, "");
  const args = argv.slice(1);
  const text = display(argv);
  if (SHELLS.has(name)) {
    const flagIndex = args.findIndex(arg => /^-[a-z]*c[a-z]*$/.test(arg));
    if (flagIndex !== -1 && args[flagIndex + 1] !== undefined) visitShell(context, args[flagIndex + 1]!, cwd, chain, depth + 1);
  } else if (name === "agent-tool" || ((name === "bun" || name === "node") && /(?:^|\/)agent-tool\/src\/index\.ts$/.test(args[0] ?? ""))) {
    agentTool(context, name === "agent-tool" ? args : args.slice(1), cwd, chain, depth);
  } else if (name === "bun") bun(context, args, cwd, chain, depth, text);
  else if (name === "bunx" || name === "npx") { const { rest } = options(args, TOOLS.exec); if (rest.length) visit(context, rest, cwd, chain, depth + 1); }
  else if (name === "npm" || name === "pnpm" || name === "yarn") packageManager(context, name, args, cwd, chain, depth, text);
  else if (name === "turbo") { if (turboTasks(args).some(task => /^test/.test(task.slice(task.lastIndexOf("#") + 1)))) report(context, "test", text, chain); }
  else if (testRunner(name, args)) report(context, "test", text, chain);
  else if (["pod", "bundle", "pip", "pip3"].includes(name) && args[0] === "install") report(context, "install", text, chain);
  else if (name === "bundle" && args[0] === "exec") visit(context, args.slice(1), cwd, chain, depth + 1);
}

function turboTasks(args: string[]): string[] {
  const rest = args[0] === "run" ? args.slice(1) : args;
  const tasks: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const value = rest[index]!;
    if (value === "--") break;
    if (value.startsWith("-")) { if (!value.includes("=") && TOOLS.turbo.values.has(value)) index++; continue; }
    tasks.push(value);
  }
  return tasks;
}

function testRunner(name: string, args: string[]): boolean {
  if (["jest", "vitest", "mocha", "ava", "maestro", "detox", "pytest", "rspec"].includes(name)) return true;
  const first = args.find(arg => !arg.startsWith("-"));
  if (name === "node") return args.some(arg => arg === "--test" || arg.startsWith("--test="));
  if (["playwright", "deno", "go", "swift"].includes(name)) return first === "test";
  if (name === "cargo") return first === "test" || first === "nextest";
  if (name === "gradle" || name === "gradlew") return args.some(arg => /^(?::?[\w-]+:)*test\w*$/i.test(arg));
  if (name === "xcodebuild") return args.some(arg => arg === "test" || arg === "test-without-building");
  if (/^python[\d.]*$/.test(name)) return args[0] === "-m" && args[1] === "pytest";
  return false;
}

function bun(context: Context, args: string[], cwd: string, chain: string[], depth: number, text: string): void {
  const { rest, seen } = options(args, TOOLS.bun);
  const directory = directoryOption(cwd, seen);
  const sub = rest[0];
  if (!sub) return;
  if (sub === "test") report(context, "test", text, chain);
  else if (INSTALLS.bun.includes(sub)) report(context, "install", text, chain);
  else if (sub === "x") { const inner = options(rest.slice(1), TOOLS.exec).rest; if (inner.length) visit(context, inner, directory, chain, depth + 1); }
  else if (sub === "exec") { if (rest[1]) visitShell(context, rest[1], directory, chain, depth + 1); }
  else if (sub === "run") {
    const run = options(rest.slice(1), TOOLS.bun);
    const target = run.rest[0];
    if (target) runScript(context, target, run.rest.slice(1).filter(arg => arg !== "--"), directoryOption(directory, run.seen), workspaceScoped(seen, TOOLS.bun) || workspaceScoped(run.seen, TOOLS.bun), chain, depth, run.rest);
  }
  // `bun <name>` runs a package script of that name, else a file or built-in.
  else runScript(context, sub, rest.slice(1), directory, workspaceScoped(seen, TOOLS.bun), chain, depth, null);
}

/** npm reads its own options anywhere before `--`, so `npm run check --workspaces` selects workspaces. */
function npmOptions(args: string[]): { rest: string[]; seen: Map<string, string | true> } {
  const separator = args.indexOf("--");
  const before = separator === -1 ? args : args.slice(0, separator);
  const seen = new Map<string, string | true>(), positional: string[] = [];
  for (let index = 0; index < before.length; index++) {
    const value = before[index]!;
    if (!value.startsWith("-")) { positional.push(value); continue; }
    const equals = value.indexOf("=");
    if (equals > 0) seen.set(value.slice(0, equals), value.slice(equals + 1));
    else if (TOOLS.npm.values.has(value) && index + 1 < before.length) seen.set(value, before[++index]!);
    else seen.set(value, true);
  }
  return { rest: separator === -1 ? positional : [...positional, ...args.slice(separator)], seen };
}

function packageManager(context: Context, manager: "npm" | "pnpm" | "yarn", args: string[], cwd: string, chain: string[], depth: number, text: string): void {
  const spec = TOOLS[manager];
  const { rest, seen } = manager === "npm" ? npmOptions(args) : options(args, spec);
  const directory = directoryOption(cwd, seen);
  const workspaces = workspaceScoped(seen, spec);
  const sub = rest[0];
  // Arguments after `--` reach the script; the manager drops the separator itself.
  const scriptArgs = (values: string[]) => { const at = values.indexOf("--"); return at === -1 ? values : [...values.slice(0, at), ...values.slice(at + 1)]; };
  if (!sub) { if (manager === "yarn") report(context, "install", text, chain); }
  else if (INSTALLS[manager].includes(sub)) report(context, "install", text, chain);
  else if (["run", "run-script", "rum", "urn"].includes(sub)) {
    const run = options(rest.slice(1), spec);
    if (run.rest[0]) runScript(context, run.rest[0], scriptArgs(run.rest.slice(1)), directoryOption(directory, run.seen), workspaces || workspaceScoped(run.seen, spec), chain, depth, manager === "npm" ? null : run.rest);
  } else if (["test", "t", "tst", "start", "stop", "restart"].includes(sub)) {
    runScript(context, ["t", "tst"].includes(sub) ? "test" : sub, scriptArgs(rest.slice(1)), directory, workspaces, chain, depth, null);
  } else if (["exec", "x", "dlx"].includes(sub)) {
    const inner = options(rest.slice(1), TOOLS.exec).rest;
    const command = inner[0] === "--" ? inner.slice(1) : inner;
    if (command.length) visit(context, command, directory, chain, depth + 1);
  }
  // pnpm and yarn run a script by its bare name, else an installed executable of that name.
  else if (manager !== "npm") runScript(context, sub, rest.slice(1), directory, workspaces, chain, depth, rest);
}

function agentTool(context: Context, input: string[], invokedIn: string, chain: string[], depth: number): void {
  const args = [...input];
  // `--repo` moves the command, and the run-group plans it resolves, to that checkout.
  let cwd = invokedIn, repo: string | null = null;
  while (args[0] === "--repo" || args[0] === "--config") { if (args[0] === "--repo" && args[1]) { cwd = path.resolve(cwd, args[1]); repo = cwd; } args.splice(0, 2); }
  const text = display(["agent-tool", ...args]);
  if (args[0] === "run-group" && args[1]) {
    const plan = path.resolve(repo ?? context.root, args[1]);
    const relative = path.relative(context.root, plan);
    let steps: { label: string; command: string[] }[];
    try {
      const value = JSON.parse(readFileSync(plan, "utf8")) as { steps?: unknown };
      const valid = (step: unknown): step is { label: string; command: string[] } => !!step && typeof (step as { label?: unknown }).label === "string" && Array.isArray((step as { command?: unknown }).command) && ((step as { command: unknown[] }).command).every(arg => typeof arg === "string");
      if (!Array.isArray(value.steps) || !value.steps.every(valid)) throw new Error("expected steps with a label and command");
      steps = value.steps;
    } catch (error) { context.errors.push(`Cannot read run-group plan ${relative} (${chain.join(" -> ")}): ${(error as Error).message}`); return; }
    for (const step of steps) visit(context, step.command, repo ?? context.root, [...chain, `${relative} step ${step.label}: ${display(step.command)}`], depth + 1);
  } else if (args[0] === "run") {
    const separator = args.indexOf("--");
    if (separator !== -1) visit(context, args.slice(separator + 1), cwd, chain, depth + 1);
  } else if (args[0] === "bun") {
    if (args[1] === "test") report(context, "test", text, chain);
    else if (["install", "add", "update", "remove"].includes(args[1] ?? "")) report(context, "install", text, chain);
    else if (args[1] === "x" && args[2]) { const separator = args.indexOf("--"); visit(context, [args[2], ...(separator === -1 ? [] : args.slice(separator + 1))], cwd, chain, depth + 1); }
  }
}

/**
 * Split a shell string into simple commands at `&&`, `||`, `;`, `|`, `&`,
 * newlines, and parentheses, honoring quotes; `cd <dir>` moves later commands.
 * Command substitutions, functions, and loops are not interpreted.
 */
function visitShell(context: Context, script: string, cwd: string, chain: string[], depth: number): void {
  let directory = cwd;
  // A `cd` inside parentheses ends with its subshell.
  const outer: string[] = [];
  for (const item of parseShell(script)) {
    if (item === "(") { outer.push(directory); continue; }
    if (item === ")") { directory = outer.pop() ?? directory; continue; }
    const words = item;
    while (words.length && KEYWORDS.has(words[0]!)) words.shift();
    if (!words.length || words[0] === "for" || words[0] === "case" || /\(\)$/.test(words[0]!)) continue;
    if (words[0] === "cd") { if (words[1] && words[1] !== "-" && !words[1].startsWith("$")) directory = path.resolve(directory, words[1]); continue; }
    visit(context, words, directory, chain, depth + 1);
  }
}

export function splitShell(script: string): string[][] {
  return parseShell(script).filter((item): item is string[] => Array.isArray(item));
}

/** Simple commands in order, with `(` and `)` marking where a subshell starts and ends. */
function parseShell(script: string): (string[] | "(" | ")")[] {
  const commands: (string[] | "(" | ")")[] = [];
  let words: string[] = [];
  let word = "";
  let quoted = false;
  const endWord = () => { if (word || quoted) words.push(word); word = ""; quoted = false; };
  const endCommand = () => { endWord(); const kept = dropRedirections(words); if (kept.length) commands.push(kept); words = []; };
  for (let index = 0; index < script.length; index++) {
    const char = script[index]!;
    if (char === "\\" && index + 1 < script.length) { if (script[index + 1] !== "\n") word += script[index + 1]; index++; }
    else if (char === "'") { const end = script.indexOf("'", index + 1); word += script.slice(index + 1, end === -1 ? undefined : end); quoted = true; index = end === -1 ? script.length : end; }
    else if (char === '"') {
      let end = index + 1;
      while (end < script.length && script[end] !== '"') {
        if (script[end] === "\\" && end + 1 < script.length) { word += script[end + 1]; end += 2; } else { word += script[end]; end++; }
      }
      quoted = true; index = end;
    } else if (char === "#" && !word && !quoted) { const end = script.indexOf("\n", index); index = end === -1 ? script.length : end - 1; }
    else if (char === "$" && script[index + 1] === "(") {
      // Keep a command substitution inside its word rather than splitting on its operators.
      let level = 0, end = index + 1;
      for (; end < script.length; end++) { if (script[end] === "(") level++; else if (script[end] === ")" && --level === 0) break; }
      word += script.slice(index, end + 1); index = end;
    } else if ("&|;\n()".includes(char)) {
      // `2>&1` and `&>` are redirections, not separators.
      if (char === "&" && (word.endsWith(">") || script[index + 1] === ">")) { word += char; continue; }
      endCommand();
      if (char === "(" || char === ")") commands.push(char);
      else if ((char === "&" || char === "|") && script[index + 1] === char) index++;
    } else if (char === " " || char === "\t") endWord();
    else word += char;
  }
  endCommand();
  return commands;
}

function dropRedirections(words: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < words.length; index++) {
    const value = words[index]!;
    if (/^\d*(?:>>?|<|&>>?)(?:&\d*)?$/.test(value) && !/&\d+$/.test(value)) { index++; continue; }
    if (/^\d*(?:>>?|<|&>>?)/.test(value)) continue;
    result.push(value);
  }
  return result;
}
