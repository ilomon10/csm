# Security Policy

## Supported versions

csm is in beta. Only the latest release (including prereleases) receives security fixes.

| Version | Supported |
| ------- | --------- |
| latest 0.x release | yes |
| older releases | no |

## Reporting a vulnerability

Please do not open a public issue. Use GitHub Security Advisories:
go to the repository's **Security** tab and choose **Report a vulnerability**
(https://github.com/ilomon10/csm/security/advisories/new).

Include the csm version (`csm --version`), your OS and shell, and steps to reproduce. You can expect an
acknowledgement within a few days; this is a volunteer project, so fixes are best effort.

## Scope

In scope:

- Handling of credential files (`.credentials.json`, `~/.claude.json`, tokens, `settings.json` overrides):
  leaks, wrong permissions, following symlinks outside a profile, unsafe deletes or overwrites.
- Installer integrity: `scripts/install.sh` / `scripts/install.ps1`, checksum verification (`SHA256SUMS`),
  PATH and shell rc edits, and release artifacts.
- Command injection through profile names, paths or arguments (including Windows `.cmd` shim quoting).

Out of scope: vulnerabilities in Claude Code itself or in Anthropic services (report those to Anthropic),
and issues that require an attacker who already controls your user account.
