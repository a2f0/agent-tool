// A reader for the shell scripts agent harnesses run with `sh -c`, with just enough grammar to find
// `until` and `while` wait loops and read their conditions. It never runs anything. A script it
// does not understand (a heredoc, `case`, a function keyword) does not parse, and callers then
// know nothing about its loops.
import path from "node:path";

/**
 * A word after quote removal. `literal` is false when it holds an expansion or a glob, whose value
 * only the shell knows; `substitution` when it runs a command (`$(...)` or backquotes) to find it.
 */
export interface Word { text: string; literal: boolean; quoted: boolean; substitution: boolean }
export interface Redirect { operator: string; target: Word }
export type Command =
  | { kind: "simple"; words: Word[]; assignments: number; redirects: Redirect[] }
  | { kind: "loop"; keyword: "until" | "while"; condition: List; body: List; redirects: Redirect[] }
  | { kind: "compound"; lists: List[]; redirects: Redirect[]; defines?: string };
export interface Pipeline { negated: boolean; commands: Command[] }
export interface AndOr { pipelines: Pipeline[]; operators: ("&&" | "||")[] }
export type List = AndOr[];

type Token = { type: "word"; word: Word } | { type: "operator"; value: string } | { type: "redirect"; value: string };

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "yash"]);
// Shells where `&>` means "run in the background, then redirect" rather than a redirection.
const POSIX_ONLY = new Set(["sh", "dash", "ash"]);
const META = new Set([" ", "\t", "\n", ";", "&", "|", "(", ")", "<", ">"]);
const OPERATORS = ["&&", "||", ";;", "|&", ";", "&", "|", "(", ")", "\n"];
const REDIRECT = /\d*(?:>>|>\||>&|<&|<>|<<<|<<-|<<|>|<)|&>>?/y;

/** Whether a `ps` command line names a shell program, login shells (`-zsh`) included. */
export function isShell(command: string): boolean {
  return SHELLS.has(path.basename(command.split(" ")[0] ?? "").replace(/^-/, ""));
}

/** Where the script operand of a `<shell> [options] -c <script> [name [args...]]` argv is. */
function scriptOperand(argv: string[]): { shell: string; index: number } | undefined {
  const shell = path.basename(argv[0] ?? "");
  if (!SHELLS.has(shell)) return undefined;
  // Options may follow `-c` (`zsh -c -l script`); the script is the first operand after them.
  let script = false, index = 1;
  for (; index < argv.length; index += 1) {
    const part = argv[index]!;
    if (part === "--") { index += 1; break; }
    if (part === "-o" || part === "+o") { index += 1; continue; }
    if (/^--[a-z][a-z-]*$/.test(part)) continue;
    if (!/^[-+][A-Za-z]+$/.test(part)) break;
    if (part.startsWith("-") && part.includes("c")) script = true;
  }
  return script && index < argv.length ? { shell, index } : undefined;
}

/**
 * The script of a `-c` shell from its `ps` command line. `ps` joins argv with spaces, so the
 * script runs to the end of the line, positional arguments included. Undefined for anything else,
 * including interactive and login shells and shells reading a script file.
 */
export function shellScript(command: string): { shell: string; script: string } | undefined {
  const parts = command.split(" "), found = scriptOperand(parts);
  return found && { shell: found.shell, script: parts.slice(found.index).join(" ") };
}

/** The script of a `-c` shell from its exact argv, without the positional arguments after it. */
export function shellArgvScript(argv: string[]): { shell: string; script: string } | undefined {
  const found = scriptOperand(argv);
  return found && { shell: found.shell, script: argv[found.index]! };
}

const runs = (text: string, at: number) => text[at] === "`" || text[at + 1] === "(";

function readDouble(text: string, start: number): { value: string; literal: boolean; substitution: boolean; end: number } | undefined {
  let value = "", literal = true, substitution = false;
  for (let at = start; at < text.length;) {
    const char = text[at]!;
    if (char === "\"") return { value, literal, substitution, end: at + 1 };
    if (char === "\\") {
      const next = text[at + 1];
      if (next === undefined) return undefined;
      if ("$`\"\\\n".includes(next)) { if (next !== "\n") value += next; at += 2; continue; }
      value += char; at += 1; continue;
    }
    if (char === "$" || char === "`") {
      const end = skipExpansion(text, at);
      if (end === undefined) return undefined;
      substitution ||= runs(text, at);
      value += text.slice(at, end); literal = false; at = end; continue;
    }
    value += char; at += 1;
  }
  return undefined;
}

