import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, parseConfig } from "../config";
import { branchErrors } from "./branch";
import { binaryPaths, evaluateGate, signatureAccepted } from "./checks";
import { parseGroup } from "../commands/group";
import { timeoutOptions } from "./core";

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
  const bin = path.join(f.root, ".git/bin"); mkdirSync(bin); writeFileSync(path.join(bin, "gh"), `#!${process.execPath}\nconsole.log(JSON.stringify({nameWithOwner:'o/r',defaultBranchRef:{name:'main'}}));\n`); chmodSync(path.join(bin, "gh"), 0o755);
  const start = f.git(["rev-parse", "HEAD"]); writeFileSync(path.join(f.root, ".git/hooks/pre-push"), "#!/bin/sh\ngit -c core.hooksPath=/dev/null commit --allow-empty -m 'chore: changed by hook'\n"); chmodSync(path.join(f.root, ".git/hooks/pre-push"), 0o755);
  const result = f.run(["branch", "push", start], { PATH: bin + path.delimiter + process.env.PATH }); expect(result.status).toBe(1); expect(result.stderr).toContain("Push changed local or remote HEAD"); expect(f.git(["rev-parse", "HEAD"])).not.toBe(start);
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
import {readFileSync,appendFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const a=process.argv.slice(2), s=JSON.parse(readFileSync(process.env.API_STATE,'utf8'));
appendFileSync(process.env.API_STATE+'.calls',JSON.stringify(a)+'\\n');
const fields=a[a.indexOf('--json')+1], say=(value)=>console.log(JSON.stringify(value));
const pr={number:1,state:s.status,title:'chore: workflow',url:'https://github.com/o/r/pull/1',headRefName:'chore/workflow',headRefOid:s.apiHead,baseRefName:'main',baseRefOid:s.liveBase,isDraft:false,mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',isCrossRepository:false,mergeCommit:{oid:s.commit}};
if(a[0]==='repo')say({nameWithOwner:'o/r',defaultBranchRef:{name:s.defaultBranch??'main'},url:'file://'+s.remote,sshUrl:'file://'+s.remote});
else if(a[0]==='config')console.log('https');
else if(a[0]==='pr' && a[1]==='checks')say(s.checks);
else if(a[0]==='pr' && fields==='headRefOid,statusCheckRollup')say({headRefOid:s.apiHead,statusCheckRollup:s.checks});
else if(a[0]==='pr')say(pr);
else if(a[0]==='run'){
 const file=process.env.API_STATE+'.polls', count=existsSync(file)?Number(readFileSync(file,'utf8')):0;writeFileSync(file,String(count+1));
 say([{databaseId:42,headSha:s.commit,status:count===0?'in_progress':'completed',conclusion:'success',url:'https://example.com/run/42'}]);
}
else if(a[0]==='api' && a.some(value=>value.includes('/rules/branches/'))){for(const rule of s.rules??[])say(rule);}
else if(a[0]==='api' && a.some(value=>value.endsWith('/protection'))){if(s.protection)say(s.protection);else{console.error('HTTP '+(s.protectionStatus??404));process.exit(1);}}
else if(a[0]==='api' && a.includes('POST')){const body=JSON.parse(readFileSync(0,'utf8'));writeFileSync(process.env.API_STATE+'.reply',JSON.stringify(body));say({id:100,...body});}
else if(a[0]==='api' && a.some(value=>value.includes('/pulls/comments/')))say({pull_request_url:'https://api.github.com/repos/o/r/pulls/'+(a.some(value=>value.endsWith('/99'))?'2':'1')});
else if(a[0]==='api' && a.includes('DELETE')){appendFileSync(process.env.API_STATE+'.deleted','yes');execFileSync('git',['--git-dir='+s.remote,'update-ref','-d','refs/heads/chore/workflow']);}
else if(a[0]==='api' && a[1]==='graphql'){
 const query=a.find(value=>value.startsWith('query='));
 if(query.includes('resolveReviewThread'))say({data:{resolveReviewThread:{thread:{id:'T1',isResolved:true}}}});
 else if(query.includes('reviewThreads')){
  const comments={nodes:[{id:'C1',databaseId:11,body:'finding',url:'https://example.com',author:{login:'reviewer'}}],pageInfo:{hasNextPage:true,endCursor:'comments-next'}};
  const nodes=a.includes('cursor=threads-next')?[]:[{id:'T1',isResolved:false,isOutdated:false,path:'file',line:1,comments}];
  say({data:{repository:{pullRequest:{reviewThreads:{nodes,pageInfo:{hasNextPage:!!nodes.length,endCursor:nodes.length?'threads-next':null}}}}}});
 }else if(query.includes('... on PullRequestReviewThread'))say({data:{node:{comments:{nodes:[{id:'C2',databaseId:12,body:'reply',url:'https://example.com',author:null}],pageInfo:{hasNextPage:false,endCursor:null}}}}});
 else say({data:{repository:{pullRequest:{id:'P1',state:'OPEN',baseRefName:'main',headRefOid:s.apiHead,autoMergeRequest:null,isInMergeQueue:false}}}});
}else {console.error('unexpected gh call '+a.join(' '));process.exit(1);}
`;
  writeFileSync(path.join(bin, "gh"), script); chmodSync(path.join(bin, "gh"), 0o755);
  const run = (args: string[]) => f.run(args, { PATH: bin + path.delimiter + process.env.PATH, API_STATE: stateFile });
  return { ...f, run, save, stateFile, commit, bin };
}

test("CI waiter does not pass no-check races, duplicate pending jobs, or head drift", () => {
  const f = githubFixture(); f.save({ checks: [] }); let result = f.run(["pr", "checks", "--wait", "--timeout", "0"]); expect(result.status).toBe(1); expect(result.stderr).toContain("Timed out waiting");
  f.save({ checks: [{ name: "test", workflow: "CI", state: "SUCCESS" }, { name: "test", workflow: "CI", state: "PENDING" }] }); result = f.run(["pr", "checks"]); expect(result.status).toBe(1); expect(JSON.parse(result.stdout).waiting).toBe(true);
  f.save({ apiHead: "a".repeat(40) }); result = f.run(["pr", "checks"]); expect(result.status).toBe(1); expect(result.stderr).toContain("HEAD changed");
  f.save(); expect(f.run(["pr", "checks", "--wait"]).status).toBe(0);
});
test("CI wait timeout prefers --timeout, then the caller's default, then 900 seconds", () => {
  expect(timeoutOptions([])).toEqual({ timeoutMs: 900_000, intervalMs: 10_000 });
  expect(timeoutOptions([], 1800)).toEqual({ timeoutMs: 1_800_000, intervalMs: 10_000 });
  expect(timeoutOptions(["--timeout", "5", "--interval", "2"], 1800)).toEqual({ timeoutMs: 5000, intervalMs: 2000 });
  expect(timeoutOptions(["--timeout", "0"], 1800).timeoutMs).toBe(0);
  expect(() => timeoutOptions(["--timeout", "86401"], 1800)).toThrow("Timeout must be");
});
test("pr checks --wait takes its default timeout from merge.checksTimeoutSeconds", () => {
  const f = githubFixture(); f.save({ checks: [{ name: "test", workflow: "CI", state: "PENDING" }] });
  // A zero policy wait makes one observation, so the plain command times out at once instead of after 900 seconds.
  writeFileSync(path.join(f.root, "agent-tool.json"), JSON.stringify({ schemaVersion: 1, merge: { checksTimeoutSeconds: 0 } }));
  let result = f.run(["pr", "checks", "--wait"]); expect(result.status).toBe(1); expect(result.stderr).toContain("Timed out waiting");
  // The command-line flag still wins over a long policy wait.
  writeFileSync(path.join(f.root, "agent-tool.json"), JSON.stringify({ schemaVersion: 1, merge: { checksTimeoutSeconds: 86400 } }));
  result = f.run(["pr", "checks", "--wait", "--timeout", "0"]); expect(result.status).toBe(1); expect(result.stderr).toContain("Timed out waiting");
  writeFileSync(path.join(f.root, "agent-tool.json"), JSON.stringify({ schemaVersion: 1, merge: { checksTimeoutSeconds: 1.5 } }));
  result = f.run(["pr", "checks", "--wait", "--timeout", "0"]); expect(result.status).toBe(1); expect(result.stderr).toContain("merge.checksTimeoutSeconds");
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
  const result = f.run(["repo", "cleanup", "1", f.commit, "--apply"]); expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).completed).toEqual(["updated-default", "deleted-local-branch", "deleted-remote-branch"]);
  expect(f.git(["branch", "--show-current"])).toBe("main"); expect(f.git(["branch", "--list", "chore/workflow"])).toBe(""); expect(existsSync(f.stateFile + ".deleted")).toBe(true);
  const again = f.run(["repo", "cleanup", "1", f.commit, "--apply"]);
  expect(again.status).toBe(0); expect(JSON.parse(again.stdout).completed).toEqual(["updated-default"]);
});
test("cleanup prunes a squash-merged local branch after GitHub deleted the remote", () => {
  const f = githubFixture();
  writeFileSync(path.join(f.root, "tracked"), "shipped change\n"); f.git(["commit", "-am", "feat: shipped change"]);
  const shipped = f.git(["rev-parse", "HEAD"]); f.git(["push", "origin", "chore/workflow"]);
  f.git(["switch", "main"]); f.git(["merge", "--squash", "chore/workflow"]); f.git(["commit", "-m", "feat: shipped change (#1)"]);
  const merge = f.git(["rev-parse", "HEAD"]); f.git(["push", "origin", "main", ":chore/workflow"]);
  expect(spawnSync("git", ["merge-base", "--is-ancestor", shipped, merge], { cwd: f.root, env: f.env }).status).toBe(1);
  f.git(["switch", "chore/workflow"]); f.save({ status: "MERGED", apiHead: shipped, commit: merge, liveBase: merge });
  const result = f.run(["repo", "cleanup", "1", shipped, "--apply"]);
  expect(result.status).toBe(0); expect(JSON.parse(result.stdout).completed).toEqual(["updated-default", "deleted-local-branch"]);
  expect(f.git(["branch", "--show-current"])).toBe("main"); expect(f.git(["rev-parse", "HEAD"])).toBe(merge);
  expect(f.git(["branch", "--list", "chore/workflow"])).toBe(""); expect(f.git(["status", "--porcelain"])).toBe("");
  expect(existsSync(f.stateFile + ".deleted")).toBe(false);
});
test("cleanup preserves a shipped branch checked out in another worktree", () => {
  const f = githubFixture(); f.save({ status: "MERGED" }); f.git(["switch", "main"]);
  const linked = path.join(f.root, ".git/linked"); f.git(["worktree", "add", linked, "chore/workflow"]);
  const result = f.run(["repo", "cleanup", "1", f.commit, "--apply"]);
  expect(result.status).toBe(1); expect(JSON.parse(result.stdout).completed).toEqual(["updated-default"]);
  expect(f.git(["rev-parse", "refs/heads/chore/workflow"])).toBe(f.commit);
  expect(existsSync(f.stateFile + ".deleted")).toBe(false);
  expect(execFileSync("git", ["branch", "--show-current"], { cwd: linked, env: f.env, encoding: "utf8" }).trim()).toBe("chore/workflow");
});
test("cleanup keeps branches on request and rejects unmerged or moved HEAD", () => {
  const f = githubFixture(); expect(f.run(["repo", "cleanup", "1", f.commit, "--apply"]).status).toBe(1); f.save({ status: "MERGED" });
  expect(f.run(["repo", "cleanup", "1", f.commit, "--apply", "--keep-branch"]).status).toBe(0); expect(f.git(["rev-parse", "refs/heads/chore/workflow"])).toBe(f.commit); expect(existsSync(f.stateFile + ".deleted")).toBe(false);
  f.git(["switch", "chore/workflow"]); f.git(["commit", "--allow-empty", "-m", "chore: additional work"]); expect(f.run(["repo", "cleanup", "1", f.commit, "--apply"]).status).toBe(1);
});

test("private source release plans require explicit opt-in and pin the scoped registry", () => {
  const f = fixture(); const bin = path.join(f.root, ".git/bin"); mkdirSync(bin);
  writeFileSync(path.join(bin, "npm"), `#!${process.execPath}\nif(!process.argv.includes('--@owner:registry=https://registry.npmjs.org'))process.exit(8);console.log(JSON.stringify({versions:['1.0.0'],'dist-tags':{latest:'1.0.0'}}));\n`); chmodSync(path.join(bin, "npm"), 0o755);
  const manifest = path.join(f.root, "package.json"); writeFileSync(manifest, JSON.stringify({ name: "@owner/package", version: "1.0.1", private: true }));
  const env = { PATH: bin + path.delimiter + process.env.PATH, GITHUB_OUTPUT: path.join(f.root, ".git/output") };
  expect(f.run(["release", "plan", manifest], env).status).toBe(1);
  const result = f.run(["release", "plan", manifest, "--allow-private-source", "--github-output"], env); expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ publish: true, privateSource: true }); expect(readFileSync(env.GITHUB_OUTPUT, "utf8")).toBe("publish=true\n");
});
test("hook installation uses the common Git directory from a linked worktree", () => {
  const f = hooksFixture(); const linked = path.join(f.root, ".git/linked"); f.git(["worktree", "add", "-b", "chore/linked", linked]);
  const result = spawnSync(process.execPath, [cli, "hooks", "install", "--apply"], { cwd: linked, env: f.env, encoding: "utf8" }); if (result.status !== 0) throw new Error(result.stderr); expect(result.status).toBe(0); expect(JSON.parse(result.stdout).destination).toBe(realpathSync(path.join(f.root, ".git/hooks")));
});

