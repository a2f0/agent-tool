import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { readRegularFile } from "../system/files";

/**
 * User-wide skills: a repository declares them by name in `skills.user`, and `skills link`
 * links each into every user skill directory, so every harness session sees them whatever
 * repository it starts in. Claude Code reads `<config dir>/skills` for each config directory;
 * `~/.agents/skills` is the user-level counterpart of a project's `.agents/skills`.
 */
export type UserSkillHarness = "claude" | "agents";
export interface UserSkillDirectory { harness: UserSkillHarness; directory: string }

/**
 * What a link path holds: nothing (`create`); a symbolic link that does not resolve to a skill
 * directory, or that resolves to another copy of the skill in this repository (`repair`); a link
 * to this repository's source (`unchanged`); a link to the same skill elsewhere, such as another
 * clone (`kept`); or anything else (`conflict`): a file or directory, or a link to a different
 * skill. Only `create` and `repair` are ever written.
 */
export type SkillLinkStatus = "create" | "repair" | "unchanged" | "kept" | "conflict";
/**
 * One declared skill in one user skill directory. `status` is the plan's classification and
 * `current` an existing link's own text. Only an applied write sets `result`: `written`, or
 * `failed` with `error` saying why; an entry without one was not written.
 */
export interface SkillLink { skill: string; directory: string; path: string; target: string; status: SkillLinkStatus; current?: string; result?: "written" | "failed"; error?: string }

type Environment = Record<string, string | undefined>;
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code ?? "";
/** Errors that mean a path, or what a link names, does not exist as asked. */
const ABSENT = ["ENOENT", "ENOTDIR", "ELOOP"];

function statOrNull(file: string) {
  try { return statSync(file); } catch (error) { if (ABSENT.includes(errorCode(error))) return null; throw error; }
}
function isLink(file: string): boolean {
  try { return lstatSync(file).isSymbolicLink(); } catch (error) { if (["ENOENT", "ENOTDIR"].includes(errorCode(error))) return false; throw error; }
}
const isDirectory = (file: string) => statOrNull(file)?.isDirectory() ?? false;
/** A directory holding a regular `SKILL.md`, following links as the harnesses do. */
const holdsSkill = (directory: string) => isDirectory(directory) && (statOrNull(path.join(directory, "SKILL.md"))?.isFile() ?? false);
function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** The home directory, from `HOME` first so tests and callers can isolate it. */
export function userHome(env: Environment = process.env): string {
  return path.resolve(env.HOME || homedir());
}

/** Keeps the first of each real path, so links and aliases name one directory once. */
function unique<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter(item => { const value = key(item); if (seen.has(value)) return false; seen.add(value); return true; });
}

/**
 * The real path of a directory that may not exist yet: its nearest existing ancestor's, then the
 * rest, following a dangling link to where it points, so a link to a directory not created yet
 * names that directory. A link loop stops after 40 links, at whichever name it reached, which
 * planning then refuses as a link that does not resolve to a directory.
 */
function realDirectory(directory: string, hops = 0): string {
  try { return realpathSync(directory); }
  catch (error) { if (!ABSENT.includes(errorCode(error))) throw error; }
  const parent = path.dirname(directory);
  if (parent === directory) return directory;
  const resolved = path.join(realDirectory(parent, hops), path.basename(directory));
  if (hops >= 40 || !isLink(resolved)) return resolved;
  return realDirectory(path.resolve(path.dirname(resolved), readlinkSync(resolved)), hops + 1);
}

/**
 * Claude Code config directories, in this order: the one `CLAUDE_CONFIG_DIR` names when it is set
 * to an absolute path; `~/.claude`; then every other directory directly in home whose name starts with
 * `.claude` and that holds `settings.json` or `.claude.json`, such as `~/.claude2`. Claude Code
 * writes `.claude.json` into a directory it runs with, and provisioning links `settings.json` into
 * one. Only existing directories count, so files such as `~/.claude.json` never do, and a
 * directory reached twice, by a link or by `CLAUDE_CONFIG_DIR`, counts once, by real path.
 */
export function claudeConfigDirectories(env: Environment = process.env): string[] {
  const home = userHome(env);
  const candidates: string[] = [];
  // Only an absolute path: a relative one depends on where Claude Code started, which is unknown here.
  if (env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR)) candidates.push(path.normalize(env.CLAUDE_CONFIG_DIR));
  candidates.push(path.join(home, ".claude"));
  let names: string[] = [];
  try { names = readdirSync(home).sort(); } catch (error) { if (!ABSENT.includes(errorCode(error))) throw error; }
  for (const name of names) {
    if (!name.startsWith(".claude") || name === ".claude") continue;
    const directory = path.join(home, name);
    if (["settings.json", ".claude.json"].some(marker => existsSync(path.join(directory, marker)))) candidates.push(directory);
  }
  return unique(candidates.filter(isDirectory), directory => realpathSync(directory));
}