/** The index just past a `$...` or backquoted expansion starting at `at`. */
function skipExpansion(text: string, at: number): number | undefined {
  if (text[at] === "`") {
    for (let index = at + 1; index < text.length; index += 1) {
      if (text[index] === "\\") index += 1;
      else if (text[index] === "`") return index + 1;
    }
    return undefined;
  }
  const next = text[at + 1];
  if (next === "(") return skipBalanced(text, at + 2, "(", ")");
  if (next === "{") return skipBalanced(text, at + 2, "{", "}");
  if (next === "'") {
    for (let index = at + 2; index < text.length; index += 1) {
      if (text[index] === "\\") index += 1;
      else if (text[index] === "'") return index + 1;
    }
    return undefined;
  }
  const name = /[A-Za-z_][A-Za-z0-9_]*|[0-9?$#@*!-]/y;
  name.lastIndex = at + 1;
  return name.exec(text) ? name.lastIndex : at + 1;
}

function skipBalanced(text: string, start: number, open: string, close: string): number | undefined {
  let depth = 1;
  for (let at = start; at < text.length; at += 1) {
    const char = text[at]!;
    if (char === "\\") { at += 1; continue; }
    if (char === "'") { const end = text.indexOf("'", at + 1); if (end < 0) return undefined; at = end; continue; }
    if (char === "\"") { const inner = readDouble(text, at + 1); if (!inner) return undefined; at = inner.end - 1; continue; }
    if (char === "$" || char === "`") { const end = skipExpansion(text, at); if (end === undefined) return undefined; at = end - 1; continue; }
    if (char === open) depth += 1;
    else if (char === close && (depth -= 1) === 0) return at + 1;
  }
  return undefined;
}

function readWord(text: string, start: number): { word: Word; end: number } | undefined {
  let at = start, value = "", literal = true, quoted = false, substitution = false;
  while (at < text.length && !META.has(text[at]!)) {
    const char = text[at]!;
    if (char === "\\") {
      if (at + 1 >= text.length) return undefined;
      if (text[at + 1] !== "\n") { value += text[at + 1]; quoted = true; }
      at += 2; continue;
    }
    if (char === "'") {
      const close = text.indexOf("'", at + 1);
      if (close < 0) return undefined;
      value += text.slice(at + 1, close); quoted = true; at = close + 1; continue;
    }
    if (char === "\"") {
      const inner = readDouble(text, at + 1);
      if (!inner) return undefined;
      value += inner.value; literal &&= inner.literal; substitution ||= inner.substitution; quoted = true; at = inner.end; continue;
    }
    if (char === "$" || char === "`") {
      const end = skipExpansion(text, at);
      if (end === undefined) return undefined;
      substitution ||= runs(text, at);
      value += text.slice(at, end); literal = false; at = end; continue;
    }
    // Globs, brace expansion and `~` give the word a value the shell decides.
    if ("*?[]{}~".includes(char)) literal = false;
    value += char; at += 1;
  }
  return { word: { text: value, literal, quoted, substitution }, end: at };
}

function lex(text: string, shell: string): Token[] | undefined {
  const tokens: Token[] = [];
  for (let at = 0; at < text.length;) {
    const char = text[at]!;
    if (char === " " || char === "\t") { at += 1; continue; }
    if (char === "\\" && text[at + 1] === "\n") { at += 2; continue; }
    if (char === "#") { while (at < text.length && text[at] !== "\n") at += 1; continue; }
    REDIRECT.lastIndex = at;
    const redirect = REDIRECT.exec(text)?.[0];
    if (redirect) {
      // A heredoc's body follows on later lines, which this reader does not follow.
      if (/<<-?$/.test(redirect) || (redirect.startsWith("&") && POSIX_ONLY.has(shell))) return undefined;
      tokens.push({ type: "redirect", value: redirect.replace(/^\d+/, "") });
      at += redirect.length;
      continue;
    }
    const operator = OPERATORS.find(value => text.startsWith(value, at));
    if (operator) { tokens.push({ type: "operator", value: operator }); at += operator.length; continue; }
    const word = readWord(text, at);
    if (!word || word.end === at) return undefined;
    tokens.push({ type: "word", word: word.word });
    at = word.end;
  }
  return tokens;
}

class Unsupported extends Error {}

class Parser {
  private at = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined { return this.tokens[this.at]; }
  private reserved(names: string[], token = this.peek()): boolean { return token?.type === "word" && !token.word.quoted && names.includes(token.word.text); }
  private operator(values: string[], token = this.peek()): boolean { return token?.type === "operator" && values.includes(token.value); }
  private expect(name: string): void { if (!this.reserved([name])) throw new Unsupported(`expected ${name}`); this.at += 1; }
  private newlines(): void { while (this.operator(["\n"])) this.at += 1; }

  script(): List {
    const list = this.list([]);
    if (this.at !== this.tokens.length) throw new Unsupported("unexpected token");
    return list;
  }

  private list(terminators: string[], closing = false): List {
    const list: List = [];
    for (;;) {
      while (this.operator(["\n", ";"])) this.at += 1;
      if (!this.peek() || this.reserved(terminators) || (closing && this.operator([")"]))) return list;
      list.push(this.andOr());
      if (!this.operator([";", "&", "\n"])) return list;
      this.at += 1;
    }
  }

  private andOr(): AndOr {
    const pipelines = [this.pipeline()], operators: ("&&" | "||")[] = [];
    while (this.operator(["&&", "||"])) {
      operators.push((this.peek() as { value: "&&" | "||" }).value);
      this.at += 1;
      this.newlines();
      pipelines.push(this.pipeline());
    }
    return { pipelines, operators };
  }

  private pipeline(): Pipeline {
    const negated = this.reserved(["!"]);
    if (negated) this.at += 1;
    const commands = [this.command()];
    while (this.operator(["|", "|&"])) { this.at += 1; this.newlines(); commands.push(this.command()); }
    return { negated, commands };
  }

  private redirects(): Redirect[] {
    const redirects: Redirect[] = [];
    while (this.peek()?.type === "redirect") {
      const operator = (this.peek() as { value: string }).value, target = this.tokens[this.at + 1];
      if (target?.type !== "word") throw new Unsupported("redirection without a target");
      redirects.push({ operator, target: target.word });
      this.at += 2;
    }
    return redirects;
  }

  private command(): Command {
    if (this.reserved(["until", "while"])) {
      const keyword = (this.peek() as { word: Word }).word.text as "until" | "while";
      this.at += 1;
      const condition = this.list(["do"]);
      this.expect("do");
      const body = this.list(["done"]);
      this.expect("done");
      return { kind: "loop", keyword, condition, body, redirects: this.redirects() };
    }
    if (this.reserved(["{"])) {
      this.at += 1;
      const body = this.list(["}"]);
      this.expect("}");
      return { kind: "compound", lists: [body], redirects: this.redirects() };
    }
    if (this.operator(["("])) {
      this.at += 1;
      const body = this.list([], true);
      if (!this.operator([")"])) throw new Unsupported("unclosed subshell");
      this.at += 1;
      return { kind: "compound", lists: [body], redirects: this.redirects() };
    }
    if (this.reserved(["if"])) {
      this.at += 1;
      const lists = [this.list(["then"])];
      this.expect("then");
      lists.push(this.list(["elif", "else", "fi"]));
      while (this.reserved(["elif"])) {
        this.at += 1;
        lists.push(this.list(["then"]));
        this.expect("then");
        lists.push(this.list(["elif", "else", "fi"]));
      }
      if (this.reserved(["else"])) { this.at += 1; lists.push(this.list(["fi"])); }
      this.expect("fi");
      return { kind: "compound", lists, redirects: this.redirects() };
    }
    if (this.reserved(["for"])) {
      this.at += 1;
      if (this.peek()?.type !== "word") throw new Unsupported("for without a name");
      this.at += 1;
      this.newlines();
      if (this.reserved(["in"])) { this.at += 1; while (this.peek()?.type === "word") this.at += 1; }
      while (this.operator([";", "\n"])) this.at += 1;
      this.expect("do");
      const body = this.list(["done"]);
      this.expect("done");
      return { kind: "compound", lists: [body], redirects: this.redirects() };
    }
    if (this.reserved(["case", "select", "function", "coproc", "then", "do", "done", "fi", "elif", "else", "esac", "}"])) throw new Unsupported("unsupported construct");
    if (this.reserved(["[["])) {
      // `[[ ... ]]` gives `&&`, `<` and parentheses their own meanings; keep it as one opaque command.
      const words: Word[] = [];
      while (this.peek() && !this.reserved(["]]"])) {
        const token = this.peek()!;
        words.push(token.type === "word" ? { ...token.word, literal: false } : { text: token.value, literal: false, quoted: false, substitution: false });
        this.at += 1;
      }
      this.expect("]]");
      const bracket = (text: string): Word => ({ text, literal: false, quoted: false, substitution: false });
      return { kind: "simple", words: [bracket("[["), ...words, bracket("]]")], assignments: 0, redirects: this.redirects() };
    }
    const words: Word[] = [], redirects: Redirect[] = [];
    for (;;) {
      const token = this.peek();
      if (token?.type === "redirect") redirects.push(...this.redirects());
      else if (token?.type === "word") { words.push(token.word); this.at += 1; }
      else break;
    }
    if (words.length === 1 && redirects.length === 0 && this.operator(["("]) && this.operator([")"], this.tokens[this.at + 1])) {
      // A function definition: its body runs only when called.
      this.at += 2;
      this.newlines();
      return { kind: "compound", lists: [[{ pipelines: [{ negated: false, commands: [this.command()] }], operators: [] }]], redirects: [], defines: words[0]!.text };
    }
    if (words.length === 0 && redirects.length === 0) throw new Unsupported("empty command");
    let assignments = 0;
    while (assignments < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[assignments]!.text) && !words[assignments]!.quoted) assignments += 1;
    return { kind: "simple", words, assignments, redirects };
  }
}