test("subject checks enforce configured style while preserving generated Git subjects", () => {
  const f = fixture({ subject: { lowercaseInitial: true, rejectTerminalPeriod: true, ignoreGenerated: true }, commits: { subjects: true } });
  for (const [subject, expected] of [["fix: Uppercase", 1], ["fix: lower.", 1], ["Merge branch 'main'", 0]] as const) {
    f.git(["commit", "--allow-empty", "-m", subject]); expect(f.run(["commits", "check", "--range", "HEAD^..HEAD"]).status).toBe(expected);
  }
});

test("unconfigured branch names remain compatible while explicit policy is enforced", () => {
  const f = fixture(); expect(f.run(["branch", "check", "codex/ABC-123"]).status).toBe(0);
  writeFileSync(path.join(f.root, "agent-tool.json"), JSON.stringify({ schemaVersion: 1, branch: { maxLength: null } })); expect(f.run(["branch", "check", "codex/ABC-123"]).status).toBe(1);
});
test("pre-push branch checks validate destinations and skip deletion/tag tuples", () => {
  const f = fixture({ branch: { types: ["feat"], maxLength: null } }); const commit = f.git(["rev-parse", "HEAD"]); const zero = "0".repeat(40);
  const run = (input: string) => spawnSync(process.execPath, [cli, "branch", "check", "--pre-push"], { cwd: f.root, env: f.env, encoding: "utf8", input });
  expect(run(`refs/heads/local ${commit} refs/heads/feat/good ${zero}\n`).status).toBe(0);
  expect(run(`refs/heads/local ${commit} refs/heads/feat/foo..bar ${zero}\n`).status).toBe(1);
  expect(run(`(delete) ${zero} refs/heads/old-legacy ${commit}\nrefs/tags/v1 ${commit} refs/tags/v1 ${zero}\n`).status).toBe(0);
  expect(run("malformed\n").status).toBe(1);
});
test("signalled group steps finalize a failure receipt instead of killing the coordinator", () => {
  const f = fixture(); const plan = path.join(f.root, "plan.json"); writeFileSync(plan, JSON.stringify({ label: "signal", steps: [{ label: "terminated", command: [process.execPath, "-e", "process.kill(process.pid,'SIGTERM')"] }] }));
  const result = f.run(["run-group", plan]); expect(result.signal).toBeNull(); expect(result.status).toBe(143); const receipt = JSON.parse(result.stdout); expect(receipt.status).toBe("failed"); expect(receipt.steps[0].receipt.signal).toBe("SIGTERM");
});
test("empty hook policy removes owned hooks without touching user hooks", () => {
  const f = hooksFixture(); expect(f.run(["hooks", "install", "--apply"]).status).toBe(0); writeFileSync(path.join(f.root, ".git/hooks/pre-commit"), "user hook"); writeFileSync(path.join(f.root, "agent-tool.json"), JSON.stringify({ schemaVersion: 1, hooks: { files: [] } }));
  expect(f.run(["hooks", "install", "--apply"]).status).toBe(0); expect(existsSync(path.join(f.root, ".git/hooks/pre-push"))).toBe(false); expect(readFileSync(path.join(f.root, ".git/hooks/pre-commit"), "utf8")).toBe("user hook");
});
test("required skipped and neutral checks fail immediately instead of waiting", () => {
  const f = githubFixture(); f.save({ checks: [{ name: "test", state: "NEUTRAL", workflow: "CI" }] }); let result = f.run(["pr", "checks", "--wait", "--timeout", "0"]); expect(result.status).toBe(1); expect(JSON.parse(result.stdout).waiting).toBe(false);
  writeFileSync(path.join(f.root, "agent-tool.json"), JSON.stringify({ schemaVersion: 1, merge: { requiredChecks: [{ name: "test", workflow: "CI" }] } })); f.save({ checks: [{ name: "test", state: "SKIPPED", workflow: "CI" }] }); result = f.run(["pr", "checks", "--wait", "--timeout", "0"]); expect(result.status).toBe(1); expect(JSON.parse(result.stdout).waiting).toBe(false);
});
test("toolchain diagnostics read pinned numeric mise versions", () => {
  const f = fixture(); writeFileSync(path.join(f.root, ".mise.toml"), `[tools]\nbun = "${Bun.version}"\n`);
  const result = f.run(["toolchain", "check"], { PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH }); expect(result.status).toBe(0); expect(JSON.parse(result.stdout).tools[0].actual).toBe(Bun.version);
});