/**
 * `~/.agents/skills`, then `<dir>/skills` for each Claude Code config directory. A skills
 * directory reached twice, such as `~/.claude2/skills` linked to `~/.claude/skills`, counts once,
 * under the name that is not itself a link, so a link to a directory not created yet resolves
 * once that directory is created.
 */
export function userSkillDirectories(env: Environment = process.env): UserSkillDirectory[] {
  const directories = [
    { harness: "agents" as const, directory: path.join(userHome(env), ".agents", "skills") },
    ...claudeConfigDirectories(env).map(directory => ({ harness: "claude" as const, directory: path.join(directory, "skills") })),
  ].map(item => ({ ...item, key: realDirectory(item.directory), link: isLink(item.directory) }));
  const chosen = new Map<string, typeof directories[number]>();
  for (const item of directories) {
    const first = chosen.get(item.key);
    if (!first || (first.link && !item.link)) chosen.set(item.key, item);
  }
  return directories.filter(item => chosen.get(item.key) === item).map(({ harness, directory }) => ({ harness, directory }));
}

/**
 * The repository directory a harness links to for one skill: its installed copy for that harness
 * when it holds `SKILL.md` (`.claude/skills/<name>` or `.agents/skills/<name>`), otherwise the
 * repository-owned `skills/<name>`, as an absolute real path inside the repository.
 */
export function skillSource(root: string, harness: UserSkillHarness, name: string): string {
  const installed = harness === "claude" ? ".claude/skills" : ".agents/skills";
  const found = [`${installed}/${name}`, `skills/${name}`].find(relative => holdsSkill(path.join(root, relative)));
  if (!found) throw new Error(`Declared user skill '${name}' has no SKILL.md in ${installed}/${name} or skills/${name}.`);
  const source = realpathSync(path.join(root, found));
  if (!within(root, source)) throw new Error(`Declared user skill '${name}' resolves outside the repository: ${found}.`);
  // Links are matched to skills by name, so a source must be the skill it is declared as.
  const named = skillName(source);
  if (named !== name) throw new Error(`Declared user skill '${name}' is named '${named}' in ${found}/SKILL.md.`);
  return source;
}

