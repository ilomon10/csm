import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { join, win32 } from 'node:path';
import { CsmError } from './errors.js';
import { readJsonLenient } from './fsx.js';
import { buildShimCommandLine, resolveWindowsClaude } from './winquote.js';

const CLAUDE_BIN: string = process.env['CSM_CLAUDE_BIN'] ?? 'claude';

/**
 * Absolute path to cmd.exe. A bare 'cmd.exe' makes libuv search the cwd first on Windows, so a
 * cmd.exe planted in an untrusted repo would run. Prefer ComSpec only when it is an absolute cmd.exe.
 */
export const windowsCmdExe = (env: NodeJS.ProcessEnv = process.env): string => {
  const comSpec = env['ComSpec'] ?? env['COMSPEC'];
  if (comSpec !== undefined && win32.isAbsolute(comSpec) && /[\\/]cmd\.exe$/i.test(comSpec)) return comSpec;
  return win32.join(env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows', 'System32', 'cmd.exe');
};

const isCmdShim = (bin: string): boolean => /\.(cmd|bat)$/i.test(bin);

const isTruthy = (value: string | undefined): boolean =>
  value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
const isNonEmpty = (value: string | undefined): boolean => value !== undefined && value !== '';

interface OverrideWarning {
  readonly vars: readonly string[];
  readonly message: string;
  /** Boolean switches count only for 1/true/yes/on; token/URL vars are in effect whenever non-empty. */
  readonly isSet: (value: string | undefined) => boolean;
}

/**
 * Env vars that make claude bypass or override the logged-in profile, in roughly the
 * precedence order Claude Code applies them (see docs/claude-config.md).
 * Each one gets its own warning, since a user hunting a "wrong account" bug needs to know
 * exactly which var is in play, not just that "something" overrode the profile.
 */
const LOGIN_OVERRIDE_WARNINGS: readonly OverrideWarning[] = [
  {
    vars: ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'],
    message: 'is set; claude will route through that cloud provider instead of this subscription.',
    isSet: isTruthy,
  },
  {
    vars: ['ANTHROPIC_AUTH_TOKEN'],
    message: 'is set; it overrides the logged-in profile.',
    isSet: isNonEmpty,
  },
  {
    vars: ['ANTHROPIC_API_KEY'],
    message: 'is set; claude may use API billing instead of this subscription.',
    isSet: isNonEmpty,
  },
  {
    vars: ['CLAUDE_CODE_OAUTH_TOKEN'],
    message: 'is set; it overrides the logged-in profile.',
    isSet: isNonEmpty,
  },
  {
    vars: ['ANTHROPIC_PROFILE'],
    message: 'is set; claude may use that named profile instead of this one.',
    isSet: isNonEmpty,
  },
  {
    vars: ['ANTHROPIC_FEDERATION_RULE_ID'],
    message: 'is set; claude may route through that federation rule instead of this subscription.',
    isSet: isNonEmpty,
  },
  {
    vars: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL'],
    message: 'is set; requests (and this profile\'s login token) go to that endpoint instead of Anthropic.',
    isSet: isNonEmpty,
  },
];

const OVERRIDE_CHECKS: ReadonlyMap<string, OverrideWarning['isSet']> = new Map(
  LOGIN_OVERRIDE_WARNINGS.flatMap((w) => w.vars.map((v): [string, OverrideWarning['isSet']] => [v, w.isSet])),
);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The same overrides can also come from the profile's settings.json (`apiKeyHelper`, or an
 * `env` block Claude Code applies to itself), which the process env check can't see.
 */
const settingsOverrides = async (configDir: string): Promise<readonly string[]> => {
  const settings = await readJsonLenient(join(configDir, 'settings.json'));
  if (!isRecord(settings)) return [];
  const found: string[] = [];
  if (typeof settings['apiKeyHelper'] === 'string' && settings['apiKeyHelper'] !== '') found.push('apiKeyHelper');
  const env = settings['env'];
  if (isRecord(env)) {
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === 'string' && OVERRIDE_CHECKS.get(key)?.(value) === true) found.push(`env.${key}`);
    }
  }
  return found;
};

/** Human-readable descriptions (no "warning: " prefix) of every login override in effect; shared with `csm doctor`. */
export const detectLoginOverrides = async (
  env: NodeJS.ProcessEnv,
  configDir: string | undefined,
): Promise<readonly string[]> => {
  const found: string[] = [];
  for (const { vars, message, isSet } of LOGIN_OVERRIDE_WARNINGS) {
    const set = vars.filter((v) => isSet(env[v]));
    if (set.length > 0) found.push(`${set.join(' or ')} ${message}`);
  }
  if (configDir === undefined) return found;
  const fromSettings = await settingsOverrides(configDir);
  if (fromSettings.length > 0) {
    found.push(`${join(configDir, 'settings.json')} sets ${fromSettings.join(', ')}; it may override the logged-in profile.`);
  }
  return found;
};

const warnLoginOverrides = async (configDir: string | undefined): Promise<void> => {
  for (const line of await detectLoginOverrides(process.env, configDir)) process.stderr.write(`warning: ${line}\n`);
};

const spawnClaude = (bin: string, args: readonly string[], env: NodeJS.ProcessEnv) =>
  process.platform === 'win32' && isCmdShim(bin)
    ? spawn(windowsCmdExe(), ['/d', '/s', '/c', buildShimCommandLine(bin, args)], {
        stdio: 'inherit',
        env,
        windowsVerbatimArguments: true,
      })
    : spawn(bin, [...args], { stdio: 'inherit', env });

/**
 * Runs claude, optionally against an isolated config dir, and resolves with its exit code.
 * `configDir` is left undefined to run claude exactly as if csm weren't involved (no
 * CLAUDE_CONFIG_DIR override) — e.g. a fresh install with no profile yet.
 */
export const runClaude = async (configDir: string | undefined, args: readonly string[]): Promise<number> => {
  await warnLoginOverrides(configDir);

  const env = configDir !== undefined ? { ...process.env, CLAUDE_CONFIG_DIR: configDir } : { ...process.env };
  const bin = process.platform === 'win32' ? resolveWindowsClaude(CLAUDE_BIN, process.env) : CLAUDE_BIN;
  const child = spawnClaude(bin, args, env);

  return new Promise((resolve, reject) => {
    // Ctrl+C reaches the child directly (same process group); the wrapper must just not die first.
    const onSigint = (): void => undefined;
    const onSigterm = (): void => {
      child.kill('SIGTERM');
    };
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    const cleanup = (): void => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    };

    child.once('error', (err: NodeJS.ErrnoException) => {
      cleanup();
      reject(
        err.code === 'ENOENT'
          ? new CsmError(`"${CLAUDE_BIN}" not found on PATH. Install Claude Code or set CSM_CLAUDE_BIN.`)
          : err,
      );
    });

    child.once('exit', (code, signal) => {
      cleanup();
      if (code !== null) resolve(code);
      else resolve(signal !== null ? 128 + (constants.signals[signal] ?? 0) : 1);
    });
  });
};
