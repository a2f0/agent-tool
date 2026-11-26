import { spawnSync } from "node:child_process";
import { loadConfig } from "./config";

interface Specification { name: string; help: string[]; flags: string[]; minimum?: string }

const specifications: Specification[] = [
  { name: "git", help: [], flags: [] },
  { name: "gh", help: ["pr", "checks", "--help"], flags: ["--json"] },
  { name: "claude", help: ["--help"], flags: ["--safe-mode", "--permission-mode", "--effort"] },
  { name: "codex", help: ["exec", "--help"], flags: ["--ignore-user-config", "--ignore-rules", "--strict-config", "--ephemeral", "--output-last-message"] },
  // OpenCode 2: the variant rides in --model as provider/model#variant, and --standalone runs a private server.
  { name: "opencode", help: ["run", "--help"], flags: ["--standalone", "--agent", "--archived", "provider/model#variant"] },
  // The generated Gemini policy needs 0.63.0, which asks for redirection that an argument-pattern rule matched in autoEdit too.
  { name: "gemini", help: [], flags: [], minimum: "0.63.0" },
];

/** Whether a reported version meets a minimum; an unreadable version does not. */
function meets(reported: string, minimum: string | undefined): boolean {
  if (!minimum) return true;
  const version = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(reported)?.[0];
  return version !== undefined && Bun.semver.order(version, minimum) >= 0;
}

/** Probe only local versions and flags; never launch a model or print credentials. */
export function doctor(rootDir: string): { schemaVersion: 1; config: ReturnType<typeof loadConfig>; tools: { name: string; version: string; compatible: boolean; missingFlags: string[] }[] } {
  const config = loadConfig(rootDir);
  const tools = specifications.map(spec => {
    const version = spawnSync(spec.name, ["--version"], { encoding: "utf8", timeout: 3000, maxBuffer: 256 * 1024 });
    const help = spec.flags.length ? spawnSync(spec.name, spec.help, { encoding: "utf8", timeout: 3000, maxBuffer: 256 * 1024 }) : undefined;
    const helpText = `${help?.stdout ?? ""}\n${help?.stderr ?? ""}`;
    const missingFlags = spec.flags.filter(flag => !helpText.includes(flag));
    const reported = version.stdout?.trim() || "unavailable";
    return { name: spec.name, version: reported, compatible: version.status === 0 && (!help || help.status === 0) && missingFlags.length === 0 && meets(reported, spec.minimum), missingFlags };
  });
  return { schemaVersion: 1, config, tools };
}
