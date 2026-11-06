/**
 * Heuristic signals of implicit state machines in one source file. Read-only
 * and line-based: it points a reader at files worth reading, it never decides.
 */

type SignalKind = "flags" | "status";

export interface Signal {
  readonly kind: SignalKind;
  /** The flag names, or the status field name. */
  readonly names: string[];
  /** For status signals, the distinct string values assigned. */
  readonly values?: string[];
  /** 1-based lines where the flags are toggled or the status is assigned. */
  readonly lines: number[];
}

export interface FileReport {
  readonly path: string;
  readonly score: number;
  readonly signals: Signal[];
}

/** Source extensions the scan reads, by the comment syntax their lines use. */
const LANGUAGES: Record<string, "c" | "hash"> = {
  ".ts": "c",
  ".tsx": "c",
  ".mts": "c",
  ".cts": "c",
  ".js": "c",
  ".jsx": "c",
  ".mjs": "c",
  ".cjs": "c",
  ".swift": "c",
  ".kt": "c",
  ".kts": "c",
  ".go": "c",
  ".rs": "c",
  ".java": "c",
  ".dart": "c",
  ".py": "hash",
  ".rb": "hash",
  ".sh": "hash",
  ".bash": "hash",
  ".zsh": "hash",
  ".exp": "hash",
};

/** Interpreters whose extensionless scripts the scan reads, by their shebang. */
const INTERPRETER = /^(?:sh|bash|zsh|dash|ksh|python[\d.]*|ruby|expect|tclsh[\d.]*)$/;

/**
 * Whether a first line is a shebang for an interpreter the scan reads:
 * `#!/bin/sh`, `#!/usr/bin/env -S python3 -u`, `#!/usr/bin/expect -f`. Parsed
 * token by token (no backtracking regex) and bounded, since the line is
 * untrusted input of any length.
 */
function readsShebang(firstLine: string): boolean {
  if (!firstLine.startsWith("#!")) return false;
  const tokens = firstLine.slice(2, 512).trim().split(/\s+/);
  const base = (token: string | undefined) => token?.slice(token.lastIndexOf("/") + 1) ?? "";
  let index = 0;
  if (base(tokens[0]) === "env") {
    index = 1;
    while (index < tokens.length && (tokens[index]!.startsWith("-") || tokens[index]!.includes("="))) index++;
  }
  return INTERPRETER.test(base(tokens[index]));
}

/** Largest file the scan reads; bigger tracked files are data or generated. */
export const MAX_BYTES = 512 * 1024;

/** Paths that are generated, vendored, tests, or agent skills rather than application code. */
const SKIPPED = [
  /(^|\/)(node_modules|vendor|dist|build|out|coverage|Pods|DerivedData|\.next|\.turbo|generated|__generated__)\//,
  /(^|\/)\.(agents|claude|codex|opencode)\//,
  /(^|\/)(__tests__|__mocks__|e2e|fixtures?|test|tests)\//,
  /\.(test|spec|stories|e2e)\.[a-z]+$/,
  /\.(test|spec)(Utils|Helpers|-utils|-helpers)\.[a-z]+$/,
  /_test\.(go|py)$/,
  /(^|\/)(test_[^/]*|conftest)\.py$/,
  /(Tests?|Spec)\.(swift|kt|java)$/,
  /\.d\.ts$/,
  /\.min\.[a-z]+$/,
];

/**
 * The comment syntax of a source file, from its extension; an extensionless
 * file (`bin/deploy`, `files/functions`) counts when its first line is a
 * shell, Python, Ruby or Expect shebang. Without `firstLine`, extensionless
 * files report "maybe" so a caller knows to read the first line.
 */
export function language(file: string, firstLine?: string): "c" | "hash" | "maybe" | undefined {
  if (SKIPPED.some(pattern => pattern.test(file))) return undefined;
  const base = file.slice(file.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot > 0) return LANGUAGES[base.slice(dot).toLowerCase()];
  if (firstLine === undefined) return "maybe";
  return readsShebang(firstLine) ? "hash" : undefined;
}

/**
 * Names that read as a lifecycle or mode flag rather than a setting: `isLoading`,
 * `hasError`, `_running`, `submitting`, `show_dialog`. Settings such as
 * `darkMode` or `enabled` toggled by a user are usually independent, so a
 * bare `enabled`/`visible` does not count on its own. Nor do `cancelled` and
 * `settled`: effect cleanups and promise races set them once as guards.
 */
