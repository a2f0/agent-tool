// Runs src/permissions/gemini.conformance.test.ts against pinned Gemini CLI releases, the oldest the
// rules support and a current one, so CI checks the generated Gemini rules with Gemini's own policy
// loader and engine. Each tarball is verified against the integrity npm records for that release
// before anything in it is read, and npm's install scripts never run: the test imports the
// published bundle directly.
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The supported floor, which docs/permissions.md and the generated policy's header name, then the
 * current pin. Update a version and its integrity together, from
 * `npm view @google/gemini-cli@<version> dist.integrity`; see docs/dependency-upgrades.md.
 */
const RELEASES = [
  { version: "0.37.0", integrity: "sha512-IdS3MxTxtwbnx7EqNkD0ucVj/jH9MoOuRxuceiQQ93glW3xLGMyQkbqz7HCtDFV1vI57vX2gragNPWyiFKwdEQ==" },
  { version: "0.71.1", integrity: "sha512-FYDTjU+9BFPYKBcFS3vCjJol8pFyV0iHVigUNr2wZqk4vYNFgacGB5ubyrySFGM5jWxCK+1EFdcDJiEQjNomaw==" },
];

const root = path.resolve(import.meta.dir, "../..");

/** The tarball, with two retries after 10 and 30 seconds for a failed or stalled download; each attempt has a minute. */
async function download(version: string): Promise<Uint8Array> {
  const url = `https://registry.npmjs.org/@google/gemini-cli/-/gemini-cli-${version}.tgz`;
  let failure = "";
  for (const delay of [0, 10_000, 30_000]) {
    if (delay) await Bun.sleep(delay);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (response.ok) return new Uint8Array(await response.arrayBuffer());
      failure = `HTTP ${response.status}`;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`Gemini CLI ${version} could not be downloaded: ${failure}`);
}

/** Verify one release's tarball, unpack it into a temporary directory, and run the conformance test against its bundle. */
async function conform({ version, integrity }: { version: string; integrity: string }): Promise<void> {
  const bytes = await download(version);
  const digest = `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`;
  assert.equal(digest, integrity, `Gemini CLI ${version} does not match its recorded integrity`);
  const directory = mkdtempSync(path.join(tmpdir(), "agent-tool-gemini-"));
  try {
    writeFileSync(path.join(directory, "gemini-cli.tgz"), bytes);
    execFileSync("tar", ["-xzf", "gemini-cli.tgz"], { cwd: directory });
    const result = spawnSync(process.execPath, ["test", "src/permissions/gemini.conformance.test.ts"], {
      cwd: root,
      // The bundle is third-party code, so the test gets only what Bun needs, never CI's tokens.
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, AGENT_TOOL_GEMINI_BUNDLE: path.join(directory, "package", "bundle") },
      encoding: "utf8",
    });
    const output = `${result.stdout}${result.stderr}`;
    process.stdout.write(output);
    // A skipped test passes too, so require that tests ran and none was skipped.
    assert.ok(result.status === 0 && /^\s*[1-9]\d* pass$/m.test(output) && !/^\s*[1-9]\d* (?:skip|fail)$/m.test(output), `Gemini CLI ${version} conformance did not pass`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const release of RELEASES) await conform(release);
