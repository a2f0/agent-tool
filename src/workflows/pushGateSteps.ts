import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { packageDirectories } from "../system/workspace";

/** A test run, build, or dependency install that a push-gate step reaches, with the chain that led to it. */
export interface StepFinding { kind: "test" | "build" | "install"; runner: string; chain: string[] }
export interface StepResolution { findings: StepFinding[]; errors: string[] }

const MAX_DEPTH = 32;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
/** Commands that run the command after them, with their options that take a separate value. */
const WRAPPERS: ReadonlyMap<string, ReadonlySet<string>> = new Map(Object.entries({
  exec: ["-a"], command: [], nohup: [], nice: ["-n", "--adjustment"], time: ["-o", "--output", "-f", "--format"],
  timeout: ["-s", "--signal", "-k", "--kill-after"], stdbuf: ["-i", "-o", "-e", "--input", "--output", "--error"],
  env: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-P", "-L", "-U"],
}).map(([name, values]) => [name, new Set(values)]));
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "fi", "done", "esac"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Per tool: options that take a separate value (`--name=value` needs no entry) and options that select workspaces. */
interface Tool { values: Set<string>; workspaces: Set<string> }
const tool = (values: string[], workspaces: string[] = []): Tool => ({ values: new Set(values), workspaces: new Set(workspaces) });
const TOOLS = {
  bun: tool(["--cwd", "--filter", "-F", "--env-file", "--preload", "-r", "--config", "-c", "--shell", "--elide-lines"], ["--filter", "-F", "--workspaces"]),
  npm: tool(["--prefix", "--workspace", "-w", "--registry", "--cache", "--userconfig", "-c", "--call", "-p", "--package"], ["--workspace", "-w", "--workspaces", "-ws"]),
  pnpm: tool(["-C", "--dir", "--filter", "-F", "--reporter"], ["--filter", "-F", "--recursive", "-r"]),
  yarn: tool(["--cwd"]),
  exec: tool(["-p", "--package", "-c", "--call"]),
  turbo: tool(["--filter", "-F", "--concurrency", "--cache-dir", "--output-logs", "--log-order", "--log-prefix", "--env-mode", "--ui", "--cache", "--profile", "--graph", "--summarize", "--cwd", "--root-turbo-json", "--heap", "--team", "--token", "--api", "--login", "--trace", "--cpuprofile", "--remote-cache-timeout", "--cache-workers", "--pkg-inference-root"]),
} as const;
const INSTALLS: Record<"bun" | "npm" | "pnpm" | "yarn", string[]> = {
  bun: ["install", "i", "add", "a", "update", "remove", "rm"],
  npm: ["install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall", "add", "ci", "clean-install", "ic", "install-clean", "isntall-clean", "update", "up", "upgrade", "install-test", "it", "install-ci-test", "cit"],
  pnpm: ["install", "i", "add", "update", "up", "upgrade", "install-test", "it"],
  yarn: ["install", "add", "up", "upgrade", "upgrade-interactive"],
};

/** `env` holds the variables a command assigns for itself and its children, such as `UV_NO_SYNC=1`. */
interface Context { root: string; seen: Set<string>; findings: StepFinding[]; errors: string[]; env: Readonly<Record<string, string>> }

/**
 * Follow a declared push-gate step through package scripts, shell strings,
 * command runners such as `env`, `uv run`, or `python -m`, and `agent-tool
 * run-group` plans to every test runner, build, or dependency install it
 * reaches. Executables and script files are leaves: their contents are not
 * inspected. Workspace filters resolve to every workspace package declaring
 * the script, which can over-report but never misses one. A command that both
 * builds and tests, such as `cargo test`, is reported once, as a test; a runner
 * that installs before running its command, such as `uv run pytest`, is
 * reported as an install and its command as what it does.
 */
export function resolveStep(root: string, command: string[]): StepResolution {
  const context: Context = { root, seen: new Set(), findings: [], errors: [], env: {} };
  visit(context, command, root, [display(command)], 0);
  return { findings: context.findings, errors: context.errors };
}

