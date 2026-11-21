import { expect, onTestFinished, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLED_SKILL_REFERENCES, BUNDLED_SKILLS } from "./bundled";

// The audit-trails skill's publication snippets, run as shipped against a stub
// gh. Documentation fixtures only: no GitHub writes, model calls, or audit.
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

// Version-manager shims for jq read the operator's own HOME, PATH, and XDG
// config, so jq runs with those while the script under test stays sandboxed.
function operatorWrapper(executable: string) {
  const lines = ["#!/bin/sh"];
  for (const name of ["HOME", "PATH", "XDG_CONFIG_HOME"]) {
    const value = process.env[name];
    lines.push(value === undefined ? `unset ${name}` : `${name}=${quote(value)}; export ${name}`);
  }
  lines.push(`exec ${quote(executable)} "$@"`, "");
  return lines.join("\n");
}

const skill = BUNDLED_SKILLS["audit-trails"]!;
const reference = (file: string) => BUNDLED_SKILL_REFERENCES["audit-trails"]![`references/${file}`]!;
const issueUrl = "https://github.com/fixture/repo/issues/7";
const priorReadback = "Previous verified checkpoint.\n";
const body = "# Report\n\n<!-- audit-usage:run-fixture:begin -->\nIt's unavailable.\n<!-- audit-usage:run-fixture:end -->\n";

const stub = `gh() {
  printf '%s\\n' "$*" >> "$receipt_dir/calls"
  test "$2" != "$failure" || return 23
  case "$*" in
    'issue create --repo fixture/repo --title Fixture --body-file '*)
      test "$#" = 8 || return 1
      cmp "$8" "$receipt_dir/expected.md" || return 1
      printf '%s\\n' '${issueUrl}' ;;
    'issue view ${issueUrl} --repo fixture/repo --json url,number,body')
      printf '%s\\n' "$response_json" ;;
    'issue edit ${issueUrl} --repo fixture/repo --body-file '*)
      test "$#" = 7 || return 1
      cmp "$7" "$receipt_dir/expected.md" ;;
    *) return 77 ;;
  esac
}
`;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "audit usage docs "));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  // No inherited credentials or config, and no real gh (even through `command gh`).
  for (const command of ["cmp", "jq", "mv", "env"]) {
    const executable = Bun.which(command);
    if (!executable) throw new Error(`Fixture requires ${command}`);
    const target = join(directory, command);
    if (command === "jq") writeFileSync(target, operatorWrapper(executable), { mode: 0o755 });
    else symlinkSync(executable, target);
  }
  writeFileSync(join(directory, "report.md"), body);
  writeFileSync(join(directory, "expected.md"), body);
  writeFileSync(join(directory, "issue-readback.json"), priorReadback);
  const blocks = [...reference("usage-receipts.md").matchAll(/```sh\n([\s\S]*?)```/g)].map(match => match[1] ?? "");
  expect(blocks).toHaveLength(3);
  return {
    blocks,
    read: (file: string) => readFileSync(join(directory, file), "utf8"),
    run: (script: string, overrides: Record<string, string> = {}) =>
      Bun.spawnSync(["/bin/sh", "-eu", "-c", `${stub}\n${script}`], {
        env: {
          PATH: directory,
          HOME: directory,
          GH_CONFIG_DIR: directory,
          XDG_CONFIG_HOME: directory,
          repo: "fixture/repo",
          title: "Fixture",
          receipt_dir: directory,
          body_file: join(directory, "report.md"),
          failure: "none",
          response_json: JSON.stringify({ url: issueUrl, number: 7, body }),
          ...overrides,
        },
        stdout: "pipe",
        stderr: "pipe",
      }),
  };
}

test("audit entry, checkpoints, and delivery share the usage procedure", () => {
  const start = skill.indexOf("## Establish scope");
  const trace = skill.indexOf("## Trace coverage");
  const deliver = skill.indexOf("## Deliver");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(trace).toBeGreaterThan(start);
  expect(deliver).toBeGreaterThan(trace);
  expect(skill.slice(start, trace)).toContain("references/usage-receipts.md");
  expect(skill.slice(start, trace)).toContain("checkpoint");
  expect(skill.slice(deliver)).toContain("references/usage-receipts.md");
  expect(reference("report-template.md")).toContain("## Audit usage receipt");
});

test("receipt examples verify the exact body and URL before saving readback", () => {
  const f = fixture();
  const result = f.run(f.blocks.join("\n"));
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  const calls = f.read("calls");
  expect(calls.match(/issue create/g)).toHaveLength(1);
  expect(calls.match(/issue edit/g)).toHaveLength(1);
  expect(calls.match(/issue view/g)).toHaveLength(2);
  expect(f.read("issue-url.txt").trim()).toBe(issueUrl);
  expect(JSON.parse(f.read("issue-readback.json"))).toEqual({ url: issueUrl, number: 7, body });
}, 30_000);

test.each(["edit", "view", "body", "url"])("failed %s preserves the earlier checkpoint", failure => {
  const f = fixture();
  const response = { url: issueUrl, number: 7, body };
  if (failure === "body") response.body = "Wrong receipt";
  if (failure === "url") response.url = "https://github.com/fixture/repo/issues/8";
  const result = f.run(f.blocks[2] ?? "", { issue_url: issueUrl, failure, response_json: JSON.stringify(response) });
  expect(result.exitCode).not.toBe(0);
  expect(f.read("issue-readback.json")).toBe(priorReadback);
  expect(f.read("report.md")).toBe(body);
  expect(f.read("calls")).not.toContain("issue create");
}, 30_000);

test("documentation fixtures fail closed if a command bypasses the gh stub", () => {
  const f = fixture();
  expect(f.run("command gh issue view anything").exitCode).toBe(127);
  const throughEnv = f.run("env gh issue view anything");
  expect(throughEnv.exitCode).toBe(127);
  expect(throughEnv.stderr.toString()).toContain("gh");
  expect(f.run(`test -z "\${GH_TOKEN:-}\${GITHUB_TOKEN:-}"`).exitCode).toBe(0);
}, 30_000);
