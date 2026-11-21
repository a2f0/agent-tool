/** `agent-tool perf` arguments: a command, its positional arguments, and its measuring conditions. */

export const PERF_USAGE = `Usage: agent-tool perf <command> [args...] [options]

Measures how fast a page becomes usable, so a performance pass compares
rounds by numbers rather than impressions. Chrome is driven through the
measured repository's own \`playwright\` dependency, found from the working
directory or --from <repository>.

  serve <dir> [--port 8765] [--http1]  serve a production build, compressed, revalidating
  measure <url> --ready <js> [...]     cold loads: median time to ready, requests, bytes
                                       --waterfall, --profile, --json
  shot <url> --ready <js> --out <png>  a seeded screenshot of the ready state; --eval <js>, --hide <css>
  diff <a.png> <b.png>                 count differing pixels between two screenshots; exit 1 on any
  graph <dir> <entry...> [--out file]  an ES module's relative static and dynamic imports

Conditions: --runs 5, --latency 40 (ms), --mbps 20, --cpu 1 (slowdown),
--width 1600, --height 900; --no-seed leaves Math.random unseeded.`;

export interface Options {
  command: string;
  args: string[];
  ready: string;
  runs: number;
  latency: number;
  mbps: number;
  cpu: number;
  width: number;
  height: number;
  port: number;
  out: string | undefined;
  hide: string | undefined;
  eval: string | undefined;
  from: string | undefined;
  waterfall: boolean;
  profile: boolean;
  json: boolean;
  seed: boolean;
  http1: boolean;
}

type NumberOption = "runs" | "latency" | "mbps" | "cpu" | "width" | "height" | "port";
type StringOption = "ready" | "out" | "hide" | "eval" | "from";
type FlagOption = "waterfall" | "profile" | "json" | "seed" | "http1";
const NUMBERS = new Set<string>(["runs", "latency", "mbps", "cpu", "width", "height", "port"] satisfies NumberOption[]);
const STRINGS = new Set<string>(["ready", "out", "hide", "eval", "from"] satisfies StringOption[]);
const FLAGS = new Set<string>(["waterfall", "profile", "json", "seed", "http1"] satisfies FlagOption[]);
const isNumber = (name: string): name is NumberOption => NUMBERS.has(name);
const isString = (name: string): name is StringOption => STRINGS.has(name);
const isFlag = (name: string): name is FlagOption => FLAGS.has(name);

export function parseOptions(argv: string[]): Options {
  const options: Options = {
    command: argv[0] ?? "help",
    args: [],
    ready: "document.readyState === 'complete'",
    runs: 5,
    latency: 40,
    mbps: 20,
    cpu: 1,
    width: 1600,
    height: 900,
    port: 8765,
    out: undefined,
    hide: undefined,
    eval: undefined,
    from: undefined,
    waterfall: false,
    profile: false,
    json: false,
    seed: true,
    http1: false,
  };
  for (let i = 1; i < argv.length; i += 1) i = readArgument(options, argv, i);
  if (options.runs < 1) throw new Error("--runs needs at least 1.");
  for (const name of ["runs", "width", "height", "port"] as const) if (!Number.isInteger(options[name])) throw new Error(`--${name} needs a whole number.`);
  if (options.width < 1 || options.height < 1) throw new Error("--width and --height need at least 1.");
  if (options.port > 65535) throw new Error("--port needs a port number, at most 65535.");
  return options;
}

/** Applies the argument at `index` to `options`, returning the index of the last argument it used. */
function readArgument(options: Options, argv: string[], index: number): number {
  const arg = argv[index]!;
  if (!arg.startsWith("--")) {
    options.args.push(arg);
    return index;
  }
  const name = arg.slice(2);
  if (name === "no-seed") options.seed = false;
  else if (isFlag(name)) options[name] = true;
  else if (isNumber(name) || isString(name)) {
    setValue(options, name, arg, argv[index + 1]);
    return index + 1;
  } else throw new Error(`Unknown option ${arg}.`);
  return index;
}

/** Stores the value that follows a `--name` option, as a number where the option takes one. */
function setValue(options: Options, name: NumberOption | StringOption, arg: string, value: string | undefined): void {
  if (value === undefined) throw new Error(`${arg} needs a value.`);
  if (isNumber(name)) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) throw new Error(`${arg} needs a non-negative number.`);
    options[name] = number;
  } else options[name] = value;
}
