#!/usr/bin/env python3
"""Read-only inventory of known agent tooling locations; no dependency/secret crawl."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path


def git(repo, *args):
    result = subprocess.run(
        ["git", "-c", "core.hooksPath=/dev/null", "-C", str(repo), *args],
        capture_output=True, text=True, check=False,
    )
    return result.stdout.strip() if result.returncode == 0 else None


def inventory(root):
    projects = []
    excluded = {"node_modules", ".git", ".secrets", "target", "dist", "build", "vendor"}
    for repo in sorted(root.iterdir()):
        if not repo.is_dir() or repo.is_symlink():
            continue
        package = repo / "packages/agent-tool"
        sources = {}
        if package.is_dir():
            for file in sorted((package / "src").rglob("*.ts")):
                if not any(part in excluded for part in file.relative_to(package).parts) and not file.is_symlink():
                    sources[str(file.relative_to(repo))] = hashlib.sha256(file.read_bytes()).hexdigest()
        legacy = repo / "scripts/agents/tooling"
        if legacy.is_dir():
            for file in sorted(legacy.rglob("*.ts")):
                if not any(part in excluded for part in file.relative_to(legacy).parts) and not file.is_symlink():
                    sources[str(file.relative_to(repo))] = hashlib.sha256(file.read_bytes()).hexdigest()
        skills = {}
        for harness in [".agents", ".codex", ".claude", ".opencode", ".gemini"]:
            directory = repo / harness / "skills"
            if directory.is_dir():
                for skill in sorted(directory.iterdir()):
                    file = skill / "SKILL.md"
                    if file.is_file():
                        skills[str(file.relative_to(repo))] = hashlib.sha256(file.read_bytes()).hexdigest()
        if not sources and not skills:
            projects.append({"project": repo.name, "toolingFound": False})
            continue
        production = {file: digest for file, digest in sources.items() if ".test." not in file and "testUtils" not in file}
        projects.append({
            "project": repo.name, "toolingFound": True,
            "commit": git(repo, "rev-parse", "HEAD"),
            "toolingDirty": bool(git(repo, "status", "--porcelain", "--", "packages/agent-tool", "scripts/agents/tooling")),
            "productionFingerprint": hashlib.sha256(json.dumps(production, sort_keys=True).encode()).hexdigest() if production else None,
            "sources": sources, "skills": skills,
        })
    return {"schemaVersion": 1, "projects": projects}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = json.dumps(inventory(args.root.expanduser().resolve()), indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(report)
    else:
        print(report, end="")
