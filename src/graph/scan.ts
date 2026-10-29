/**
 * Import specifiers of a TypeScript source, type-only imports included. TypeScript 7
 * has no JS compiler API and Bun.Transpiler.scanImports drops type-only imports, so
 * this tokenizes just enough of the language to tell code from comments, strings,
 * template text, and regular expression literals, then matches import forms.
 */

/** Whether a `/` after this code starts a regular expression literal rather than a division. */
function startsRegex(before: string): boolean {
  const code = before.trimEnd();
  // `<` is left out so JSX closing tags (`</a>`) do not read as expressions.
  return code === "" || /[(,=:[!&|?{};+\-*%>~^]$/.test(code)
    || /(?<![.$\w])(?:return|typeof|case|in|of|delete|void|throw|new|yield|await|else|do)$/.test(code);
}

// A string or template right after one of these is a module specifier.
const SPECIFIER_CONTEXT = /(?:(?<![.$\w])from|(?<![.$\w])import\s*\(?|(?<![.$\w])require\s*\()\s*$/;
const CALL_CONTEXT = /(?<![.$\w])(?:import|require)\s*\(\s*$/;

/**
 * Blanks comments, template-literal text, regular expression bodies, and every string
 * that is not a module specifier, keeping the code inside `${...}` interpolations,
 * which can import too. Offsets and line breaks are preserved.
 */
export function stripNonCode(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number) => { for (let i = from; i < to; i++) if (out[i] !== "\n") out[i] = " "; };
  const before = (i: number) => out.slice(Math.max(0, i - 40), i).join("");
  // Each entry is the brace depth of an open interpolation; template text resumes when it closes.
  const interpolations: number[] = [];
  let depth = 0;
  let i = 0;
  if (source.startsWith("#!")) { i = source.indexOf("\n"); if (i === -1) i = source.length; blank(0, i); }
  const skipTemplateText = () => {
    const start = i;
    while (i < source.length) {
      if (source[i] === "\\") { i += 2; continue; }
      if (source[i] === "`") { blank(start, i); i++; return; }
      if (source[i] === "$" && source[i + 1] === "{") { blank(start, i); interpolations.push(depth); depth++; i += 2; return; }
      i++;
    }
    blank(start, source.length);
  };
  while (i < source.length) {
    const char = source[i]!;
    if (char === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop); i = stop;
    } else if (char === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop); i = stop;
    } else if (char === "/" && startsRegex(before(i))) {
      // Skip to the closing slash, honoring escapes and character classes, where `/` is literal.
      const start = ++i;
      let inClass = false;
      while (i < source.length && source[i] !== "\n" && (inClass || source[i] !== "/")) {
        if (source[i] === "\\") i++;
        else if (source[i] === "[") inClass = true;
        else if (source[i] === "]") inClass = false;
        i++;
      }
      blank(start, Math.min(i, source.length));
      i++;
    } else if (char === "\"" || char === "'") {
      const specifier = SPECIFIER_CONTEXT.test(before(i));
      const start = ++i;
      while (i < source.length && source[i] !== char && source[i] !== "\n") i += source[i] === "\\" ? 2 : 1;
      if (!specifier) blank(start, Math.min(i, source.length));
      i++;
    } else if (char === "`") {
      // A substitution-free template right after `import(` or `require(` is a specifier; keep it.
      const close = source.indexOf("`", i + 1);
      const literal = close === -1 ? "" : source.slice(i + 1, close);
      if (close !== -1 && !literal.includes("${") && !literal.includes("\\") && CALL_CONTEXT.test(before(i))) i = close + 1;
      else { i++; skipTemplateText(); }
    } else if (char === "{") { depth++; i++; }
    else if (char === "}") {
      depth--; i++;
      if (interpolations.at(-1) === depth) { interpolations.pop(); skipTemplateText(); }
    } else i++;
  }
  return out.join("");
}

const SPECIFIER = /(?<![.$\w])(?:import|export)(?:\s+type\b)?\s*(?:[\w*{}\s,$]*?\bfrom\s*)?["']([^"'\n]+)["']|(?<![.$\w])(?:import|require)\s*\(\s*["'`]([^"'`\n]+)["'`]\s*[,)]/g;

/** Every module specifier in source order, bare packages included. */
export function importSpecifiers(source: string): string[] {
  return [...stripNonCode(source).matchAll(SPECIFIER)].map(match => (match[1] ?? match[2])!);
}

/** Relative specifiers (`./` or `../`) in source order; bare packages are leaves of the graph. */
export function relativeImports(source: string): string[] {
  return importSpecifiers(source).filter(specifier => specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../"));
}
