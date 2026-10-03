# Validation on 2026-10-03

The extraction was checked locally with Bun 1.3.11 and TypeScript 5.9.3.

| Check | Result |
| --- | --- |
| Strict TypeScript, including unused declarations | Passed |
| macOS ARM64 source suite | 191 passed, 0 failed |
| Linux ARM64 source suite in a container | 190 passed, 1 filesystem-specific skip, 0 failed |
| Linux x64 source suite under emulation | 190 passed, 1 filesystem-specific skip, 0 failed |
| macOS ARM64 compiled smoke | Passed all three reviewer adapters |
| Linux ARM64 Debian package installed with apt | Installed executable passed compiled smoke |
| Linux amd64 Debian package installed with apt | Installed executable passed compiled smoke |
| Four OS/architecture builds | Produced macOS ARM64/x64 and Linux ARM64/x64 binaries |
| Homebrew formula | Ruby syntax and Homebrew formula loading passed |
| Five portable skills | Skill validator passed for each |
| Release SHA-256 checksums | All four archives and both Debian packages verified |

Compiled smoke covers a local-base review without GitHub, committed-file input,
trusted-base review instructions, verdict output, snapshot cleanup, skill preview
and installation, policy overwrite refusal, invalid configuration, invalid CLI
arguments, and HEAD drift rejection. Its PATH excludes Node and Bun. Reviewer
processes are local stubs; the test makes no model calls and does not exercise
live provider authentication or review quality.

The Linux skip checks platform-specific destination aliases. The container
filesystem did not expose the alias behavior needed by that test; it passed on
the macOS filesystem. Mac x64 was cross-compiled and its binary format checked,
but was not executed on an Intel Mac.

`doctor` confirmed required flags in the installed Claude Code 2.1.287,
Codex 0.158.0, and OpenCode 1.17.7 CLIs. The formula's public download URLs have
not been published, and a Brew install from those URLs has not been performed.
Debian installation was verified in disposable containers rather than on the
host. No live PR was created or merged, and sibling projects were unchanged.

Reproduce source and compiled checks with the commands in the README. CI runs
these checks and Debian packaging; the release workflow produces artifacts
without publishing them. Generated binaries, archives, packages, checksums, and
the formula are in the ignored `dist/` directory.
