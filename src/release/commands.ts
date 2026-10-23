import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { decidePublish, readRegistryState } from "./npm";
import { assert, flag, json, oid, option, output, poll, repository, timeoutOptions } from "../workflows/core";

function packageName(name: unknown): asserts name is string { assert(typeof name === "string" && /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(name), "Invalid npm package name."); }
export interface ReleaseRun { databaseId: number; status: string; conclusion: string; headSha: string; url: string }
export async function verifyTarball(metadata: { name: string; version: string; dist: { tarball: string; integrity: string } }): Promise<{ tarball: string; integrity: string }> {
  const url = new URL(metadata.dist.tarball);
  assert(url.protocol === "https:" && url.hostname === "registry.npmjs.org", "Expected an HTTPS npm registry tarball.");
  const integrity = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(metadata.dist.integrity);
  assert(integrity, "Package must have SHA-512 tarball integrity.");
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: "error" });
  assert(response.ok && response.body, "Could not download the published tarball.");
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; assert(size <= 100 * 1024 * 1024, "Tarball exceeds the 100 MiB verification limit."); chunks.push(chunk); }
  const archive = Buffer.concat(chunks);
  assert(createHash("sha512").update(archive).digest("base64") === integrity[1], "Published tarball integrity does not match registry metadata.");
  // Read one member to stdout: do not extract untrusted archive paths to disk.
  const manifest = JSON.parse(execFileSync("tar", ["-xzOf", "-", "package/package.json"], { input: archive, encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 30_000 }));
  assert(manifest.name === metadata.name && manifest.version === metadata.version, "Published tarball manifest does not match the requested package/version.");
  return { tarball: url.href, integrity: metadata.dist.integrity };
}

export async function inspectRelease(
  runs: ReleaseRun[],
  expected: { name: string; version: string; commit: string },
  readMetadata = () => fetch(`https://registry.npmjs.org/${encodeURIComponent(expected.name)}/${expected.version}`, { signal: AbortSignal.timeout(30_000) }),
  checkArtifact = verifyTarball,
) {
  const run = runs.filter(run => run.headSha === expected.commit).sort((a, b) => b.databaseId - a.databaseId)[0];
  if (!run || run.status !== "completed") return { done: false, value: { ok: false, reason: "Publishing workflow has not completed.", run: run ?? null } };
  assert(run.conclusion === "success", `Publishing workflow failed: ${run.url} (${run.conclusion}).`);
  const response = await readMetadata();
  if (response.status === 404) return { done: false, value: { ok: false, reason: "Version has not propagated to npm.", run } };
  assert(response.ok, `npm registry returned HTTP ${response.status}.`);
  const metadata = await response.json() as { name: string; version: string; gitHead?: string; dist: { tarball: string; integrity: string } };
  assert(metadata.name === expected.name && metadata.version === expected.version, "Registry returned a different package version.");
  assert(!metadata.gitHead || metadata.gitHead === expected.commit, "Registry gitHead differs from the publishing merge commit.");
  const artifact = await checkArtifact(metadata);
  return { done: true, value: { ok: true, reason: "Workflow and published tarball verified.", run, ...artifact, gitHead: metadata.gitHead ?? null } };
}

export async function releaseCommand(args: string[]): Promise<number> {
  const action = args.shift();
  if (action === "plan") {
    const githubOutput = flag(args, "--github-output");
    const allowPrivateSource = flag(args, "--allow-private-source");
    assert(args.length === 1, "Usage: release plan <package.json> [--github-output] [--allow-private-source]");
    const manifest = JSON.parse(readFileSync(args[0]!, "utf8"));
    packageName(manifest.name);
    assert(manifest.private !== true || allowPrivateSource, "Private source manifest; use --allow-private-source only when the build creates a publishable manifest.");
    const decision = decidePublish(manifest.version, readRegistryState(manifest.name));
    if (githubOutput) { assert(process.env.GITHUB_OUTPUT, "--github-output requires GITHUB_OUTPUT."); appendFileSync(process.env.GITHUB_OUTPUT, `publish=${decision.publish}\n`); }
    output({ name: manifest.name, version: manifest.version, privateSource: manifest.private === true, ...decision }); return 0;
  }
  const workflow = option(args, "--workflow");
  const options = timeoutOptions(args);
  assert(action === "verify" && args.length === 3 && workflow, "Usage: release verify <package> <version> <merge-oid> --workflow <name> [--timeout seconds] [--interval seconds]");
  const [name, version, commit] = args as [string, string, string];
  packageName(name); oid(commit);
  assert(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version), "Expected a stable package version.");
  const repo = repository().nameWithOwner;
  const result = await poll(() => inspectRelease(json<ReleaseRun[]>(["run", "list", "-R", repo, "--workflow", workflow, "--commit", commit, "--limit", "100", "--json", "databaseId,status,conclusion,headSha,url"]), { name, version, commit }), options);
  output({ repo, name, version, commit, ...result }); return 0;
}
