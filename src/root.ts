import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { CsmError } from './errors.js';
import { errCode } from './fsx.js';
import { PROFILES_DIR, ROOT, ROOT_MARKER, SHARED_DIR, assertRootValid } from './paths.js';

export const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;

const MARKER_CONTENT = 'csm data dir\n';

/** Runs a Windows tool with an absolute path and no shell; resolves stdout ('' on failure). */
const runWin = (file: string, args: readonly string[]): Promise<string> =>
  new Promise((done) => {
    execFile(file, [...args], { windowsHide: true }, (err, stdout) => done(err === null ? String(stdout) : ''));
  });

/** The current user's SID (`*S-1-...`, the form icacls accepts) via whoami.exe, or null. */
const currentSid = async (): Promise<string | null> => {
  const whoami = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'whoami.exe');
  const out = await runWin(whoami, ['/user', '/fo', 'csv', '/nh']);
  const m = /"(S-1-[0-9-]+)"/.exec(out);
  return m?.[1] !== undefined ? `*${m[1]}` : null;
};

/** Restrict a freshly created ROOT to the current user on Windows. Failure is only a warning. */
const restrictWin32 = async (): Promise<void> => {
  const icacls = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'icacls.exe');
  const domain = process.env['USERDOMAIN'];
  const name = process.env['USERNAME'] ?? userInfo().username;
  const user = (await currentSid()) ?? (domain !== undefined && domain !== '' ? `${domain}\\${name}` : name);
  await new Promise<void>((done) => {
    execFile(icacls, [ROOT, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true }, (err) => {
      if (err !== null) process.stderr.write(`warning: could not restrict permissions on ${ROOT}: ${err.message}\n`);
      done();
    });
  });
};

const sameOwner = (uid: number): boolean => typeof process.getuid !== 'function' || uid === process.getuid();

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Names csm creates transiently at the top level (atomic state write, lock breaking, doctor/link probes). */
const TMP_FILE_RE = /^(state\.json\.[0-9a-f]{12}\.tmp|\.lock\.stale-[0-9a-f]{8}|\.doctor-probe-[0-9a-f]{6})$/;
const TMP_DIR_RE = /^\.csm-probe-[A-Za-z0-9]{6}$/;
/** Files the OS itself drops into any folder it browses; never a sign of foreign data. */
const OS_JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
/** What csm puts in shared/: the shared items themselves, plus the `.bak-<ts>` copies sync/adopt keep. */
const SHARED_ENTRY_RE =
  /^(settings\.json|CLAUDE\.md|commands|agents|skills|projects|history\.jsonl)(\.bak-\d+)?$/;

/** Returns why `dir/name` is not what csm would have put there, or null when it is fine. */
const checkEntry = async (dir: string, name: string): Promise<string | null> => {
  const p = join(dir, name);
  const st = await lstat(p).catch(() => null);
  if (st === null) return name; // vanished mid-scan: treat as unexpected rather than guess
  switch (name) {
    case ROOT_MARKER:
      if (!st.isFile()) return `${name} (not a regular file)`;
      return (await readFile(p, 'utf8').catch(() => null)) === MARKER_CONTENT ? null : `${name} (invalid content)`;
    case 'state.json': {
      if (!st.isFile()) return `${name} (not a regular file)`;
      try {
        // csm always writes `current` (string or null), so a bare `{}` or foreign JSON is not ours.
        const v: unknown = JSON.parse(await readFile(p, 'utf8'));
        const ours = isRecord(v) && (v['current'] === null || typeof v['current'] === 'string');
        return ours ? null : `${name} (not csm state)`;
      } catch {
        return `${name} (not valid JSON)`;
      }
    }
    case 'profiles': {
      if (!st.isDirectory()) return `${name} (not a directory)`;
      const inner = await readdir(p, { withFileTypes: true }).catch(() => null);
      if (inner === null) return `${name} (unreadable)`;
      const bad = inner.filter((e) => !NAME_RE.test(e.name) || !e.isDirectory()).map((e) => `${name}/${e.name}`);
      return bad.length > 0 ? bad.join(', ') : null;
    }
    case 'shared': {
      if (!st.isDirectory()) return `${name} (not a directory)`;
      const inner = await readdir(p).catch(() => null);
      if (inner === null) return `${name} (unreadable)`;
      const bad = inner.filter((e) => !SHARED_ENTRY_RE.test(e) && !OS_JUNK.has(e)).map((e) => `${name}/${e}`);
      return bad.length > 0 ? bad.join(', ') : null;
    }
    case '.lock':
    case '.lock.breaking':
      return st.isFile() ? null : `${name} (not a regular file)`;
  }
  if (OS_JUNK.has(name)) return st.isFile() ? null : `${name} (not a regular file)`;
  if (TMP_FILE_RE.test(name)) return st.isFile() ? null : `${name} (not a regular file)`;
  if (TMP_DIR_RE.test(name)) return st.isDirectory() ? null : `${name} (not a directory)`;
  return name;
};

