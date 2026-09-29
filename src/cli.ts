#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { basename } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { runDoctor, formatReport } from './doctor.js';
import { CsmError, describeError } from './errors.js';
import { importProfile } from './import.js';
import { withLock } from './lock.js';
import { ROOT, SHARED_DIR, assertRootValid, isInsideProfilesDir, profileDir } from './paths.js';
import {
  adoptConfig,
  createProfile,
  enableHistorySharing,
  getCurrent,
  inspectShared,
  inspectSharedSources,
  linkShared,
  listProfiles,
  removeProfile,
  repairShared,
  resolveProfile,
  setCurrent,
} from './profiles.js';
import { runClaude } from './runner.js';
import { SHELLS, detectShell, shellInit, type Shell } from './shell.js';
import { hasBlock, preflightPurge, rcTargets, setup, sourceLine, uninstall } from './setup.js';
import { ISSUES_URL, VERSION } from './version.js';
import { exists } from './fsx.js';

type Handler = (args: readonly string[]) => Promise<number>;

const HELP = `csm — Claude Code session manager

Usage:
  csm add <name> [--no-login]        Create a profile and launch claude to log in
  csm import <name> [--move] [--force]
                                     Import an existing file-based login as a profile
                                     (--move removes it from the source afterwards)
  csm use <name>                     Set the default profile
  csm list | ls                      List profiles (* = current)
  csm current                        Print the current profile name
  csm run [name] [-- args...]        Run claude with a profile (default: current)
  csm env [name]                     Print shell export line (use with eval)
  csm sync [name] [--repair=adopt|discard]
                                     Report (or fix) shared-config drift for profile(s)
  csm share-history <from-profile>   Share session history/transcripts across profiles
                                     (pools every account's transcripts into one store)
  csm adopt-config [--from <dir>] [--history] [--dry-run]
                                     Share an existing config dir (default ~/.claude) with every
                                     profile: its settings.json, CLAUDE.md, commands/, agents/ and
                                     skills/ are linked into shared/; profiles' own copies are backed up
                                     (--history also pools projects/ + memory and history.jsonl)
  csm rm <name> [--yes|-y]           Delete a profile and its login (prompts unless --yes)
  csm shell-init [shell]             Print a shell snippet so plain \`claude\` uses the current profile
  csm setup [bash|zsh|fish|pwsh] [--yes|-y]
                                     Add the csm block to your shell rc (default: detected shell)
  csm uninstall [--purge] [--yes|-y] Remove every csm rc block; --purge also deletes CSM_HOME (all logins)
  csm doctor [--json] [--no-redact]  Diagnose install, shell wrapper, links and profiles
  csm --version | -v                 Print version

Shared config: files in ${SHARED_DIR}
  (settings.json, CLAUDE.md, commands/, agents/, skills/) are symlinked into every profile.
  Claude Code can replace a symlink with a regular file (e.g. after "don't ask again"
  permission approvals), causing drift. "csm sync" reports it; "--repair" fixes it.

Shell setup: run \`csm setup\` (or add one of these lines manually), then restart your shell:
  bash/zsh:  eval "$(csm shell-init)"
  fish:      csm shell-init fish | source
  pwsh:      csm shell-init pwsh | Out-String | Invoke-Expression

Env: CSM_HOME (data dir), CSM_CLAUDE_BIN (claude binary path), CSM_DEBUG=1 (print stack traces)
Report bugs: ${ISSUES_URL}
`;

const splitPassthrough = (
  args: readonly string[],
): { readonly own: readonly string[]; readonly passthrough: readonly string[] } => {
  const idx = args.indexOf('--');
  return idx === -1 ? { own: args, passthrough: [] } : { own: args.slice(0, idx), passthrough: args.slice(idx + 1) };
};

const requireName = (args: readonly string[], usage: string): string => {
  const [name] = args;
  if (name === undefined) throw new CsmError(`Usage: csm ${usage}`);
  return name;
};

// PowerShell expands `$` (and backticks) inside double-quoted strings, so a path is quoted with
// single quotes there instead, with the one special character single quotes still need escaped -
// a literal `'` - doubled per PowerShell's own rule.
const shellQuote = (value: string): string =>
  process.platform === 'win32' ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, `'\\''`)}'`;

