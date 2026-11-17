import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

/** What `readRegularFile` found: nothing, something other than a regular file, or a file's text. */
export type RegularFile = { status: "missing" } | { status: "irregular" } | { status: "file"; contents: string };

/**
 * Reads a regular file. It refuses anything else before opening it, then opens one descriptor
 * without following a final symbolic link and without blocking and checks that descriptor, so a
 * path replaced after the first check can neither redirect the read nor stall it on a FIFO.
 */
export function readRegularFile(file: string): RegularFile {
  // Never open an existing special file: opening a device can block or act even without reading.
  try { if (!lstatSync(file).isFile()) return { status: "irregular" }; }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return { status: "missing" };
    throw error;
  }
  let descriptor: number;
  try { descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { status: "missing" };
    // O_NOFOLLOW reports a final symbolic link as ELOOP (EMLINK on some BSDs).
    if (code === "ELOOP" || code === "EMLINK") return { status: "irregular" };
    throw error;
  }
  try { return fstatSync(descriptor).isFile() ? { status: "file", contents: readFileSync(descriptor, "utf8") } : { status: "irregular" }; }
  finally { closeSync(descriptor); }
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
