import { loadConfig } from "../config";

/** Validate a data-only header policy without running branch-controlled code. */
export function validateCommitSubject(rootDir: string, subject: string): void {
  const policy = loadConfig(rootDir).subject;
  if (!subject.trim() || /[\r\n]/.test(subject)) throw new Error("Commit subject must be a nonempty single line.");
  if (policy.ignoreGenerated && /^(?:Merge\b|Revert\b|(?:fixup|squash|amend)! |Initial commit$)/.test(subject)) return;
  if ([...subject].length > policy.maxLength) throw new Error(`Commit subject exceeds ${policy.maxLength} characters.`);
  if (policy.conventional) {
    const match = /^([a-z]+)(?:\([^\r\n()]+\))?!?: \S.*$/.exec(subject);
    if (!match || !policy.types.includes(match[1]!)) throw new Error(`Commit subject must use a conventional type: ${policy.types.join(", ")}.`);
  }
  const text = subject.replace(/^[a-z]+(?:\([^\r\n()]+\))?!?: /, "");
  if (policy.lowercaseInitial && /^[A-Z]/.test(text)) throw new Error("Commit subject must start with lowercase text.");
  if (policy.rejectTerminalPeriod && text.endsWith(".")) throw new Error("Commit subject must not end with a period.");
}
