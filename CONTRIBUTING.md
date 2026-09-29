# Contributing to csm

Thanks for helping out. csm is a small TypeScript CLI (Node >= 20, ESM, no runtime dependencies).

## Dev setup

```sh
git clone https://github.com/ilomon10/csm.git
cd csm
corepack enable          # or install pnpm 9 yourself
pnpm install
pnpm build               # tsc -> dist/
node dist/cli.js --help
```

## Build and test

```sh
pnpm typecheck           # tsc --noEmit
pnpm test                # tsc, then the node:test suite (test/**/*.test.mjs)
pnpm test:only           # suite only, no rebuild
```

Set `CSM_TEST_CLI=/abs/path/to/csm` to run the suite against a compiled binary instead of `dist/cli.js`.

Tests never touch your real `~/.claude` or `~/.claude-sessions`. Every test runs against a temp `CSM_HOME` and `HOME`
with a fake `claude` binary. Keep it that way: never hard-code a home path in a test or in `src/` (use `ROOT` from `src/paths.ts`).

## Cross-OS notes

csm supports Linux, macOS and Windows. When you change filesystem code:

- Use the helpers in `src/fsx.ts` (`renameRetry`, `removeTreeSafe`, ...) rather than raw `rename` / `rm -r`.
- Windows symlinks need Developer Mode or an elevated shell. csm falls back to junctions for directories and to
  hardlinks or copies for files. Tests that need real file symlinks must use `skipUnlessSymlink` from `test/support/helpers.mjs`.
- POSIX-only tests use `skipOnWindows`. Shell wrapper tests for bash/zsh/fish are skipped on Windows; the pwsh test runs wherever `pwsh` exists.
- Line endings are enforced by `.gitattributes` (`.sh` LF, `.ps1`/`.cmd` CRLF).

## Coding style

- Strict TypeScript, matching the existing code: `readonly` where possible, small functions, `const` arrow exports.
- User-facing failures throw `CsmError` (`src/errors.ts`); only `main` in `cli.ts` calls `process.exit`.
- No new runtime dependencies without prior discussion.
- Formatting follows `.editorconfig` (2 spaces, LF, final newline).

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`.
- Branch from `main`, keep PRs focused, and fill in the PR template.
- Add or update tests for what you change, run `pnpm test`, and add a line under `[Unreleased]` in `CHANGELOG.md`.
- CI must be green on all three operating systems.

## Releases

Maintainers cut releases by tag:

1. Update `version` in `package.json` and move `[Unreleased]` in `CHANGELOG.md` under the new version.
2. Merge to `main`, then push a tag `v<version>` (for example `v0.1.0-beta.1`).
3. The release workflow verifies the tag matches `package.json`, runs the test matrix, builds the binaries,
   generates `SHA256SUMS` and publishes a GitHub Release (marked as prerelease for `-beta`/`-rc` versions).

Distribution is GitHub-only; the package is `private` and is not published to npm.