test("toolchain diagnostics preserve v-prefixed major versions and reject mismatches", () => {
  const f = fixture();
  const bin = path.join(f.root, ".git/bin"); mkdirSync(bin);
  const executable = path.join(bin, "node");
  writeFileSync(path.join(f.root, ".mise.toml"), '[tools]\nnode = "24.22.1"\n');
  for (const [reported, stream, status, expectedActual, expectedStatus] of [
    ["v24.22.1", "stdout", 0, "24.22.1", 0],
    ["Node v24.22.1", "stderr", 0, "24.22.1", 0],
    ["v25.22.1", "stdout", 0, "25.22.1", 1],
    ["v24.22.1", "stdout", 1, "24.22.1", 1],
  ] as const) {
    writeFileSync(executable, `#!${process.execPath}\nprocess.${stream}.write(${JSON.stringify(reported + "\n")}); process.exit(${status});\n`);
    chmodSync(executable, 0o755);
    const result = f.run(["toolchain", "check"], { PATH: bin + path.delimiter + process.env.PATH });
    expect(result.status).toBe(expectedStatus);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.tools[0].actual).toBe(expectedActual);
    expect(receipt.ok).toBe(expectedStatus === 0);
  }
});

test("commit-msg checks share attribution policy while allowing human coauthors when configured", () => {
  const f = fixture({ commits: { rejectCoauthors: false, rejectClaudeAttribution: true, subjects: true, signatures: "present" } }); const file = path.join(f.root, ".git/COMMIT_EDITMSG");
  writeFileSync(file, "fix: human change\n\nCo-authored-by: Human <human@example.com>\n"); expect(f.run(["commits", "check", "--message-file", file]).status).toBe(0);
  writeFileSync(file, "fix: attributed change\n\nCo-authored-by: Claude <claude@anthropic.com>\n"); expect(f.run(["commits", "check", "--message-file", file]).status).toBe(1);
});

