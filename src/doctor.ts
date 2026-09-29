import { randomBytes } from 'node:crypto';
import { access, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { CsmError } from './errors.js';
import { exists, readJson, sameDevice } from './fsx.js';
import { isLockStale, readLock } from './lock.js';
import { LOCK_FILE, ROOT, STATE_FILE, profileDir } from './paths.js';
import { getAdoptedFrom, getCurrent, inspectShared, inspectSharedSources, listProfiles, probeLinkSupport } from './profiles.js';
import { detectLoginOverrides } from './runner.js';
import { detectShell } from './shell.js';
import { hasBlock, rcTargets } from './setup.js';
import { VERSION } from './version.js';
import { resolveWindowsClaude } from './winquote.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';
export interface DoctorCheck {
  readonly id: string;
  readonly status: CheckStatus;
  readonly message: string;
  readonly hint?: string;
}
export interface DoctorReport {
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  readonly runtime: string;
  readonly checks: readonly DoctorCheck[];
  readonly ok: boolean;
}

const check = (id: string, status: CheckStatus, message: string, hint?: string): DoctorCheck => ({
  id,
  status,
  message,
  ...(hint !== undefined && { hint }),
});

const isExecutable = async (path: string): Promise<boolean> => {
  try {
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

/** First runnable `name` on PATH (POSIX exec bit; win32 PATHEXT), or null. */
const findOnPath = async (name: string): Promise<string | null> => {
  const exts = process.platform === 'win32' ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env['PATH'] ?? process.env['Path'] ?? '').split(delimiter)) {
    if (dir === '' || !isAbsolute(dir)) continue;
    for (const ext of exts) if (await isExecutable(join(dir, name + ext))) return join(dir, name + ext);
  }
  return null;
};

const checkClaude = async (): Promise<DoctorCheck> => {
  const bin = process.env['CSM_CLAUDE_BIN'] ?? 'claude';
  let found: string | null = null;
  if (/[\\/]/.test(bin)) found = (await isExecutable(bin)) ? bin : null;
  else if (process.platform === 'win32') {
    try {
      found = resolveWindowsClaude(bin, process.env);
    } catch {
      found = null;
    }
  } else found = await findOnPath(bin);
  return found !== null
    ? check('claude', 'ok', `claude found: ${found}`)
    : check('claude', 'fail', `"${bin}" not found on PATH`, 'Install Claude Code, or set CSM_CLAUDE_BIN to its path.');
};

const checkRcBlock = async (): Promise<DoctorCheck> => {
  const shell = detectShell(process.env, process.platform);
  const files = await rcTargets(shell);
  for (const file of files) {
    try {
      if (hasBlock(await readFile(file, 'utf8'))) return check('rc-block', 'ok', `csm block present in ${file}`);
    } catch {
      // Missing/unreadable rc file: keep looking.
    }
  }
  return check('rc-block', 'fail', `no csm block in ${files.join(', ')} (${shell})`, 'csm setup');
};

const checkHome = async (): Promise<DoctorCheck> => {
  if (!(await exists(ROOT))) return check('csm-home', 'warn', `${ROOT} not created yet`, 'It is created by "csm add <name>".');
  const probe = join(ROOT, `.doctor-probe-${randomBytes(3).toString('hex')}`);
  try {
    await writeFile(probe, '', { flag: 'wx' });
    await unlink(probe);
    return check('csm-home', 'ok', `${ROOT} is writable`);
  } catch (err) {
    return check('csm-home', 'fail', `${ROOT} is not writable (${(err as NodeJS.ErrnoException).code ?? 'error'})`, 'Fix its permissions, or set CSM_HOME elsewhere.');
  }
};

const checkLock = async (): Promise<DoctorCheck> => {
  let mtimeMs = 0;
  try {
    mtimeMs = (await stat(LOCK_FILE)).mtimeMs;
  } catch {
    return check('lock', 'ok', 'no csm command is running');
  }
  const info = await readLock();
  if (info === null) return check('lock', 'warn', 'lock file exists but cannot be parsed', `Delete ${LOCK_FILE} if no csm command is running.`);
  // Only the subcommand name is shown: older locks stored the full argv, which may hold private names.
  const sub = info.cmd.split(' ')[0] ?? '';
  return isLockStale(info, mtimeMs)
    ? check('lock', 'warn', `stale lock from pid ${info.pid}`, `Delete ${LOCK_FILE}`)
    : check('lock', 'ok', `held by pid ${info.pid} (csm ${sub})`);
};

const checkState = async (): Promise<DoctorCheck> => {
  try {
    await readJson(STATE_FILE);
    return check('state', 'ok', 'state.json is readable');
  } catch (err) {
    if (!(err instanceof CsmError)) throw err;
    return check('state', 'fail', err.message, `Fix or delete ${STATE_FILE}`);
  }
};

const checkLinks = async (): Promise<DoctorCheck> => {
  // Probe in the temp dir, not CSM_HOME: doctor never writes into the data dir beyond its writable check.
  const probe = await probeLinkSupport(tmpdir());
  if (probe.fileMode === null || probe.dirMode === null) {
    const what = probe.fileMode === null ? 'file' : 'directory';
    return check(
      'links',
      'fail',
      `cannot create ${what} links in ${probe.dir}`,
      process.platform === 'win32'
        ? 'Enable Developer Mode (Settings > System > For developers), or put CSM_HOME on a local NTFS drive, on the same drive as ~/.claude.'
        : 'Put CSM_HOME on a file system that supports symlinks.',
    );
  }
  if (probe.fileMode === 'hardlink') {
    const adopted = await getAdoptedFrom();
    if (adopted !== null && !(await sameDevice(ROOT, adopted))) {
      return check('links', 'fail', `file links use hardlinks but CSM_HOME and ${adopted} are on different drives`, `Move CSM_HOME to the same drive as ${adopted}, or enable Developer Mode.`);
    }
    return check('links', 'warn', 'file links use hardlinks; Claude Code rewrites may drift, "csm sync" repairs', 'Enable Developer Mode for symlinks.');
  }
  return check('links', 'ok', `links work (files: ${probe.fileMode}, dirs: ${probe.dirMode})`);
};

const checkShared = async (): Promise<DoctorCheck> => {
  const stale = (await inspectSharedSources()).filter((s) => s.status === 'stale').map((s) => s.item);
  return stale.length > 0
    ? check('shared', 'fail', `stale shared copy: ${stale.join(', ')}`, 'csm sync --repair=discard')
    : check('shared', 'ok', 'shared config sources are up to date');
};

const checkProfile = async (name: string, email: string | null): Promise<DoctorCheck> => {
  const id = `profile:${name}`;
  const items = await inspectShared(name);
  const bad = items.filter((i) => i.status === 'drifted' || i.status === 'foreign' || i.status === 'stale');
  if (bad.length > 0) {
    return check(id, 'fail', `${bad.map((b) => `${b.item} ${b.status}`).join(', ')}`, `csm sync ${name} --repair=adopt|discard`);
  }
  if (email === null) return check(id, 'warn', 'not logged in', `csm run ${name}`);
  const missing = items.filter((i) => i.status === 'missing').map((i) => i.item);
  if (missing.length > 0) return check(id, 'warn', `${email}; unlinked: ${missing.join(', ')}`, 'csm sync');
  return check(id, 'ok', email);
};

const checkOverrides = async (): Promise<DoctorCheck> => {
  const current = await getCurrent();
  const found = await detectLoginOverrides(process.env, current !== null ? profileDir(current) : undefined);
  return found.length > 0
    ? check('overrides', 'warn', found.join(' '), 'Unset them (or clear them from settings.json) for csm profiles to take effect.')
    : check('overrides', 'ok', 'no login overrides in the environment');
};

/** `alice@example.com` -> `a***@example.com`. */
export const redactEmails = (text: string): string =>
  text.replace(/([^\s@,;()<>"']+)@([^\s@,;()<>"']+)/g, (_m, local: string, domain: string) => `${local.slice(0, 1)}***@${domain}`);

const redactCheck = (c: DoctorCheck): DoctorCheck => ({
  ...c,
  message: redactEmails(c.message),
  ...(c.hint !== undefined && { hint: redactEmails(c.hint) }),
});

/** Runs one check; an unexpected throw becomes a failed check so the rest still run. */
const guard = async (id: string, fn: () => Promise<DoctorCheck | readonly DoctorCheck[]>): Promise<readonly DoctorCheck[]> => {
  try {
    const r = await fn();
    return Array.isArray(r) ? (r as readonly DoctorCheck[]) : [r as DoctorCheck];
  } catch (err) {
    return [check(id, 'fail', err instanceof Error ? err.message : String(err))];
  }
};

/** Read-only except for its own create+unlink probes (CSM_HOME writable check, temp-dir link probe); never takes the lock. */
export const runDoctor = async (opts: { redact?: boolean } = {}): Promise<DoctorReport> => {
  const bun = process.versions['bun'];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const checks: DoctorCheck[] = [];
  const run = async (id: string, fn: () => Promise<DoctorCheck | readonly DoctorCheck[]>): Promise<void> => {
    checks.push(...(await guard(id, fn)));
  };

  await run('runtime', async () =>
    bun !== undefined
      ? check('runtime', 'ok', `bundled (bun ${bun})`)
      : nodeMajor >= 20
        ? check('runtime', 'ok', `node ${process.versions.node}`)
        : check('runtime', 'fail', `node ${process.versions.node} is too old`, 'Install Node 20 or newer.'),
  );
  await run('claude', checkClaude);
  await run('csm-on-path', async () => {
    const found = await findOnPath('csm');
    return found !== null
      ? check('csm-on-path', 'ok', `csm found: ${found}`)
      : check('csm-on-path', 'warn', 'csm is not on PATH', 'Add its install directory to PATH.');
  });
  await run('wrapper', async () =>
    process.env['CSM_SHELL_INIT'] === '1'
      ? check('wrapper', 'ok', 'shell wrapper active')
      : check('wrapper', 'warn', 'shell wrapper not active in this shell', 'restart your shell (after "csm setup")'),
  );
  await run('rc-block', checkRcBlock);
  await run('csm-home', checkHome);
  await run('lock', checkLock);
  await run('state', checkState);
  await run('links', checkLinks);
  await run('shared', checkShared);
  if (await exists(ROOT)) {
    await run('profiles', async () => {
      const profiles = await listProfiles({ create: false });
      const out: DoctorCheck[] = [];
      for (const p of profiles) out.push(...(await guard(`profile:${p.name}`, () => checkProfile(p.name, p.email))));
      return out;
    });
  }
  await run('overrides', checkOverrides);

  return {
    version: VERSION,
    platform: process.platform,
    arch: process.arch,
    runtime: bun !== undefined ? `bun ${bun}` : `node ${process.versions.node}`,
    checks: opts.redact === false ? checks : checks.map(redactCheck),
    ok: checks.every((c) => c.status !== 'fail'),
  };
};

/** One line per check (+ indented hint). ASCII markers when the terminal can't be trusted with unicode. */
export const formatReport = (report: DoctorReport, ascii: boolean): string => {
  const mark: Record<CheckStatus, string> = ascii ? { ok: 'OK', warn: 'WARN', fail: 'FAIL' } : { ok: '✓', warn: '!', fail: '✗' };
  const lines = [`csm ${report.version} on ${report.platform}/${report.arch} (${report.runtime})`];
  for (const c of report.checks) {
    lines.push(`${mark[c.status]} ${c.id}: ${c.message}`);
    if (c.hint !== undefined && c.status !== 'ok') lines.push(`    ${ascii ? '->' : '→'} ${c.hint}`);
  }
  return `${lines.join('\n')}\n`;
};
