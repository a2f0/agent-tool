import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const helper = path.join(import.meta.dir, "diagnostics.ts");

for (const exit of [0, 9]) {
  test(`review diagnostics retain complete stderr and keep verdict visible for exit ${exit}`, () => {
    const source = `import {withReviewDiagnostics} from ${JSON.stringify(helper)};
      import {spawnSync} from "node:child_process";
      const result = withReviewDiagnostics("stub", fd => spawnSync(process.execPath, ["-e", 'process.stderr.write("x".repeat(4*1024*1024)+"\\\\nlast diagnostic\\\\n"); console.log("Findings remain visible\\\\nVERDICT: MAJOR"); process.exitCode=${exit}'], {stdio:["ignore","pipe",fd],encoding:"utf8"}));
      process.stdout.write(result.stdout); process.exitCode=result.status;`;
    const result = spawnSync(process.execPath, ["-e", source], { encoding: "utf8", timeout: 10000 });
    expect(result.status).toBe(exit);
    expect(result.stdout).toContain("VERDICT: MAJOR");
    const receipt = JSON.parse(result.stderr.split("\n")[0]);
    try {
      expect(receipt.reviewer).toBe("stub");
      expect(receipt.outputBytes).toBeGreaterThan(4 * 1024 * 1024);
      expect(statSync(receipt.log).mode & 0o777).toBe(0o600);
      expect(readFileSync(receipt.log, "utf8")).toContain("last diagnostic");
      expect(result.stderr.length).toBeLessThan(5000);
      expect(result.stderr.includes("last diagnostic")).toBe(exit !== 0);
    } finally { rmSync(path.dirname(receipt.log), { recursive: true, force: true }); }
  });
}