/** The skill a directory holds: its `SKILL.md` front matter `name`, else the directory's name; none without `SKILL.md`. */
function skillName(directory: string): string | undefined {
  if (!holdsSkill(directory)) return undefined;
  // One non-blocking, link-refusing read of the resolved file, so a FIFO cannot stall the check.
  let file: string;
  try { file = realpathSync(path.join(directory, "SKILL.md")); }
  catch (error) { if (ABSENT.includes(errorCode(error))) return undefined; throw error; }
  const read = readRegularFile(file);
  if (read.status !== "file") return undefined;
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(read.contents)?.[1];
  const name = front === undefined ? undefined : /^name:[ \t]*(.*?)[ \t]*$/m.exec(front)?.[1]?.replace(/^(["'])(.*)\1$/, "$2");
  return name || path.basename(directory);
}

/** Inside the repository and not inside a repository nested in it, such as a workspace's checkouts. */
function inRepository(root: string, file: string): boolean {
  if (!within(root, file)) return false;
  for (let directory = file; directory !== root && within(root, directory); directory = path.dirname(directory)) {
    if (existsSync(path.join(directory, ".git"))) return false;
  }
  return true;
}

/** Classify one link path against its intended target without changing anything. */
function classify(root: string, file: string, target: string, skill: string): Pick<SkillLink, "status" | "current"> {
  let link: boolean;
  try { link = lstatSync(file).isSymbolicLink(); }
  catch (error) { if (errorCode(error) === "ENOENT") return { status: "create" }; throw error; }
  if (!link) return { status: "conflict" };
  const current = readlinkSync(file);
  let resolved: string;
  try { resolved = realpathSync(file); }
  catch (error) { if (ABSENT.includes(errorCode(error))) return { status: "repair", current }; throw error; }
  if (resolved === target) return { status: "unchanged", current };
  const name = skillName(resolved);
  if (name === undefined) return { status: "repair", current };
  if (name !== skill) return { status: "conflict", current };
  // This repository owns both copies, so the link moves to the one this harness should load.
  return { status: inRepository(root, resolved) ? "repair" : "kept", current };
}

/** Whether a user skill directory exists; one that names anything but a directory is refused. */
function directoryExists(directory: string): boolean {
  try { lstatSync(directory); }
  catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    if (errorCode(error) !== "ENOTDIR") throw error;
  }
  if (isDirectory(directory)) return true;
  if (isLink(directory)) throw new Error(`User skill directory is a link that does not resolve to a directory: ${directory} -> ${readlinkSync(directory)}`);
  throw new Error(`User skill directory is not a directory: ${directory}`);
}

/**
 * One entry per declared skill and user skill directory. Every source resolves first, for both
 * harnesses, so a declaration without one fails on every machine and before anything is read
 * from home. Only the declared names are ever examined.
 */
export function planSkillLinks(rootDir: string, names: string[], env: Environment = process.env): SkillLink[] {
  if (!names.length) return [];
  const root = realpathSync(rootDir);
  const sources = {
    agents: names.map(name => skillSource(root, "agents", name)),
    claude: names.map(name => skillSource(root, "claude", name)),
  };
  const links: SkillLink[] = [];
  for (const { harness, directory } of userSkillDirectories(env)) {
    const exists = directoryExists(directory);
    names.forEach((skill, index) => {
      const target = sources[harness][index]!, file = path.join(directory, skill);
      links.push({ skill, directory, path: file, target, ...(exists ? classify(root, file, target, skill) : { status: "create" as const }) });
    });
  }
  return links;
}

/**
 * Replace a link through a fresh temporary link and a rename, so the name is never missing. Only
 * the link the plan classified is replaced: the path must still hold a link with the same text
 * just before the rename. Node has no exchanging rename, so a writer racing that instant is
 * outside this guard; only another process writing the user's skill directories could do it.
 */
function replaceLink(link: SkillLink): void {
  const temporary = path.join(link.directory, `.${link.skill}.agent-tool-${randomUUID()}.tmp`);
  symlinkSync(link.target, temporary, "dir");
  let renamed = false;
  try {
    let current: string | undefined;
    // EINVAL: not a link.
    try { current = readlinkSync(link.path); } catch (error) { if (!["ENOENT", "ENOTDIR", "EINVAL"].includes(errorCode(error))) throw error; }
    if (current === undefined || current !== link.current) throw new Error(`Refusing to replace ${link.path}, which changed since the plan.`);
    renameSync(temporary, link.path);
    renamed = true;
  } finally {
    // Best effort: the original error matters more than a temporary link left behind.
    if (!renamed) try { unlinkSync(temporary); } catch {}
  }
}

/**
 * Writes a plan's `create` and `repair` entries. Each write stands alone: one that fails, such as
 * a create whose path was taken since the plan, records its `error` and the rest still run, so
 * the result says exactly what was written. Nothing that is not a link is replaced or removed.
 */
export function applySkillLinks(changes: SkillLink[]): SkillLink[] {
  return changes.map(change => {
    if (change.status !== "create" && change.status !== "repair") return change;
    try {
      if (change.status === "create") {
        mkdirSync(change.directory, { recursive: true, mode: 0o700 });
        // Fails rather than overwrites if anything appeared since the plan.
        symlinkSync(change.target, change.path, "dir");
      } else replaceLink(change);
      return { ...change, result: "written" as const };
    } catch (error) {
      return { ...change, result: "failed" as const, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

/**
 * Whether the checkout lives in a linked worktree. `git rev-parse --git-common-dir` would miss a
 * submodule inside a linked worktree, so this reads the layout: the checkout's `.git` is a file
 * naming a Git directory that, or one of whose ancestors up to the enclosing `.git` directory,
 * holds `commondir`, which Git writes only into a linked worktree's Git directory. The ancestors
 * cover a submodule checked out inside a linked worktree, whose Git directory sits under that
 * worktree's `modules/`. The walk stops at the outermost Git directory, so a stray `commondir`
 * above the repository never counts.
 */
function linkedWorktree(root: string): boolean {
  const read = readRegularFile(path.join(root, ".git"));
  const gitdir = read.status === "file" ? /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(read.contents)?.[1] : undefined;
  if (gitdir === undefined) return false;
  for (let directory = path.resolve(root, gitdir); ; directory = path.dirname(directory)) {
    if (existsSync(path.join(directory, "commondir"))) return true;
    const parent = path.dirname(directory);
    if (parent === directory || path.basename(directory) === ".git") return false;
    // A Git directory with no `modules` directory above it is the outermost, as with `--separate-git-dir`.
    if (existsSync(path.join(directory, "HEAD")) && !parent.split(path.sep).includes("modules")) return false;
  }
}

/**
 * Previews by default. With `apply`, creates missing links, creating a missing skills directory
 * (mode 0700), and repairs broken ones. A conflict anywhere blocks every write. Links follow the
 * checked-out working tree, so a linked worktree, which is removed when its work is done, is refused.
 * `applied` is true only when every write succeeded; a failed one carries `error`.
 */
export function linkSkills(rootDir: string, names: string[], apply = false, env: Environment = process.env): { applied: boolean; changes: SkillLink[] } {
  const changes = planSkillLinks(rootDir, names, env);
  if (!apply || changes.some(change => change.status === "conflict")) return { applied: false, changes };
  if (changes.some(change => change.status === "create" || change.status === "repair") && linkedWorktree(realpathSync(rootDir))) {
    throw new Error("Refusing to link user-wide skills from a linked worktree, whose removal would break them; run skills link from the main checkout.");
  }
  const applied = applySkillLinks(changes);
  return { applied: applied.every(change => change.result !== "failed"), changes: applied };
}

/** Read-only: ok while every declared link is unchanged or kept, so health reports can gate on it. */
export function checkSkillLinks(rootDir: string, names: string[], env: Environment = process.env): { ok: boolean; changes: SkillLink[] } {
  const changes = planSkillLinks(rootDir, names, env);
  return { ok: changes.every(change => change.status === "unchanged" || change.status === "kept"), changes };
}
