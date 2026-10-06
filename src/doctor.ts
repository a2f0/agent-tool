import { spawnSync } from "node:child_process";
import { loadConfig } from "./config";

const specifications = [
  { name: "git", help: [] as string[], flags: [] as string[] },
  { name: "gh", help: ["pr", "checks", "--help"], flags: ["--json"] },
  { name: "claude", help: ["--help"], flags: ["--safe-mode", "--permission-mode", "--effort"] },
  { name: "codex", help: ["exec", "--help"], flags: ["--ignore-user-config", "--ignore-rules", "--strict-config", "--ephemeral", "--output-last-message"] },
  { name: "opencode", help: ["run", "--help"], flags: ["--pure", "--variant", "--agent"] },
];

/** Probe only local versions and flags; never launch a model or print credentials. */
export function doctor(rootDir: string): { schemaVersion: 1; config: ReturnType<typeof loadConfig>; tools: { name: string; version: string; compatible: boolean; missingFlags: string[] }[] } {
  const config = loadConfig(rootDir);
  const tools = specifications.map(spec => {
    const version = spawnSync(spec.name, ["--version"], { encoding: "utf8", timeout: 3000, maxBuffer: 256 * 1024 });
    const help = spec.flags.length ? spawnSync(spec.name, spec.help, { encoding: "utf8", timeout: 3000, maxBuffer: 256 * 1024 }) : undefined;
    const helpText = `${help?.stdout ?? ""}\n${help?.stderr ?? ""}`;
    const missingFlags = spec.flags.filter(flag => !helpText.includes(flag));
    return { name: spec.name, version: version.stdout?.trim() || "unavailable", compatible: version.status === 0 && (!help || help.status === 0) && missingFlags.length === 0, missingFlags };
  });
  return { schemaVersion: 1, config, tools };
}