export function display(argv: string[]): string { return argv.map(arg => /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`).join(" "); }
function report(context: Context, kind: StepFinding["kind"], runner: string, chain: string[]): void {
  context.findings.push({ kind, runner, chain: chain.at(-1) === runner ? chain : [...chain, runner] });
}

/**
 * The options in one word, as getopt reads them: `--name=value`, `--name`
 * with its value in the next word, or bundled short options (`-iC dir`,
 * `-Cdir`), where the first that takes a value takes the rest of the word or,
 * when nothing is left, the next word, which `next` supplies.
 */
function optionWords(word: string, takesValue: ReadonlySet<string>, next: () => string | undefined): [string, string | undefined][] {
  if (word.startsWith("--") || word.length <= 2) {
    const equals = word.indexOf("=");
    return equals > 0 ? [[word.slice(0, equals), word.slice(equals + 1)]] : [[word, takesValue.has(word) ? next() : undefined]];
  }
  const found: [string, string | undefined][] = [];
  for (let at = 1; at < word.length; at++) {
    const name = `-${word[at]}`;
    if (!takesValue.has(name)) { found.push([name, undefined]); continue; }
    const rest = word.slice(at + 1).replace(/^=/, "");
    found.push([name, rest || next()]);
    break;
  }
  return found;
}

/** Skip leading options, consuming the separate value of the ones that take one; returns the options seen. */
function options(argv: string[], spec: Tool): { rest: string[]; seen: Map<string, string | true> } {
  const seen = new Map<string, string | true>();
  let index = 0;
  while (index < argv.length && argv[index]!.startsWith("-") && argv[index] !== "--") {
    for (const [name, value] of optionWords(argv[index]!, spec.values, () => index + 1 < argv.length ? argv[++index] : undefined)) seen.set(name, value ?? true);
    index++;
  }
  return { rest: argv.slice(index), seen };
}

/** `npx`, `bunx`, `bun x`, and `<manager> exec|dlx`: a command after an optional `--`, or a shell string given to `--call`. */
function execute(context: Context, args: string[], cwd: string, chain: string[], depth: number): void {
  const { rest, seen } = options(args, TOOLS.exec);
  const call = seen.get("--call") ?? seen.get("-c");
  if (typeof call === "string") visitShell(context, call, cwd, chain, depth + 1);
  const command = rest[0] === "--" ? rest.slice(1) : rest;
  if (command.length) visit(context, command, cwd, chain, depth + 1);
}

/** `run [options] [--] <script> [args]`: a `--` before the script name only ends the manager's options. */
function scriptOptions(args: string[], spec: Tool): { rest: string[]; seen: Map<string, string | true> } {
  const parsed = options(args, spec);
  return parsed.rest[0] === "--" ? { rest: parsed.rest.slice(1), seen: parsed.seen } : parsed;
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
/** Workspace packages of the workspace rooted at `root` (the repository's by default), from `package.json` workspaces and pnpm's `pnpm-workspace.yaml`. */
function workspaceDirectories(context: Context, root = context.root): string[] {
  const directories = new Set(packageDirectories(root));
  const file = path.join(root, "pnpm-workspace.yaml");
  if (!existsSync(file)) return [...directories];
  let patterns: unknown;
  try { patterns = (Bun.YAML.parse(readFileSync(file, "utf8")) as { packages?: unknown } | null)?.packages; }
  catch (error) { context.errors.push(`Cannot read ${path.relative(context.root, file) || file}: ${(error as Error).message}`); return [...directories]; }
  const list = (Array.isArray(patterns) ? patterns : []).filter((pattern): pattern is string => typeof pattern === "string");
  const excluded = list.filter(pattern => pattern.startsWith("!")).map(pattern => new Bun.Glob(pattern.slice(1).replace(/\/$/, "")));
  for (const pattern of list.filter(pattern => !pattern.startsWith("!"))) {
    for (const match of new Bun.Glob(`${pattern.replace(/\/$/, "")}/package.json`).scanSync({ cwd: root, onlyFiles: true })) {
      const relative = path.dirname(match);
      if (!match.split("/").includes("node_modules") && !excluded.some(glob => glob.match(relative))) directories.add(path.join(root, relative));
    }
  }
  return [...directories];
}

/** Package managers run scripts from the nearest `package.json` (or other `manifest`) at or above the directory, within the repository. */
function packageRoot(context: Context, directory: string, manifest = "package.json"): string {
  let current = directory;
  while (!existsSync(path.join(current, manifest)) && current !== context.root && current.startsWith(`${context.root}${path.sep}`)) current = path.dirname(current);
  return current;
}

function runScript(context: Context, name: string, args: string[], directory: string, workspaces: boolean, chain: string[], depth: number, fallback: string[] | null): void {
  const directories = workspaces ? workspaceDirectories(context).filter(dir => typeof scripts(dir)?.[name] === "string") : [packageRoot(context, directory)];
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

/**
 * Strip what runs a command rather than being it: `NAME=value` assignments and
 * wrappers such as `env -u NAME`, `nice -n 5`, or `timeout 60`, with their
 * options. Returns the command, the directory it runs in (`env -C`), and the
 * variables it sets, or null when nothing runs (`command -v`).
 */
function unwrap(input: string[], cwd: string, inherited: Context["env"]): { argv: string[]; cwd: string; env: Context["env"] } | null {
  const argv = [...input];
  let directory = cwd, env = inherited;
  while (argv.length) {
    const word = argv[0]!;
    if (ASSIGNMENT.test(word)) { const equals = word.indexOf("="); env = { ...env, [word.slice(0, equals)]: word.slice(equals + 1) }; argv.shift(); continue; }
    const wrapper = path.basename(word);
    const takesValue = WRAPPERS.get(wrapper);
    if (!takesValue) break;
    argv.shift();
    while (argv[0]?.startsWith("-")) {
      const option = argv.shift()!;
      if (option === "--") break;
      for (const [name, value] of optionWords(option, takesValue, () => argv.shift())) {
        // `command -v` and `command -V` only describe the command.
        if (wrapper === "command" && (name === "-v" || name === "-V")) return null;
        // `exec -c` and `env -i` start the command with an empty environment.
        if ((wrapper === "exec" && name === "-c") || (wrapper === "env" && (name === "-" || name === "-i" || name === "--ignore-environment"))) env = {};
        else if (wrapper !== "env" || value === undefined) continue;
        else if (name === "-u" || name === "--unset") env = Object.fromEntries(Object.entries(env).filter(([key]) => key !== value));
        else if (name === "-C" || name === "--chdir") directory = path.resolve(directory, value);
        // `env -S 'a b'` reads its words as if they were given separately.
        else if (name === "-S" || name === "--split-string") argv.unshift(...splitShell(value).flat());
      }
    }
    // `timeout` takes its duration before the command.
    if (wrapper === "timeout") argv.shift();
  }
  return { argv, cwd: directory, env };
}

function visit(context: Context, input: string[], invokedIn: string, chain: string[], depth: number): void {
  if (depth > MAX_DEPTH) { context.errors.push(`Resolution deeper than ${MAX_DEPTH} levels: ${chain.join(" -> ")}`); return; }
  const unwrapped = unwrap(input, invokedIn, context.env);
  if (!unwrapped?.argv.length) return;
  // Variables a command sets reach every command it runs, and only those.
  const outer = context.env;
  context.env = unwrapped.env;
  try { dispatch(context, unwrapped.argv, unwrapped.cwd, chain, depth); } finally { context.env = outer; }
}

function dispatch(context: Context, argv: string[], cwd: string, chain: string[], depth: number): void {
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
  else if (name === "bunx" || name === "npx") execute(context, args, cwd, chain, depth);
  else if (name === "npm" || name === "pnpm" || name === "yarn") packageManager(context, name, args, cwd, chain, depth, text);
  else if (name === "turbo") turbo(context, args, cwd, chain, text);
  else if (name === "uv" || name === "uvx") uv(context, name === "uvx" ? ["tool", "run", ...args] : args, cwd, chain, depth, text);
  else if (name === "poetry" || name === "pdm" || name === "hatch" || name === "pipenv" || name === "pipx") pythonProject(context, name, args, cwd, chain, depth, text);
  else if (/^python[\d.]*$/.test(name)) python(context, args, cwd, chain, depth, text);
  else if (name === "coverage") { if (args[0] === "run") coverageRun(context, args.slice(1), cwd, chain, depth, text); }
  else if (name === "mise") mise(context, args, cwd, chain, depth);
  else if (testRunner(name, args)) report(context, "test", text, chain);
  else if (builds(name, args)) report(context, "build", text, chain);
  else if ((name === "pod" || name === "bundle") && args[0] === "install") report(context, "install", text, chain);
  else if (/^pip[\d.]*$/.test(name) && options(args, PYTHON_TOOLS.pip).rest[0] === "install" && !previews(context, "pip", "install", args)) report(context, "install", text, chain);
  else if (name === "bundle" && args[0] === "exec") visit(context, args.slice(1), cwd, chain, depth + 1);
}

/* Options, per tool, that take a separate value, so `--profile release` or `-x build` is never read as a subcommand or task. */
const WEBPACK_VALUES: ReadonlySet<string> = new Set(["-c", "--config", "--config-name", "--env", "--node-env", "--mode", "-o", "--output-path", "--entry", "--name", "-t", "--target", "-d", "--devtool", "--stats"]);
const DOCKER_VALUES: ReadonlySet<string> = new Set(["--config", "-c", "--context", "-H", "--host", "-l", "--log-level", "--tlscacert", "--tlscert", "--tlskey", "--builder", "-f", "--file", "-p", "--project-name", "--profile", "--env-file", "--project-directory", "--ansi", "--progress", "--parallel"]);
const GRADLE_VALUES: ReadonlySet<string> = new Set(["-p", "--project-dir", "-x", "--exclude-task", "-b", "--build-file", "-c", "--settings-file", "-g", "--gradle-user-home", "-I", "--init-script", "--include-build", "--project-cache-dir", "--console", "--warning-mode", "--max-workers", "--priority", "--update-locks", "--dependency-verification", "--write-verification-metadata", "--configuration-cache-problems", "--tests", "-D", "-P"]);
const XCODEBUILD_VALUES: ReadonlySet<string> = new Set(["-project", "-workspace", "-target", "-scheme", "-configuration", "-sdk", "-arch", "-destination", "-destination-timeout", "-xcconfig", "-toolchain", "-derivedDataPath", "-resultBundlePath", "-resultBundleVersion", "-archivePath", "-exportPath", "-exportOptionsPlist", "-clonedSourcePackagesDirPath", "-packageCachePath", "-testPlan", "-only-testing", "-skip-testing", "-only-test-configuration", "-skip-test-configuration", "-xctestrun", "-testProductsPath", "-test-iterations", "-jobs", "-parallel-testing-worker-count", "-maximum-parallel-testing-workers", "-maximum-concurrent-test-device-destinations", "-maximum-concurrent-test-simulator-destinations", "-parallel-testing-enabled", "-test-timeouts-enabled", "-default-test-execution-time-allowance", "-maximum-test-execution-time-allowance", "-test-repetition-relaunch-enabled", "-collect-test-diagnostics", "-localizationPath", "-exportLanguage", "-scmProvider", "-defaultPackageRegistryURL", "-packageDependencySCMToRegistryTransformation", "-authenticationKeyPath", "-authenticationKeyID", "-authenticationKeyIssuerID", "-framework", "-library", "-headers", "-debug-symbols", "-output", "-find-executable", "-find-library"]);
const RUNNER_VALUES: Record<string, ReadonlySet<string>> = {
  go: new Set(["-C"]), cargo: new Set(["-C", "--config", "-Z", "--color"]), deno: new Set(["--config", "-c"]), swift: new Set(["--package-path"]),
  vite: new Set(["-c", "--config", "--base", "-l", "--logLevel", "-m", "--mode", "--configLoader", "-f", "--filter"]),
  astro: new Set(["--root", "--config", "--site", "--base", "--mode"]),
  webpack: WEBPACK_VALUES, "webpack-cli": WEBPACK_VALUES, docker: DOCKER_VALUES, "docker-compose": DOCKER_VALUES,
};

/** The positional words before any `--`, skipping options and the separate values of those in `takesValue`. */
function positionals(args: string[], takesValue: ReadonlySet<string>): string[] {
  const words: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (value === "--") break;
    if (value.startsWith("-")) { if (takesValue.has(value)) index++; continue; }
    words.push(value);
  }
  return words;
}

/** The first positional word, after global options such as `go -C dir` or `cargo +nightly -Z flag`. */
function subcommand(name: string, args: string[]): string | undefined {
  const takesValue = RUNNER_VALUES[name] ?? new Set();
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (takesValue.has(value)) { index++; continue; }
    if (value.startsWith("-") || (name === "cargo" && value.startsWith("+"))) continue;
    return value;
  }
  return undefined;
}

/** xcodebuild's actions: positional words other than `NAME=value` build settings. */
const xcodebuildActions = (args: string[]) => positionals(args, XCODEBUILD_VALUES).filter(word => !word.includes("="));
/** Gradle task paths such as `test` or `:app:testDebugUnitTest`. */
const gradleTask = (pattern: string) => new RegExp(`^(?::?[\\w-]+:)*(?:${pattern})$`, "i");
const GRADLE_TEST = gradleTask("test\\w*");
const GRADLE_BUILD = gradleTask("assemble\\w*|build(?:Needed|Dependents)?|bundle\\w*|install\\w*");

function testRunner(name: string, args: string[]): boolean {
  if (["jest", "vitest", "mocha", "ava", "maestro", "detox", "pytest", "py.test", "tox", "nox", "rspec"].includes(name)) return true;
  const first = subcommand(name, args);
  if (name === "node") return args.some(arg => arg === "--test" || arg.startsWith("--test="));
  if (["playwright", "deno", "go", "swift"].includes(name)) return first === "test";
  if (name === "cargo") return first === "test" || first === "nextest";
  if (name === "gradle" || name === "gradlew") return positionals(args, GRADLE_VALUES).some(task => GRADLE_TEST.test(task));
  if (name === "xcodebuild") return xcodebuildActions(args).some(action => action === "test" || action === "test-without-building");
  return false;
}

/** webpack-cli subcommands that serve, inspect, or scaffold instead of bundling; any other first word is a build or an entry. */
const WEBPACK_OTHER = new Set(["serve", "server", "s", "info", "i", "configtest", "t", "version", "v", "help", "h", "init", "create", "new", "c", "n", "loader", "l", "plugin", "p", "migrate", "m"]);
/** xcodebuild options that only list, report, export, or resolve; without one, xcodebuild builds (its default action). */
const XCODEBUILD_OTHER = new Set(["-list", "-showBuildSettings", "-showBuildSettingsForIndex", "-showsdks", "-showdestinations", "-showTestPlans", "-version", "-usage", "-help", "-license", "-checkFirstLaunchStatus", "-runFirstLaunch", "-resolvePackageDependencies", "-exportArchive", "-create-xcframework", "-find-executable", "-find-library", "-downloadPlatform", "-downloadAllPlatforms", "-importPlatform"]);

/**
 * Bundlers, framework builds, native compilers, image builds, and Python
 * package builds. Static checks are not builds: `tsc` (whether `--noEmit` or
 * `-b`), `cargo check|clippy|fmt`, linters, formatters, and type checkers.
 */
function builds(name: string, args: string[]): boolean {
  if (name === "rollup" || name === "tsup" || name === "pyproject-build") return true;
  if (name === "esbuild") return args.some(arg => arg === "--bundle" || /^--out(?:file|dir)(?:=|$)/.test(arg));
  const first = subcommand(name, args);
  if (name === "webpack" || name === "webpack-cli") return !WEBPACK_OTHER.has(first ?? "");
  if (["vite", "next", "astro", "electrobun", "swift", "go"].includes(name)) return first === "build";
  if (name === "cargo") return ["build", "b", "run", "r"].includes(first ?? "");
  // `expo run:ios|android` compiles the native app before launching it.
  if (name === "expo") return first === "export" || /^(?:export|run):/.test(first ?? "");
  if (name === "gradle" || name === "gradlew") return positionals(args, GRADLE_VALUES).some(task => GRADLE_BUILD.test(task));
  if (name === "xcodebuild") {
    if (args.some(arg => XCODEBUILD_OTHER.has(arg))) return false;
    const actions = xcodebuildActions(args);
    // Without an action, xcodebuild builds.
    return !actions.length || actions.some(action => action !== "clean" && action !== "installsrc");
  }
  if (name === "docker-compose") return first === "build";
  if (name === "docker") {
    const [command, sub] = positionals(args, DOCKER_VALUES);
    return command === "build" || ((command === "image" || command === "builder" || command === "compose") && sub === "build") || (command === "buildx" && ["build", "b", "bake"].includes(sub ?? ""));
  }
  return false;
}

/** turbo's subcommands that run no tasks. */
const TURBO_COMMANDS = new Set(["prune", "ls", "info", "query", "gen", "generate", "login", "logout", "link", "unlink", "daemon", "telemetry", "bin", "completion", "scan", "boundaries", "devtools", "docs", "config"]);

/** The tasks a `turbo` command runs: those after `run` or `watch`, or bare task names. */
function turboTasks(args: string[]): string[] {
  const words = positionals(args, TOOLS.turbo.values);
  if (words[0] === "run" || words[0] === "watch") return words.slice(1);
  return TURBO_COMMANDS.has(words[0] ?? "") ? [] : words;
}

/** The value of `--name value` or `--name=value` before any `--`. */
function optionValue(args: string[], name: string): string | undefined {
  for (let index = 0; index < args.length && args[index] !== "--"; index++) {
    const value = args[index]!;
    if (value === name) return args[index + 1];
    if (value.startsWith(`${name}=`)) return value.slice(name.length + 1);
  }
  return undefined;
}

interface TurboConfig { file: string; section: string; tasks: Record<string, unknown>; extends: boolean }

function readTurboConfig(context: Context, file: string): TurboConfig | null {
  const relative = path.relative(context.root, file) || file;
  try {
    const value: unknown = Bun.JSONC.parse(readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
    // turbo 2 names the section `tasks`; turbo 1 named it `pipeline`.
    const section = "tasks" in value ? "tasks" : "pipeline";
    const tasks = (value as Record<string, unknown>)[section] ?? {};
    if (!tasks || typeof tasks !== "object" || Array.isArray(tasks)) throw new Error(`expected ${section} to be an object`);
    return { file: relative, section, tasks: tasks as Record<string, unknown>, extends: "extends" in value };
  } catch (error) { context.errors.push(`Cannot read ${relative}: ${(error as Error).message}`); return null; }
}

function declaresWorkspaces(directory: string): boolean {
  if (existsSync(path.join(directory, "pnpm-workspace.yaml"))) return true;
  try { return (JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")) as { workspaces?: unknown }).workspaces !== undefined; } catch { return false; }
}

const turboFile = (directory: string) => ["turbo.json", "turbo.jsonc"].map(name => path.join(directory, name)).find(file => existsSync(file));

/**
 * Every turbo configuration that can define a task: the root one, then each
 * workspace package's. The root one is `--root-turbo-json` when given (read
 * from the directory turbo starts in and from the repository root, wherever it
 * exists), else the nearest at or above the directory turbo starts in
 * (`--cwd`) without `extends`.
 */
function turboConfigs(context: Context, args: string[], cwd: string): TurboConfig[] {
  const loaded = new Map<string, TurboConfig | null>();
  const load = (file: string) => { if (!loaded.has(file)) loaded.set(file, readTurboConfig(context, file)); return loaded.get(file)!; };
  const start = path.resolve(cwd, optionValue(args, "--cwd") ?? ".");
  const explicit = optionValue(args, "--root-turbo-json");
  const roots: string[] = [];
  if (explicit !== undefined) {
    roots.push(...new Set([path.resolve(start, explicit), path.resolve(context.root, explicit)].filter(file => existsSync(file))));
    if (!roots.length) context.errors.push(`Cannot read ${explicit} (--root-turbo-json): no such file.`);
  } else for (let current = start; ; current = path.dirname(current)) {
    const file = turboFile(current);
    if (file && load(file) && !load(file)!.extends) { roots.push(file); break; }
    if (current === context.root || !current.startsWith(`${context.root}${path.sep}`)) break;
  }
  // Packages come from the workspace turbo runs in, the nearest at or above where it starts that declares
  // workspaces, and from the repository's. A workspace root is a workspace directory too, but its
  // turbo.json is a root configuration, not a package's.
  const workspaceRoots = new Set([context.root]);
  for (let current = start; current.startsWith(`${context.root}${path.sep}`); current = path.dirname(current)) {
    if (declaresWorkspaces(current)) { workspaceRoots.add(current); break; }
  }
  const packages = [...workspaceRoots].flatMap(root => workspaceDirectories(context, root).filter(directory => !workspaceRoots.has(directory))).flatMap(directory => turboFile(directory) ?? []);
  return [...new Set([...roots, ...packages])].flatMap(file => load(file) ?? []);
}

/**
 * `turbo run <task...>` runs its tasks and, unless `--only`, every task they
 * depend on in turbo.json: `^name`, `name`, and `package#name` all run tasks
 * named `name`. A dependency's definitions in the root and every package
 * configuration are followed together, which can over-report but never misses
 * one. The package scripts turbo runs for each task are not followed.
 */
function turbo(context: Context, args: string[], cwd: string, chain: string[], text: string): void {
  const queue = turboTasks(args).map(task => ({ task, hops: [] as string[] }));
  if (!queue.length) return;
  const separator = args.indexOf("--");
  const configs = (separator === -1 ? args : args.slice(0, separator)).includes("--only") ? [] : turboConfigs(context, args, cwd);
  const found: Partial<Record<"test" | "build", string[]>> = {};
  const seen = new Set<string>();
  while (queue.length) {
    const { task, hops } = queue.shift()!;
    const name = task.slice(task.lastIndexOf("#") + 1);
    if (seen.has(name)) continue;
    seen.add(name);
    if (/^test/.test(name)) found.test ??= hops;
    else if (/^build/.test(name)) found.build ??= hops;
    for (const config of configs) {
      for (const [key, definition] of Object.entries(config.tasks)) {
        if (key.slice(key.lastIndexOf("#") + 1) !== name) continue;
        const dependsOn = (definition as { dependsOn?: unknown } | null)?.dependsOn;
        // `$TURBO_EXTENDS$` and turbo 1's `$ENV` entries name no task.
        for (const dependency of Array.isArray(dependsOn) ? dependsOn : []) {
          if (typeof dependency === "string" && !dependency.startsWith("$")) queue.push({ task: dependency.replace(/^\^/, ""), hops: [...hops, `${config.file} ${config.section}.${key}.dependsOn: ${dependency}`] });
        }
      }
    }
  }
  const kind = found.test ? "test" : found.build ? "build" : null;
  if (kind) context.findings.push({ kind, runner: text, chain: [...(chain.at(-1) === text ? chain : [...chain, text]), ...found[kind]!] });
}

function bun(context: Context, args: string[], cwd: string, chain: string[], depth: number, text: string): void {
  const { rest, seen } = options(args, TOOLS.bun);
  const directory = directoryOption(cwd, seen);
  const sub = rest[0];
  if (!sub) return;
  if (sub === "test") report(context, "test", text, chain);
  // The bundler is built in, so `bun build` never runs a package script of that name.
  else if (sub === "build") report(context, "build", text, chain);
  else if (INSTALLS.bun.includes(sub)) report(context, "install", text, chain);
  else if (sub === "x") execute(context, rest.slice(1), directory, chain, depth);
  else if (sub === "exec") { if (rest[1]) visitShell(context, rest[1], directory, chain, depth + 1); }
  else if (sub === "run") {
    const run = scriptOptions(rest.slice(1), TOOLS.bun);
    const target = run.rest[0];
    // Only a leading `--` separates the script's arguments; later ones belong to the script.
    const forwarded = run.rest.slice(1);
    if (target) runScript(context, target, forwarded[0] === "--" ? forwarded.slice(1) : forwarded, directoryOption(directory, run.seen), workspaceScoped(seen, TOOLS.bun) || workspaceScoped(run.seen, TOOLS.bun), chain, depth, run.rest);
  }
  // `bun <name>` runs a package script of that name, else a file or built-in.
  else runScript(context, sub, rest.slice(1), directory, workspaceScoped(seen, TOOLS.bun), chain, depth, null);
}

/** Options read anywhere before `--`, as npm reads `npm run check --workspaces` and mise `mise x node@24 -C dir -- …`; returns the positional words, then `--` and what follows it. */
function scatteredOptions(args: string[], spec: Tool): { rest: string[]; seen: Map<string, string | true> } {
  const separator = args.indexOf("--");
  const before = separator === -1 ? args : args.slice(0, separator);
  const seen = new Map<string, string | true>(), positional: string[] = [];
  for (let index = 0; index < before.length; index++) {
    const value = before[index]!;
    if (!value.startsWith("-")) { positional.push(value); continue; }
    for (const [name, found] of optionWords(value, spec.values, () => index + 1 < before.length ? before[++index] : undefined)) seen.set(name, found ?? true);
  }
  return { rest: separator === -1 ? positional : [...positional, ...args.slice(separator)], seen };
}

function packageManager(context: Context, manager: "npm" | "pnpm" | "yarn", args: string[], cwd: string, chain: string[], depth: number, text: string): void {
  const spec = TOOLS[manager];
  const { rest, seen } = manager === "npm" ? scatteredOptions(args, spec) : options(args, spec);
  const directory = directoryOption(cwd, seen);
  const workspaces = workspaceScoped(seen, spec);
  const sub = rest[0];
  // Arguments after `--` reach the script; the manager drops the separator itself.
  const scriptArgs = (values: string[]) => { const at = values.indexOf("--"); return at === -1 ? values : [...values.slice(0, at), ...values.slice(at + 1)]; };
  if (!sub) { if (manager === "yarn") report(context, "install", text, chain); }
  else if (INSTALLS[manager].includes(sub)) report(context, "install", text, chain);
  else if (["run", "run-script", "rum", "urn"].includes(sub)) {
    const run = scriptOptions(rest.slice(1), spec);
    if (run.rest[0]) runScript(context, run.rest[0], scriptArgs(run.rest.slice(1)), directoryOption(directory, run.seen), workspaces || workspaceScoped(run.seen, spec), chain, depth, manager === "npm" ? null : run.rest);
  } else if (["test", "t", "tst", "start", "stop", "restart"].includes(sub)) {
    runScript(context, ["t", "tst"].includes(sub) ? "test" : sub, scriptArgs(rest.slice(1)), directory, workspaces, chain, depth, null);
  } else if (["exec", "x", "dlx"].includes(sub)) {
    // npm has already read `--call` wherever it appeared.
    const call = seen.get("--call") ?? seen.get("-c");
    if (manager === "npm" && typeof call === "string") visitShell(context, call, directory, chain, depth + 1);
    execute(context, rest.slice(1), directory, chain, depth);
  }
  // pnpm and yarn run a script by its bare name, else an installed executable of that name.
  else if (manager !== "npm") runScript(context, sub, rest.slice(1), directory, workspaces, chain, depth, rest);
}

/** Options that take a separate value, for each Python runner and project manager, before and after its subcommand. */
const PYTHON_TOOLS = {
  uv: tool([
    "--directory", "--project", "--cache-dir", "--color", "--config-file", "--allow-insecure-host",
    "-w", "--with", "--with-editable", "--with-requirements", "--from", "-c", "--constraints", "-b", "--build-constraints", "--overrides",
    "--extra", "--no-extra", "--group", "--no-group", "--only-group", "--package", "--env-file", "-p", "--python", "--python-platform", "--torch-backend",
    "--index", "--default-index", "-i", "--index-url", "--extra-index-url", "-f", "--find-links", "--index-strategy", "--keyring-provider",
    "-P", "--upgrade-package", "--resolution", "--prerelease", "--fork-strategy", "--exclude-newer", "--exclude-newer-package", "--no-sources-package",
    "--reinstall-package", "--link-mode", "-C", "--config-setting", "--config-settings-package", "--no-build-isolation-package", "--no-build-package",
    "--no-binary-package", "--refresh-package",
  ]),
  poetry: tool(["-C", "--directory", "-P", "--project"]),
  // pdm takes `-p`, `--project`, and `--venv` only after its subcommand (`pdm -p api run` fails), but reading them before it too means a misplaced one never hides the command.
  pdm: tool(["-c", "--config", "-p", "--project", "--venv"]),
  pdmRun: tool(["-p", "--project", "-k", "--skip", "--venv", "--env", "--env-file", "--working-dir"]),
  hatch: tool(["-e", "--env", "-p", "--project", "--data-dir", "--cache-dir", "--config"]),
  hatchEnvRun: tool(["-e", "--env", "-i", "--include", "-x", "--exclude", "-f", "--filter"]),
  pipenv: tool(["--python", "--pypi-mirror"]),
  pipx: tool(["--python-args", "--with", "--spec", "--python", "--fetch-python", "--index-url", "--pip-args", "--cooldown", "--backend"]),
  pip: tool(["--python", "--log", "--log-file", "--proxy", "--retries", "--resume-retries", "--timeout", "--exists-action", "--trusted-host", "--cert", "--client-cert", "--cache-dir", "--use-feature", "--use-deprecated", "--keyring-provider"]),
  coverage: tool(["--rcfile", "--source", "--include", "--omit", "--context", "--concurrency", "--data-file", "--debug"]),
} as const;
const MISE = tool(["-C", "--cd", "-E", "--env", "-j", "--jobs", "-c", "--command", "--allow-env", "--allow-net", "--allow-read", "--allow-write", "--secrets"]);
/** Subcommands that install a Python project's dependencies into its environment. */
const PYTHON_INSTALLS: Partial<Record<keyof typeof PYTHON_TOOLS, readonly string[]>> = {
  uv: ["sync", "add", "remove"], poetry: ["install", "sync", "add", "remove", "update"], pdm: ["install", "sync", "add", "remove", "update"],
  // `pipenv upgrade` only updates the lockfile; `pipenv update` also syncs.
  pipenv: ["install", "sync", "update"],
};
/**
 * A Python install that only previews or changes declarations and locks:
 * `--dry-run`, `uv sync --check`, `uv add|remove` with `--no-sync`,
 * `--frozen`, or a true `UV_NO_SYNC` or `UV_FROZEN`, `pdm add|remove|update
 * --no-sync`, or poetry's `--lock`. `pdm install --check` checks the lockfile
 * and then installs.
 */
function previews(context: Context, tool: string, sub: string | undefined, args: string[]): boolean {
  if (tool === "uv" && (sub === "add" || sub === "remove") && (truthy(context.env.UV_NO_SYNC) || truthy(context.env.UV_FROZEN))) return true;
  return args.some(arg => arg === "--dry-run"
    || (tool === "uv" && sub === "sync" && arg === "--check")
    || (tool === "uv" && (sub === "add" || sub === "remove") && (arg === "--no-sync" || arg === "--frozen"))
    || (tool === "pdm" && (sub === "add" || sub === "remove" || sub === "update") && arg === "--no-sync")
    || (tool === "poetry" && arg === "--lock"));
}
const truthy = (value: string | undefined) => /^(?:1|t|true|y|yes|on)$/i.test(value ?? "");
/** `uvx` and `pipx run` take a requirement for the command they run, such as `ruff==0.6`, `ruff>=0.6`, or `ruff[all]`; the command is its name. */
const requirement = ([first, ...rest]: string[]) => first === undefined ? [] : [first.replace(/^([A-Za-z0-9][\w.-]*)\s*(?:\[[^\]]*\])?\s*(?:[=<>!~].*)?$/s, "$1"), ...rest];

/** The directory a command runs in after options such as `--directory` or `-C`, applied in order. */
function movedTo(cwd: string, names: string[], ...seen: Map<string, string | true>[]): string {
  let directory = cwd;
  for (const options of seen) for (const name of names) { const value = options.get(name); if (typeof value === "string") directory = path.resolve(directory, value); }
  return directory;
}

/**
 * `uv run` syncs the project's environment before its command, even with
 * `--frozen` or `--locked`, unless `--no-sync`, `--no-project`, a script
 * (`--script`, `--gui-script`), or a true `UV_NO_SYNC` skips it; `-m` runs a
 * module. `uvx` is `uv tool run`, whose cached tool environment, like `npx`'s
 * download, is not counted as an install; neither are `--with` requirements.
 */
function uv(context: Context, args: string[], cwd: string, chain: string[], depth: number, text: string): void {
  const spec = PYTHON_TOOLS.uv;
  const { rest, seen } = options(args, spec);
  const sub = rest[0], words = rest.slice(1);
  // uv reads its global options anywhere, so `uv tool --no-cache run` is `uv tool run`.
  const tool = sub === "tool" ? options(words, spec) : { rest: [], seen: new Map<string, string | true>() };
  if (sub === "run" || tool.rest[0] === "run") {
    const run = scriptOptions(sub === "run" ? words : tool.rest.slice(1), spec);
    const flags = new Set([...seen.keys(), ...tool.seen.keys(), ...run.seen.keys()]);
    // Even without a command, `uv run` syncs before it lists what it could run.
    if (sub === "run" && !["--no-sync", "--no-project", "-s", "--script", "--gui-script"].some(flag => flags.has(flag)) && !truthy(context.env.UV_NO_SYNC)) report(context, "install", text, chain);
    if (!run.rest.length) return;
    const module = sub === "run" && (run.seen.has("-m") || run.seen.has("--module"));
    visit(context, module ? ["python", "-m", ...run.rest] : sub === "run" ? run.rest : requirement(run.rest), movedTo(cwd, ["--directory"], seen, tool.seen, run.seen), chain, depth + 1);
  } else if ((PYTHON_INSTALLS.uv!.includes(sub ?? "") || (sub === "pip" && ["install", "sync"].includes(options(words, spec).rest[0] ?? ""))) && !previews(context, "uv", sub, words)) report(context, "install", text, chain);
  else if (sub === "build") report(context, "build", text, chain);
}

/**
 * `poetry run`, `pdm run`, `pipenv run`, and `pipx run` run their command as
 * given; `hatch run` and `hatch env run` first create and sync the
 * environment, and `hatch run` takes leading `+`/`-` matrix selectors and an
 * `env:` prefix. `poetry -C` moves the command; `pdm run` keeps its directory
 * unless `--working-dir` names one, relative to the project root (`-p`, else
 * the nearest `pyproject.toml`). Script names they look up in
 * `pyproject.toml`, `hatch.toml`, or `Pipfile` are leaves.
 */
function pythonProject(context: Context, name: "poetry" | "pdm" | "hatch" | "pipenv" | "pipx", args: string[], cwd: string, chain: string[], depth: number, text: string): void {
  const spec = PYTHON_TOOLS[name];
  const { rest, seen } = options(args, spec);
  const sub = rest[0], words = rest.slice(1);
  if (sub === "run" || (name === "hatch" && sub === "env" && words[0] === "run")) {
    let run: { rest: string[]; seen: Map<string, string | true> };
    if (name === "hatch" && sub === "run") {
      let at = 0;
      while (at < words.length && /^[+-]/.test(words[at]!) && words[at] !== "--") at++;
      const command = words[at] === "--" ? words.slice(at + 1) : words.slice(at);
      const prefix = command[0]?.indexOf(":") ?? -1;
      run = { rest: prefix === -1 ? command : [command[0]!.slice(prefix + 1), ...command.slice(1)], seen: new Map() };
    } else run = scriptOptions(sub === "run" ? words : words.slice(1), name === "hatch" ? PYTHON_TOOLS.hatchEnvRun : name === "pdm" ? PYTHON_TOOLS.pdmRun : spec);
    if (!run.rest.length) return;
    if (name === "hatch") report(context, "install", text, chain);
    let directory = movedTo(cwd, name === "poetry" ? ["-C", "--directory"] : [], seen, run.seen);
    const working = name === "pdm" ? run.seen.get("--working-dir") : undefined;
    if (typeof working === "string") {
      const project = run.seen.get("--project") ?? run.seen.get("-p") ?? seen.get("--project") ?? seen.get("-p");
      directory = path.resolve(typeof project === "string" ? path.resolve(cwd, project) : packageRoot(context, cwd, "pyproject.toml"), working);
    }
    visit(context, name === "pipx" ? requirement(run.rest) : run.rest, directory, chain, depth + 1);
  } else if (PYTHON_INSTALLS[name]?.includes(sub ?? "")) { if (!previews(context, name, sub, words)) report(context, "install", text, chain); }
  else if (sub === "build" && name !== "pipenv" && name !== "pipx") report(context, "build", text, chain);
  else if (name === "hatch" && sub === "test") report(context, "test", text, chain);
}

/**
 * `python [options] -m <module> [args]` runs the module as its command would:
 * `-m pytest` is a test run and `-m pip install` an install. `-m unittest`
 * tests and `-m build` builds. Code (`-c`), standard input, and script files
 * are leaves.
 */
function python(context: Context, args: string[], cwd: string, chain: string[], depth: number, text: string): void {
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!;
    if (word === "--check-hash-based-pycs") { index++; continue; }
    // A script file, `-` for standard input, or a long option such as `--version`.
    if (!/^-[^-]/.test(word)) return;
    for (let at = 1; at < word.length; at++) {
      const flag = word[at]!;
      if (!"cmWX".includes(flag)) continue;
      // An option that takes a value takes the rest of its word, else the next word.
      const value = at + 1 < word.length ? word.slice(at + 1) : args[++index];
      if (flag === "c" || value === undefined) return;
      if (flag === "m") {
        if (value === "build") report(context, "build", text, chain);
        else if (value === "unittest") report(context, "test", text, chain);
        else visit(context, [value, ...args.slice(index + 1)], cwd, chain, depth + 1);
        return;
      }
      break;
    }
  }
}

