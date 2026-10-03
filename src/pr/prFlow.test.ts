import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const entry = path.resolve(import.meta.dir, "../index.ts");
let temporary: string;
let fixture: string;
let head: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: fixture,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

beforeEach(() => {
  temporary = mkdtempSync(path.join(tmpdir(), "agent-tool-pr-flow-"));
  fixture = path.join(temporary, "repo");
  const tools = path.join(temporary, "tools");
  const remote = path.join(temporary, "remote.git");
  mkdirSync(fixture);
  mkdirSync(tools);
  git("init", "-q", "-b", "feature");
  git("init", "-q", "--bare", remote);
  writeFileSync(path.join(fixture, "agent-tool.json"), JSON.stringify({
    schemaVersion: 1,
    subject: { maxLength: 100 },
    merge: { requiredChecks: [{ name: "build", workflow: "CI" }] },
    pr: { rejectClaudeBranding: true },
  }));
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com",
    "-c", "commit.gpgsign=false", "commit", "-qm", "feat: example");
  head = git("rev-parse", "HEAD");
  git("push", "-q", remote, "feature");
  // Git resolves the fake GitHub URL only to this local bare repository.
  git("config", `url.${remote}.insteadOf`, "https://github.com/owner/repo");
  writeFileSync(path.join(tools, "gh"), `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const scenario = process.env.PR_SCENARIO;
const head = process.env.PR_HEAD;
const reply = value => console.log(JSON.stringify(value));
appendFileSync("gh-calls.jsonl", JSON.stringify(args) + "\\n");
if (args[0] === "repo" && args[1] === "view") {
  reply({nameWithOwner:"owner/repo", defaultBranchRef:{name:"production"}, url:"https://github.com/owner/repo", sshUrl:"git@github.com:owner/repo.git"});
} else if (args[0] === "config" && args[1] === "get") {
  console.log("https");
} else if (args[0] === "pr" && args[1] === "list") {
  reply([]);
} else if (args[0] === "pr" && args[1] === "create") {
  writeFileSync("created.json", JSON.stringify({args, body:readFileSync(0,"utf8")}));
  console.log("https://github.com/owner/repo/pull/12");
} else if (args[0] === "pr" && args[1] === "checks") {
  reply([{name:"build", workflow:"CI", state:scenario === "failed-ci" ? "FAILURE" : "SUCCESS"}]);
} else if (args[0] === "pr" && args[1] === "view") {
  if (args.includes("headRefOid")) {
    reply({headRefOid:scenario === "head-drift" ? "b".repeat(40) : head});
  } else if (args.includes("state")) {
    reply({state:scenario === "unmerged" ? "OPEN" : "MERGED"});
  } else if (scenario === "missing") {
    console.error('no pull requests found for branch "feature"');
    process.exitCode = 1;
  } else {
    reply({number:12, state:"OPEN", title:"feat: example", baseRefName:"production", url:"https://github.com/owner/repo/pull/12"});
  }
} else if (args[0] === "api" && args[1] === "graphql") {
  if (args.some(arg => arg.includes("mutation("))) {
    writeFileSync("mutation.json", JSON.stringify(args));
    reply({data:{mergePullRequest:{pullRequest:{state:"MERGED"}}}});
  } else {
    reply({data:{repository:{pullRequest:{id:"PR_test", headRefOid:head, baseRefName:scenario === "retargeted" ? "staging" : "production", state:"OPEN", autoMergeRequest:null, isInMergeQueue:false}}}});
  }
} else {
  console.error("Unexpected gh invocation", args);
  process.exitCode = 1;
}
`);
  chmodSync(path.join(tools, "gh"), 0o755);
});

afterEach(() => rmSync(temporary, { recursive: true, force: true }));

function invoke(scenario: string, args: string[], body = "") {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: fixture,
    env: {
      ...process.env,
      PATH: `${path.join(temporary, "tools")}${path.delimiter}${process.env.PATH}`,
      AGENT_TOOL_CONFIG: undefined,
      PR_SCENARIO: scenario,
      PR_HEAD: head,
    },
    input: body,
    encoding: "utf8",
    timeout: 15_000,
  });
}

describe("PR CLI flows ported from a2f0.net", () => {
  test.each(["squashMerge", "pr"])("%s merges the reviewed SHA with an empty body and PR suffix", (command) => {
    const args = command === "pr" ? ["pr", "merge"] : [command];
    const result = invoke("merged", [...args, "", head, "production"]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const mutation = JSON.parse(readFileSync(path.join(fixture, "mutation.json"), "utf8"));
    expect(mutation).toContain(`expectedHeadOid=${head}`);
    expect(mutation).toContain("commitBody=");
    expect(mutation).toContain("commitHeadline=feat: example (#12)");
    const calls = readFileSync(path.join(fixture, "gh-calls.jsonl"), "utf8")
      .trim().split("\n").map(line => JSON.parse(line) as string[]);
    const query = calls.find(call => call.includes("owner=owner"));
    expect(query?.[query.indexOf("owner=owner") - 1]).toBe("-f");
    expect(query?.[query.indexOf("name=repo") - 1]).toBe("-f");
  });

  test.each(["missing", "retargeted", "failed-ci", "head-drift"])(
    "refuses a %s PR before sending a merge", (scenario) => {
      const result = invoke(scenario, ["pr", "merge", "", head, "production"]);
      expect(result.status).toBe(1);
      expect(existsSync(path.join(fixture, "mutation.json"))).toBe(false);
    },
  );

  test("does not report success if GitHub still reports OPEN after mutation", () => {
    const result = invoke("unmerged", ["pr", "merge", "", head, "production"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not merged");
  });

  test("creates a PR with literal multiline stdin and an explicit base", () => {
    const body = "First line\n\nLiteral `code` and $(no-shell-expansion).\n";
    const result = invoke("missing", ["pr", "open", "feat: example"], body);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const created = JSON.parse(readFileSync(path.join(fixture, "created.json"), "utf8"));
    expect(created.body).toBe(body);
    expect(created.args).toContain("--body-file");
    expect(created.args).toContain("production");
    expect(created.args).not.toContain(body);
  });

  test("preserves the consumer's title length and branding policy", () => {
    const title = `feat: ${"x".repeat(80)}`;
    expect(invoke("missing", ["openPr", title], "Details\n").status).toBe(0);
    rmSync(path.join(fixture, "created.json"));
    expect(invoke("missing", ["openPr", `feat: ${"x".repeat(100)}`]).status).toBe(1);
    expect(invoke("missing", ["openPr", "feat: example"], "Generated with Claude Code").status).toBe(1);
    expect(existsSync(path.join(fixture, "created.json"))).toBe(false);
  });

  test("refuses to open a PR when the local head is not pushed", () => {
    git("-c", "user.name=Test", "-c", "user.email=test@example.com",
      "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "feat: unpushed");
    const result = invoke("missing", ["pr", "open", "feat: example"]);
    expect(result.status).toBe(1);
    expect(existsSync(path.join(fixture, "created.json"))).toBe(false);
  });
});
