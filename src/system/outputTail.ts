/** The last lines of a command's output, bounded for an error message. */
export function outputTail(text: string, lines = 20, characters = 2000): string {
  const tail = text.trim().split("\n").slice(-lines).join("\n");
  return tail.length > characters ? `…${tail.slice(-characters)}` : tail;
}
