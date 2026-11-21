/** `agent-tool perf`: measures how fast a page becomes usable; PERF_USAGE lists the commands. */
import { writeFileSync, writeSync } from "node:fs";
import { measureLoad, shot } from "./browser";
import { compareImages } from "./diff";
import { moduleGraph } from "./graph";
import { type Options, PERF_USAGE, parseOptions } from "./options";
import { serve } from "./serve";

const print = (text: string) => {
  writeSync(1, `${text}\n`);
};

async function measure(options: Options): Promise<void> {
  const report = await measureLoad(options);
  if (options.json) {
    print(JSON.stringify(report, null, 2));
    return;
  }
  const { url, readyMs } = report;
  print(`${url}  ready median ${readyMs.median} ms (min ${readyMs.min}, max ${readyMs.max}, ${readyMs.runs} runs)`);
  print(
    `  ${report.requests} requests, ${report.transferredBytes} bytes, network done at ${report.networkDoneMs} ms${report.pendingRequests ? ` (${report.pendingRequests} still pending)` : ""}; ${JSON.stringify(report.conditions)}`,
  );
  for (const row of report.waterfall ?? [])
    print(`  ${String(row.start).padStart(6)} ${String(row.end ?? "-").padStart(6)} ${String(row.bytes ?? "").padStart(8)} ${row.path}`);
  if (report.cpu) {
    printCpuRows("self", report.cpu.self);
    printCpuRows("inclusive", report.cpu.inclusive);
  }
}

function printCpuRows(title: string, rows: { fn: string; ms: number }[]): void {
  print(`  CPU ${title} (ms):`);
  for (const row of rows) print(`  ${row.ms.toFixed(1).padStart(8)} ${row.fn}`);
}

/**
 * Runs one perf command. `serve` returns once it is listening and keeps the
 * process alive; `diff` exits 1 when any pixel differs. Usage errors throw.
 */
export async function perfCommand(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    print(PERF_USAGE);
    return 0;
  }
  const options = parseOptions(argv);
  switch (options.command) {
    case "serve": {
      if (!options.args[0]) throw new Error("serve needs a directory.");
      const server = serve(options.args[0], options.port, options.http1);
      // Listening keeps the process alive; a port already in use ends it with 1.
      return new Promise(resolve => {
        server.once("listening", () => resolve(0));
        server.once("error", () => resolve(1));
      });
    }
    case "measure":
      await measure(options);
      return 0;
    case "shot":
      await shot(options);
      return 0;
    case "diff": {
      const result = compareImages(options);
      print(JSON.stringify(result));
      return result.differing === 0 ? 0 : 1;
    }
    case "graph": {
      const [root, ...entries] = options.args;
      if (!root || entries.length === 0) throw new Error("graph needs a directory and at least one entry.");
      const graph = moduleGraph(root, entries);
      if (options.out) writeFileSync(options.out, `${JSON.stringify(graph, null, 2)}\n`);
      print(JSON.stringify(graph));
      return 0;
    }
    case "help":
      print(PERF_USAGE);
      return 0;
    default:
      throw new Error(`Unknown perf command '${options.command}'.\n\n${PERF_USAGE}`);
  }
}