/** Parses a script; undefined when it uses grammar this reader does not follow. */
export function parseScript(text: string, shell = "sh"): List | undefined {
  // Any failure, such as nesting deep enough to exhaust the stack, leaves the script unknown.
  try {
    const tokens = lex(text, shell);
    return tokens && new Parser(tokens).script();
  } catch { return undefined; }
}

/** One test in a loop's condition, as far as teardown can judge it. */
export type Check =
  | { kind: "pgrep"; pattern: string }
  /** A file test that can never succeed: `grep` or `[ -f ]` on an empty file name. */
  | { kind: "missing-file" }
  | { kind: "other" };
export interface Atom { negated: boolean; text: string; check: Check }

/** A simple command anywhere in a script, `eval`ed text included, as far as it shows what it may start. */
export interface CommandInfo {
  /** Its words joined, as `ps` shows the process it starts. */
  text: string;
  /** Its first word after assignments, unless that is an expansion. */
  program?: string;
  /** Its other words. */
  args: string[];
  /** Whether a word, assignment or redirection holds an expansion. */
  expands: boolean;
  /** Whether one runs a command (`$(...)` or backquotes) to find its value. */
  substitutes: boolean;
}

export interface WaitLoop {
  keyword: "until" | "while";
  /** The script holding the loop, unwrapped from `eval`. */
  script: string;
  /** The condition, when it is one and-or list of simple commands. */
  condition?: { atoms: Atom[]; operators: ("&&" | "||")[] };
  /** The body runs nothing but `sleep`. */
  pure: boolean;
  /** Each simple command in the loop, as `ps` shows it once started. */
  commands: string[];
  /** Indexes into the analysis's `commands` of the loop's own simple commands. */
  own: number[];
}

