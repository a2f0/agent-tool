import { afterEach, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyTarball } from "./commands";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function artifact() {
  const root = mkdtempSync(path.join(tmpdir(), "release-artifact-")); roots.push(root);
  mkdirSync(path.join(root, "package")); writeFileSync(path.join(root, "package/package.json"), JSON.stringify({ name: "@owner/package", version: "1.2.3" }));
  execFileSync("tar", ["-czf", "package.tgz", "package"], { cwd: root });
  const archive = readFileSync(path.join(root, "package.tgz"));
  return { archive, metadata: { name: "@owner/package", version: "1.2.3", dist: { tarball: "https://registry.npmjs.org/@owner/package/-/package-1.2.3.tgz", integrity: "sha512-" + createHash("sha512").update(archive).digest("base64") } } };
}
test("published tarballs require matching integrity and embedded package identity", async () => {
  const { archive, metadata } = artifact();
  const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(archive), { preconnect() {} }));
  try {
    expect(await verifyTarball(metadata)).toEqual(metadata.dist);
    await expect(verifyTarball({ ...metadata, version: "1.2.4" })).rejects.toThrow("manifest does not match");
    await expect(verifyTarball({ ...metadata, dist: { ...metadata.dist, integrity: "sha512-AAAA" } })).rejects.toThrow("integrity does not match");
    await expect(verifyTarball({ ...metadata, dist: { ...metadata.dist, tarball: "https://other.example/package.tgz" } })).rejects.toThrow("HTTPS npm registry");
  } finally { fetch.mockRestore(); }
});
