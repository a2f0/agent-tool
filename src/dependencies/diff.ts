import { git, oid } from "../workflows/core";

const SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
type Entries = Map<string, string>;
export interface DependencyEntry { manifest: string; section: string; name: string }

const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function manifests(commit: string): Map<string, Entries> {
  const files = git(["ls-tree", "-r", "--full-tree", "--name-only", "-z", commit]).split("\0").filter(file => /(?:^|\/)package\.json$/.test(file) && !file.split("/").includes("node_modules"));
  const read = (file: string): Record<string, unknown> => {
    try { return JSON.parse(git(["show", `${commit}:${file}`])) as Record<string, unknown>; }
    catch { throw new Error(`${file} at ${commit.slice(0, 12)} is not valid JSON.`); }
  };
  // `catalog:` and `catalog:<name>` resolve through the root manifest's catalogs, so a catalog change is a change.
  const root = files.includes("package.json") ? read("package.json") : {};
  const workspaces = object(root.workspaces);
  const catalog = object(root.catalog) ?? object(workspaces?.catalog) ?? {};
  const catalogs = object(root.catalogs) ?? object(workspaces?.catalogs) ?? {};
  const resolve = (name: string, spec: string): string => {
    if (!spec.startsWith("catalog:")) return spec;
    const named = spec.slice("catalog:".length);
    const value = named && named !== "default" ? object(catalogs[named])?.[name] : catalog[name];
    return typeof value === "string" ? value : spec;
  };
  const result = new Map<string, Entries>();
  for (const file of files) {
    const value = read(file);
    const entries: Entries = new Map();
    for (const section of SECTIONS) {
      const declared = object(value[section]);
      if (!declared) continue;
      for (const [name, spec] of Object.entries(declared)) entries.set(`${section}\0${name}`, resolve(name, String(spec)));
    }
    result.set(file, entries);
  }
  return result;
}

/**
 * Declared dependencies added, removed, or changed in every tracked package.json between
 * a base and HEAD. It reads committed manifests, so a package added by any route, including
 * a hand-edited manifest, shows up for review.
 */
export function dependencyDiff(base: string) {
  const baseOid = oid(git(["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]));
  const headOid = oid(git(["rev-parse", "HEAD"]));
  const before = manifests(baseOid), after = manifests(headOid);
  const added: (DependencyEntry & { spec: string })[] = [], removed: (DependencyEntry & { spec: string })[] = [], changed: (DependencyEntry & { from: string; to: string })[] = [];
  for (const manifest of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const old = before.get(manifest) ?? new Map(), now = after.get(manifest) ?? new Map();
    for (const key of [...new Set([...old.keys(), ...now.keys()])].sort()) {
      const [section, name] = key.split("\0") as [string, string];
      const from = old.get(key), to = now.get(key);
      if (from === undefined) added.push({ manifest, section, name, spec: to! });
      else if (to === undefined) removed.push({ manifest, section, name, spec: from });
      else if (from !== to) changed.push({ manifest, section, name, from, to });
    }
  }
  // Package identity: an `npm:` alias installs the package it names, not the declared name.
  const identity = (name: string, spec: string) => spec.startsWith("npm:") ? spec.slice(4).replace(/(.)@[^@]*$/, "$1") : name;
  // A package already declared elsewhere in the repository is not new third-party code.
  const known = new Set([...before.values()].flatMap(entries => [...entries].filter(([, spec]) => !spec.startsWith("workspace:")).map(([key, spec]) => identity(key.split("\0")[1]!, spec))));
  const introduced = [
    ...added.filter(item => !item.spec.startsWith("workspace:")).map(item => identity(item.name, item.spec)),
    // A switch from a workspace, or to another aliased package, is new third-party code too.
    ...changed.filter(item => !item.to.startsWith("workspace:") && (item.from.startsWith("workspace:") || identity(item.name, item.from) !== identity(item.name, item.to))).map(item => identity(item.name, item.to)),
  ];
  const newPackages = [...new Set(introduced.filter(name => !known.has(name) || changed.some(item => item.from.startsWith("workspace:") && item.name === name)))].sort();
  return { base, baseOid, headOid, newPackages, added, removed, changed };
}