/** `coverage run -m <module>` runs the module as `python -m` does; a program file is a leaf. */
function coverageRun(context: Context, args: string[], cwd: string, chain: string[], depth: number, text: string): void {
  const { rest, seen } = options(args, PYTHON_TOOLS.coverage);
  if ((seen.has("-m") || seen.has("--module")) && rest.length) python(context, ["-m", ...rest], cwd, chain, depth, text);
}

/** `mise exec|x [tool@version...] -- <command>` runs its command, and `-c` a shell string, in the directory `-C` names. */
function mise(context: Context, args: string[], cwd: string, chain: string[], depth: number): void {
  const { rest, seen } = options(args, MISE);
  if (rest[0] !== "exec" && rest[0] !== "x") return;
  const exec = scatteredOptions(rest.slice(1), MISE);
  const directory = movedTo(cwd, ["-C", "--cd"], seen, exec.seen);
  const call = exec.seen.get("-c") ?? exec.seen.get("--command");
  if (typeof call === "string") visitShell(context, call, directory, chain, depth + 1);
  const separator = exec.rest.indexOf("--");
  if (separator !== -1 && separator + 1 < exec.rest.length) visit(context, exec.rest.slice(separator + 1), directory, chain, depth + 1);
}

/** The checkout holding `directory`: this repository's root when it is inside it, else the nearest directory with a `.git`. */
function checkoutOf(context: Context, directory: string): string {
  if (directory === context.root || directory.startsWith(`${context.root}${path.sep}`)) {
    for (let current = directory; current !== context.root; current = path.dirname(current)) if (existsSync(path.join(current, ".git"))) return current;
    return context.root;
  }
  for (let current = directory; current !== path.dirname(current); current = path.dirname(current)) if (existsSync(path.join(current, ".git"))) return current;
  return directory;
}