test("hook paths expand home and root-level policy snapshots can be copied", () => {
  const f = fixture({ hooks: { files: [{ source: "agent-tool.json", target: "policy.json", executable: false }] } });
  const normal = f.run(["hooks", "install", "--apply"]); expect(normal.status).toBe(0); expect(readFileSync(path.join(f.root, ".git/hooks/policy.json"), "utf8")).toBe(readFileSync(path.join(f.root, "agent-tool.json"), "utf8"));
  const home = path.join(f.root, ".git/home"); mkdirSync(home); f.git(["config", "core.hooksPath", "~/managed-hooks"]);
  const expanded = f.run(["hooks", "install", "--apply"], { HOME: home }); expect(expanded.status).toBe(0); expect(JSON.parse(expanded.stdout).destination).toBe(path.join(realpathSync(home), "managed-hooks")); expect(existsSync(path.join(f.root, "~"))).toBe(false);
});
test("branch push refuses a custom default even without naming policy", () => {
  const f = githubFixture(); f.save({ defaultBranch: "chore/workflow" }); const result = f.run(["branch", "push", f.commit]); expect(result.status).toBe(1); expect(result.stderr).toContain("feature branch");
});
test("thread mutations validate PR membership and use the original reply route", () => {
  const f = githubFixture(); const file = path.join(f.root, ".git/reply.txt"); const body = 'Reply with `literal` $text\nand a newline.\n'; writeFileSync(file, body);
  expect(f.run(["pr", "threads", "reply", "99", "--body-file", file]).status).toBe(1); expect(existsSync(f.stateFile + ".reply")).toBe(false);
  const result = f.run(["pr", "threads", "reply", "11", "--body-file", file]); expect(result.status).toBe(0); expect(JSON.parse(readFileSync(f.stateFile + ".reply", "utf8"))).toEqual({ body });
  const calls = readFileSync(f.stateFile + ".calls", "utf8").trim().split("\n").map(line => JSON.parse(line)); expect(calls).toContainEqual(["api", "--method", "POST", "repos/o/r/pulls/1/comments/11/replies", "--input", "-"]);
  const resolved = f.run(["pr", "threads", "resolve", "T1"]); expect(resolved.status).toBe(0); expect(JSON.parse(resolved.stdout).resolveReviewThread.thread.isResolved).toBe(true);
});
test("policy diagnostics combine classic and effective rules and fail unreadable protection", () => {
  const f = githubFixture(); f.save({ rules: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "rules-check" }] } }], protection: { required_status_checks: { contexts: ["classic-check"] } } });
  let result = f.run(["policy", "check"]); expect(result.status).toBe(1); expect(JSON.parse(result.stdout).missingConfiguredChecks.sort()).toEqual(["classic-check", "rules-check"]);
  writeFileSync(path.join(f.root, "agent-tool.json"), JSON.stringify({ schemaVersion: 1, merge: { requiredChecks: [{ name: "classic-check" }, { name: "rules-check" }] } })); expect(f.run(["policy", "check"]).status).toBe(0);
  f.save(); result = f.run(["policy", "check"]); expect(result.status).toBe(0); expect(JSON.parse(result.stdout).classicProtection).toBeNull();
  f.save({ protectionStatus: 403 }); expect(f.run(["policy", "check"]).status).toBe(1);
});
test("CI gate CLI parses stdin and policy files and rejects invalid schemas", () => {
  const f = fixture(); const policy = path.join(f.root, "policy.json"); writeFileSync(policy, JSON.stringify({ required: ["changes"], conditional: [{ job: "native", source: "changes", output: "native" }] }));
  const run = (needs: unknown) => spawnSync(process.execPath, [cli, "ci", "gate", "-", "--policy", policy], { cwd: f.root, env: f.env, encoding: "utf8", input: JSON.stringify(needs) });
  expect(run({ changes: { result: "success", outputs: { native: "false" } }, native: { result: "skipped" } }).status).toBe(0); expect(run({ changes: { result: "success", outputs: {} }, native: { result: "skipped" } }).status).toBe(1);
  for (const bad of [{ unknown: true }, { required: "test" }, { conditional: [{ job: "native", output: "native" }] }]) { writeFileSync(policy, JSON.stringify(bad)); expect(run({ test: { result: "success" } }).status).toBe(1); }
  expect(f.run(["ci", "gate", "--policy"]).status).toBe(1);
});
test("unscoped release plans pin only the global npm registry", () => {
  const f = fixture(); const bin = path.join(f.root, ".git/bin"); mkdirSync(bin); const npm = path.join(bin, "npm"); writeFileSync(npm, `#!${process.execPath}\nif(process.argv.some(a=>a.startsWith('--@'))||process.argv[process.argv.indexOf('--registry')+1]!=='https://registry.npmjs.org')process.exit(8);console.log(JSON.stringify({versions:'1.0.0','dist-tags':{latest:'1.0.0'}}));\n`); chmodSync(npm, 0o755); writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ name: "unscoped-package", version: "1.0.1" }));
  const result = f.run(["release", "plan", "package.json"], { PATH: bin + path.delimiter + process.env.PATH }); expect(result.status).toBe(0); expect(JSON.parse(result.stdout).publish).toBe(true);
});
test("history reports corrupt receipts without losing valid source-bound runs", () => {
  const f = fixture(); const folder = path.join(f.root, ".git/agent-tool/runs"); mkdirSync(folder, { recursive: true }); writeFileSync(path.join(folder, "bad.json"), "{bad"); writeFileSync(path.join(folder, "good.json"), JSON.stringify({ startedAt: "2026-01-01T00:00:00Z", before: { headOid: f.git(["rev-parse", "HEAD"]), branch: "main" } }));
  const result = f.run(["runs", "list"]); expect(result.status).toBe(0); const receipt = JSON.parse(result.stdout); expect(receipt.runs).toHaveLength(1); expect(receipt.skipped[0].file).toBe("bad.json");
});
test("release verify CLI polls the selected workflow and commit before verifying npm", () => {
  const f = githubFixture(); const manifest = { name: "@owner/package", version: "1.2.3" }; const packageDir = path.join(f.root, ".git/package"); mkdirSync(packageDir); writeFileSync(path.join(packageDir, "package.json"), JSON.stringify(manifest)); execFileSync("tar", ["-czf", "package.tgz", "package"], { cwd: path.join(f.root, ".git") });
  const archive = path.join(f.root, ".git/package.tgz"); const preload = path.join(f.root, ".git/fetch.ts");
  writeFileSync(preload, `import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';const archive=readFileSync(${JSON.stringify(archive)});let metadataCalls=0;globalThis.fetch=async(url)=>{if(String(url).endsWith('.tgz'))return new Response(archive);if(metadataCalls++===0)return new Response(null,{status:404});return Response.json({...${JSON.stringify(manifest)},gitHead:${JSON.stringify(f.commit)},dist:{tarball:'https://registry.npmjs.org/package.tgz',integrity:'sha512-'+createHash('sha512').update(archive).digest('base64')}});};`);
  const result = spawnSync(process.execPath, ["--preload", preload, cli, "release", "verify", manifest.name, manifest.version, f.commit, "--workflow", "Publish fixture", "--timeout", "10", "--interval", "1"], { cwd: f.root, env: { ...f.env, PATH: f.bin + path.delimiter + process.env.PATH, API_STATE: f.stateFile }, encoding: "utf8", timeout: 15000 }); if (result.status !== 0) throw new Error(result.stderr); expect(JSON.parse(result.stdout).ok).toBe(true); expect(Number(readFileSync(f.stateFile + ".polls", "utf8"))).toBe(3);
  const calls = readFileSync(f.stateFile + ".calls", "utf8").trim().split("\n").map(line => JSON.parse(line)); expect(calls.filter(call => call[0] === "run")).toEqual(Array(3).fill(["run", "list", "-R", "o/r", "--workflow", "Publish fixture", "--commit", f.commit, "--limit", "100", "--json", "databaseId,status,conclusion,headSha,url"]));
});