/**
 * Strict allowlist check that `dir` is a csm data dir, in marker and legacy mode alike: every
 * top-level entry must be one csm creates, with the right type and content, and the dir must be
 * ours. An empty dir passes. The marker alone never vouches for the rest of the contents.
 */
export const looksLikeCsmHome = async (dir: string): Promise<{ ok: boolean; reason: string; entries: string[] }> => {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    return { ok: false, reason: `cannot read ${dir}: ${errCode(err) ?? String(err)}`, entries: [] };
  }
  const unexpected = (await Promise.all(entries.map((e) => checkEntry(dir, e)))).filter((r): r is string => r !== null);
  if (unexpected.length > 0) return { ok: false, reason: `unexpected: ${unexpected.join(', ')}`, entries };
  if (!sameOwner((await stat(dir)).uid)) return { ok: false, reason: `${dir} is owned by another user`, entries };
  const hasMarker = entries.includes(ROOT_MARKER);
  return { ok: true, reason: hasMarker ? `${ROOT_MARKER} marker present` : entries.length === 0 ? 'empty directory' : 'legacy csm layout', entries };
};

const refuse = (unexpected: string): CsmError => {
  const shown = unexpected.split(', ');
  const list = shown.length > 6 ? `${shown.slice(0, 6).join(', ')}, ...` : unexpected;
  return new CsmError(
    `CSM_HOME ${ROOT} exists and is not a csm data dir (unexpected: ${list}). Point CSM_HOME at an empty or new directory.`,
  );
};

/** True when `p` is (or resolves to) the user's home directory or ~/.claude. */
const isProtectedDir = async (p: string): Promise<boolean> => {
  const bad = [resolve(homedir()), resolve(homedir(), '.claude')];
  const real = async (x: string): Promise<string> => realpath(x).catch(() => x);
  const badReal = await Promise.all(bad.map(real));
  return [resolve(p), await real(p)].some((c) => bad.includes(c) || badReal.includes(c));
};

/**
 * Makes ROOT ready for use. A missing ROOT is created (0700, marker, Windows ACL). An existing
 * one is only accepted when it carries a valid marker or passes the strict legacy check (then the
 * marker is written); anything else is refused before a single chmod, mkdir or write. That is
 * also what refuses CSM_HOME=$HOME or ~/.claude: they hold plenty csm never creates.
 */
export const ensureRoot = async (): Promise<void> => {
  assertRootValid();
  if (await isProtectedDir(ROOT)) {
    throw new CsmError(`CSM_HOME ${ROOT} is your home or Claude config directory; refusing to use it. Point CSM_HOME at an empty or new directory.`);
  }
  const existing = await stat(ROOT).catch((err: unknown) => {
    if (errCode(err) === 'ENOENT') return null;
    throw err;
  });
  const fresh = existing === null;
  if (fresh) {
    await mkdir(ROOT, { recursive: true, mode: 0o700 });
  } else {
    if (!existing.isDirectory()) throw refuse(`${ROOT} (not a directory)`);
    const marker = await checkEntry(ROOT, ROOT_MARKER).then(async (bad) => {
      if ((await lstat(join(ROOT, ROOT_MARKER)).catch(() => null)) === null) return 'absent';
      return bad === null ? 'valid' : bad;
    });
    if (marker !== 'valid') {
      if (marker !== 'absent') throw refuse(marker);
      const verdict = await looksLikeCsmHome(ROOT);
      if (!verdict.ok) throw refuse(verdict.reason.replace(/^unexpected: /, ''));
    }
  }
  if (process.platform === 'win32') {
    if (fresh) await restrictWin32();
  } else if (typeof process.getuid === 'function') {
    const st = await stat(ROOT); // follows a symlinked CSM_HOME to the real directory
    if (!sameOwner(st.uid)) {
      throw new CsmError(`${ROOT} is owned by another user (uid ${st.uid}); refusing to use it. Set CSM_HOME to a directory you own.`);
    }
    if ((st.mode & 0o077) !== 0) await chmod(ROOT, 0o700);
  }
  await writeFile(join(ROOT, ROOT_MARKER), MARKER_CONTENT, { flag: 'wx', mode: 0o600 }).catch((err: unknown) => {
    if (errCode(err) !== 'EEXIST') throw err;
  });
  await mkdir(PROFILES_DIR, { recursive: true, mode: 0o700 });
  await mkdir(SHARED_DIR, { recursive: true, mode: 0o700 });
};
