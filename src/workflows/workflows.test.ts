import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, parseConfig } from "../config";
import { branchErrors } from "./branch";
import { binaryPaths, evaluateGate, signatureAccepted } from "./checks";
import { parseGroup } from "../commands/group";

const cli = path.resolve(import.meta.dir, "../index.ts");
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture(config: Record<string, unknown> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-tests-")); directories.push(root);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0", AGENT_TOOL_CONFIG: "" };
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [cli, ...args], { cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 15000 });
  git(["init", "-b", "main"]); git(["config", "user.name", "Test"]); git(["config", "user.email", "test@example.com"]); git(["config", "commit.gpgsign", "false"]);
  writeFileSync(path.join(root, "agent-tool.json"), JSON.stringify({ schemaVersion: 1, ...config }));
  writeFileSync(path.join(root, "tracked"), "baseline\n"); git(["add", "."]); git(["commit", "-m", "chore: initialize"]);
  return { root, env, git, run };
}
function hooksFixture() {
  const f = fixture({ hooks: { files: [{ source: "scripts/git/hooks/pre-push", target: "pre-push", executable: true }] } });
  mkdirSync(path.join(f.root, "scripts/git/hooks"), { recursive: true }); writeFileSync(path.join(f.root, "scripts/git/hooks/pre-push"), "#!/bin/sh\nexit 0\n"); f.git(["add", "."]); f.git(["commit", "-m", "chore: add hook"]); return f;
}