export interface Analysis {
  loops: WaitLoop[];
  /** Every simple command in the script, loops and `eval`ed text included. */
  commands: CommandInfo[];
  /** Names the script defines as functions or aliases, which then run in place of the command. */
  defines: Set<string>;
  /** Files the script sources by a literal path, whose definitions apply too. */
  sourced: string[];
}

type Simple = Extract<Command, { kind: "simple" }>;

const commandText = (words: Word[]) => words.map(word => word.text).join(" ").trim();
const SLEEP = /^\d+(?:\.\d+)?[smhd]?$/;
const FILE_TESTS = new Set(["-e", "-f", "-s", "-r", "-w", "-x", "-d", "-L", "-h", "-p", "-S", "-b", "-c"]);
// Commands that run code or another program given in their arguments.
const RUNNERS = new Set(["eval", "exec", "command", "builtin", "source", ".", "env", "nohup", "nice", "xargs", "time", "stdbuf", "sudo", "doas", "timeout", "gtimeout"]);

/** Redirections that only discard or merge output, which change nothing a loop waits on. */
function harmless(redirects: Redirect[]): boolean {
  return redirects.every(({ operator, target }) => target.literal && (target.text === "/dev/null" || ((operator === ">&" || operator === "<&") && /^[0-9-]$/.test(target.text))));
}

