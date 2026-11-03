import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Refuses symbolic links below the base, so a committed link cannot redirect a write outside it. */
export function assertNoLinks(base: string, destination: string): void {
  let current = base;
  for (const part of path.relative(base, destination).split(path.sep)) {
    current = path.join(current, part);
    let link: boolean;
    try { link = lstatSync(current).isSymbolicLink(); } catch { return; }
    if (link) throw new Error(`Refusing to write through symbolic link ${path.relative(base, current)}.`);
  }
}

/**
 * Replaces a file atomically through an unpredictable, exclusively created
 * temporary name, so no committed link can stand in for it. Sandboxed build
 * phases, such as Xcode's, may write only their declared outputs; there the
 * file is rewritten in place, refusing to follow a link.
 */
export function replaceFile(destination: string, bytes: Uint8Array): void {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let created = false;
  try {
    writeFileSync(temporary, bytes, { flag: "wx" });
    created = true;
    renameSync(temporary, destination);
  } catch (error) {
    if (created || !["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      // Best effort: the original error matters more than a temporary file left behind.
      try { rmSync(temporary, { force: true }); } catch {}
      throw error;
    }
    // Nothing was created, and a sandbox may refuse even an attempt to remove an undeclared path.
    const descriptor = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW);
    try {
      // A hard link would share the file with a path outside the output, so only a sole link is rewritten.
      const stats = fstatSync(descriptor);
      if (!stats.isFile() || stats.nlink !== 1) throw new Error(`Refusing to rewrite ${destination}, which is not a file with a single link.`);
      ftruncateSync(descriptor, 0);
      // writeFileSync on a descriptor repeats short writes until every byte is written.
      writeFileSync(descriptor, bytes);
    } finally { closeSync(descriptor); }
  }
}
