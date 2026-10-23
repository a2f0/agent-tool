import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("Debian builder resolves root metadata after script relocation", () => {
  const root = mkdtempSync(path.join(tmpdir(), "deb-script-"));
  try {
    mkdirSync(path.join(root, "scripts/release"), { recursive: true }); mkdirSync(path.join(root, "bin"));
    copyFileSync(path.join(import.meta.dir, "package-deb.sh"), path.join(root, "scripts/release/package-deb.sh"));
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "4.5.6" })); writeFileSync(path.join(root, "binary"), "standalone executable fixture");
    const stub = `#!${process.execPath}\nimport{readFileSync,writeFileSync}from'node:fs';const a=process.argv.slice(2);if(!readFileSync(a[2]+'/DEBIAN/control','utf8').includes('Version: 4.5.6'))process.exit(3);writeFileSync(a[3],'built');\n`;
    writeFileSync(path.join(root, "bin/dpkg-deb"), stub); chmodSync(path.join(root, "bin/dpkg-deb"), 0o755);
    const result = spawnSync("sh", ["scripts/release/package-deb.sh", "binary", "amd64"], { cwd: root, env: { ...process.env, PATH: path.join(root, "bin") + path.delimiter + path.dirname(process.execPath) + path.delimiter + process.env.PATH }, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    expect(readFileSync(path.join(root, "dist/agent-tool_4.5.6_amd64.deb"), "utf8")).toBe("built");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
