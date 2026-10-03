import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import metadata from "../package.json";

const root = path.resolve(import.meta.dir, "..");
const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
const repository = process.argv[2];
if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Usage: bun scripts/release.ts <owner/repository>");
execFileSync(process.execPath, ["run", "generate"], { cwd: root, stdio: "inherit" });
const checksums: Record<string, string> = {};
for (const target of targets) {
  const name = `agent-tool-${metadata.version}-${target}`;
  const directory = path.join(root, "dist", name);
  mkdirSync(path.join(directory, "bin"), { recursive: true });
  execFileSync(process.execPath, ["build", "--compile", "--minify", `--target=bun-${target}`, "src/index.ts", "--outfile", path.join(directory, "bin/agent-tool")], { cwd: root, stdio: "inherit" });
  const archive = `${name}.tar.gz`;
  execFileSync("tar", ["-czf", path.join(root, "dist", archive), "-C", directory, "bin"], { stdio: "inherit" });
  checksums[target] = createHash("sha256").update(readFileSync(path.join(root, "dist", archive))).digest("hex");
}
writeFileSync(path.join(root, "dist/SHA256SUMS"), targets.map(target => `${checksums[target]}  agent-tool-${metadata.version}-${target}.tar.gz`).join("\n") + "\n");
const base = `https://github.com/${repository}/releases/download/v${metadata.version}`;
function resource(target: string): string {
  return `      url "${base}/agent-tool-${metadata.version}-${target}.tar.gz"\n      sha256 "${checksums[target]}"`;
}
writeFileSync(path.join(root, "dist/agent-tool.rb"), `class AgentTool < Formula
  desc "Portable agent reviews, PR workflows, and shared skills"
  homepage "https://github.com/${repository}"
  version "${metadata.version}"

  on_macos do
    on_arm do
${resource("darwin-arm64")}
    end
    on_intel do
${resource("darwin-x64")}
    end
  end
  on_linux do
    on_arm do
${resource("linux-arm64")}
    end
    on_intel do
${resource("linux-x64")}
    end
  end

  depends_on "git"
  depends_on "gh"

  def install
    bin.install "bin/agent-tool"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/agent-tool --version")
    assert_match "cross-agent-review", shell_output("#{bin}/agent-tool skills list")
  end
end
`);
console.log("Created platform archives, SHA256SUMS, and a Homebrew formula in dist/.");