test("signed commit checks ignore signature display without weakening trust or message policy", () => {
  const f = fixture({ commits: { signatures: "verified", rejectCoauthors: true, rejectClaudeAttribution: true, subjects: true } });
  const key = path.join(f.root, ".git/signing-key");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], { stdio: "ignore" });
  const allowed = path.join(f.root, ".git/allowed-signers");
  writeFileSync(allowed, `test@example.com ${readFileSync(key + ".pub", "utf8")}`);
  f.git(["config", "gpg.format", "ssh"]); f.git(["config", "user.signingkey", key]);
  f.git(["config", "gpg.ssh.allowedSignersFile", allowed]); f.git(["config", "commit.gpgsign", "true"]);
  f.git(["config", "log.showSignature", "true"]);
  f.git(["commit", "--allow-empty", "-m", "fix: valid signed change"]);
  // Establish the real Git behavior that previously polluted all formatted reads.
  expect(f.git(["show", "--no-patch", "--format=%G?", "HEAD"])).toContain('Good "git" signature');
  let result = f.run(["commits", "check", "--range", "HEAD^..HEAD"]);
  expect(result.status).toBe(0); expect(JSON.parse(result.stdout).findings).toEqual([]);
  expect(f.run(["commits", "check", "--range", "HEAD^..HEAD"], { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "log.showSignature", GIT_CONFIG_VALUE_0: "true" }).status).toBe(0);
  writeFileSync(path.join(f.root, "agent-tool.json"), JSON.stringify({ schemaVersion: 1, commits: { signatures: "present", rejectCoauthors: true, subjects: true } }));
  expect(f.run(["commits", "check", "--range", "HEAD^..HEAD"]).status).toBe(0);
  f.git(["commit", "--allow-empty", "-m", "fix: attributed change\n\nCo-authored-by: Human <human@example.com>"]);
  result = f.run(["commits", "check", "--range", "HEAD^..HEAD"]);
  expect(result.status).toBe(1); expect(JSON.parse(result.stdout).findings[0].errors).toEqual(["Co-authored-by trailer is forbidden."]);
  f.git(["commit", "--allow-empty", "-m", "invalid subject"]);
  result = f.run(["commits", "check", "--range", "HEAD^..HEAD"]);
  expect(result.status).toBe(1); expect(JSON.parse(result.stdout).findings[0].errors).toHaveLength(1);
  f.git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fix: unsigned change"]);
  result = f.run(["commits", "check", "--range", "HEAD^..HEAD"]);
  expect(result.status).toBe(1); expect(JSON.parse(result.stdout).findings[0].errors).toEqual(["Signature does not meet 'present' policy (N)."]);
});