function agentTool(context: Context, input: string[], invokedIn: string, chain: string[], depth: number): void {
  const args = [...input];
  // `--repo` moves the command, and the run-group plans it resolves, to that checkout.
  let cwd = invokedIn, repo: string | null = null;
  while (args[0] === "--repo" || args[0] === "--config") { if (args[0] === "--repo" && args[1]) { cwd = path.resolve(cwd, args[1]); repo = cwd; } args.splice(0, 2); }
  const text = display(["agent-tool", ...args]);
  if (args[0] === "run-group" && args[1]) {
    // Like the CLI, resolve the plan and run its steps from the root of the checkout `--repo` names.
    const checkout = repo ? checkoutOf(context, repo) : context.root;
    const plan = path.resolve(checkout, args[1]);
    const relative = path.relative(context.root, plan);
    let steps: { label: string; command: string[] }[];
    try {
      const value = JSON.parse(readFileSync(plan, "utf8")) as { steps?: unknown };
      const valid = (step: unknown): step is { label: string; command: string[] } => !!step && typeof (step as { label?: unknown }).label === "string" && Array.isArray((step as { command?: unknown }).command) && ((step as { command: unknown[] }).command).every(arg => typeof arg === "string");
      if (!Array.isArray(value.steps) || !value.steps.every(valid)) throw new Error("expected steps with a label and command");
      steps = value.steps;
    } catch (error) { context.errors.push(`Cannot read run-group plan ${relative} (${chain.join(" -> ")}): ${(error as Error).message}`); return; }
    for (const step of steps) visit(context, step.command, checkout, [...chain, `${relative} step ${step.label}: ${display(step.command)}`], depth + 1);
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
  const items = parseShell(script);
  for (const [index, item] of items.entries()) {
    if (item === "&") continue;
    if (item === "(") { outer.push(directory); continue; }
    if (item === ")") { directory = outer.pop() ?? directory; continue; }
    const words = item;
    // A backgrounded `cd dir &` runs in its own process and moves nothing after it.
    if (words[0] === "cd" && items[index + 1] === "&") continue;
    while (words.length && KEYWORDS.has(words[0]!)) words.shift();
    if (!words.length || words[0] === "for" || words[0] === "case" || /\(\)$/.test(words[0]!)) continue;
    if (words[0] === "cd") { if (words[1] && words[1] !== "-" && !words[1].startsWith("$")) directory = path.resolve(directory, words[1]); continue; }
    visit(context, words, directory, chain, depth + 1);
  }
}

export function splitShell(script: string): string[][] {
  return parseShell(script).filter((item): item is string[] => Array.isArray(item));
}

/** Simple commands in order, with `(` and `)` marking where a subshell starts and ends and `&` following a backgrounded command. */
function parseShell(script: string): (string[] | "(" | ")" | "&")[] {
  const commands: (string[] | "(" | ")" | "&")[] = [];
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
      else if (char === "&") commands.push("&");
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