function check(command: Command): Check {
  // `[` and `]` read as globs, but alone they are the test command and its closing word.
  const literal = (word: Word) => word.literal || (!word.quoted && (word.text === "[" || word.text === "]"));
  if (command.kind !== "simple" || command.assignments > 0 || !harmless(command.redirects) || !command.words.every(literal)) return { kind: "other" };
  const words = command.words.map(word => word.text);
  if (words[0] === "pgrep" && words[1] === "-f") {
    const rest = words[2] === "--" ? words.slice(3) : words.slice(2);
    if (rest.length === 1 && rest[0] !== "" && (words[2] === "--" || !rest[0]!.startsWith("-"))) return { kind: "pgrep", pattern: rest[0]! };
  }
  if (words[0] === "grep") {
    let index = 1;
    while (index < words.length && /^-[qsEFiwxv]+$/.test(words[index]!)) index += 1;
    const separated = words[index] === "--";
    if (separated) index += 1;
    // A pattern, then exactly one file operand, which is empty. A pattern that looks like an option
    // (`-e ""`) would leave grep reading its input instead.
    if (words.length === index + 2 && (separated || !words[index]!.startsWith("-")) && words[index + 1] === "") return { kind: "missing-file" };
  }
  const test = words[0] === "[" ? (words.at(-1) === "]" ? words.slice(1, -1) : undefined) : words[0] === "test" ? words.slice(1) : undefined;
  if (test?.length === 2 && FILE_TESTS.has(test[0]!) && test[1] === "") return { kind: "missing-file" };
  return { kind: "other" };
}

function* commandsOf(list: List): Generator<Command> {
  for (const andOr of list) for (const pipeline of andOr.pipelines) for (const command of pipeline.commands) yield command;
}

/** Every simple command under a list, loops and nested lists included, but not `eval`ed text. */
function* simpleCommands(list: List): Generator<Simple> {
  for (const command of commandsOf(list)) {
    if (command.kind === "simple") yield command;
    else if (command.kind === "loop") { yield* simpleCommands(command.condition); yield* simpleCommands(command.body); }
    else for (const inner of command.lists) yield* simpleCommands(inner);
  }
}

function evaluated(command: Simple): string | undefined {
  const words = command.words.slice(command.assignments);
  const start = words[0]?.text === "builtin" ? 1 : 0;
  if (words[start]?.text !== "eval" || words.length === start + 1) return undefined;
  const args = words.slice(start + 1);
  return args.every(word => word.literal) ? args.map(word => word.text).join(" ") : undefined;
}

function condition(list: List): WaitLoop["condition"] {
  if (list.length !== 1) return undefined;
  const [andOr] = list;
  const atoms: Atom[] = [];
  for (const pipeline of andOr!.pipelines) {
    if (pipeline.commands.length !== 1) return undefined;
    const command = pipeline.commands[0]!;
    atoms.push({ negated: pipeline.negated, text: command.kind === "simple" ? commandText(command.words) : command.kind, check: check(command) });
  }
  return { atoms, operators: andOr!.operators };
}

const sleeps = (list: List): boolean => [...simpleCommands(list)].some(command => command.words[command.assignments]?.text === "sleep");

function describe(command: Simple): CommandInfo {
  const words = command.words.slice(command.assignments), all = [...command.words, ...command.redirects.map(redirect => redirect.target)];
  return {
    text: commandText(command.words),
    ...(words[0]?.literal ? { program: words[0].text } : {}),
    args: words.slice(1).map(word => word.text),
    expands: all.some(word => !word.literal),
    substitutes: all.some(word => word.substitution),
  };
}

/**
 * The wait loops in a script (`until` or `while` loops whose body sleeps), searching `eval`ed text
 * too, since harnesses wrap the command they were given in `eval '...'`. Undefined when the script
 * does not parse.
 */