const parseShell = (value: string): Shell => {
  if ((SHELLS as readonly string[]).includes(value)) return value as Shell;
  throw new CsmError(`Unknown shell "${value}". Supported: ${SHELLS.join(', ')}.`);
};

const isStale = (status: string): boolean => status === 'stale';

/** Cheap pre-flight check for `csm run`: one stderr line if the profile's shared config has drifted. */
const warnDrift = async (name: string): Promise<void> => {
  const report = await inspectShared(name);
  const drifted = report.filter((r) => r.status === 'drifted' || isStale(r.status)).map((r) => r.item);
  if (drifted.length > 0) {
    process.stderr.write(
      `warning: profile "${name}" has drifted shared config (${drifted.join(', ')}); run "csm sync ${name} --repair=adopt|discard" to fix.\n`,
    );
  }
};

const list: Handler = async () => {
  const profiles = await listProfiles();
  if (profiles.length === 0) {
    console.log('No profiles yet. Create one with: csm add <name>');
    return 0;
  }
  const width = Math.max(...profiles.map((p) => p.name.length));
  for (const p of profiles) {
    const marker = p.isCurrent ? '*' : ' ';
    console.log(`${marker} ${p.name.padEnd(width)}  ${p.email ?? '(not logged in)'}`);
  }
  return 0;
};