test("Git ref rules compose with branch policy and optional length cap", () => {
  for (const name of ["feat/foo..bar", "feat/topic.lock", "feat/a@{b}", "@{-1}", "feat/trailing.", "feat//double", "-f"]) expect(branchErrors(name, DEFAULT_CONFIG).length).toBeGreaterThan(0);
  for (const name of ["feat/name", "chore/a/b", "main"]) expect(branchErrors(name, DEFAULT_CONFIG)).toEqual([]);
  const config = parseConfig(JSON.stringify({ schemaVersion: 1, branch: { maxLength: null, types: ["cleanup"], exempt: ["staging"] } }));
  expect(branchErrors("cleanup/" + "a".repeat(120), config)).toEqual([]); expect(branchErrors("staging", config)).toEqual([]); expect(branchErrors("feat/name", config).length).toBe(1);
});
test("malformed workflow policies fail", () => {
  for (const policy of [{ branch: { maxLength: 0 } }, { commits: { signatures: "signed-ish" } }, { hooks: { files: [{ source: "../hook", target: "pre-push", executable: true }] } }, { binaries: { allow: ["../secret"] } }]) expect(() => parseConfig(JSON.stringify({ schemaVersion: 1, ...policy }))).toThrow();
});
test("signature presence and verification are separate", () => {
  for (const status of ["G", "U", "E", "X", "Y", "R"]) expect(signatureAccepted(status, "present")).toBe(true);
  for (const status of ["N", "B", "", "?"]) expect(signatureAccepted(status, "present")).toBe(false);
  expect(signatureAccepted("E", "verified")).toBe(false); expect(signatureAccepted("G", "verified")).toBe(true);
});
test("binary rename parsing preserves unusual filenames", () => {
  expect(binaryPaths("-\t-\t\0old\0new\tfile\n.png\0\n2\t1\ttext\0")).toEqual(["new\tfile\n.png"]);
  expect(() => binaryPaths("-\t-\t\0old\0")).toThrow();
});
test("aggregate gate enforces exact conditional success/skip and missing-job rules", () => {
  expect(evaluateGate({}).ok).toBe(false); expect(evaluateGate({ a: { result: "success" } }, { required: ["b"] }).ok).toBe(false);
  for (const result of ["failure", "cancelled", "pending", "skipped"]) expect(evaluateGate({ a: { result } }).ok).toBe(false);
  const policy = { required: ["changes"], conditional: [{ job: "native", source: "changes", output: "native" }] };
  expect(evaluateGate({ changes: { result: "success", outputs: { native: "false" } }, native: { result: "skipped" } }, policy).ok).toBe(true);
  expect(evaluateGate({ changes: { result: "success", outputs: { native: "true" } }, native: { result: "skipped" } }, policy).ok).toBe(false);
  expect(evaluateGate({ changes: { result: "success", outputs: { native: false } }, native: { result: "skipped" } }, policy).ok).toBe(false);
});
test("detached branch checking requires explicit names", () => {
  const f = fixture(); f.git(["checkout", "--detach"]);
  expect(f.run(["branch", "check", "feat/good"]).status).toBe(0); expect(f.run(["branch", "check"]).status).toBe(1); expect(f.run(["branch", "check", "feat/foo..bar"]).status).toBe(1);
});
test("branch creation pins remote base and avoids local upstream settings", () => {
  const f = fixture(); const remote = path.join(f.root, "remote.git");
  f.git(["init", "--bare", remote]); f.git(["remote", "add", "origin", remote]); f.git(["push", "origin", "main"]); f.git(["config", "branch.autoSetupMerge", "always"]);
  writeFileSync(path.join(f.root, ".git/info/exclude"), "remote.git/\n");
  const result = f.run(["branch", "create", "chore/task", "--base", "main"]); expect(result.status).toBe(0);
  expect(f.git(["branch", "--show-current"])).toBe("chore/task");
  expect(spawnSync("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], { cwd: f.root, env: f.env }).status).not.toBe(0);
  expect(f.run(["branch", "create", "chore/task", "--base", "main"]).status).toBe(1);
  writeFileSync(path.join(f.root, "user-edit"), "keep"); expect(f.run(["branch", "create", "chore/another", "--base", "main"]).status).toBe(1); expect(readFileSync(path.join(f.root, "user-edit"), "utf8")).toBe("keep");
});
test("push runs normal hooks and detects hook-created commits", () => {
  const f = fixture(); const remote = path.join(f.root, "remote.git"); f.git(["init", "--bare", remote]); f.git(["remote", "add", "origin", remote]); writeFileSync(path.join(f.root, ".git/info/exclude"), "remote.git/\n"); f.git(["switch", "-c", "chore/push"]);
  const start = f.git(["rev-parse", "HEAD"]); writeFileSync(path.join(f.root, ".git/hooks/pre-push"), "#!/bin/sh\ngit -c core.hooksPath=/dev/null commit --allow-empty -m 'chore: changed by hook'\n"); chmodSync(path.join(f.root, ".git/hooks/pre-push"), 0o755);
  const result = f.run(["branch", "push", start]); expect(result.status).toBe(1); expect(result.stderr).toContain("Push changed local or remote HEAD"); expect(f.git(["rev-parse", "HEAD"])).not.toBe(start);
});
test("commit checking rejects unsigned commits, trailers and invalid revisions", () => {
  const f = fixture({ commits: { signatures: "present" } }); expect(f.run(["commits", "check", "--range", "HEAD"]).status).toBe(1); expect(f.run(["commits", "check", "--range", "missing"]).status).toBe(1); expect(f.run(["commits", "check", "--range", "HEAD", "--exclude", "HEAD"]).status).toBe(0);
  writeFileSync(path.join(f.root, "agent-tool.json"), JSON.stringify({ schemaVersion: 1 })); f.git(["add", "."]); f.git(["commit", "-m", "chore: adjust\n\nCo-authored-by: Someone <a@example.com>"]); expect(f.run(["commits", "check", "--range", "HEAD^..HEAD"]).status).toBe(1);
});
test("binary staged/all checks honor allowlist", () => {
  const f = fixture(); writeFileSync(path.join(f.root, "icon.png"), Buffer.from([0, 1, 2, 3])); f.git(["add", "icon.png"]); expect(f.run(["checks", "binaries", "--staged"]).status).toBe(1);
  writeFileSync(path.join(f.root, "agent-tool.json"), JSON.stringify({ schemaVersion: 1, binaries: { allow: ["*.png"] } })); expect(f.run(["checks", "binaries", "--all"]).status).toBe(0);
});
test("hook preview is read-only and edited installed hooks are preserved", () => {
  const f = hooksFixture(); const destination = path.join(f.root, ".git/hooks/pre-push"); expect(f.run(["hooks", "install"]).status).toBe(0); expect(existsSync(destination)).toBe(false); expect(f.run(["hooks", "install", "--apply"]).status).toBe(0); expect(f.run(["hooks", "check"]).status).toBe(0);
  writeFileSync(destination, "user edit"); expect(f.run(["hooks", "install", "--apply"]).status).toBe(1); expect(readFileSync(destination, "utf8")).toBe("user edit");
});
test("adoption backs up an unmanaged symlink without changing its target", () => {
  const f = hooksFixture(); const destination = path.join(f.root, ".git/hooks/pre-push"); const other = path.join(f.root, "external-hook"); writeFileSync(other, "user hook"); symlinkSync(other, destination); expect(f.run(["hooks", "install", "--apply"]).status).toBe(1);
  const result = f.run(["hooks", "install", "--apply", "--adopt"]); expect(result.status).toBe(0); const receipt = JSON.parse(result.stdout); expect(receipt.backups).toHaveLength(1); expect(readFileSync(receipt.backups[0], "utf8")).toBe("user hook"); expect(readFileSync(other, "utf8")).toBe("user hook");
});
test("stale owned hook removal preserves unmanaged neighbors", () => {
  const f = hooksFixture(); expect(f.run(["hooks", "install", "--apply"]).status).toBe(0); writeFileSync(path.join(f.root, ".git/hooks/pre-commit"), "other tool"); f.git(["mv", "scripts/git/hooks/pre-push", "scripts/git/hooks/commit-msg"]);
  writeFileSync(path.join(f.root, "agent-tool.json"), JSON.stringify({ schemaVersion: 1, hooks: { files: [{ source: "scripts/git/hooks/commit-msg", target: "commit-msg", executable: true }] } })); expect(f.run(["hooks", "install", "--apply"]).status).toBe(0); expect(existsSync(path.join(f.root, ".git/hooks/pre-push"))).toBe(false); expect(readFileSync(path.join(f.root, ".git/hooks/pre-commit"), "utf8")).toBe("other tool");
});
test("hooks refuse tracked source destinations and override inherited global paths", () => {
  const f = hooksFixture(); f.git(["config", "core.hooksPath", "scripts/git/hooks"]); expect(f.run(["hooks", "install", "--apply"]).status).toBe(1); f.git(["config", "--unset", "core.hooksPath"]);
  const globalFile = path.join(f.root, "global-config"); writeFileSync(globalFile, "[core]\n hooksPath = /shared/global/hooks\n"); const result = f.run(["hooks", "install", "--apply"], { GIT_CONFIG_GLOBAL: globalFile }); expect(result.status).toBe(0); expect(JSON.parse(result.stdout).destination).toBe(realpathSync(path.join(f.root, ".git/hooks")));
});
test("groups reject invalid plans and retain source-bound timing history", () => {
  expect(() => parseGroup('{"label":"a","steps":[]}')).toThrow(); const f = fixture(); const plan = path.join(f.root, "plan.json"); writeFileSync(plan, JSON.stringify({ label: "verify", steps: [{ label: "first", command: [process.execPath, "-e", "console.log('checked')"] }] })); expect(f.run(["run-group", plan]).status).toBe(0);
  const record = JSON.parse(f.run(["runs", "list", "--head", f.git(["rev-parse", "HEAD"])]).stdout).runs[0]; expect(record.status).toBe("passed"); expect(record.before).toEqual(record.after); expect(record.steps[0].receipt.log).toBeString();
});
test("source changes invalidate zero-exit validation and stop later steps", () => {
  const f = fixture(); const plan = path.join(f.root, "plan.json"); writeFileSync(plan, JSON.stringify({ label: "verify", steps: [{ label: "changes-source", command: [process.execPath, "-e", "require('fs').writeFileSync('tracked','changed')"] }, { label: "later", command: ["false"] }] })); expect(f.run(["run-group", plan]).status).toBe(1); const record = JSON.parse(f.run(["runs", "list"]).stdout).runs[0]; expect(record.status).toBe("failed"); expect(record.steps[1].status).toBe("pending"); expect(record.error).toContain("Source state changed");
});

function githubFixture() {
  const f = fixture(); f.git(["switch", "-c", "chore/workflow"]);
  const remote = path.join(f.root, ".git/remote.git"); f.git(["init", "--bare", remote]); f.git(["remote", "add", "origin", remote]); f.git(["push", "origin", "main", "chore/workflow"]);
  const commit = f.git(["rev-parse", "HEAD"]); const bin = path.join(f.root, ".git/bin"); mkdirSync(bin);
  const stateFile = path.join(f.root, ".git/api-state.json");
  const state = { commit, remote, status: "OPEN", checks: [{ name: "test", state: "SUCCESS", workflow: "CI" }], apiHead: commit, liveBase: commit };
  const save = (override: Record<string, unknown> = {}) => writeFileSync(stateFile, JSON.stringify({ ...state, ...override })); save();
  const script = `#!${process.execPath}
import {readFileSync,appendFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const a=process.argv.slice(2), s=JSON.parse(readFileSync(process.env.API_STATE,'utf8'));
const fields=a[a.indexOf('--json')+1], say=(value)=>console.log(JSON.stringify(value));
const pr={number:1,state:s.status,title:'chore: workflow',url:'https://github.com/o/r/pull/1',headRefName:'chore/workflow',headRefOid:s.apiHead,baseRefName:'main',baseRefOid:s.liveBase,isDraft:false,mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',isCrossRepository:false,mergeCommit:{oid:s.commit}};
if(a[0]==='repo')say({nameWithOwner:'o/r',defaultBranchRef:{name:'main'},url:'file://'+s.remote,sshUrl:'file://'+s.remote});
else if(a[0]==='config')console.log('https');
else if(a[0]==='pr' && a[1]==='checks')say(s.checks);
else if(a[0]==='pr' && fields==='headRefOid,statusCheckRollup')say({headRefOid:s.apiHead,statusCheckRollup:s.checks});
else if(a[0]==='pr')say(pr);
else if(a[0]==='api' && a.includes('DELETE')){appendFileSync(process.env.API_STATE+'.deleted','yes');execFileSync('git',['--git-dir='+s.remote,'update-ref','-d','refs/heads/chore/workflow']);}
else if(a[0]==='api' && a[1]==='graphql'){
 const query=a.find(value=>value.startsWith('query='));
 if(query.includes('reviewThreads')){
  const comments={nodes:[{id:'C1',databaseId:11,body:'finding',url:'https://example.com',author:{login:'reviewer'}}],pageInfo:{hasNextPage:true,endCursor:'comments-next'}};
  const nodes=a.includes('cursor=threads-next')?[]:[{id:'T1',isResolved:false,isOutdated:false,path:'file',line:1,comments}];
  say({data:{repository:{pullRequest:{reviewThreads:{nodes,pageInfo:{hasNextPage:!!nodes.length,endCursor:nodes.length?'threads-next':null}}}}}});
 }else if(query.includes('... on PullRequestReviewThread'))say({data:{node:{comments:{nodes:[{id:'C2',databaseId:12,body:'reply',url:'https://example.com',author:null}],pageInfo:{hasNextPage:false,endCursor:null}}}}});
 else say({data:{repository:{pullRequest:{id:'P1',state:'OPEN',baseRefName:'main',headRefOid:s.apiHead,autoMergeRequest:null,isInMergeQueue:false}}}});
}else {console.error('unexpected gh call '+a.join(' '));process.exit(1);}
`;
  writeFileSync(path.join(bin, "gh"), script); chmodSync(path.join(bin, "gh"), 0o755);
  const run = (args: string[]) => f.run(args, { PATH: bin + path.delimiter + process.env.PATH, API_STATE: stateFile });
  return { ...f, run, save, stateFile, commit };
}

test("CI waiter does not pass no-check races, duplicate pending jobs, or head drift", () => {
  const f = githubFixture(); f.save({ checks: [] }); let result = f.run(["pr", "checks", "--wait", "--timeout", "0"]); expect(result.status).toBe(1); expect(result.stderr).toContain("Timed out waiting");
  f.save({ checks: [{ name: "test", workflow: "CI", state: "SUCCESS" }, { name: "test", workflow: "CI", state: "PENDING" }] }); result = f.run(["pr", "checks"]); expect(result.status).toBe(1); expect(JSON.parse(result.stdout).waiting).toBe(true);
  f.save({ apiHead: "a".repeat(40) }); result = f.run(["pr", "checks"]); expect(result.status).toBe(1); expect(result.stderr).toContain("HEAD changed");
  f.save(); expect(f.run(["pr", "checks", "--wait"]).status).toBe(0);
});
test("preflight checks exact base/HEAD and preserves dirty user edits", () => {
  const f = githubFixture(); let result = f.run(["pr", "preflight", f.commit, "main", f.commit]); expect(result.status).toBe(0);
  result = f.run(["pr", "preflight", f.commit, "main", "a".repeat(40)]); expect(result.status).toBe(1); expect(result.stderr).toContain("Live base differs");
  writeFileSync(path.join(f.root, "user-edit"), "keep"); result = f.run(["pr", "preflight", f.commit, "main", f.commit]); expect(result.status).toBe(1); expect(readFileSync(path.join(f.root, "user-edit"), "utf8")).toBe("keep");
});
test("review listing paginates nested comments and resolution rejects foreign threads", () => {
  const f = githubFixture(); const result = f.run(["pr", "threads", "list"]); expect(result.status).toBe(0); const threads = JSON.parse(result.stdout).threads; expect(threads).toHaveLength(1); expect(threads[0].comments.nodes.map((comment: { databaseId: number }) => comment.databaseId)).toEqual([11, 12]);
  const invalid = f.run(["pr", "threads", "resolve", "foreign"]); expect(invalid.status).toBe(1); expect(invalid.stderr).toContain("does not belong");
});
test("cleanup previews without changes, then deletes only exact shipped refs through REST", () => {
  const f = githubFixture(); f.save({ status: "MERGED" });
  expect(f.run(["repo", "cleanup", "1", f.commit]).status).toBe(0); expect(f.git(["branch", "--show-current"])).toBe("chore/workflow"); expect(existsSync(f.stateFile + ".deleted")).toBe(false);
  const result = f.run(["repo", "cleanup", "1", f.commit, "--apply"]); expect(result.status).toBe(0); expect(JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))).completed).toContain("deleted-remote-branch"); expect(f.git(["branch", "--show-current"])).toBe("main"); expect(existsSync(f.stateFile + ".deleted")).toBe(true);
});
test("cleanup keeps branches on request and rejects unmerged or moved HEAD", () => {
  const f = githubFixture(); expect(f.run(["repo", "cleanup", "1", f.commit, "--apply"]).status).toBe(1); f.save({ status: "MERGED" });
  expect(f.run(["repo", "cleanup", "1", f.commit, "--apply", "--keep-branch"]).status).toBe(0); expect(f.git(["rev-parse", "refs/heads/chore/workflow"])).toBe(f.commit); expect(existsSync(f.stateFile + ".deleted")).toBe(false);
  f.git(["switch", "chore/workflow"]); f.git(["commit", "--allow-empty", "-m", "chore: additional work"]); expect(f.run(["repo", "cleanup", "1", f.commit, "--apply"]).status).toBe(1);
});
