import { describe, expect, test } from "bun:test";
import { importSpecifiers, relativeImports, stripNonCode } from "./scan";

describe("relativeImports", () => {
  test("passes the reference fixture of the guard tests it replaces", () => {
    const source = [
      'import { a } from "./a";',
      'import type { B } from "./b";',
      'import "./c";',
      'export * from "./d";',
      'const e = await import("./e");',
      "import {\n  f,\n  type F,\n} from './f';",
      '// import { g } from "./g";',
      '/* import { h } from "./h"; */',
      'const preload = `import { i } from "./i";`;',
      'import { j } from "node:fs";',
      'const url = "https://example.com"; import{k}from"./k";',
      'const lazy = `${(await import("./l")).name} and ${`nested ${await import("./m")}`} import "./n"`;',
      'const brace = `${ { o: 1 }.o }`; import "./p";',
      'const spaced = await import ("./q");',
      'const fixture = \'import "./r";\'; const other = "export * from \'./s\'";',
      'const literal = await import(`./t`); const dynamic = await import(`./${name}`);',
      'const quote = /"/; import "./u"; const tick = /`/g; import "./v"; const half = 4 / 2; import "./w";',
      'const klass = /[/"]/; import "./x";',
    ].join("\n");
    expect(relativeImports(source)).toEqual(["./a", "./b", "./c", "./d", "./e", "./f", "./k", "./l", "./m", "./p", "./q", "./t", "./u", "./v", "./w", "./x"]);
  });

  test("scans every import form, including type-only ones", () => {
    const source = [
      'import { a } from "./a";',
      'import type { B } from "./b";',
      'import "./c";',
      'export * from "./d";',
      'export type { E } from "./e";',
      'const f = await import("./f");',
      "import {\n  g,\n  type G,\n} from './g';",
      'import{l}from"./l";import type{M}from"./m";export*from"./n";import"./o";',
      'import p, * as q from "./p";',
      'export * as r from "../r";',
      'type S = typeof import("./s"); type T = import("./t").T;',
      'const u = require("./u"); import v = require("./v");',
      'const w = await import("./w", { with: { type: "json" } });',
      'import x from "./x" with { type: "json" };',
      'import { "string name" as y } from "./y";',
    ].join("\n");
    expect(relativeImports(source)).toEqual(["./a", "./b", "./c", "./d", "./e", "./f", "./g", "./l", "./m", "./n", "./o", "./p", "../r", "./s", "./t", "./u", "./v", "./w", "./x", "./y"]);
  });

  test("ignores comments, template text, and strings that are not specifiers", () => {
    const source = [
      '// import { g } from "./g";',
      '/* import { h } from "./h"; */',
      "/**\n * import './multi';\n */",
      'const preload = `import { i } from "./i";`;',
      'const url = "https://example.com"; import{k}from"./k";',
      'const fixture = \'import "./r";\'; const other = "export * from \'./s\'";',
      'const multiline = `\nimport "./t2";\n`;',
      'const escaped = "\\" import \\"./esc\\""; import "./after-escape";',
    ].join("\n");
    expect(relativeImports(source)).toEqual(["./k", "./after-escape"]);
  });

  test("keeps code inside template interpolations and blanks the text around it", () => {
    const source = [
      'const lazy = `${(await import("./l")).name} and ${`nested ${await import("./m")}`} import "./n"`;',
      'const brace = `${ { o: 1 }.o }`; import "./p";',
      'const tail = `${a}` + `b ${ c } import "./nope"`; import "./q";',
    ].join("\n");
    expect(relativeImports(source)).toEqual(["./l", "./m", "./p", "./q"]);
  });

  test("reads substitution-free template specifiers, spaced calls, and skips method calls named import", () => {
    const source = [
      'const spaced = await import ("./q");',
      "const literal = await import(`./t`); const dynamic = await import(`./${name}`);",
      'const call = await import(\n  "./split"\n);',
      'loader.import("./method"); module.require("./member"); $import("./dollar");',
      "const required = require(`./req`);",
    ].join("\n");
    expect(relativeImports(source)).toEqual(["./q", "./t", "./split", "./req"]);
  });

  test("treats quotes and backticks in regular expression literals as regex text", () => {
    const source = [
      'const quote = /"/; import "./u"; const tick = /`/g; import "./v"; const half = 4 / 2; import "./w";',
      'const klass = /[/"]/; import "./x";',
      'if (ok) return /\'/.test(s); import "./y";',
      'const ratio = (a + b) / 2 / c; import "./z";',
      'const escapedSlash = /\\/"/; import "./aa";',
    ].join("\n");
    expect(relativeImports(source)).toEqual(["./u", "./v", "./w", "./x", "./y", "./z", "./aa"]);
  });

  test("tells regex literals after control-flow conditions from divisions after expressions", () => {
    const source = [
      'if (ok) /"/.test(s); import "./a";',
      'while (f(x)) /`/.exec(s); import "./b";',
      'for (const c of cs) /\'/.test(c); import "./c";',
      'const d = f(x) / 2 / g(y); import "./d";',
      'const e = i++ / 2; const q = "/"; import "./e";',
      'if (a) { x = (b) / c; } import "./f";',
      'const n = value! / 2; const m = list[0]! / f()! / 3; import "./g";',
      'if (!/"/.test(s)) x = 1; const neg = !/`/.test(s); import "./h";',
    ].join("\n");
    expect(relativeImports(source)).toEqual(["./a", "./b", "./c", "./d", "./e", "./f", "./g", "./h"]);
  });

  test("finds a specifier however long the comment or whitespace before it", () => {
    const comment = `/* ${"x".repeat(200)} */`;
    const source = [
      `import { a } from ${comment} "./a";`,
      `export * from\n${" ".repeat(100)}\n"./b";`,
      `const c = await import(${comment}\n  "./c");`,
      `const d = await import ${comment} (\`./d\`);`,
    ].join("\n");
    expect(relativeImports(source)).toEqual(["./a", "./b", "./c", "./d"]);
  });

  test("reads JSX closing tags as code and skips a shebang", () => {
    const tsx = '#!/usr/bin/env bun\nimport { A } from "./a";\nconst view = <a href="/x">ok</a>; import "./b";';
    expect(relativeImports(tsx)).toEqual(["./a", "./b"]);
  });

  test("keeps bare packages out of relative imports and preserves offsets", () => {
    const source = 'import { k } from "node:fs";\nimport x from "@scope/pkg";\nimport ".";\nimport "./x";';
    expect(importSpecifiers(source)).toEqual(["node:fs", "@scope/pkg", ".", "./x"]);
    expect(relativeImports(source)).toEqual([".", "./x"]);
    const stripped = stripNonCode('const s = "text";\n// note\n');
    expect(stripped.length).toBe('const s = "text";\n// note\n'.length);
    expect(stripped.split("\n").length).toBe(3);
  });
});
