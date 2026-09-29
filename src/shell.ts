/** Shells csm can generate a `claude` wrapper snippet for. */
export type Shell = 'bash' | 'zsh' | 'fish' | 'pwsh';

export const SHELLS: readonly Shell[] = ['bash', 'zsh', 'fish', 'pwsh'];

/**
 * Picks a shell from $SHELL's basename. On Windows that is pwsh unless $SHELL names a POSIX shell
 * (Git Bash / MSYS set SHELL=/usr/bin/bash); elsewhere bash if nothing matches.
 */
export const detectShell = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Shell => {
  const base = ((env['SHELL'] ?? '').split(/[\\/]/).pop() ?? '').replace(/\.exe$/i, '');
  if (base === 'zsh' || base === 'fish' || base === 'bash') return base;
  return platform === 'win32' ? 'pwsh' : 'bash';
};

/**
 * Snippet that defines a `claude` function/wrapper routing every call through
 * `csm run`, so plain `claude` invocations honor the active profile (and get the
 * runner's login-override warnings) without the user having to remember `csm run`.
 * `CSM_SHELL_INIT=1` is exported so other csm commands can tell the wrapper is active.
 * `--from-wrapper` tells `csm run` it's being called from here (not typed directly), so it's
 * safe to fall back to an inherited CLAUDE_CONFIG_DIR or plain claude when there's no current
 * profile — see cli.ts's `run` handler for why plain `csm run` doesn't get those fallbacks.
 */
export const shellInit = (shell: Shell): string => {
  switch (shell) {
    case 'bash':
    case 'zsh':
      return 'export CSM_SHELL_INIT=1\nclaude() {\n  command csm run --from-wrapper -- "$@"\n}\n';
    case 'fish':
      return 'set -gx CSM_SHELL_INIT 1\nfunction claude\n    command csm run --from-wrapper -- $argv\nend\n';
    case 'pwsh':
      return "$env:CSM_SHELL_INIT = '1'\nfunction claude {\n    csm run --from-wrapper -- @args\n}\n";
  }
};
