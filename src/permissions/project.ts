import { loadConfig, type AgentToolConfig } from "../config";
import type { CatalogEntry } from "./catalog";

/**
 * Commands whose class depends on the repository: installed executables that `bun x` may run,
 * as `permissions.executables` classifies them. Unlisted executables keep the harness default.
 */
export function projectCommands(root: string, config: AgentToolConfig = loadConfig(root)): CatalogEntry[] {
  return Object.entries(config.permissions.executables).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => ({ command: `bun x ${name}`, class: value }));
}
