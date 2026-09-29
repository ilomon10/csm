import { accessSync } from 'node:fs';
import { win32 } from 'node:path';
import { CsmError } from './errors.js';

/**
 * Pure Windows command-line helpers for runner.ts, kept separate (and platform-independent) so
 * they can be unit-tested on any OS. Algorithm per https://qntm.org/cmd, as used by cross-spawn.
 */

// cmd.exe metacharacters, including the ones a .cmd/.bat shim's own `%*` re-parse cares about.
const META_RE = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Escapes the command (the resolved claude/shim path) for use unquoted inside a cmd.exe command
 * line: each metacharacter is neutralized with `^`, which also escapes spaces, so the path needs
 * no quoting of its own.
 */
export const escapeCmdCommand = (command: string): string => command.replace(META_RE, '^$1');

/**
 * Escapes one argument for a cmd.exe command line that invokes a .cmd/.bat shim. cmd.exe parses
 * the line once, then the shim parses `%*` again with the same metacharacter rules, so the
 * `^`-escaping is applied twice ("BatBadBut"); escaping once would let `%VAR%`, `&` and friends
 * through on the second parse.
 */
export const escapeCmdShimArg = (arg: string): string => {
  if (/[\r\n]/.test(arg)) {
    throw new CsmError('Arguments containing newlines cannot be passed through a .cmd/.bat claude shim on Windows.');
  }
  // A run of backslashes right before a `"` (or at the end of the string) must be doubled,
  // since the quote we wrap the whole argument in would otherwise escape them away.
  let escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  escaped = `"${escaped}"`;
  escaped = escaped.replace(META_RE, '^$1');
  return escaped.replace(META_RE, '^$1');
};

/** The full `/c` payload for `cmd.exe /d /s /c "<this>"` (spawned with windowsVerbatimArguments). */
export const buildShimCommandLine = (shim: string, args: readonly string[]): string =>
  `"${[escapeCmdCommand(shim), ...args.map(escapeCmdShimArg)].join(' ')}"`;

const canAccess = (path: string): boolean => {
  try {
    accessSync(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Resolves the executable to spawn on Windows, where we can't use `shell: true` (it would pass
 * passthrough args unquoted through cmd.exe). A bare command name isn't PATH/PATHEXT-resolved by
 * `spawn` the way a shell would, so we search for it ourselves, preferring claude.exe over a
 * .cmd/.bat shim. Relative PATH entries are skipped, and a miss is an error rather than a bare
 * fallback, so a `claude.exe` in the current directory is never picked up by accident. A
 * path/filename the caller already gave us (CSM_CLAUDE_BIN) is trusted as-is.
 */
export const resolveWindowsClaude = (
  bin: string,
  env: NodeJS.ProcessEnv,
  access: (path: string) => boolean = canAccess,
): string => {
  if (/[\\/]/.test(bin) || /\.[^\\/.]+$/.test(bin)) return bin;

  const pathExts = (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const orderedExts = ['.EXE', ...pathExts.filter((ext) => ext.toUpperCase() !== '.EXE')];
  const dirs = (env['PATH'] ?? env['Path'] ?? '').split(';').filter((dir) => dir !== '' && win32.isAbsolute(dir));

  for (const dir of dirs) {
    for (const ext of orderedExts) {
      const candidate = win32.join(dir, bin + ext);
      if (access(candidate)) return candidate;
    }
  }
  throw new CsmError(`"${bin}" not found on PATH. Install Claude Code or set CSM_CLAUDE_BIN.`);
};
