import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/*
 * gallery.css promises (docs/screenshots.md#styling): rules on the host
 * elements have zero specificity, and every rule on a rendered part has
 * exactly one class, so a site's element resets (`button { color: inherit;
 * background: none }`) never reach the parts, while a site rule with two
 * classes, or a class and an element, still overrides them.
 */

type Specificity = [number, number, number];

/** Splits on commas outside parentheses and brackets. */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let index = 0; index < list.length; index += 1) {
    const char = list[index];
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    else if (char === "," && depth === 0) { parts.push(list.slice(start, index).trim()); start = index + 1; }
  }
  parts.push(list.slice(start).trim());
  return parts.filter(Boolean);
}

/** Selectors Level 4 specificity, for the selector forms gallery.css uses. */
function specificity(selector: string): Specificity {
  const total: Specificity = [0, 0, 0];
  let index = 0;
  const closing = (from: number) => {
    let depth = 1, at = from;
    while (depth > 0 && at < selector.length) { at += 1; if (selector[at] === "(") depth += 1; else if (selector[at] === ")") depth -= 1; }
    return at;
  };
  const add = (value: Specificity) => { for (const position of [0, 1, 2] as const) total[position] += value[position]; };
  while (index < selector.length) {
    const rest = selector.slice(index);
    const functional = /^:(where|is|not|has)\(/.exec(rest);
    if (functional) {
      const open = index + functional[0].length - 1, end = closing(open);
      if (functional[1] !== "where") {
        const max = splitTopLevel(selector.slice(open + 1, end)).map(specificity).sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])[0];
        if (max) add(max);
      }
      index = end + 1;
      continue;
    }
    const token = /^(#[\w-]+|\.[\w-]+|\[[^\]]*\]|::[\w-]+|:[\w-]+|[a-zA-Z][\w-]*|\*|[\s>+~]+)/.exec(rest);
    if (!token) throw new Error(`Cannot read selector ${selector} at ${rest}`);
    const text = token[1]!;
    if (text.startsWith("#")) total[0] += 1;
    else if (text.startsWith("::")) total[2] += 1;
    else if (text.startsWith(".") || text.startsWith("[") || text.startsWith(":")) total[1] += 1;
    else if (/^[a-zA-Z]/.test(text)) total[2] += 1;
    index += text.length;
  }
  return total;
}

/** Every style rule's selectors, with nested at-rules flattened. */
function selectors(css: string): string[] {
  const found: string[] = [];
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const prelude = /([^{}]+)\{/g;
  for (const match of source.matchAll(prelude)) {
    const text = match[1]!.trim();
    if (!text.startsWith("@")) found.push(...splitTopLevel(text));
  }
  return found;
}

const css = readFileSync(new URL("./gallery.css", import.meta.url), "utf8");
const all = selectors(css);
const compare = (a: Specificity, b: Specificity) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

describe("gallery.css specificity", () => {
  test("the specificity helper reads the forms the stylesheet uses", () => {
    expect(specificity(":where(screenshot-gallery, screenshot-carousel)")).toEqual([0, 0, 0]);
    expect(specificity(":where(.a[data-frame=\"phone\"]) .b:where(:not(.c))")).toEqual([0, 1, 0]);
    expect(specificity(".a :where(button)")).toEqual([0, 1, 0]);
    expect(specificity(".a::backdrop")).toEqual([0, 1, 1]);
    expect(specificity(":is(.a, .b) button:not(.c)")).toEqual([0, 2, 1]);
    expect(selectors("/* a { } */ @media (x) { .a, :where(b, c) { d: e; } }")).toEqual([".a", ":where(b, c)"]);
  });

  test("host rules are zero; every rule on a part has exactly one class", () => {
    expect(all.length).toBeGreaterThan(50);
    const unexpected = all.filter(selector => {
      const [ids, classes, elements] = specificity(selector);
      const host = ids === 0 && classes === 0 && elements === 0 && /^:where\(screenshot-(gallery|carousel)[\s\S]*\)$/.test(selector);
      const part = ids === 0 && classes === 1 && (elements === 0 || (elements === 1 && /::[\w-]+$/.test(selector)));
      return !host && !part;
    });
    expect(unexpected).toEqual([]);
  });

  test("control colors and backgrounds beat element resets and lose to a site class plus element", () => {
    const reset: Specificity = [0, 0, 1], siteOverride: Specificity = [0, 1, 1];
    const rule = (selector: string) => {
      const match = all.find(item => item === selector);
      if (!match) throw new Error(`gallery.css has no rule ${selector}`);
      return specificity(match);
    };
    for (const selector of [
      ".shots-toggle-button",
      ".shots-toggle-button:where([aria-pressed=\"true\"])",
      ".shots-icon-button",
      ".shots-thumb",
      ".shots-frame",
      ":where(.shots-gallery[data-frame=\"phone\"], .shots-gallery[data-frame=\"tablet\"]) .shots-frame:where(:not(.shots-missing))",
      ".shots-lightbox",
      ".shots-lightbox-close",
      ".shots-carousel-step",
    ]) {
      expect(compare(rule(selector), reset)).toBeGreaterThan(0);
      expect(compare(rule(selector), siteOverride)).toBeLessThan(0);
    }
  });

  test("no rule styles by data-theme, which sites use for their own themes", () => {
    expect(css).not.toMatch(/data-theme/);
  });
});
