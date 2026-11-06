import { openPr } from "./pr/openPr";
import { solicitClaudeCodeReview } from "./review/solicitClaudeCodeReview";
import { solicitCodexReview } from "./review/solicitCodexReview";
import { solicitOpencodeReview } from "./review/solicitOpencodeReview";
import { bumpVersions, checkVersions } from "./version/bumpVersions";
import { resolveVersionConflicts } from "./version/resolveVersionConflicts";

const AGENT_TOOL_USAGE =
  "Usage: agent-tool <solicitClaudeCodeReview|solicitCodexReview|solicitOpencodeReview|openPr|bumpVersions|checkVersions|resolveVersionConflicts> [args]\n";

export interface AgentToolActions {
  readonly bumpVersions: (rootDir: string, baseOid?: string) => number;
  readonly checkVersions: (rootDir: string, baseOid?: string) => number;
  readonly resolveVersionConflicts: (rootDir: string) => number;
  readonly openPr: (rootDir: string, title?: string) => number;
  readonly solicitClaudeCodeReview: (
    rootDir: string,
    effort?: string,
  ) => number | Promise<number>;
  readonly solicitCodexReview: (rootDir: string, effort?: string) => number | Promise<number>;
  readonly solicitOpencodeReview: (rootDir: string, effort?: string) => number | Promise<number>;
}

const defaultActions: AgentToolActions = {
  bumpVersions,
  checkVersions,
  resolveVersionConflicts,
  openPr,
  solicitClaudeCodeReview,
  solicitCodexReview,
  solicitOpencodeReview,
};

function assertMaximumPositionals(
  action: string,
  positionals: readonly string[],
  maximum: number,
): void {
  if (positionals.length > maximum) {
    throw new Error(
      `${action} accepts at most ${maximum} positional argument${maximum === 1 ? "" : "s"}.`,
    );
  }
}

/** Dispatch one public agent-tool action with its positional CLI arguments. */
export function runAgentToolAction(
  rootDir: string,
  args: readonly string[],
  actions: AgentToolActions = defaultActions,
): number | Promise<number> {
  const [action, ...positionals] = args;
  const [first] = positionals;
  switch (action) {
    case "bumpVersions": {
      assertMaximumPositionals(action, positionals, 1);
      return actions.bumpVersions(rootDir, first);
    }
    case "checkVersions": {
      assertMaximumPositionals(action, positionals, 1);
      return actions.checkVersions(rootDir, first);
    }
    case "resolveVersionConflicts": {
      assertMaximumPositionals(action, positionals, 0);
      return actions.resolveVersionConflicts(rootDir);
    }
    case "solicitClaudeCodeReview": {
      assertMaximumPositionals(action, positionals, 1);
      return actions.solicitClaudeCodeReview(rootDir, first);
    }
    case "solicitCodexReview": {
      assertMaximumPositionals(action, positionals, 1);
      return actions.solicitCodexReview(rootDir, first);
    }
    case "solicitOpencodeReview": {
      assertMaximumPositionals(action, positionals, 1);
      return actions.solicitOpencodeReview(rootDir, first);
    }
    case "openPr": {
      assertMaximumPositionals(action, positionals, 1);
      return actions.openPr(rootDir, first);
    }
    case "squashMerge":
      // Removed: its optional reviewed head let a merge skip preflight.
      process.stderr.write(
        "squashMerge was removed; use agent-tool pr merge <subject-or-empty> <reviewed-head-oid> <base-branch>.\n",
      );
      return 1;
    default:
      process.stderr.write(`Unknown action: ${action ?? "(none)"}\n`);
      process.stderr.write(AGENT_TOOL_USAGE);
      return 1;
  }
}
