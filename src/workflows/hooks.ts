import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config";
import { assert, flag, git, output } from "./core";

const manifestName = ".agent-tool-hooks.json";
interface Manifest { schemaVersion: 1; files: Record<string, { hash: string; executable: boolean }> }
function digest(file: string): string { return createHash("sha256").update(readFileSync(file)).digest("hex"); }
function present(file: string): boolean { try { lstatSync(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
function config(args: string[]): string | null {
  // Do not use gitEnvironment(): it intentionally overrides hooksPath for reads.
  const result = spawnSync("git", ["config", ...args], { encoding: "utf8" });
  if (result.status === 1) return null;
  assert(result.status === 0, "Could not read Git hook configuration.");
  return result.stdout.trim();
}
function resolveDirectory(directory: string): string {
  if (existsSync(directory)) return realpathSync(directory);
  return path.join(resolveDirectory(path.dirname(directory)), path.basename(directory));
}
function within(parent: string, child: string): boolean { const relative = path.relative(parent, child); return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); }

export function hooksCommand(args: string[]): number {
  const action = args.shift();
  const apply = flag(args, "--apply");
  const adopt = flag(args, "--adopt");
  assert((action === "install" || action === "check") && !args.length && (action === "install" || (!apply && !adopt)), "Usage: hooks install [--apply] [--adopt] | hooks check");
  const root = realpathSync(git(["rev-parse", "--show-toplevel"]));
  const common = resolveDirectory(git(["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const local = config(["--worktree", "--get", "core.hooksPath"]) ?? config(["--local", "--get", "core.hooksPath"]);
  const inherited = config(["--get", "core.hooksPath"]);
  const destination = resolveDirectory(local ? path.resolve(root, local) : path.join(common, "hooks"));
  const effective = resolveDirectory(inherited ? path.resolve(root, inherited) : path.join(common, "hooks"));
  const entries = loadConfig(root).hooks.files;
  assert(entries.length > 0, "No hooks.files are configured.");
  const sources = entries.map(entry => {
    const source = path.join(root, entry.source);
    assert(lstatSync(source).isFile() && realpathSync(source) === source, `Hook source must be a regular file without symlinks: ${entry.source}`);
    git(["ls-files", "--error-unmatch", "--", entry.source]);
    assert(!within(destination, source) && !within(path.dirname(source), destination), "Hook destination overlaps source files.");
    return { ...entry, source, hash: digest(source) };
  });
  // A configured destination inside the checkout must not contain tracked files.
  if (within(root, destination)) assert(!git(["ls-files", "--", path.relative(root, destination)]), "Hook destination contains tracked files.");
  const manifestFile = path.join(destination, manifestName);
  let previous: Manifest = { schemaVersion: 1, files: {} };
  if (present(manifestFile)) {
    assert(lstatSync(manifestFile).isFile(), "Hook ownership manifest must be a regular file.");
    previous = JSON.parse(readFileSync(manifestFile, "utf8"));
    assert(previous.schemaVersion === 1 && previous.files && typeof previous.files === "object" && !Array.isArray(previous.files), "Invalid hook ownership manifest.");
    for (const [name, entry] of Object.entries(previous.files)) assert(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) && /^[a-f0-9]{64}$/.test(entry.hash) && typeof entry.executable === "boolean", "Invalid hook ownership entry.");
  }
  const changes: { target: string; status: string }[] = [];
  const blockers: string[] = [];
  const wanted = new Set(sources.map(source => source.target));
  for (const source of sources) {
    const file = path.join(destination, source.target);
    const exists = present(file);
    const regular = exists && lstatSync(file).isFile();
    const owned = previous.files[source.target];
    if (exists && !regular && !lstatSync(file).isSymbolicLink()) blockers.push(`${source.target}: destination is not a file or symlink.`);
    if (exists && !owned && !adopt) blockers.push(`${source.target}: unmanaged file; inspect it, then use --adopt to back it up.`);
    if (exists && owned && (!regular || digest(file) !== owned.hash)) blockers.push(`${source.target}: installed file was locally edited; preserve it before installing.`);
    const matches = regular && digest(file) === source.hash && (!source.executable || !!(lstatSync(file).mode & 0o111));
    changes.push({ target: source.target, status: matches && owned ? "unchanged" : exists ? "update" : "create" });
  }
  for (const [target, owned] of Object.entries(previous.files)) {
    if (wanted.has(target)) continue;
    const file = path.join(destination, target);
    if (present(file) && (!lstatSync(file).isFile() || digest(file) !== owned.hash)) blockers.push(`${target}: stale managed file was edited; refusing removal.`);
    changes.push({ target, status: "remove" });
  }
  const configure = destination !== effective;
  const ok = !blockers.length && changes.every(change => change.status === "unchanged") && !configure;
  if (action === "check" || !apply) {
    output({ ok, applied: false, destination, configure, changes, blockers });
    return action === "check" && !ok || blockers.length ? 1 : 0;
  }
  assert(!blockers.length, blockers.join("\n"));
  mkdirSync(destination, { recursive: true });
  const backupDirectory = path.join(destination, `.agent-tool-backup-${randomUUID()}`);
  const backups: string[] = [];
  // Preflight completes before changes. Never follow a destination symlink.
  for (const change of changes.filter(change => change.status !== "unchanged")) {
    const target = path.join(destination, change.target);
    if (present(target)) {
      mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
      const backup = path.join(backupDirectory, change.target);
      if (lstatSync(target).isSymbolicLink()) symlinkSync(readlinkSync(target), backup);
      else copyFileSync(target, backup);
      backups.push(backup);
    }
    if (change.status === "remove") { if (present(target)) unlinkSync(target); continue; }
    const source = sources.find(source => source.target === change.target)!;
    const temporary = path.join(destination, `.agent-tool-${randomUUID()}`);
    copyFileSync(source.source, temporary);
    chmodSync(temporary, source.executable ? 0o755 : 0o644);
    renameSync(temporary, target);
  }
  const next: Manifest = { schemaVersion: 1, files: Object.fromEntries(sources.map(source => [source.target, { hash: source.hash, executable: source.executable }])) };
  const temporary = path.join(destination, `.agent-tool-manifest-${randomUUID()}`);
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, manifestFile);
  if (configure) assert(spawnSync("git", ["config", "--local", "core.hooksPath", destination], { stdio: "inherit" }).status === 0, "Could not configure installed hooks.");
  const after = config(["--get", "core.hooksPath"]);
  assert(resolveDirectory(after ? path.resolve(root, after) : path.join(common, "hooks")) === destination, "Effective hooksPath does not match installation; inspect Git configuration.");
  output({ ok: true, applied: true, destination, changes, backups }); return 0;
}
