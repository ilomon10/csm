import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { link, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { CsmError } from './errors.js';
import { errCode, sleep } from './fsx.js';
import { LOCK_FILE, ROOT, assertRootValid } from './paths.js';
import { ensureRoot } from './root.js';

export interface LockInfo {
  readonly pid: number;
  readonly host: string;
  /** ISO timestamp. */
  readonly startedAt: string;
  /** Epoch ms. */
  readonly ts: number;
  readonly cmd: string;
  readonly token: string;
}

export interface LockOptions {
  readonly path?: string;
  readonly waitMs?: number;
  readonly staleMs?: number;
  /** Subcommand name recorded in the lock. Defaults to process.argv[2]. */
  readonly cmd?: string;
  /** Test seams: pretend to be another platform / replace the O_EXCL create. */
  readonly platform?: NodeJS.Platform;
  readonly breakingStaleMs?: number;
  readonly create?: (path: string, data: string) => Promise<void>;
}

export class LockHeldError extends CsmError {
  readonly holder: LockInfo | null;
  constructor(message: string, holder: LockInfo | null) {
    super(message);
    this.holder = holder;
  }
}

const POLL_MS = 100;
/** An unparsable lock is a writer that crashed between open and write; give live writers this long. */
const UNPARSABLE_GRACE_MS = 10_000;
/** A `.lock.breaking` sub-lock older than this belonged to a breaker that crashed. */
const BREAKING_STALE_MS = 10_000;

/** Only a bare subcommand name is stored, never argv (which may carry paths or secrets). */
const cmdName = (raw: string | undefined): string => (raw !== undefined && /^[a-z][a-z0-9-]{0,31}$/.test(raw) ? raw : 'unknown');

const parseLock = (raw: string): LockInfo | null => {
  try {
    const v = JSON.parse(raw) as Partial<LockInfo> | null;
    if (
      v !== null &&
      typeof v === 'object' &&
      typeof v.pid === 'number' &&
      typeof v.host === 'string' &&
      typeof v.startedAt === 'string' &&
      typeof v.ts === 'number' &&
      typeof v.cmd === 'string' &&
      typeof v.token === 'string'
    ) {
      return v as LockInfo;
    }
  } catch {
    // fall through: unparsable
  }
  return null;
};

export const readLock = async (path: string = LOCK_FILE): Promise<LockInfo | null> => {
  try {
    return parseLock(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
};

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but belongs to someone else.
    return errCode(err) !== 'ESRCH';
  }
};

/**
 * On this host a lock is stale only when its pid is dead (a live holder may legitimately run
 * longer than staleMs). The age rule applies to other hosts, whose pids we cannot probe, and
 * to unparsable locks (a writer that crashed between open and write).
 */
export const isLockStale = (info: LockInfo | null, mtimeMs: number, now: number = Date.now(), staleMs = 600_000): boolean => {
  if (info === null) return now - mtimeMs > UNPARSABLE_GRACE_MS;
  if (info.host === hostname()) return !pidAlive(info.pid);
  return now - info.ts > staleMs;
};

const describeHolder = (info: LockInfo | null, path: string, breaking = false): string => {
  const who =
    info === null
      ? 'pid unknown'
      : `pid ${info.pid} on ${info.host}, running "csm ${cmdName(info.cmd)}" since ${info.startedAt}`;
  const sub = breaking
    ? ` A lock-breaking sub-lock ${path}.breaking exists (another csm is clearing a stale lock); retry shortly, or if no csm is running delete it too.`
    : '';
  return `Another csm process (${who}) is modifying ${ROOT}. Wait for it to finish, or if that process is gone delete ${path}.${sub}`;
};

/** On Windows a file that is delete-pending, or briefly held by a scanner, fails create with EPERM/EACCES/EBUSY. */
const CREATE_CONTENTION = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

/**
 * Move a stale lock aside and delete it. Breakers serialize on an O_EXCL `.lock.breaking`
 * sub-lock, and the lock is re-read and re-verified as stale right before the rename, so a
 * lock freshly taken by someone else is never removed. If the rename still caught a fresh lock
 * (its owner replaced the stale one in the tiny gap), it is put back.
 */
const breakStale = async (path: string, seenRaw: string, staleMs: number, breakingStaleMs: number): Promise<void> => {
  const breaking = `${path}.breaking`;
  try {
    await writeFile(breaking, String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (errCode(err) !== 'EEXIST') throw err;
    // Another process is breaking. Only clear its sub-lock if that process evidently died.
    const st = await stat(breaking).catch(() => null);
    if (st !== null && Date.now() - st.mtimeMs > breakingStaleMs) await unlink(breaking).catch(() => undefined);
    return;
  }
  try {
    const current = await readFile(path, 'utf8').catch(() => null);
    if (current === null || current !== seenRaw) return;
    const mtimeMs = (await stat(path).catch(() => null))?.mtimeMs ?? Date.now();
    if (!isLockStale(parseLock(current), mtimeMs, Date.now(), staleMs)) return;
    const aside = `${path}.stale-${randomBytes(4).toString('hex')}`;
    try {
      await rename(path, aside);
    } catch {
      return; // released, or won by someone else
    }
    const moved = await readFile(aside, 'utf8').catch(() => null);
    if (moved !== null && moved !== seenRaw) {
      // link() never overwrites; where it is unsupported, fall back to moving it back.
      try {
        await link(aside, path);
      } catch (err) {
        if (errCode(err) !== 'EEXIST') {
          await rename(aside, path).catch(() => undefined);
          return;
        }
      }
    }
    await unlink(aside).catch(() => undefined);
  } finally {
    await unlink(breaking).catch(() => undefined);
  }
};

/**
 * Runs `fn` while holding an exclusive lock file (O_EXCL create), so two csm processes never
 * mutate ROOT at once. Not re-entrant: only CLI handlers take it, library functions never do.
 */
export const withLock = async <T>(fn: () => Promise<T>, opts?: LockOptions): Promise<T> => {
  const path = opts?.path ?? LOCK_FILE;
  const waitMs = opts?.waitMs ?? 2000;
  const staleMs = opts?.staleMs ?? 600_000;
  const breakingStaleMs = opts?.breakingStaleMs ?? BREAKING_STALE_MS;
  const platform = opts?.platform ?? process.platform;
  const create =
    opts?.create ?? ((p: string, data: string) => writeFile(p, data, { flag: 'wx', mode: 0o600 }));
  assertRootValid();
  const token = randomBytes(8).toString('hex');
  const now = Date.now();
  const info: LockInfo = {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date(now).toISOString(),
    ts: now,
    cmd: cmdName(opts?.cmd ?? process.argv[2]),
    token,
  };
  // The real lock lives in ROOT, which only ensureRoot may create (owner check, chmod, ACLs, marker).
  if (resolve(dirname(path)) === resolve(ROOT)) await ensureRoot();
  else await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  let deadline = Date.now() + waitMs;
  let extended = false;
  for (;;) {
    try {
      await create(path, JSON.stringify(info));
      break;
    } catch (err) {
      const code = errCode(err);
      if (code === undefined || !CREATE_CONTENTION.has(code)) throw err;
      if (code !== 'EEXIST') {
        // Only Windows reports contention this way; elsewhere EPERM/EACCES is a real permission problem.
        if (platform !== 'win32') throw err;
        if (Date.now() >= deadline) throw new LockHeldError(describeHolder(null, path), null);
        await sleep(10 + Math.floor(Math.random() * 41));
        continue;
      }
    }
    const raw = await readFile(path, 'utf8').catch(() => null);
    if (raw === null) {
      // Released between our create and read (retry now), or unreadable (bounded by the deadline).
      if (Date.now() >= deadline) throw new LockHeldError(describeHolder(null, path), null);
      await sleep(10);
      continue;
    }
    const holder = parseLock(raw);
    const mtimeMs = (await stat(path).catch(() => null))?.mtimeMs ?? 0;
    if (isLockStale(holder, mtimeMs, Date.now(), staleMs)) {
      await breakStale(path, raw, staleMs, breakingStaleMs);
      if (Date.now() >= deadline && (await stat(path).catch(() => null)) !== null) {
        // A crashed breaker's sub-lock self-heals after BREAKING_STALE_MS; wait that out once.
        const sub = await stat(`${path}.breaking`).catch(() => null);
        if (sub !== null && !extended) {
          extended = true;
          deadline = Math.max(deadline, sub.mtimeMs + breakingStaleMs + 1000);
        }
        if (Date.now() >= deadline) throw new LockHeldError(describeHolder(holder, path, sub !== null), holder);
      }
      await sleep(10); // another breaker may hold the sub-lock; don't spin
      continue;
    }
    if (Date.now() >= deadline) throw new LockHeldError(describeHolder(holder, path), holder);
    await sleep(POLL_MS);
  }

  try {
    return await fn();
  } finally {
    // Only remove the lock if it is still ours; ENOENT is fine (uninstall --purge deletes ROOT).
    const current = await readLock(path);
    if (current !== null && current.token === token) await unlink(path).catch(() => undefined);
  }
};
