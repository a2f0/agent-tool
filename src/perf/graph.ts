/** `perf graph`: the relative import closure of ES modules, for preload lists generated from built files. */
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * The source with comments blanked and every string literal's contents replaced by a
 * placeholder, keeping its quotes, so a scan for imports sees neither commented-out imports nor
 * text that only looks like one. Specifiers are kept in `strings`, indexed by placeholder.
 * Regular expression literals are not recognised: a quote inside one can hide later imports.
 */
function tokens(source: string): { code: string; strings: string[] } {
  let code = "",
    i = 0;
  const strings: string[] = [];
  while (i < source.length) {
    const char = source[i]!;
    const skipped = comment(source, i);
    if (skipped) {
      code += skipped.text;
      i = skipped.end;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const literal = stringLiteral(source, i);
      code += `${char}${strings.length}${char}`;
      strings.push(literal.text);
      i = literal.end;
      continue;
    }
    code += char;
    i += 1;
  }
  return { code, strings };
}

/** The comment starting at `start`, if one does: the index just past it (a line comment's newline stays) and what replaces it in the code. */
function comment(source: string, start: number): { end: number; text: string } | undefined {
  if (source[start] !== "/") return undefined;
  if (source[start + 1] === "/") {
    const end = source.indexOf("\n", start);
    return { end: end < 0 ? source.length : end, text: "" };
  }
  if (source[start + 1] !== "*") return undefined;
  const end = source.indexOf("*/", start + 2);
  return { end: end < 0 ? source.length : end + 2, text: " " };
}

/** The contents of the string literal whose quote is at `start`, escapes kept, and the index just past its closing quote. */
function stringLiteral(source: string, start: number): { text: string; end: number } {
  const quote = source[start];
  let j = start + 1,
    text = "";
  while (j < source.length && source[j] !== quote) {
    if (source[j] === "\\") {
      text += source[j]! + (source[j + 1] ?? "");
      j += 2;
      continue;
    }
    text += source[j]!;
    j += 1;
  }
  return { text, end: j + 1 };
}

/** Relative imports of an ES module's source: static `import`/`export from`, bare `import "x"`, and literal `import("x")`. */
export function importsOf(source: string): string[] {
  const { code, strings } = tokens(source);
  const found = new Set<string>();
  const patterns = [
    /(?:^|[^\w$.])(?:import|export)\b[^;'"`]*?\bfrom\s*["'](\d+)["']/g,
    /(?:^|[^\w$.])import\s*["'](\d+)["']/g,
    /(?:^|[^\w$.])import\s*\(\s*["'](\d+)["']\s*\)/g,
  ];
  for (const pattern of patterns)
    for (const match of code.matchAll(pattern)) {
      const specifier = strings[Number(match[1])]!;
      if (specifier.startsWith(".")) found.add(specifier);
    }
  return [...found];
}

/** Every module reachable from the entries through relative imports, as paths within `root`, entries first. */
export function moduleGraph(root: string, entries: string[]): string[] {
  const seen = new Set<string>();
  let base: string;
  try {
    base = realpathSync(root);
  } catch (error) {
    throw new Error(`Cannot read ${root}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}.`);
  }
  const walk = (rel: string, from: string | undefined) => {
    const where = from === undefined ? `entry ${rel}` : `${rel}, imported by ${from}`;
    if (rel === ".." || rel.startsWith("../") || path.posix.isAbsolute(rel)) throw new Error(`The graph leaves ${root} at ${where}.`);
    if (seen.has(rel)) return;
    seen.add(rel);
    let source: string;
    try {
      // A symbolic link inside the directory can lead out of it, as `..` can.
      const real = realpathSync(path.join(root, rel));
      if (!real.startsWith(`${base}${path.sep}`)) throw new Error(`The graph leaves ${root} at ${where}, through a symbolic link.`);
      source = readFileSync(real, "utf8");
    } catch (error) {
      if (!(error as NodeJS.ErrnoException).code) throw error;
      throw new Error(`Cannot read ${where}: ${(error as NodeJS.ErrnoException).code}.`);
    }
    for (const spec of importsOf(source)) walk(path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)), rel);
  };
  for (const entry of entries) walk(path.posix.normalize(entry), undefined);
  return [...seen];
}
