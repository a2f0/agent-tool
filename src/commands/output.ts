import { closeSync, constants, fstatSync, openSync, readSync, writeSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";

export interface OutputLimits { maxBytes: number; tailLines: number }
export const DEFAULT_LIMITS: OutputLimits = { maxBytes: 4096, tailLines: 40 };

export function outputLimit(flag: string, value: string | undefined): number {
  const maximum = flag === "--max-bytes" ? 65536 : 1000;
  if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`${flag} requires an integer from 1 to ${maximum}.`);
  }
  return Number(value);
}

export function plainText(value: string): string {
  return stripVTControlCharacters(value).replace(/\r\n/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

/** Read at most maxBytes, including when the last line is gigabytes long. */
export function logTail(file: string, limits: OutputLimits): { text: string; bytes: number; truncated: boolean } {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("Log inspection requires a regular file.");
    const buffer = Buffer.alloc(Math.min(stat.size, limits.maxBytes));
    const size = readSync(fd, buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length));
    let text = plainText(buffer.subarray(0, size).toString("utf8"));
    const lines = text.replace(/\n$/, "").split("\n");
    let truncated = stat.size > size || lines.length > limits.tailLines;
    text = lines.slice(-limits.tailLines).join("\n");
    // Invalid UTF-8 can expand to replacement characters; enforce the byte cap
    // after decoding and terminal-control removal as well.
    const encoded = Buffer.from(text);
    if (encoded.length > limits.maxBytes) {
      truncated = true;
      let offset = encoded.length - limits.maxBytes;
      while ((encoded[offset] & 0xc0) === 0x80) offset++;
      text = encoded.subarray(offset).toString("utf8");
    }
    return { text, bytes: stat.size, truncated };
  } finally { closeSync(fd); }
}

export function printLogTail(file: string, limits: OutputLimits, fd = 1): void {
  const tail = logTail(file, limits);
  writeSync(fd, `${JSON.stringify({ log: file, outputBytes: tail.bytes, truncated: tail.truncated })}\n`);
  if (tail.text) writeSync(fd, `${tail.text}\n`);
}

export function inspectLog(args: string[]): number {
  const file = args.shift();
  if (!file || file.startsWith("--")) throw new Error("Usage: agent-tool logs <file> [--max-bytes N] [--tail-lines N]");
  const limits = { ...DEFAULT_LIMITS };
  while (args.length) {
    const flag = args.shift();
    if (flag === "--max-bytes") limits.maxBytes = outputLimit(flag, args.shift());
    else if (flag === "--tail-lines") limits.tailLines = outputLimit(flag, args.shift());
    else throw new Error(`Unknown logs argument '${flag}'.`);
  }
  printLogTail(file, limits);
  return 0;
}
