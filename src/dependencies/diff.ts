import { git, oid } from "../workflows/core";

const SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
type Entries = Map<string, string>;
export interface DependencyEntry { manifest: string; section: string; name: string }

function manifests(commit: string): Map<string, Entries> {
  const files = git(["ls-tree", "-r", "--name-only", "-z", commit]).split("\0").filter(file => /(?:^|\/)package\.json$/.test(file) && !file.split("/").includes("node_modules"));
  const result = new Map<string, Entries>();
  for (const file of files) {
    let value: Record<string, unknown>;
    try { value = JSON.parse(git(["show", `${commit}:${file}`])) as Record<string, unknown>; }
    catch { throw new Error(`${file} at ${commit.slice(0, 12)} is not valid JSON.`); }
    const entries: Entries = new Map();
    for (const section of SECTIONS) {
      const declared = value[section];
      if (!declared || typeof declared !== "object" || Array.isArray(declared)) continue;
      for (const [name, spec] of Object.entries(declared)) entries.set(`${section}\0${name}`, String(spec));
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
  // A name already declared elsewhere in the repository is not new third-party code.
  const known = new Set([...before.values()].flatMap(entries => [...entries].filter(([, spec]) => !spec.startsWith("workspace:")).map(([key]) => key.split("\0")[1])));
  // A switch from a workspace to a registry or other source is new third-party code too.
  const resourced = changed.filter(item => item.from.startsWith("workspace:") && !item.to.startsWith("workspace:")).map(item => item.name);
  const newPackages = [...new Set([...added.filter(item => !item.spec.startsWith("workspace:")).map(item => item.name).filter(name => !known.has(name)), ...resourced])].sort();
  return { base, baseOid, headOid, newPackages, added, removed, changed };
}
