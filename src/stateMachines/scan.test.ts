import { describe, expect, test } from "bun:test";
import { codeLines, language, scanFile, scanText } from "./scan";
import { FETCHER, WORKER } from "./fixtures.testUtils";

describe("explicit-state-machines scan", () => {
  test("finds lifecycle booleans that are toggled together", () => {
    const signals = scanText(FETCHER, "c");
    expect(signals).toEqual([{ kind: "flags", names: ["hasError", "isLoading"], lines: [3, 4, 7, 8, 9] }]);
  });

  test("finds a status written with many values from many places, in Python too", () => {
    const signals = scanText(WORKER, "hash");
    expect(signals.find(signal => signal.kind === "status")).toEqual({
      kind: "status",
      names: ["status"],
      values: ["done", "error", "running"],
      lines: [4, 7, 10],
    });
    expect(signals.find(signal => signal.kind === "flags")?.names).toEqual(["_running", "is_dirty"]);
  });

  test("finds machines held in refs, private fields, object members and nested status writes", () => {
    // Shapes the first sweep's readers found and the scanner missed.
    const refs = "busy.current = true;\nbusy.current = false;\nconst [paging, setPaging] = useState(false);\nsetPaging(true);";
    expect(scanText(refs, "c")).toEqual([{ kind: "flags", names: ["busy", "paging"], lines: [1, 2, 3, 4] }]);
    const element = "this.#rendered = false;\nthis.#loading = true;\nthis.#rendered = true;\nthis.#loading = false;";
    expect(scanText(element, "c").map(signal => signal.names)).toEqual([["loading", "rendered"]]);
    const viewer = "this.booting = true;\nviewer.unavailable = false;\nthis.booting = false;\nviewer.unavailable = true;";
    expect(scanText(viewer, "c").map(signal => signal.names)).toEqual([["booting", "unavailable"]]);
    const report = 'record.steps[i]!.status = "running";\nrecord.steps[i]!.status = "passed";\nrecord.steps[index].status = "failed";';
    expect(scanText(report, "c")).toEqual([{ kind: "status", names: ["status"], values: ["failed", "passed", "running"], lines: [1, 2, 3] }]);
    expect(scanText("a.b == true;\nisDone !== false;\nconst f = () => true;\nx <= true;", "c")).toEqual([]);
  });

  test("reads extensionless and Expect scripts by their shebang", () => {
    const script = "#!/usr/bin/env bash\nlocked=false\napplying=false\nlocked=true\napplying=true\n";
    expect(language("bin/deploy")).toBe("maybe");
    expect(language("bin/deploy", "#!/usr/bin/env bash")).toBe("hash");
    expect(language("bin/deploy", "#!/bin/sh")).toBe("hash");
    expect(language("bin/run", "#!/usr/bin/env -S python3 -u")).toBe("hash");
    expect(language("LICENSE", "MIT License")).toBeUndefined();
    expect(language("qemu.exp")).toBe("hash");
    expect(language("bin/boot", "#!/usr/bin/expect -f")).toBe("hash");
    expect(language("bin/run", "#!/usr/bin/env PYTHONPATH=. python3.13")).toBe("hash");
    expect(language("bin/node", "#!/usr/bin/env node")).toBeUndefined();
    expect(language("bin/shout", "#!/opt/shellac")).toBeUndefined();
    // A long, unrecognized first line returns at once instead of backtracking.
    const started = performance.now();
    expect(language("blob", `#!${"/x".repeat(200_000)}`)).toBeUndefined();
    expect(language("blob", `#!${"a".repeat(400_000)} b`)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(200);
    // A real Expect script: flags and a status set with Tcl's `set`.
    const expect_ = [
      "#!/usr/bin/expect -f",
      "set is_booted 0",
      "set ::is_installing false",
      "set phase fetch",
      "proc install {} {",
      "    set is_installing true",
      '    set phase "install"',
      "}",
      "set is_booted 1",
      "set is_installing false",
      "set phase verify",
      "set timeout 30",
    ].join("\n");
    const report = scanFile("qemu.exp", expect_);
    expect(report?.signals).toEqual([
      { kind: "flags", names: ["is_booted", "is_installing"], lines: [2, 3, 6, 9, 10] },
      { kind: "status", names: ["phase"], values: ["fetch", "install", "verify"], lines: [4, 7, 11] },
    ]);
    // Shell `set` options are not assignments.
    expect(scanText("set -euo pipefail\nset -x\nset +e", "hash")).toEqual([]);
    expect(scanFile("bin/deploy", script)).toBeUndefined();
    const flagged = "#!/usr/bin/env bash\nisLocked=false\nisApplying=false\nisLocked=true\nisApplying=true\n";
    expect(scanFile("bin/deploy", flagged)?.signals[0]?.names).toEqual(["isApplying", "isLocked"]);
    expect(scanFile("LICENSE", "isLocked=false\nisApplying=false\nisLocked=true\nisApplying=true")).toBeUndefined();
  });

  test("ignores one flag, flags set only one way, guards, settings, comments and explicit unions", () => {
    expect(scanText("const [isLoading, setIsLoading] = useState(false);\nsetIsLoading(true);\nsetIsLoading(false);", "c")).toEqual([]);
    expect(scanText("let isDone = false;\nlet isReady = false;\nisDone = true;", "c")).toEqual([]);
    expect(scanText("let cancelled = false;\nlet settled = false;\ncancelled = true;\nsettled = true;", "c")).toEqual([]);
    expect(scanText("let darkMode = false;\nlet enabled = true;\ndarkMode = true;\nenabled = false;", "c")).toEqual([]);
    expect(scanText("// isLoading = true; hasError = false;\n/* isLoading = false;\n hasError = true; */", "c")).toEqual([]);
    expect(scanText('type S =\n  | { status: "idle" }\n  | { status: "loading" }\n  | { status: "failed" };\nreturn { status: "idle" };', "c")).toEqual([]);
    expect(scanText('if (status === "a") x();\nif (status == "b") y();\nif (status === "c") z();', "c")).toEqual([]);
  });

  test("keeps line numbers through block comments and URLs", () => {
    expect(codeLines('a /* x */ b\n/* start\nmiddle\nend */ c\nurl = "https://x" // note', "c")).toEqual(["a  b", "", "", " c", 'url = "https://x" ']);
    expect(codeLines("  # comment\nx = 1", "hash")).toEqual(["", "x = 1"]);
    // Comment markers inside strings are text, not comments.
    expect(codeLines('const glob = "src/*"; isLoading = true;\nconst u = \'a//b\'; hasError = false; // c\nconst e = "\\"/*";', "c")).toEqual([
      'const glob = "src/*"; isLoading = true;',
      "const u = 'a//b'; hasError = false; ",
      'const e = "\\"/*";',
    ]);
    // Escapes, an escape or string left open at the line's end, and a block that closes and reopens.
    expect(codeLines("a = 'x\\\\' // c\nb = \"open // c\nc = \"end\\\\\nd /* x */ e /* y\nz */ f // g", "c")).toEqual([
      "a = 'x\\\\' ",
      'b = "open // c',
      'c = "end\\\\',
      "d  e ",
      " f ",
    ]);
    // Status setters, Python booleans, and a field written from too few lines.
    const setters = 'setStatus("idle");\nsetStatus("loading"); setStatus("failed");\nthis.mode = "a";\nthis.mode = "b"; this.mode = "c";\nsetStatus(\'done\');';
    expect(scanText(setters, "c")).toEqual([{ kind: "status", names: ["status"], values: ["done", "failed", "idle", "loading"], lines: [1, 2, 5] }]);
    const python = "self.is_busy = True\nself.is_busy = False\nis_open = False\nis_open = True\nmode = 'a'\nmode = 'b'\nmode = 'c'";
    expect(scanText(python, "hash")).toEqual([
      { kind: "flags", names: ["is_busy", "is_open"], lines: [1, 2, 3, 4] },
      { kind: "status", names: ["mode"], values: ["a", "b", "c"], lines: [5, 6, 7] },
    ]);
    const glob = 'const glob = "src/*.ts";\nsetIsLoading(true);\nsetIsLoading(false);\nsetHasError(true);\nsetHasError(false);';
    expect(scanText(glob, "c").map(signal => signal.names)).toEqual([["hasError", "isLoading"]]);
  });

  test("reads application source only", () => {
    expect(language("src/app.tsx")).toBe("c");
    expect(language("scripts/run.sh")).toBe("hash");
    expect(language("pkg/sync.go")).toBe("c");
    expect(language("app/testing_tools.py")).toBe("hash");
    for (const skipped of [
      "src/app.test.ts",
      "node_modules/x/index.js",
      "dist/app.js",
      "types.d.ts",
      ".agents/skills/x/run.ts",
      "src/__tests__/a.ts",
      "vendor/lib.go",
      "README.md",
      "app.min.js",
      "pkg/sync_test.go",
      "app/test_worker.py",
      "app/worker_test.py",
      "conftest.py",
      "AppTests.swift",
      "SyncSpec.kt",
    ]) {
      expect(language(skipped)).toBeUndefined();
    }
    expect(scanFile("src/app.test.tsx", FETCHER)).toBeUndefined();
    expect(scanFile("src/app.tsx", FETCHER)?.score).toBe(4);
  });
});
