import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import metadata from "../../package.json";
import { encodePng } from "../../src/images/png";

const root = path.resolve(import.meta.dir, "../..");
const temporary = mkdtempSync(path.join(tmpdir(), "agent-tool-package-"));
const consumer = path.join(temporary, "consumer");
const archive = path.join(temporary, "agent-tool.tgz");
const env = { ...process.env, AGENT_TOOL_CONFIG: undefined };
try {
  execFileSync(process.execPath, ["pm", "pack", "--ignore-scripts", "--quiet", "--filename", archive], { cwd: root, env });
  const packed = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).split("\n");
  assert.ok(packed.includes("package/src/index.ts"), "the package ships the CLI source");
  assert.deepEqual(packed.filter(file => /\.test(?:Utils)?\.ts$/.test(file)), [], "tests stay out of the package");
  for (const file of ["gallery.ts", "gallery.css", "manifest.ts"]) assert.ok(packed.includes(`package/src/screenshots/${file}`), `the package ships screenshots/${file}`);
  mkdirSync(consumer);
  writeFileSync(path.join(consumer, "package.json"), JSON.stringify({
    name: "agent-tool-consumer-smoke",
    private: true,
    dependencies: { [metadata.name]: `file:${archive}` },
    scripts: { "agent-tool": `bun node_modules/${metadata.name}/src/index.ts` },
  }));
  execFileSync(process.execPath, ["install", "--ignore-scripts"], { cwd: consumer, env, stdio: "pipe" });
  const executable = path.join(consumer, "node_modules/.bin/agent-tool");
  const run = (...args: string[]) => execFileSync(executable, args, { cwd: consumer, env, encoding: "utf8" });
  assert.equal(run("--version").trim(), metadata.version);
  assert.match(run("--help"), /pr merge/);
  const compact = JSON.parse(run("run", "--", process.execPath, "-e", 'console.log("installed harness output")'));
  try {
    assert.equal(compact.exitCode, 0);
    assert.equal(readFileSync(compact.log, "utf8"), "installed harness output\n");
    assert.match(run("logs", compact.log), /installed harness output/);
  } finally { rmSync(path.dirname(compact.log), { recursive: true, force: true }); }
  const skills = JSON.parse(run("skills", "list"));
  assert.ok(skills.includes("ship-pr") && skills.includes("update-dependencies"));
  assert.equal(JSON.parse(run("config", "show")).schemaVersion, 1);
  assert.equal(JSON.parse(run("skills", "install")).applied, false);
  assert.equal(existsSync(path.join(consumer, ".agents")), false);
  const check = () => execFileSync(executable, ["skills", "check"], { cwd: consumer, env, encoding: "utf8", stdio: "pipe" });
  assert.throws(check, "missing skills fail the CI check");
  run("skills", "install", "--apply");
  assert.equal(JSON.parse(check()).ok, true);
  const dependencySkill = readFileSync(path.join(root, "skills/update-dependencies/SKILL.md"), "utf8");
  for (const harness of [".agents", ".claude"]) {
    assert.equal(readFileSync(path.join(consumer, harness, "skills/update-dependencies/SKILL.md"), "utf8"), dependencySkill, "installed harness policies match the canonical dependency-upgrade skill");
  }
  // A separate Git checkout, invoked from elsewhere, needs no workspace layout
  // or Hermes installation/trust mutation to receive the portable bundle.
  const standalone = path.join(temporary, "standalone");
  mkdirSync(standalone);
  execFileSync("git", ["init", "--quiet", standalone], { env, stdio: "pipe" });
  const hermes = (...args: string[]) => run("--repo", standalone, "skills", ...args, "--harness", "hermes");
  assert.equal(JSON.parse(hermes("install")).applied, false);
  assert.equal(existsSync(path.join(standalone, ".agents")), false);
  assert.throws(() => hermes("check"), "Hermes checks fail on missing skills");
  hermes("install", "--apply");
  assert.equal(JSON.parse(hermes("check")).ok, true);
  const owned = readFileSync(path.join(standalone, ".agent-tool-skills.json"), "utf8");
  assert.ok(JSON.parse(run("--repo", standalone, "skills", "install", "--harness", "codex", "--apply")).changes.every((item: { status: string }) => item.status === "unchanged"));
  assert.equal(readFileSync(path.join(standalone, ".agent-tool-skills.json"), "utf8"), owned, "Hermes and Codex share ownership");
  assert.equal(readFileSync(path.join(standalone, ".agents/skills/update-dependencies/SKILL.md"), "utf8"), dependencySkill);
  assert.equal(existsSync(path.join(standalone, ".hermes")), false, "installation never creates Hermes configuration or a duplicate bundle");
  // The portable fallback for harnesses without background jobs retains the
  // inner failure receipt; an exited outer process is not a successful check.
  const background = JSON.parse(run("--repo", standalone, "proc", "start", "--label", "finite-check", "--", executable, "run", "--label", "expected-failure", "--", process.execPath, "-e", 'setTimeout(() => { console.log("background evidence"); process.exit(3); }, 1000)'));
  try {
    const deadline = performance.now() + 10_000;
    let state: string | undefined;
    do {
      await Bun.sleep(50);
      state = JSON.parse(run("--repo", standalone, "proc", "list")).processes.find((item: { id: string }) => item.id === background.id)?.state;
    } while (state === "running" && performance.now() < deadline);
    assert.equal(state, "exited");
    const outerLog = run("logs", background.log, "--max-bytes", "8192");
    assert.match(outerLog, /"status":"failed"/);
    assert.match(outerLog, /"exitCode":3/);
    assert.match(outerLog, /background evidence/);
    const receipt = JSON.parse(readFileSync(background.log, "utf8").split("\n")[0]!);
    rmSync(path.dirname(receipt.log), { recursive: true, force: true });
  } finally {
    run("--repo", standalone, "proc", "stop", background.id);
    rmSync(path.dirname(background.log), { recursive: true, force: true });
  }
  const plan = path.join(consumer, "plan.json");
  const safe = { format_version: "1.2", terraform_version: "1.14.0", complete: true, planned_values: {}, configuration: {}, resource_changes: [] };
  writeFileSync(plan, JSON.stringify(safe));
  assert.equal(JSON.parse(run("dependencies", "check-terraform-plan", plan)).ok, true);
  writeFileSync(plan, JSON.stringify({ ...safe, resource_changes: [{ address: "module.site.aws_instance.main", mode: "managed", change: { actions: ["create", "delete"], before: { secret: "private-attribute" } } }] }));
  assert.throws(() => run("dependencies", "check-terraform-plan", plan), error => {
    const failure = error as { status?: number; stdout?: string };
    assert.equal(failure.status, 1);
    assert.equal(JSON.parse(String(failure.stdout)).ok, false);
    assert.equal(String(failure.stdout).includes("private-attribute"), false);
    return true;
  }, "installed CLI rejects resource replacement without printing attributes");
  const skill = path.join(consumer, ".agents/skills/ship-pr/SKILL.md");
  writeFileSync(skill, "local edit");
  assert.throws(check, "edited skills fail the CI check");
  assert.equal(readFileSync(skill, "utf8"), "local edit", "checking never repairs files");
  mkdirSync(path.join(consumer, "assets/brand"), { recursive: true });
  writeFileSync(path.join(consumer, "assets/brand/logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><rect width="1" height="2" fill="#f00"/></svg>');
  writeFileSync(path.join(consumer, "agent-tool.json"), JSON.stringify({ schemaVersion: 1, images: { targets: { web: { outputs: [{ path: "favicon.ico", sizes: [16, 32], layers: [{ source: "logo" }] }] } } } }));
  assert.deepEqual(JSON.parse(run("images", "build", "web", "--out", "public")).targets[0].written, ["public/favicon.ico"], "the installed renderer dependency loads");
  assert.equal(readFileSync(path.join(consumer, "public/favicon.ico")).readUInt16LE(4), 2);
  // Screenshot staging from a capture directory, and the browser entry points through the exports map.
  const capture = path.join(consumer, ".screenshots/mobile/light");
  mkdirSync(capture, { recursive: true });
  writeFileSync(path.join(capture, "home.png"), encodePng({ width: 3, height: 7, channels: 3, data: new Uint8Array(63) }));
  writeFileSync(path.join(consumer, "agent-tool.json"), JSON.stringify({ schemaVersion: 1, screenshots: { targets: { site: { dir: "public/shots", urlPrefix: "/shots/", projects: { mobile: "Phone" }, screens: ["home"] } } } }));
  assert.equal(JSON.parse(run("screenshots", "build", "--json")).targets[0].entries, 1, "the installed CLI stages screenshots");
  assert.deepEqual(JSON.parse(readFileSync(path.join(consumer, "public/shots/manifest.json"), "utf8")).entries[0].width, 3);
  writeFileSync(path.join(consumer, "exports.ts"), [
    'import { readFileSync } from "node:fs";',
    'import { fileURLToPath } from "node:url";',
    'import { EMPTY_MANIFEST, screenshotRoutes } from "@a2f0/agent-tool/screenshots/manifest";',
    'import { defineScreenshotElements, fitFrame } from "@a2f0/agent-tool/screenshots/gallery";',
    'const css = readFileSync(fileURLToPath(import.meta.resolve("@a2f0/agent-tool/screenshots/gallery.css")), "utf8");',
    'const metadata = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve("@a2f0/agent-tool/package.json")), "utf8"));',
    'console.log(JSON.stringify({ routes: screenshotRoutes(EMPTY_MANIFEST).length, define: typeof defineScreenshotElements, fit: fitFrame("phone", 1170, 2532, 390, 844).height, css: css.includes("--shots-bezel"), version: metadata.version }));',
  ].join("\n"));
  const exported = JSON.parse(execFileSync(process.execPath, ["exports.ts"], { cwd: consumer, env, encoding: "utf8" }));
  assert.deepEqual(exported, { routes: 1, define: "function", fit: 788, css: true, version: metadata.version }, "the browser entry points import without a DOM");
  // Consumers type-check shipped TypeScript with their own settings; @tsconfig/strictest is the strictest in use.
  writeFileSync(path.join(consumer, "browser.ts"), [
    'import { defineScreenshotElements, type ScreenshotGalleryElement } from "@a2f0/agent-tool/screenshots/gallery";',
    'import { screenshotHeading, type ScreenshotManifest } from "@a2f0/agent-tool/screenshots/manifest";',
    'defineScreenshotElements();',
    'const gallery = document.querySelector<ScreenshotGalleryElement>("screenshot-gallery");',
    'gallery?.select({ project: "mobile" });',
    'export const heading = (manifest: ScreenshotManifest) => screenshotHeading(manifest, "mobile", "home");',
  ].join("\n"));
  const browserConfig = JSON.parse(readFileSync(path.join(root, "tsconfig.browser.json"), "utf8"));
  writeFileSync(path.join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: browserConfig.compilerOptions, files: ["browser.ts"] }));
  execFileSync(path.join(root, "node_modules/.bin/tsc"), ["-p", consumer], { cwd: consumer, env, stdio: "pipe" });
  assert.match(execFileSync(process.execPath, ["run", "agent-tool", "--help"], { cwd: consumer, env, encoding: "utf8" }), /agent-tool/);
  console.log("Installed source package passed executable, script, policy, image rendering, screenshot staging, browser entry point, and embedded-skills checks without install scripts or a build.");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