test("pr logs saves each failed Actions job log and lists external failures without one", () => {
  const f = githubFixture();
  f.save({ checks: [{ name: "test", state: "FAILURE", workflow: "CI", link: "https://github.com/o/r/actions/runs/42/job/7" }, { name: "lint", state: "SUCCESS", workflow: "CI", link: "https://github.com/o/r/actions/runs/42/job/8" }, { name: "preview", state: "FAILURE", workflow: "", link: "https://vercel.com/o/r" }] });
  const result = f.run(["pr", "logs", "--tail-lines", "5"]);
  expect(result.status).toBe(0);
  const failed = JSON.parse(result.stdout).failed;
  expect(failed.map((check: { name: string }) => check.name)).toEqual(["test", "preview"]);
  expect(failed[0]).toMatchObject({ runId: 42, jobId: 7, ok: true });
  expect(failed[0].tail).toContain("databaseId");
  expect(failed[1].log).toBeNull();
  rmSync(path.dirname(failed[0].log), { recursive: true, force: true });
  expect(readFileSync(f.stateFile + ".calls", "utf8")).toContain(JSON.stringify(["run", "view", "42", "-R", "o/r", "--job", "7", "--log-failed"]));
  expect(f.run(["pr", "logs", "--head", "a".repeat(40)]).stderr).toContain("PR HEAD differs");
});

