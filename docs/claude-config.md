# Claude Code Config Facts

This document describes the Claude Code configuration facts that csm depends on for correct behavior.

## Overview

Claude Code stores login credentials, account information, and settings in a configuration directory. By default, this is `~/.claude`, but it can be overridden with the `CLAUDE_CONFIG_DIR` environment variable. Each csm profile uses a separate `CLAUDE_CONFIG_DIR` to isolate logins.

## 1. Credentials Storage

**Linux / Windows**: `$CLAUDE_CONFIG_DIR/.credentials.json` (file permissions 0600)

**macOS**: System Keychain (service `Claude Code-credentials`; when `CLAUDE_CONFIG_DIR` is set, the service becomes `Claude Code-credentials-<sha256(dir)[:8]>` for per-profile isolation). A file-based fallback `.credentials.json` is created only when Keychain write fails.

By default, `CLAUDE_CONFIG_DIR` is `~/.claude`, so credentials go to `~/.claude/.credentials.json` (or Keychain on macOS).

## 2. Account Info

**`.claude.json`** (default location: `~/.claude.json`, i.e., outside `~/.claude`)

When `CLAUDE_CONFIG_DIR` is set, it goes to `$CLAUDE_CONFIG_DIR/.claude.json`.

Contains:
- `oauthAccount.emailAddress` — Logged-in email
- User-scoped MCP server configs
- Per-project trust settings

**Must remain per-profile** — each profile needs its own `.claude.json` with the correct email and MCP servers.

## 3. Shared vs Per-Account Items

**Shared items** (by design, can be symlinked):
- `settings.json` — General preferences and configurations
- `CLAUDE.md` — Custom instructions
- `commands/` — Custom commands
- `agents/` — Custom agents
- `skills/` — Custom skills (including synced from claude.ai)

**Per-account items** (must not be shared):
- `.claude.json` — Account email and MCP servers
- `.credentials.json` — Login refresh token
- `remote-settings.json` — Account-specific remote settings
- `policy-limits.json` — Account usage limits
- `backups/` — Backup files
- `history.jsonl` — Prompt history
- `shell-snapshots/` — Shell execution snapshots

**Conditional sharing**:
- `projects/` — Session transcripts keyed by path. Per-profile by default; sharing is opt-in via `csm share-history`.
- `plugins/` — Per-account install state; don't share by default.

**Deprecated** (not currently written):
- `todos/`
- `statsig/`
- `logs/`

## 4. Symlink Clobbering

Claude Code persists `settings.json` via atomic write+rename. When a symlink is the target of this operation, it is replaced with a regular file. This happens after permission approvals (e.g., "don't ask again" on a `functions` call) or when the user manually edits settings.

**Impact**: If all profiles symlink `settings.json` to `shared/settings.json`, but one profile is edited, that profile's symlink becomes a regular copy with different content. Other profiles have different settings, breaking the sharing intent.

**csm's approach**: `csm sync` detects such "drift" and repairs it via `--repair=adopt` (promote one profile's copy as shared) or `--repair=discard` (discard it and re-link).

## 5. Login Override Precedence

The following environment variables and settings can override the logged-in profile (high to low precedence):

**Environment Variables**:
1. `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY` — Route through a cloud provider
2. `ANTHROPIC_AUTH_TOKEN` — Override with an explicit token
3. `ANTHROPIC_API_KEY` — Use API billing instead of subscription
4. `apiKeyHelper` (setting in `settings.json`) — A custom API key helper command
5. `CLAUDE_CODE_OAUTH_TOKEN` — Override with a specific OAuth token
6. `ANTHROPIC_PROFILE`, `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID` — Named profiles or federation (stored in `~/.config/anthropic`, outside the config dir)
7. `ANTHROPIC_BASE_URL`, `ANTHROPIC_BEDROCK_BASE_URL`, `ANTHROPIC_VERTEX_BASE_URL` — Custom endpoints (warning: sends auth there)

The profile's `/login` OAuth token (stored in `.credentials.json`) is the final fallback.

**csm's approach**: `csm run` warns when any of these overrides are set, so the user is aware their profile login is being bypassed.

## 6. Default Login Import

When importing a login (via `csm import`), csm copies:
- `~/.claude.json` → `<profile>/.claude.json`
- `~/.claude/.credentials.json` → `<profile>/.credentials.json` (preserving 0600 permissions)

csm **does not** copy:
- `plugins/` — Install per-profile
- `projects/` — Transcripts are profile-specific
- `history.jsonl` — Use `csm adopt-config --history` to pool histories
- `remote-settings.json` — Account-specific; regenerated on login
- `policy-limits.json` — Account-specific; regenerated on login

On macOS with Keychain-only logins (no file fallback), `csm import` cannot proceed — users must run `csm add <name>` to log in fresh instead.

## See Also

- csm README: [Shared Config](../README.md#shared-config) section
- csm CLI source: `src/runner.ts` (login override detection)
- csm profiles source: `src/profiles.ts` (shared config linking and drift detection)
