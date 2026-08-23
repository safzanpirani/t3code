# PAPERCUTS

Small, non-blocking frictions encountered by agents while working. Review this file periodically and sand them down.

## cf2161 · 2026-08-23T15:46:31.334Z — codex — gpt-5.6-sol

- **Directory:** `/Users/safzan/Development/t3code-codex-inline`
- **Tags:** `dx`
- **Resolved:** 2026-08-23T16:11:12.132Z — Added and tested a 1.5 GiB free-space preflight before desktop artifact staging, with a typed error reporting required and available space.

Desktop artifact build spent several minutes staging before hdiutil failed with no space left on device. scripts/build-desktop-artifact.ts should preflight enough free space for DMG creation and fail early with a clear requirement.

## 14d3b0 · 2026-08-23T15:48:02.431Z — codex — gpt-5.6-sol

- **Directory:** `/Users/safzan/Development/t3code-codex-inline`
- **Tags:** `dx`
- **Resolved:** 2026-08-23T16:11:12.154Z — Desktop artifact subprocesses now prepend the workspace node_modules/.bin to PATH, so direct node invocation resolves the installed vp binary; unit tests and scripts typecheck pass.

scripts/build-desktop-artifact.ts shells out to vp by bare name, so direct node invocation fails with spawn vp ENOENT even after pnpm install. Either resolve the local binary explicitly or document that custom targets must run through pnpm exec.