export function analyzeScript(text: string, shell = "sh"): Analysis | undefined {
  const analysis: Analysis = { loops: [], commands: [], defines: new Set(), sourced: [] };
  return collect(text, shell, analysis, 0) ? analysis : undefined;
}

// Stands for `eval`ed text that could not be read: it may run anything.
const OPAQUE: CommandInfo = { text: "eval", args: [], expands: true, substitutes: true };

/** What a simple command defines or sources: aliases, autoloaded functions, and sourced files. */
function definitions(command: CommandInfo, analysis: Analysis): void {
  const operands = command.args.filter(arg => !arg.startsWith("-") && !arg.startsWith("+"));
  if (command.program === "alias") for (const arg of operands) { const name = /^([^=]+)=/.exec(arg)?.[1]; if (name) analysis.defines.add(name); }
  if (command.program === "autoload" || command.program === "functions") for (const arg of operands) analysis.defines.add(arg.replace(/=.*$/, ""));
  if ((command.program === "source" || command.program === ".") && operands[0] && !command.expands) analysis.sourced.push(operands[0]);
}

function collect(text: string, shell: string, analysis: Analysis, depth: number): boolean {
  const list = parseScript(text, shell);
  if (!list) return false;
  const index = new Map<Simple, number>();
  for (const command of simpleCommands(list)) {
    index.set(command, analysis.commands.length);
    const info = describe(command);
    analysis.commands.push(info);
    definitions(info, analysis);
  }
  const visit = (current: List) => {
    for (const command of commandsOf(current)) {
      if (command.kind === "loop") {
        if (sleeps(command.body)) {
          const inside = [...simpleCommands(command.condition), ...simpleCommands(command.body)], body = [...simpleCommands(command.body)];
          analysis.loops.push({
            keyword: command.keyword,
            script: text,
            condition: condition(command.condition),
            pure: harmless(command.redirects) && [...commandsOf(command.body)].every(inner => inner.kind === "simple") && body.every(inner => inner.assignments === 0 && harmless(inner.redirects) && inner.words.length === 2 && inner.words[0]!.text === "sleep" && inner.words.every(word => word.literal) && SLEEP.test(inner.words[1]!.text)),
            commands: inside.map(inner => commandText(inner.words)),
            own: inside.map(inner => index.get(inner)!),
          });
        }
        visit(command.condition);
        visit(command.body);
      } else if (command.kind === "compound") {
        if (command.defines) analysis.defines.add(command.defines);
        command.lists.forEach(visit);
      } else {
        const nested = evaluated(command);
        if (nested !== undefined && !(depth < 3 && collect(nested, shell, analysis, depth + 1))) analysis.commands.push(OPAQUE);
      }
    }
  };
  visit(list);
  return true;
}

/**
 * Whether nothing in the script outside the loop could start a process that looks like one of the
 * loop's own: no command with the same words, no command naming one of its programs as an
 * argument (`env sleep 30`), no command whose program or arguments are found by expansion when it
 * runs one of its programs or runs other code (`sleep "$n"`, `"$@"`, `eval "$x"`), and no command
 * substitution, whose subshell may run the command directly. Functions and sourced files are taken
 * at their word: they are not read.
 */
export function exclusive(analysis: Analysis, loop: WaitLoop): boolean {
  const own = new Set(loop.own), texts = new Set(loop.commands);
  const programs = new Set(loop.commands.map(text => text.split(" ")[0]!));
  return analysis.commands.every((command, index) => own.has(index) || !(
    texts.has(command.text)
    || command.substitutes
    || command.args.some(arg => programs.has(arg))
    || (command.expands && (command.program === undefined || programs.has(command.program) || RUNNERS.has(command.program)))
  ));
}

/** Whether the words occur in this order, as whole words, anywhere in the text; linear in its length. */
export function wordsInOrder(text: string, words: string[]): boolean {
  let at = 0;
  for (const word of words) {
    const pattern = new RegExp(`(?<![A-Za-z0-9_])(?:${word})(?![A-Za-z0-9_])`, "g");
    pattern.lastIndex = at;
    const match = pattern.exec(text);
    if (!match) return false;
    at = match.index + match[0].length;
  }
  return true;
}
