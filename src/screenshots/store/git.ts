/** Git for the shared screenshot store, bound to the repository it is asked about. */
import { isolatedGit } from "../../system/checkouts";

/** Git without hooks, prompts, or variables that bind it to another repository; stdout is trimmed. */
export function git(cwd: string, ...args: string[]): { status: number | null; stdout: string } {
  const result = isolatedGit(cwd, args);
  if (result.error) throw new Error(`Could not run git: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout.trim() };
}

export function gitValue(cwd: string, ...args: string[]): string | undefined {
  const result = git(cwd, ...args);
  return result.status === 0 && result.stdout ? result.stdout : undefined;
}