const FLAG =
  /^_*(?:(?:is|has|was|did|should|show|needs?|can)(?:[A-Z_].*)?|(?:loading|pending|running|started|starting|stopping|stopped|done|finished|complete|completed|ready|busy|saving|submitting|fetching|syncing|connecting|connected|reconnecting|initiali[sz]ed|initiali[sz]ing|cancell?ing|failed|retrying|paused|waiting|polling|booting|editing|reserving|paging|rendered|rendering|unavailable|interrupted|dismissed|opened|published|uploading|downloading|refreshing|processing|in_?progress|inflight|in_?flight)(?:[A-Z_].*)?)$/;

/** Field names that hold a mode as a string. */
const STATUS = /^_*(?:status|state|phase|mode|stage|step|lifecycle|connectionState|syncState|loadState|[a-z]+(?:Status|State|Phase|Stage))$/;

/**
 * The flag or field an assignment target names: the last member of a chain
 * (`record.steps[i]!.status` -> `status`, `this.#rendered` -> `rendered`), or a
 * React ref's own name (`busy.current` -> `busy`).
 */
function targetName(owner: string | undefined, member: string): string {
  const name = member.replace(/^#/, "");
  return name === "current" && owner ? owner : name;
}

function isFlag(name: string): boolean {
  return FLAG.test(name) && !/^(?:is|has|was|did|should|show|needs?|can)$/.test(name);
}

/** `setIsLoading` -> `isLoading`; `set_loading` stays as is. */
function fromSetter(name: string): string {
  return name[0].toLowerCase() + name.slice(1);
}

/** Blanks comments, which often quote code, keeping line numbers. */
export function codeLines(text: string, syntax: "c" | "hash"): string[] {
  const lines = text.split("\n");
  if (syntax === "hash") return lines.map(line => (line.trimStart().startsWith("#") ? "" : line));
  // String-aware, so "/*" or "//" inside a string literal never hides code.
  // Strings are tracked per line; a template literal spanning lines is rare
  // enough in state code that a lead missed there is acceptable.
  const state = { inBlock: false };
  return lines.map(line => stripComments(line, state));
}

const QUOTES = new Set(['"', "'", "`"]);

/** One line without its comments; `state.inBlock` carries an open block comment to the next line. */
function stripComments(line: string, state: { inBlock: boolean }): string {
  let out = "";
  let index = 0;
  while (index < line.length) {
    if (state.inBlock) {
      index = blockCommentEnd(line, index, state);
      continue;
    }
    if (line.startsWith("/*", index)) {
      state.inBlock = true;
      index += 2;
      continue;
    }
    if (line.startsWith("//", index)) break;
    const end = QUOTES.has(line[index]) ? stringEnd(line, index) : index + 1;
    out += line.slice(index, end);
    index = end;
  }
  return out;
}

// Where an open block comment ends on this line (just past its `*/`), or the line's end.
function blockCommentEnd(line: string, index: number, state: { inBlock: boolean }): number {
  const close = line.indexOf("*/", index);
  if (close < 0) return line.length;
  state.inBlock = false;
  return close + 2;
}

/** Just past the string literal opening at `start`, honoring backslash escapes; the line's end when unterminated. */
function stringEnd(line: string, start: number): number {
  const quote = line[start];
  let index = start + 1;
  while (index < line.length) {
    if (line[index] === "\\") index += 2;
    else if (line[index] === quote) return index + 1;
    else index++;
  }
  return index;
}

const BOOLEAN = String.raw`(true|false|True|False)\b`;
/** An assignment target's last two members: `(owner.)?member`, where the owner may follow any chain. */
const TARGET = String.raw`(?<![\w$#])(?:([A-Za-z_$][\w$]*)[!?]?\.)?(#?[A-Za-z_$][\w$]*)`;
/**
 * `x = true`, `this.x = false`, `self._x = True`, `this.#x = true`,
 * `busy.current = true`, `press.moved = true`, `x: false` (object literal),
 * but not `==`/`===`.
 */
const ASSIGN = new RegExp(TARGET + String.raw`\s*(?:=(?!=)|:)\s*` + BOOLEAN, "g");
/** `setIsOpen(true)`, `set_loading(False)`. */
const SETTER = new RegExp(String.raw`\bset_?([A-Za-z_$][\w$]*)\(\s*` + BOOLEAN, "g");
/** `const [isOpen, setIsOpen] = useState(false)` names the flag and its first value. */
const USE_STATE = /\[\s*([A-Za-z_$][\w$]*)\s*,\s*set[A-Za-z_$][\w$]*\s*\]\s*=\s*(?:React\.)?useState(?:<boolean>)?\(\s*(true|false)\s*\)/g;
/**
 * `status = "loading"`, `this.phase = 'done'`, `setStatus("error")`. Not
 * `status: "idle"`: type members and returned object literals are how an
 * explicit machine names its states, not scattered writes.
 */
const STATUS_ASSIGN = new RegExp(TARGET + String.raw`\s*=(?!=)\s*(["'\`])([\w-]+)\3`, "g");
/** Tcl and Expect: `set busy true`, `set ::done 0`, `set status running`, `set status "done"`. */
const TCL_FLAG = /^\s*set\s+(?:::)?([A-Za-z_][\w]*)\s+(true|false|1|0|yes|no)\s*$/;
const TCL_STATUS = /^\s*set\s+(?:::)?([A-Za-z_][\w]*)\s+"?([A-Za-z][\w-]*)"?\s*$/;
const TCL_TRUE = new Set(["true", "1", "yes"]);
const STATUS_SETTER = /\bset_?([A-Za-z_$][\w$]*)\(\s*(["'`])([\w-]+)\2\s*\)/g;

/**
 * Signals in one file:
 * - `flags`: two or more lifecycle-style booleans that are each set both true
 *   and false, so their combinations encode one mode with impossible states.
 * - `status`: one string field assigned three or more distinct literal values
 *   from several places, so its transitions are scattered.
 */
export function scanText(text: string, syntax: "c" | "hash"): Signal[] {
  const flags: Writes = new Map();
  const statuses: Writes = new Map();
  const lines = codeLines(text, syntax);
  const sql = sqlStatusFacts(lines);
  lines.forEach((line, index) => {
    const at = index + 1;
    noteFlagWrites(line, at, flags);
    noteStatusAssigns(line, at, statuses, sql);
    if (syntax === "hash") noteTclWrites(line, at, flags, statuses);
    noteStatusSetters(line, at, statuses);
  });
  return signalsFrom(flags, statuses);
}

/**
 * The values each flag or status field is written with, the lines that write
 * it, and whether any write is not a guarded SQL update.
 */
type Writes = Map<string, { values: Set<string>; lines: Set<number>; unguarded: boolean }>;

function note(map: Writes, name: string, value: string, line: number, guarded = false): void {
  const entry = map.get(name) ?? { values: new Set<string>(), lines: new Set<number>(), unguarded: false };
  entry.values.add(value);
  entry.lines.add(line);
  entry.unguarded ||= !guarded;
  map.set(name, entry);
}

/** `useState` booleans, `x = true` assignments and `setX(false)` calls. */
function noteFlagWrites(line: string, at: number, flags: Writes): void {
  for (const match of line.matchAll(USE_STATE)) if (isFlag(match[1])) note(flags, match[1], match[2], at);
  for (const match of line.matchAll(ASSIGN)) {
    const name = targetName(match[1], match[2]);
    if (match[0].includes(":") && isCasePayloadLabel(line, match.index)) continue;
    if (isFlag(name)) note(flags, name, match[3].toLowerCase(), at);
  }
  for (const match of line.matchAll(SETTER)) {
    const name = fromSetter(match[1]);
    if (isFlag(name)) note(flags, name, match[2].toLowerCase(), at);
  }
}

/**
 * Whether the `label:` starting at `index` is the first argument label of an
 * implicit member such as Swift's `.interruptionEnded(shouldResume: true)`: an
 * enum case's payload, so part of an event, not a write to state. Looks back
 * over one identifier only, so it is linear and bounded.
 */
function isCasePayloadLabel(line: string, index: number): boolean {
  let at = index - 1;
  while (at >= 0 && (line[at] === " " || line[at] === "\t")) at--;
  if (line[at] !== "(") return false;
  const end = --at;
  while (at >= 0 && /[\w$]/.test(line[at]!)) at--;
  if (at === end || line[at] !== ".") return false;
  return at === 0 || !/[\w$)\]?!]/.test(line[at - 1]!);
}

function noteStatusAssigns(line: string, at: number, statuses: Writes, sql: SqlFacts): void {
  for (const match of line.matchAll(STATUS_ASSIGN)) {
    const name = targetName(match[1], match[2]);
    if (!STATUS.test(name)) continue;
    const key = `${at}:${match.index + match[0].search(/\s*=/)}`;
    if (sql.comparisons.has(key)) continue;
    note(statuses, name, match[4], at, sql.guarded.has(key));
  }
}

/** Where SQL compares a status (`WHERE status = 'x'`), and which SQL writes name their from-state, keyed `line:end`. */
interface SqlFacts {
  readonly comparisons: Set<string>;
  readonly guarded: Set<string>;
}

interface Token {
  readonly text: string;
  readonly kind: "word" | "literal" | "punct";
  readonly line: number;
  /** Column just past the token, matching where an assignment target ends. */
  readonly end: number;
}

/** Words, single-quoted literals and punctuation, one pass per line; a literal ends at the line's end. */
function sqlTokens(lines: string[]): Token[] {
  const tokens: Token[] = [];
  lines.forEach((text, index) => {
    const line = index + 1;
    let at = 0;
    while (at < text.length) {
      const char = text[at]!;
      if (char === " " || char === "\t" || char === "\r") {
        at++;
      } else if (/[\w$#.]/.test(char)) {
        const start = at;
        while (at < text.length && /[\w$#.]/.test(text[at]!)) at++;
        tokens.push({ text: text.slice(start, at), kind: "word", line, end: at });
      } else if (char === "'") {
        const close = text.indexOf("'", at + 1);
        const end = close < 0 ? text.length : close + 1;
        tokens.push({ text: text.slice(at, end), kind: "literal", line, end });
        at = end;
      } else {
        tokens.push({ text: char, kind: "punct", line, end: ++at });
      }
    }
  });
  return tokens;
}

/** Uppercase SQL keywords: lowercase `and`/`or`/`in` are code in Python and Ruby. */
const COMPARES_AFTER = new Set(["WHERE", "AND", "OR", "ON", "WHEN", "NOT"]);
/** A statement ends at `;` or at the delimiter of the string holding it. */
const STATEMENT_ENDS = new Set([";", "`", '"']);
/** Lines an `UPDATE` may span before the scan stops treating what follows as its clauses. */
const STATEMENT_LINES = 40;

/** Whether the token at `index` follows `WHERE`, `AND` and the like, past any opening parentheses. */
function followsComparisonKeyword(tokens: Token[], index: number): boolean {
  let at = index - 1;
  while (at >= 0 && tokens[at]!.text === "(") at--;
  return at >= 0 && COMPARES_AFTER.has(tokens[at]!.text);
}

/** An `UPDATE` being read: its clause, the status writes in its `SET`, and the fields its `WHERE` names a from-state for. */
interface UpdateMode {
  readonly kind: "update";
  readonly line: number;
  readonly phase: "update" | "set" | "where";
  readonly writes: { field: string; key: string }[];
  readonly guards: Set<string>;
  /**
   * An `OR` or `NOT` in the `WHERE`, or a subquery anywhere in the update:
   * the from-state may not hold for every row, so nothing is guarded.
   */
  readonly loose: boolean;
}

/** Where the SQL pass is: in code, inside a `SELECT` or `DELETE` (every `field = 'x'` is a comparison), or in an `UPDATE`. */
type SqlMode = { readonly kind: "code" } | { readonly kind: "reading"; readonly line: number } | UpdateMode;

const CODE: SqlMode = { kind: "code" };

/** The mode after one token, and the update it ended, if any. Pure: it never changes `mode`. */
function sqlStep(mode: SqlMode, token: Token): { mode: SqlMode; ended?: UpdateMode } {
  const ended = mode.kind === "update" ? mode : undefined;
  if (mode.kind !== "code" && token.line - mode.line > STATEMENT_LINES) return { mode: sqlStep(CODE, token).mode, ended };
  if (token.kind === "punct") return STATEMENT_ENDS.has(token.text) ? { mode: CODE, ended } : { mode };
  if (token.kind !== "word") return { mode };
  switch (token.text) {
    case "UPDATE":
      return { mode: { kind: "update", line: token.line, phase: "update", writes: [], guards: new Set(), loose: false }, ended };
    case "SELECT":
    case "DELETE":
      // A subquery ends the UPDATE holding it unguarded, and writes after it stay counted.
      return mode.kind === "update" ? { mode: CODE, ended: { ...mode, loose: true } } : { mode: { kind: "reading", line: token.line }, ended };
    case "INSERT":
      return { mode: CODE, ended };
    case "SET":
      return { mode: mode.kind === "update" ? { ...mode, phase: "set" } : mode };
    case "WHERE":
      return { mode: mode.kind === "update" ? { ...mode, phase: "where" } : mode };
    case "OR":
    case "NOT":
      return { mode: mode.kind === "update" && mode.phase === "where" ? { ...mode, loose: true } : mode };
    default:
      return { mode };
  }
}

/** Whether `field = <value>` or `field IN (` names a from-state. */
function namesFromState(next: Token | undefined, value: Token | undefined): boolean {
  if (next?.text === "IN" || next?.text === "in") return value?.text === "(";
  if (next?.text !== "=" || value === undefined) return false;
  return value.kind === "literal" || value.text === "?" || value.text === ":" || value.text === "@" || /^\$\w+$/.test(value.text);
}

/**
 * SQL facts about status fields, found token by token with no backtracking:
 * comparisons after `WHERE`/`AND`/`OR`/`ON`/`WHEN` or inside a `SELECT` or
 * `DELETE` are reads, not writes, and an `UPDATE ... SET status = 'x'` is
 * guarded when its own `WHERE`, with no `OR`, `NOT` or subquery, names the same field's
 * from-state (`status = 'y'`, `= ?`, `= $1`, `= :from`, `IN (...)`). Such
 * updates make their module the transition table, which the skill leaves alone.
 */
function sqlStatusFacts(lines: string[]): SqlFacts {
  const facts: SqlFacts = { comparisons: new Set(), guarded: new Set() };
  const finish = (update: UpdateMode) => {
    if (update.loose) return;
    for (const write of update.writes) if (update.guards.has(write.field)) facts.guarded.add(write.key);
  };
  const tokens = sqlTokens(lines);
  let mode: SqlMode = CODE;
  tokens.forEach((token, index) => {
    const step = sqlStep(mode, token);
    if (step.ended) finish(step.ended);
    mode = step.mode;
    if (token.kind !== "word") return;
    const field = token.text.slice(token.text.lastIndexOf(".") + 1);
    if (!STATUS.test(field)) return;
    const [next, value] = [tokens[index + 1], tokens[index + 2]];
    const key = `${token.line}:${token.end}`;
    const assignsLiteral = next?.text === "=" && value?.kind === "literal";
    const inWhere = mode.kind === "update" && mode.phase === "where";
    if (mode.kind === "reading" || inWhere || followsComparisonKeyword(tokens, index)) {
      if (assignsLiteral) facts.comparisons.add(key);
      if (mode.kind === "update" && inWhere && namesFromState(next, value)) mode.guards.add(field);
      return;
    }
    if (mode.kind === "update" && mode.phase === "set" && assignsLiteral) mode.writes.push({ field, key });
  });
  if (mode.kind === "update") finish(mode);
  return facts;
}

/** Tcl's `set name value`: a flag when the value is boolean, otherwise a status. */
function noteTclWrites(line: string, at: number, flags: Writes, statuses: Writes): void {
  const flag = TCL_FLAG.exec(line);
  if (flag && isFlag(flag[1])) note(flags, flag[1], String(TCL_TRUE.has(flag[2])), at);
  const status = flag ? undefined : TCL_STATUS.exec(line);
  if (status && STATUS.test(status[1])) note(statuses, status[1], status[2], at);
}

function noteStatusSetters(line: string, at: number, statuses: Writes): void {
  for (const match of line.matchAll(STATUS_SETTER)) {
    const name = fromSetter(match[1]);
    if (STATUS.test(name)) note(statuses, name, match[3], at);
  }
}

function signalsFrom(flags: Writes, statuses: Writes): Signal[] {
  const signals: Signal[] = [];
  const toggled = [...flags].filter(([, entry]) => entry.values.size === 2);
  if (toggled.length >= 2) {
    signals.push({
      kind: "flags",
      names: toggled.map(([name]) => name).sort(),
      lines: [...new Set(toggled.flatMap(([, entry]) => [...entry.lines]))].sort((a, b) => a - b),
    });
  }
  for (const [name, entry] of statuses) {
    // A field written only by guarded SQL updates already has its transition table.
    if (entry.unguarded && entry.values.size >= 3 && entry.lines.size >= 3) {
      signals.push({ kind: "status", names: [name], values: [...entry.values].sort(), lines: [...entry.lines].sort((a, b) => a - b) });
    }
  }
  return signals;
}

/** Toggled flags weigh most: each one doubles the combinations a reader must rule out. */
function score(signals: Signal[]): number {
  return signals.reduce((total, signal) => total + (signal.kind === "flags" ? 2 * signal.names.length : signal.values!.length), 0);
}

export function scanFile(file: string, text: string): FileReport | undefined {
  const syntax = language(file, text.split("\n", 1)[0]);
  if (!syntax || syntax === "maybe" || text.length > MAX_BYTES || text.includes("\u0000")) return undefined;
  const signals = scanText(text, syntax);
  return signals.length ? { path: file, score: score(signals), signals } : undefined;
}
