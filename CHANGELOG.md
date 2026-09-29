# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0-beta.1] - 2026-09-29

First public prerelease.

### Added

- Profile management: `csm add`, `use`, `list`, `run`, `env`, `rm`, each profile with its own isolated `CLAUDE_CONFIG_DIR`.
- `csm import` to bring an existing `~/.claude` login into a profile, with rollback on failure.
- `csm sync` and `csm share-history` to share settings and conversation history between profiles.
- `csm adopt-config` to share `~/.claude` config and history with profiles.
- `csm shell-init` for bash, zsh, fish and PowerShell: a `claude` wrapper that follows the current profile.
- `csm setup`, `csm uninstall` (with `--purge`) and `csm doctor` for installing, removing and diagnosing shell integration.
- Installers: `scripts/install.sh` (Linux, macOS) and `scripts/install.ps1` (Windows) with SHA-256 verification.
- Prebuilt binaries for Linux, macOS and Windows attached to GitHub Releases.
- Cross-platform support (Linux, macOS, Windows): safe rename/delete helpers, junction and hardlink fallbacks,
  a profile lock, and safe `.cmd` shim quoting on Windows.
- Warnings when environment variables or `settings.json` (`apiKeyHelper`, API keys, base URL) would override the profile login.

[Unreleased]: https://github.com/ilomon10/csm/compare/v0.1.0-beta.1...HEAD
[0.1.0-beta.1]: https://github.com/ilomon10/csm/releases/tag/v0.1.0-beta.1