test("dependency diff reports declared changes in every manifest and names new third-party packages", () => {
  const f = fixture();
  mkdirSync(path.join(f.root, "packages/web"), { recursive: true });
  writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ dependencies: { ms: "1.0.0", chalk: "5.0.0" } }));
  writeFileSync(path.join(f.root, "packages/web/package.json"), JSON.stringify({ devDependencies: { vite: "7.0.0" } }));
  f.git(["add", "."]); f.git(["commit", "-m", "chore: manifests"]);
  const base = f.git(["rev-parse", "HEAD"]);
  writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ dependencies: { ms: "2.0.0", "left-pad": "1.3.0" } }));
  writeFileSync(path.join(f.root, "packages/web/package.json"), JSON.stringify({ devDependencies: { vite: "7.0.0", chalk: "5.0.0", api: "workspace:*" } }));
  f.git(["commit", "-am", "chore: change dependencies"]);
  const result = f.run(["dependencies", "diff", "--base", base]);
  expect(result.status).toBe(0);
  const diff = JSON.parse(result.stdout);
  expect(diff.newPackages).toEqual(["left-pad"]);
  writeFileSync(path.join(f.root, "packages/web/package.json"), JSON.stringify({ devDependencies: { vite: "7.0.0", chalk: "5.0.0", api: "9.9.9" } }));
  f.git(["commit", "-am", "chore: take api from the registry"]);
  expect(JSON.parse(f.run(["dependencies", "diff", "--base", base]).stdout).newPackages).toEqual(["api", "left-pad"]);
  writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ dependencies: { ms: "npm:@evil/ms@2.0.0", "left-pad": "1.3.0" } }));
  f.git(["commit", "-am", "chore: alias ms"]);
  expect(JSON.parse(f.run(["dependencies", "diff", "--base", base]).stdout).newPackages).toEqual(["@evil/ms", "api", "left-pad"]);
  writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ catalog: { tool: "npm:old@1.0.0" }, dependencies: { tool: "catalog:" } }));
  f.git(["commit", "-am", "chore: catalog tool"]);
  const cataloged = f.git(["rev-parse", "HEAD"]);
  writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ catalog: { tool: "npm:new@1.0.0" }, dependencies: { tool: "catalog:" } }));
  f.git(["commit", "-am", "chore: repoint the catalog"]);
  const repointed = JSON.parse(f.run(["dependencies", "diff", "--base", cataloged]).stdout);
  expect(repointed.changed).toEqual([{ manifest: "package.json", section: "dependencies", name: "tool", from: "npm:old@1.0.0", to: "npm:new@1.0.0" }]);
  expect(repointed.newPackages).toEqual(["new"]);
  expect(diff.added).toEqual([{ manifest: "package.json", section: "dependencies", name: "left-pad", spec: "1.3.0" }, { manifest: "packages/web/package.json", section: "devDependencies", name: "api", spec: "workspace:*" }, { manifest: "packages/web/package.json", section: "devDependencies", name: "chalk", spec: "5.0.0" }]);
  expect(diff.removed).toEqual([{ manifest: "package.json", section: "dependencies", name: "chalk", spec: "5.0.0" }]);
  expect(diff.changed).toEqual([{ manifest: "package.json", section: "dependencies", name: "ms", from: "1.0.0", to: "2.0.0" }]);
  expect(f.run(["dependencies", "diff", "--base", "--output=x"]).status).toBe(1);
  const nested = spawnSync(process.execPath, [cli, "dependencies", "diff", "--base", base], { cwd: path.join(f.root, "packages/web"), env: f.env, encoding: "utf8" });
  expect(JSON.parse(nested.stdout).newPackages).toEqual(JSON.parse(f.run(["dependencies", "diff", "--base", base]).stdout).newPackages);
});
