import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { packageDirectories } from "../system/workspace";

/** A test run, build, or dependency install that a push-gate step reaches, with the chain that led to it. */
export interface StepFinding { kind: "test" | "build" | "install"; runner: string; chain: string[] }
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

interface Context { root: string; seen: Set<string>; findings: StepFinding[]; errors: string[] }

/**
 * Follow a declared push-gate step through package scripts, shell strings,
 * and `agent-tool run-group` plans to every test runner, build, or dependency
 * install it reaches. Executables and script files are leaves: their contents
 * are not inspected. Workspace filters resolve to every workspace package
 * declaring the script, which can over-report but never misses one. A command
 * that both builds and tests, such as `cargo test`, is reported once, as a test.
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

/** Package managers run scripts from the nearest `package.json` at or above the directory, within the repository. */
function packageRoot(context: Context, directory: string): string {
  let current = directory;
  while (!existsSync(path.join(current, "package.json")) && current !== context.root && current.startsWith(`${context.root}${path.sep}`)) current = path.dirname(current);
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
  else if (name === "bunx" || name === "npx") execute(context, args, cwd, chain, depth);
  else if (name === "npm" || name === "pnpm" || name === "yarn") packageManager(context, name, args, cwd, chain, depth, text);
  else if (name === "turbo") turbo(context, args, cwd, chain, text);
  else if (testRunner(name, args)) report(context, "test", text, chain);
  else if (builds(name, args)) report(context, "build", text, chain);
  else if (["pod", "bundle", "pip", "pip3"].includes(name) && args[0] === "install") report(context, "install", text, chain);
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
  if (["jest", "vitest", "mocha", "ava", "maestro", "detox", "pytest", "rspec"].includes(name)) return true;
  const first = subcommand(name, args);
  if (name === "node") return args.some(arg => arg === "--test" || arg.startsWith("--test="));
  if (["playwright", "deno", "go", "swift"].includes(name)) return first === "test";
  if (name === "cargo") return first === "test" || first === "nextest";
  if (name === "gradle" || name === "gradlew") return positionals(args, GRADLE_VALUES).some(task => GRADLE_TEST.test(task));
  if (name === "xcodebuild") return xcodebuildActions(args).some(action => action === "test" || action === "test-without-building");
  if (/^python[\d.]*$/.test(name)) return args[0] === "-m" && args[1] === "pytest";
  return false;
}

/** webpack-cli subcommands that serve, inspect, or scaffold instead of bundling; any other first word is a build or an entry. */
const WEBPACK_OTHER = new Set(["serve", "server", "s", "info", "i", "configtest", "t", "version", "v", "help", "h", "init", "create", "new", "c", "n", "loader", "l", "plugin", "p", "migrate", "m"]);
/** xcodebuild options that only list, report, export, or resolve; without one, xcodebuild builds (its default action). */
const XCODEBUILD_OTHER = new Set(["-list", "-showBuildSettings", "-showBuildSettingsForIndex", "-showsdks", "-showdestinations", "-showTestPlans", "-version", "-usage", "-help", "-license", "-checkFirstLaunchStatus", "-runFirstLaunch", "-resolvePackageDependencies", "-exportArchive", "-create-xcframework", "-find-executable", "-find-library", "-downloadPlatform", "-downloadAllPlatforms", "-importPlatform"]);

/**
 * Bundlers, framework builds, native compilers, and image builds. Static
 * checks are not builds: `tsc` (whether `--noEmit` or `-b`), `cargo
 * check|clippy|fmt`, linters, and formatters.
 */
function builds(name: string, args: string[]): boolean {
  if (name === "rollup" || name === "tsup") return true;
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

const turboFile = (directory: string) => ["turbo.json", "turbo.jsonc"].map(name => path.join(directory, name)).find(file => existsSync(file));

/**
 * Every turbo configuration that can define a task: the root one, the nearest
 * at or above the directory turbo starts in (`--cwd`) without `extends`, then
 * each workspace package's.
 */
function turboConfigs(context: Context, args: string[], cwd: string): TurboConfig[] {
  const loaded = new Map<string, TurboConfig | null>();
  const load = (file: string) => { if (!loaded.has(file)) loaded.set(file, readTurboConfig(context, file)); return loaded.get(file)!; };
  let root: string | undefined;
  for (let current = path.resolve(cwd, optionValue(args, "--cwd") ?? "."); ; current = path.dirname(current)) {
    const file = turboFile(current);
    if (file && load(file) && !load(file)!.extends) { root = file; break; }
    if (current === context.root || !current.startsWith(`${context.root}${path.sep}`)) break;
  }
  const files = new Set([...(root ? [root] : []), ...workspaceDirectories(context).flatMap(directory => turboFile(directory) ?? [])]);
  return [...files].flatMap(file => load(file) ?? []);
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
