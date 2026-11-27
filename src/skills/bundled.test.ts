import { expect, test } from "bun:test";
import path from "node:path";
import { bundledSkillFiles } from "./manifest";

// An installed skill has only the files the bundle ships, so a relative link to
// anything else (a script, a repository doc) would be broken in every consumer.
const shipped = new Map<string, string>(bundledSkillFiles().flatMap(([name, files]) => files.map(([inside, source]): [string, string] => [`${name}/${inside}`, source])));
const slug = (heading: string) => heading.toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s/g, "-");

test("every relative link in a bundled skill names a shipped file and heading", () => {
  const links: string[] = [];
  for (const [file, source] of shipped) {
    if (!file.endsWith(".md")) continue;
    for (const match of source.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1]!;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const [relative = "", fragment] = target.split("#");
      const resolved = relative ? path.posix.normalize(path.posix.join(path.posix.dirname(file), relative)) : file;
      const linked = shipped.get(resolved);
      links.push(`${file} -> ${target}`);
      expect({ link: `${file} -> ${target}`, shipped: linked !== undefined }).toEqual({ link: `${file} -> ${target}`, shipped: true });
      if (fragment && linked !== undefined) {
        const headings = [...linked.matchAll(/^#+ (.+)$/gm)].map(heading => slug(heading[1]!));
        expect({ link: `${file} -> ${target}`, headings }).toEqual({ link: `${file} -> ${target}`, headings: expect.arrayContaining([fragment]) });
      }
    }
  }
  // The check found the links it guards, across skills and within one.
  expect(links).toContain("update-dependencies/SKILL.md -> ../ship-pr/SKILL.md");
  expect(links).toContain("audit-trails/SKILL.md -> references/usage-receipts.md#publish-and-resume");
  expect(links).toContain("seo-optimization/SKILL.md -> references/standard.md");
});
