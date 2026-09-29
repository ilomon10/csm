# csm — Claude Code Session Manager

Switch between multiple Claude Code subscription logins on a single host. Each profile runs with its own isolated login (`CLAUDE_CONFIG_DIR`), stored in `~/.claude-sessions/profiles` by default.

[![CI](https://github.com/ilomon10/csm/actions/workflows/ci.yml/badge.svg)](https://github.com/ilomon10/csm/actions/workflows/ci.yml)
[![Latest Release](https://img.shields.io/github/v/release/ilomon10/csm?include_prereleases)](https://github.com/ilomon10/csm/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Why csm?

You have multiple Claude Code subscriptions (work, personal, partner accounts). Without csm, switching between them means manually logging out and in, clearing credentials, or maintaining separate machines. csm isolates each login to a named profile so plain `claude` runs against your current account — switching is instant and safe.

## Install

Requires Node.js >= 20.

### Linux & macOS

```bash
curl -fsSL https://raw.githubusercontent.com/ilomon10/csm/main/scripts/install.sh | sh
```

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/ilomon10/csm/main/scripts/install.ps1 | iex
```

### Install Options

Add flags to the one-liner:

```bash
# sh: version pinning
curl -fsSL https://raw.githubusercontent.com/ilomon10/csm/main/scripts/install.sh | sh -s -- --version 0.1.0-beta.1

# sh: skip shell setup
curl -fsSL https://raw.githubusercontent.com/ilomon10/csm/main/scripts/install.sh | sh -s -- --no-setup

# PowerShell: version pinning
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/ilomon10/csm/main/scripts/install.ps1))) -Version 0.1.0-beta.1

# PowerShell: skip shell setup
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/ilomon10/csm/main/scripts/install.ps1))) -NoSetup
```

### Pin the installer itself

The installers are also attached to every release, so you can pin the exact script that runs:

```sh
curl -fsSL https://github.com/ilomon10/csm/releases/download/v0.1.0-beta.1/install.sh | sh -s -- --version 0.1.0-beta.1
```

```powershell
& ([scriptblock]::Create((irm https://github.com/ilomon10/csm/releases/download/v0.1.0-beta.1/install.ps1))) -Version 0.1.0-beta.1
```

The installer only downloads over HTTPS, verifies every binary against the release's `SHA256SUMS`, and refuses to run as root (override with `--allow-root`).

### Manual download and verification

```bash
VER=v0.1.0-beta.1
ASSET=csm-linux-x64   # or csm-linux-arm64, csm-darwin-x64, csm-darwin-arm64
curl -fsSLO "https://github.com/ilomon10/csm/releases/download/$VER/$ASSET"
curl -fsSLO "https://github.com/ilomon10/csm/releases/download/$VER/SHA256SUMS"
grep " $ASSET\$" SHA256SUMS | sha256sum -c -     # macOS: shasum -a 256 -c -
chmod +x "$ASSET" && mv "$ASSET" ~/.local/bin/csm
```

```powershell
$Ver = 'v0.1.0-beta.1'; $Asset = 'csm-windows-x64.exe'
irm "https://github.com/ilomon10/csm/releases/download/$Ver/$Asset" -OutFile $Asset
$sums = irm "https://github.com/ilomon10/csm/releases/download/$Ver/SHA256SUMS"
$want = (($sums -split "`n") | Where-Object { $_ -match " \*?$([regex]::Escape($Asset))$" }).Split(' ')[0]
(Get-FileHash $Asset -Algorithm SHA256).Hash -eq $want.ToUpper()
```

Release binaries also carry [build provenance](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations): verify with `gh attestation verify <file> --repo ilomon10/csm`.

### From npm (Node users)

```bash
npm install -g https://github.com/ilomon10/csm/releases/download/v0.1.0-beta.1/claude-session-manager-0.1.0-beta.1.tgz
```

### From Source

```bash
git clone https://github.com/ilomon10/csm.git
cd csm
corepack enable  # or install pnpm 9
pnpm install
pnpm build
pnpm add -g "$PWD"
```

## Quick Start

Create two profiles and switch between them:

```bash
csm add work          # Creates profile, launches claude to log in
csm add personal      # Create another profile with a different account
csm use work          # Switch to work account
claude                # Runs Claude Code with the work profile
csm use personal
claude                # Runs Claude Code with the personal profile
```

## Shell Setup (Required)

Before plain `claude` will use your selected profile, add a shell initialization snippet to your shell's rc file and restart your shell.

Run this once to auto-detect your shell and add the block:

```bash
csm setup
```

Or add manually:

### Bash

Add to `~/.bashrc` (and `~/.bash_profile` on macOS/Windows):

```bash
if command -v csm >/dev/null 2>&1; then eval "$(csm shell-init bash)"; fi
```

### Zsh

Add to `~/.zshrc`:

```bash
if command -v csm >/dev/null 2>&1; then eval "$(csm shell-init zsh)"; fi
```

### Fish

Add to `~/.config/fish/conf.d/csm.fish` (create the file):

```fish
if command -q csm; csm shell-init fish | source; end
```

### PowerShell

Add to your PowerShell profile (`$PROFILE`):

```powershell
if (Get-Command csm -CommandType Application -ErrorAction SilentlyContinue) { csm shell-init pwsh | Out-String | Invoke-Expression }
```

Then restart your shell:

```bash
exec $SHELL
```

## Verify Shell Setup

To confirm shell integration is active:

```bash
type claude   # Should show a function (bash/zsh) or definition (fish/pwsh), not a command
```

## Commands

### Profile Management

**`csm add <name> [--no-login]`**

Create a profile and launch Claude Code to log in.

```bash
csm add work          # Creates profile and opens login
csm add test --no-login  # Creates profile without logging in yet
```

**`csm use <name>`**

Set the current profile. Plain `claude` will use this after shell init.

```bash
csm use work
```

**`csm list` or `csm ls`**

List all profiles. The `*` marks the current profile.

```bash
$ csm list
* work          user@work.com
  personal      user@personal.com
  testing       (not logged in)
```

**`csm current`**

Print the name of the current profile.

```bash
$ csm current
work
```

**`csm run [name] [-- args...]`**

Run Claude Code with a specific profile (default: current profile).

```bash
csm run work          # Uses work profile
csm run work -- -p    # Pass arguments to claude
csm run -- -p         # Uses current profile
```

**`csm env [name]`**

Print a shell export statement to temporarily set `CLAUDE_CONFIG_DIR` for a profile. Use with `eval`.

```bash
eval "$(csm env work)"
claude -p
```

**`csm rm <name> [--yes|-y]`**

Delete a profile and its login.

```bash
csm rm work           # Prompts for confirmation
csm rm work --yes     # Deletes without prompting
```

### Logins & Import

**`csm import <name> [--move] [--force]`**

Import an existing file-based login (e.g., from `~/.claude`) into a new profile.

```bash
csm import work                  # Copies login from ~/.claude to profile "work"
csm import work --move           # Also removes the source, so login exists only in the profile
csm import work --force          # Force import even if source is another csm profile
```

**Note:** On macOS, logins stored in the Keychain cannot be imported — use `csm add` instead.

### Shared Config

**`csm sync [name] [--repair=adopt|discard]`**

Detect and repair shared config drift (see [Shared Config](#shared-config)).

```bash
csm sync work                     # Report any drift in the work profile
csm sync --repair=discard         # Fix all profiles by discarding their drifted copies
csm sync work --repair=adopt      # Fix work profile by adopting its drifted copy as shared
```

**`csm share-history <from-profile>`**

Enable cross-profile session history sharing. All profiles will share transcripts, allowing `--resume` to access prior sessions from any account.

```bash
csm share-history work
```

**`csm adopt-config [--from <dir>] [--history] [--dry-run]`**

Share an existing config dir (default `~/.claude`) with every profile. Settings, commands, agents, and skills are linked into `shared/`; profiles' own copies are backed up.

```bash
csm adopt-config --dry-run        # Show what would change
csm adopt-config                  # Share settings, skills, agents, commands, CLAUDE.md
csm adopt-config --history        # Also pool transcripts and history.jsonl
```

### Shell & Setup

**`csm shell-init [shell]`**

Print a shell snippet for rc files. Detects your shell automatically.

```bash
csm shell-init              # Auto-detect bash/zsh/fish/pwsh
csm shell-init bash         # Explicitly output bash snippet
```

**`csm setup [bash|zsh|fish|pwsh] [--yes|-y]`**

Add the csm block to your shell rc (default: detected shell).

```bash
csm setup                   # Auto-detect and setup
csm setup zsh --yes         # Setup zsh without prompting
```

### Diagnostic & Admin

**`csm doctor [--json]`**

Diagnose install, shell wrapper, links and profiles.

```bash
csm doctor              # Human-readable output
csm doctor --json       # Machine-readable JSON
```

**`csm uninstall [--purge] [--yes|-y]`**

Remove every csm rc block; `--purge` also deletes `CSM_HOME` (all logins).

```bash
csm uninstall           # Remove rc blocks only
csm uninstall --purge   # Also delete all profiles and logins
csm uninstall --yes     # Don't prompt for confirmation
```

**`csm --version` or `csm -v`**

Print the installed version.

```bash
$ csm --version
0.1.0-beta.1
```

## Shared Config

Several settings are shared across all profiles via links from `~/.claude-sessions/shared`:

- `settings.json` — General preferences
- `CLAUDE.md` — Custom instructions
- `commands/` — Custom commands
- `agents/` — Custom agents
- `skills/` — Custom skills

Per-profile items (not shared):

- `.credentials.json` — Login credentials
- `.claude.json` — Account info and per-profile MCP servers
- `projects/` — Session transcripts (unless history sharing is enabled)
- `history.jsonl` — Prompt history (unless shared with `adopt-config --history`)
- `policy-limits.json` — Account usage limits

### Shared Config Drift

Claude Code can replace symlinks with regular files (e.g., when saving settings after permission approvals). This causes profiles to have different copies, losing the intent of sharing.

When drift is detected, `csm sync` reports it:

```bash
$ csm sync
work: settings.json drifted, agents drifted
personal: settings.json drifted — run "csm sync personal --repair=adopt|discard" to fix.
```

Fix drift with `--repair`:

```bash
# Discard work's copy (backed up) and relink to shared
csm sync work --repair=discard

# Adopt work's copy as the new shared version for all profiles
csm sync work --repair=adopt
```

### Windows Linking Behavior

On Windows, csm uses junctions instead of symlinks (no admin required). Junction behavior:

- **Symlink shorthand**: junctions point to directories; they act like symlinks but don't require Developer Mode.
- **Developer Mode**: With Developer Mode enabled (Settings > System > For developers), csm prefers true symlinks.
- **Hardlink fallback**: For files, when symlinks fail, csm falls back to hardlinks. If those fail too, an error is reported.
- **Stale detection**: If a hardlinked file is edited by Claude Code (which breaks the inode), `csm sync` detects it as "stale" and can refresh it.

See `csm doctor` to check link support on your system.

## Troubleshooting

### "I switched profile but `claude` still uses my main account"

1. Run `type claude` — it must report a shell function, not a command path. If it shows a path, the rc line is missing or your shell wasn't restarted: add it and run `exec $SHELL`.
2. Verify `csm shell-init` works: `csm shell-init` should output shell code, not "Unknown command".
3. Check that your profile is logged in: `csm list` shows the email for each profile. A profile showing `(not logged in)` never finished login — run `csm run <name>` and log in.

### "My skills/settings from ~/.claude don't show in a profile"

Profiles only see what is in `~/.claude-sessions/shared/`. By default, `csm import` copies only the login. Run `csm adopt-config` to link your original `~/.claude` config into every profile. Add `--history` to also pool transcripts and memory.

### "csm setup" or "csm shell-init" fails on PowerShell

If `Out-String | Invoke-Expression` fails (error about piping), try piping differently:

```powershell
csm shell-init pwsh | Out-String | Invoke-Expression
```

This converts the multi-line script to a single string before invoking it. The installers do this automatically; if you're running manually, use this form.

### Run `csm doctor` first

For any other issue, run `csm doctor`. It checks:

- Runtime version (Node 20+)
- Claude Code installation
- Shell wrapper integration
- Shell rc file blocks
- Profile directory permissions
- Linked shared config
- Profile login status

```bash
csm doctor      # Human-readable
csm doctor --json  # JSON for scripting
```

## Uninstall

### Linux & macOS

```bash
curl -fsSL https://raw.githubusercontent.com/ilomon10/csm/main/scripts/install.sh | sh -s -- --uninstall [--purge]
```

Add `--purge` to also delete all profiles and logins.

### Windows (PowerShell)

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/ilomon10/csm/main/scripts/install.ps1))) -Uninstall [-Purge]
```

### Using the installed binary

```bash
csm uninstall [--purge] [--yes]
```

## Caveats

### macOS Keychain Logins

On macOS, Claude Code stores logins in the system Keychain by default. `csm import` only works with file-based logins (the fallback when Keychain write fails). To import a Keychain login:

1. Use `csm add <name>` to log in fresh
2. Or run `csm import` after manually creating a file-based fallback (unset `CLAUDE_CONFIG_DIR`, log in once to create a `.credentials.json` file, then import)

### Importing Shares a Refresh Token

`csm import` copies a refresh token. If the source login (e.g., `~/.claude`) is later refreshed, the profile's copy becomes invalid. Solutions:

- Use `csm import --move` to remove the source after copying
- Log out from the source (`~/.claude`)
- Or accept that only one copy can stay logged in at a time

### History Sharing Pools Accounts

`csm share-history` moves a profile's `projects/` to `shared/`, visible to all profiles. If you later log out of one account, its transcripts remain accessible from another account. This is intentional but worth knowing.

### Windows PowerShell Notes

- `csm shell-init pwsh` generates PowerShell script; cmd.exe is not supported (install PowerShell 7 or run `csm run` directly)
- On Windows, csm uses junctions and hardlinks instead of symlinks (no admin required)

## Environment Variables

- `CSM_HOME` — Override the data directory (default: `~/.claude-sessions`)
- `CSM_CLAUDE_BIN` — Override the claude binary path (default: `claude` on PATH)
- `CSM_DEBUG=1` — Print stack traces on errors
- `NO_COLOR` — Disable colored output in `csm doctor`

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, testing, and coding style.

## Security

For security issues, see [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).

## Status

This is a **beta release** (v0.1.0-beta.1). The CLI and shell integration are stable, but the feature set may evolve. Please report bugs at [github.com/ilomon10/csm/issues](https://github.com/ilomon10/csm/issues).