/** true = go ahead. Without --yes a TTY is prompted ([y/N], or the exact `word`); a non-TTY is refused. */
const confirm = async (action: string, yes: boolean, question: string, word?: string): Promise<boolean> => {
  if (yes) return true;
  if (process.stdin.isTTY !== true) throw new CsmError(`Refusing to ${action} without confirmation. Re-run with --yes.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Ctrl-D closes the interface without ever settling question(); resolve it as an empty answer.
  const closed = new Promise<string>((res) => rl.once('close', () => res('')));
  rl.once('SIGINT', () => rl.close());
  let answer: string;
  try {
    answer = await Promise.race([rl.question(question), closed]);
  } catch (err) {
    // Ctrl-C / Ctrl-D closes readline mid-question: that is "no", not a crash.
    if ((err as NodeJS.ErrnoException).code === 'ABORT_ERR' || (err as Error).name === 'AbortError') return false;
    throw err;
  } finally {
    rl.close();
  }
  return word !== undefined ? answer.trim() === word : /^y(es)?$/i.test(answer.trim());
};

/** True when the current shell's rc file(s) already hold the csm block (so the tip would be noise). */
const rcBlockPresent = async (): Promise<boolean> => {
  try {
    for (const file of await rcTargets(detectShell(process.env, process.platform))) {
      try {
        if (hasBlock(await readFile(file, 'utf8'))) return true;
      } catch {
        // Missing/unreadable rc file: keep looking.
      }
    }
  } catch {
    // Discovery failed: fall back to showing the tip.
  }
  return false;
};

const isYes = (a: string): boolean => a === '--yes' || a === '-y';

const remove: Handler = async (args) => {
  const yes = args.some(isYes);
  const name = requireName(
    args.filter((a) => !isYes(a)),
    'rm <name> [--yes|-y]',
  );
  if (!(await confirm(`delete profile "${name}"`, yes, `Delete profile "${name}" and its login? [y/N] `))) {
    console.log('Cancelled.');
    return 0;
  }
  await withLock(() => removeProfile(name));
  console.log(`Removed profile "${name}".`);
  return 0;
};

const version: Handler = async () => {
  process.stdout.write(`${VERSION}\n`);
  return 0;
};

const commands: Readonly<Record<string, Handler>> = {
  add: async (args) => {
    const flags = args.filter((a) => a.startsWith('--'));
    const unknown = flags.filter((f) => f !== '--no-login');
    if (unknown.length > 0) {
      throw new CsmError(`Unknown flag(s) for "csm add": ${unknown.join(', ')}. Supported: --no-login.`);
    }
    const positionals = args.filter((a) => !a.startsWith('--'));
    const usage = 'add <name> [--no-login]';
    if (positionals.length > 1) throw new CsmError(`Usage: csm ${usage}`);
    const name = requireName(positionals, usage);
    // The lock covers only the mutation; it is released before claude runs (a login can take minutes).
    const dir = await withLock(async () => {
      const created = await createProfile(name);
      console.log(`Created profile "${name}" at ${created}`);
      if ((await getCurrent()) === null) {
        await setCurrent(name);
        console.log(`"${name}" is now the current profile.`);
      }
      return created;
    });
    if (flags.includes('--no-login')) return 0;
    console.log('Launching claude — complete the login, then type /exit.');
    return runClaude(dir, []);
  },

  import: async (args) => {
    const flags = args.filter((a) => a.startsWith('--'));
    const unknown = flags.filter((f) => f !== '--move' && f !== '--force');
    if (unknown.length > 0) {
      throw new CsmError(`Unknown flag(s) for "csm import": ${unknown.join(', ')}. Supported: --move, --force.`);
    }
    const positionals = args.filter((a) => !a.startsWith('--'));
    const usage = 'import <name> [--move] [--force]';
    if (positionals.length > 1) throw new CsmError(`Usage: csm ${usage}`);
    const name = requireName(positionals, usage);
    const { dir, source, moved } = await withLock(() =>
      importProfile(name, { move: flags.includes('--move'), force: flags.includes('--force') }),
    );
    console.log(`Imported profile "${name}" at ${dir}`);
    if (moved) {
      console.log(`Moved the login out of ${source}; it now lives only in "${name}".`);
    } else {
      process.stderr.write(
        `note: ${source} still holds the same login. When either copy refreshes its token the other may be logged out; delete that file (or re-import with --move) to keep the login in one place.\n`,
      );
    }
    await withLock(async () => {
      if ((await getCurrent()) === null) {
        await setCurrent(name);
        console.log(`"${name}" is now the current profile.`);
      }
    });
    return 0;
  },

  use: async (args) => {
    const name = requireName(args, 'use <name>');
    await withLock(() => setCurrent(name));
    console.log(`Switched to "${name}".`);
    if (process.env['CSM_SHELL_INIT'] !== '1' && !(await rcBlockPresent())) {
      console.log('Tip: add `eval "$(csm shell-init)"` to your shell rc so plain `claude` uses the active profile.');
    }
    return 0;
  },

  list,
  ls: list,

  current: async () => {
    const current = await getCurrent();
    if (current === null) throw new CsmError('No current profile.');
    console.log(current);
    return 0;
  },

  run: async (args) => {
    // Internal flag set only by the shell-init wrapper (src/shell.ts), never typed directly.
    // It's what lets the fallbacks below (inherited CLAUDE_CONFIG_DIR, plain claude with no
    // profile) apply to plain `claude` calls without also silently overriding an explicit
    // `csm run` after `csm use` - see runner.ts/shell.ts for the full rationale.
    const fromWrapper = args[0] === '--from-wrapper';
    const { own, passthrough } = splitPassthrough(fromWrapper ? args.slice(1) : args);
    if (own.length > 1) throw new CsmError('Usage: csm run [name] [-- claude args...]');
    const explicitName = own[0];

    if (explicitName === undefined && fromWrapper) {
      const envConfigDir = process.env['CLAUDE_CONFIG_DIR'];
      // Only an inherited CLAUDE_CONFIG_DIR from *outside* csm's profile store wins outright; a
      // stale csm-set value (e.g. from an earlier `eval "$(csm env)"`) must follow `csm use`.
      if (envConfigDir !== undefined && envConfigDir !== '' && !isInsideProfilesDir(envConfigDir)) {
        return runClaude(envConfigDir, passthrough);
      }
      const current = await getCurrent();
      // No profile selected yet: behave like plain `claude` instead of erroring.
      if (current === null) return runClaude(undefined, passthrough);
      await warnDrift(current);
      return runClaude(profileDir(current), passthrough);
    }

    const name = await resolveProfile(explicitName);
    await warnDrift(name);
    return runClaude(profileDir(name), passthrough);
  },

  env: async (args) => {
    const dir = profileDir(await resolveProfile(args[0]));
    console.log(
      process.platform === 'win32'
        ? `$env:CLAUDE_CONFIG_DIR = ${shellQuote(dir)}`
        : `export CLAUDE_CONFIG_DIR=${shellQuote(dir)}`,
    );
    return 0;
  },

  sync: (args) => withLock(async () => {
    const repairArg = args.find((a) => a.startsWith('--repair'));
    const name = args.find((a) => !a.startsWith('--'));
    const usage = 'Usage: csm sync [name] [--repair=adopt|discard]';
    if (args.filter((a) => !a.startsWith('--')).length > 1) throw new CsmError(usage);

    if (repairArg !== undefined) {
      const mode = repairArg.slice('--repair='.length);
      if (repairArg === '--repair' || (mode !== 'adopt' && mode !== 'discard')) {
        throw new CsmError(`${usage} (--repair needs a value: --repair=adopt or --repair=discard)`);
      }
      // "adopt" promotes one profile's drifted copy to become the new shared item for
      // everyone else, so it only makes sense pointed at a single, explicitly named profile.
      if (mode === 'adopt' && name === undefined) {
        throw new CsmError('csm sync --repair=adopt requires an explicit profile name.');
      }
      const targets = name !== undefined ? [await resolveProfile(name)] : (await listProfiles()).map((p) => p.name);
      for (const target of targets) {
        const actions = await repairShared(target, mode);
        console.log(
          `${target}: ${actions.length > 0 ? actions.map((a) => `${a.item} ${a.action}`).join('; ') : 'nothing to repair'}`,
        );
      }
      return 0;
    }

    const targets = name !== undefined ? [await resolveProfile(name)] : (await listProfiles()).map((p) => p.name);
    for (const target of targets) {
      const report = await inspectShared(target);
      const problems = report.filter((r) => r.status === 'drifted' || r.status === 'foreign' || isStale(r.status));
      const reported = problems.length > 0;
      if (reported) {
        console.error(
          `${target}: ${problems.map((p) => `${p.item} ${p.status}`).join(', ')} — run "csm sync ${target} --repair=adopt|discard" to fix.`,
        );
      }
      const linked = await linkShared(target);
      if (linked.length > 0) console.log(`${target}: linked ${linked.join(', ')}`);
      else if (!reported) console.log(`${target}: up to date`);
    }
    const staleSources = (await inspectSharedSources()).filter((s) => isStale(s.status)).map((s) => s.item);
    if (staleSources.length > 0) {
      console.error(`shared/${staleSources.join(', shared/')}: stale copy of the adopted config — run "csm sync --repair=discard" to refresh.`);
    }
    return 0;
  }),

  'share-history': async (args) => {
    const name = requireName(args, 'share-history <from-profile>');
    await withLock(() => enableHistorySharing(name));
    console.log(`Shared history enabled from "${name}". Profiles without their own history are now linked to it.`);
    return 0;
  },

  'adopt-config': async (args) => {
    const usage = 'Usage: csm adopt-config [--from <dir>] [--history] [--dry-run]';
    let from: string | undefined;
    let history = false;
    let dryRun = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] as string;
      if (arg === '--history') history = true;
      else if (arg === '--dry-run') dryRun = true;
      else if (arg === '--from') {
        from = args[++i];
        if (from === undefined) throw new CsmError(`${usage} (--from needs a directory)`);
      } else if (arg.startsWith('--from=')) from = arg.slice('--from='.length);
      else throw new CsmError(usage);
    }
    const doAdopt = () => adoptConfig({ ...(from !== undefined && { from }), history, dryRun });
    const result = await (dryRun ? doAdopt() : withLock(doAdopt));
    console.log(`${dryRun ? '[dry run] ' : ''}Adopting config from ${result.source}`);
    for (const { item, action } of result.shared) console.log(`  shared/${item}: ${action}`);
    for (const { name, actions } of result.profiles) {
      console.log(`${name}: ${actions.length > 0 ? actions.join('; ') : 'up to date'}`);
    }
    if (result.shared.some((s) => s.item === 'skills')) {
      process.stderr.write(
        'note: skills/ (including claude.ai-synced skills in skills/synced) is now shared by every account. Plugins are not shared; reinstall them per profile with /plugin.\n',
      );
    }
    return 0;
  },

  rm: remove,
  remove,

  'shell-init': async (args) => {
    const shell = args[0] !== undefined ? parseShell(args[0]) : detectShell(process.env, process.platform);
    process.stdout.write(shellInit(shell));
    return 0;
  },

  setup: async (args) => {
    const usage = 'Usage: csm setup [bash|zsh|fish|pwsh] [--yes|-y]';
    const yes = args.some(isYes);
    const rest = args.filter((a) => !isYes(a));
    if (rest.length > 1 || rest.some((a) => a.startsWith('-'))) throw new CsmError(usage);
    const shell = rest[0] !== undefined ? parseShell(rest[0]) : detectShell(process.env, process.platform);
    const files = await rcTargets(shell);
    if (!(await confirm('modify your shell rc', yes, `Add the csm block to ${files.join(', ')}? [y/N] `))) {
      console.log('Cancelled.');
      return 0;
    }
    // No lock (and no ROOT created just to hold it) when there is no data dir to protect.
    const results = await ((await exists(ROOT)) ? withLock(() => setup(shell)) : setup(shell));
    for (const r of results) {
      const note = r.action === 'unchanged' ? 'already set up' : r.action;
      console.log(`${r.file}: ${note}${r.backup !== undefined ? ` (backup: ${r.backup})` : ''}`);
    }
    console.log(`restart your shell or run: ${sourceLine(shell)}`);
    return 0;
  },

  uninstall: async (args) => {
    const usage = 'Usage: csm uninstall [--purge] [--yes|-y]';
    if (args.some((a) => !isYes(a) && a !== '--purge')) throw new CsmError(usage);
    const yes = args.some(isYes);
    const purge = args.includes('--purge');
    // Validate (and list what would go) before asking, so a refused purge never even prompts.
    const entries = purge ? await preflightPurge() : null;
    const listing = entries !== null && entries.length > 0 ? `Contents: ${entries.join(', ')}\n` : '';
    const question = purge
      ? `This deletes ${ROOT}, including every profile login (they cannot be recovered; ~/.claude is not touched).\n${listing}Type "purge" to continue: `
      : 'Remove the csm block from your shell rc files? [y/N] ';
    if (!(await confirm(purge ? `purge ${ROOT}` : 'modify your shell rc', yes, question, purge ? 'purge' : undefined))) {
      console.log('Cancelled.');
      return 0;
    }
    const hadData = purge && (await exists(ROOT));
    // No lock (and no ROOT created just to hold it) when there is no data dir to protect.
    const run = () => uninstall({ purge });
    const results = await ((await exists(ROOT)) ? withLock(run) : run());
    for (const r of results) {
      if (r.action !== 'none') console.log(`${r.file}: ${r.action}${r.backup !== undefined ? ` (backup: ${r.backup})` : ''}`);
    }
    if (results.every((r) => r.action === 'none')) console.log('No csm rc blocks found.');
    if (hadData) console.log(`Deleted ${ROOT}`);
    const compiled = !/^node(\.exe)?$/i.test(basename(process.execPath));
    console.log(
      compiled
        ? `Remove the binary: ${process.execPath} (or re-run the installer with --uninstall)`
        : 'To remove the package: npm rm -g claude-session-manager',
    );
    return 0;
  },

  doctor: async (args) => {
    const usage = 'Usage: csm doctor [--json] [--no-redact]';
    if (args.some((a) => a !== '--json' && a !== '--no-redact')) throw new CsmError(usage);
    const report = await runDoctor({ redact: !args.includes('--no-redact') });
    if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else {
      const ascii = process.stdout.isTTY !== true || (process.env['NO_COLOR'] ?? '') !== '';
      process.stdout.write(formatReport(report, ascii));
    }
    return report.ok ? 0 : 1;
  },

  version,
  '--version': version,
  '-v': version,

  help: async () => {
    process.stdout.write(HELP);
    return 0;
  },
};

const main = async (): Promise<number> => {
  const [cmd = 'help', ...rest] = process.argv.slice(2);
  // Test hook: exercises the unexpected-error path (exit 2, issues URL) end to end.
  // Only honored together with CSM_DEBUG so a stray env var can never break a real run.
  const testThrow = process.env['CSM_TEST_THROW'];
  if (testThrow !== undefined && testThrow !== '' && (process.env['CSM_DEBUG'] ?? '') !== '') throw new Error(testThrow);
  const noRootCheck = ['help', '-h', '--help', 'version', '--version', '-v'].includes(cmd);
  if (!noRootCheck) assertRootValid();
  const handler = Object.hasOwn(commands, cmd === '-h' || cmd === '--help' ? 'help' : cmd)
    ? commands[cmd === '-h' || cmd === '--help' ? 'help' : cmd]
    : undefined;
  if (handler === undefined) throw new CsmError(`Unknown command "${cmd}". Run "csm help".`);
  return handler(rest);
};

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const { message, exitCode } = describeError(err);
    process.stderr.write(`csm: ${message}\n`);
    if (process.env['CSM_DEBUG'] === '1') process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = exitCode;
  },
);
