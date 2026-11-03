import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Real owning-manager fixture; only the registry is local, never Bun or its lockfile writer. */
export function registryFixture(manifest: Record<string, unknown>, workspaces: Record<string, Record<string, unknown>> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "dependency-registry-"));
  const project = path.join(root, "project");
  mkdirSync(project);
  // Minimum-runtime and packed-consumer checks can select a distinct owning manager / installed CLI.
  const manager = process.env.AGENT_TOOL_TEST_BUN ?? process.execPath;
  const version = spawnSync(manager, ["--version"], { encoding: "utf8" });
  if (version.status !== 0) throw new Error(`Could not identify fixture manager ${manager}.`);
  const cli = process.env.AGENT_TOOL_TEST_CLI ?? path.resolve(import.meta.dir, "../index.ts");
  const packages = new Map<string, Map<string, { manifest: Record<string, unknown>; archive: Buffer; time: string }>>();
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request): Response {
      const name = decodeURIComponent(new URL(request.url).pathname.slice(1));
      requests.push(name);
      for (const [pkg, versions] of packages) for (const [version, entry] of versions) {
        if (name === `${pkg}/-/${version}.tgz`) return new Response(new Uint8Array(entry.archive));
      }
      const versions = packages.get(name);
      if (!versions) return Response.json({ error: "unknown fixture package" }, { status: 404 });
      return Response.json({
        name, "dist-tags": { latest: [...versions.keys()].at(-1) },
        time: Object.fromEntries([...versions].map(([version, entry]) => [version, entry.time])),
        versions: Object.fromEntries([...versions].map(([version, entry]) => [version, {
          ...entry.manifest,
          dist: { tarball: `${server.url}${name}/-/${version}.tgz`, integrity: `sha512-${createHash("sha512").update(entry.archive).digest("base64")}` },
        }])),
      });
    },
  });
  const write = (relative: string, value: unknown) => {
    const file = path.join(project, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  };
  write("package.json", { name: "fixture", private: true, ...manifest });
  for (const [directory, value] of Object.entries(workspaces)) write(`${directory}/package.json`, value);
  writeFileSync(path.join(project, ".mise.toml"), `[tools]\nbun = "${version.stdout.trim()}"\n`);
  writeFileSync(path.join(project, "bunfig.toml"), `[install]\nregistry = "${server.url}"\n[install.cache]\ndir = ${JSON.stringify(path.join(root, "cache"))}\ndisable = true\ndisableManifest = true\n`);
  spawnSync("git", ["init", "-q"], { cwd: project });
  // No fixture can accidentally read credentials, use the public registry, or populate the global cache.
  const env = { ...process.env, PATH: `${path.dirname(manager)}${path.delimiter}${process.env.PATH}`, BUN_CONFIG_REGISTRY: server.url.toString(), npm_config_registry: server.url.toString(), BUN_INSTALL_CACHE_DIR: path.join(root, "cache"), MISE_DATA_DIR: path.join(root, "absent-mise"), HOME: root };
  const logs = new Set<string>();
  const execute = async (executable: string, args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) => {
    const child = Bun.spawn([executable, ...args], { cwd: options.cwd ?? project, env: { ...env, ...options.env }, stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const receipt = stdout.startsWith("{") ? JSON.parse(stdout) : null;
    for (const item of receipt?.runs ?? []) logs.add(path.dirname(item.log));
    return { status, stdout, stderr, receipt };
  };
  return {
    root, project, requests, env, write, manager, cli,
    read: (relative = "package.json") => readFileSync(path.join(project, relative), "utf8"),
    lock: () => Bun.JSONC.parse(readFileSync(path.join(project, "bun.lock"), "utf8")) as { packages: Record<string, unknown[]>; catalog?: Record<string, string>; catalogs?: Record<string, Record<string, string>> },
    run: (args: string[], options?: { cwd?: string; env?: Record<string, string> }) => execute(manager, args, options),
    command: (args: string[], options?: { cwd?: string; env?: Record<string, string> }) => execute(process.execPath, [cli, "bun", ...args], options),
    publish(name: string, version: string, fields: Record<string, unknown> = {}, time = "2020-01-01T00:00:00.000Z") {
      const pkg = { name, version, ...fields };
      const directory = path.join(root, "tar");
      mkdirSync(path.join(directory, "package"), { recursive: true });
      writeFileSync(path.join(directory, "package/package.json"), JSON.stringify(pkg));
      const tar = spawnSync("tar", ["-czf", "-", "package"], { cwd: directory });
      if (tar.status !== 0) throw new Error(tar.stderr.toString());
      const versions = packages.get(name) ?? new Map();
      versions.set(version, { manifest: pkg, archive: tar.stdout, time });
      packages.set(name, versions);
    },
    close() {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
      for (const log of logs) rmSync(log, { recursive: true, force: true });
    },
  };
}
