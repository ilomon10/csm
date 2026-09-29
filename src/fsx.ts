import { createHash, randomBytes } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename as fsRename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { CsmError } from './errors.js';

export const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

/** Like exists(), but true for dangling symlinks too. */
export const entryExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Reads and parses a JSON file we expect to be well-formed csm state: missing is a normal,
 * silent `null` (nothing has been written yet), but a file that exists and fails to read or
 * parse is surfaced as a CsmError naming the file, since silently discarding it would look like
 * data loss to the user (e.g. state.json). For files csm doesn't own the format of (Claude
 * Code's own .claude.json), use readJsonLenient instead.
 */
export const readJson = async (path: string): Promise<unknown> => {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new CsmError(`Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new CsmError(`Invalid JSON in ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
};

/** Like readJson, but returns null on any error (missing, unreadable, or malformed). */
export const readJsonLenient = async (path: string): Promise<unknown> => {
  try {
    return await readJson(path);
  } catch {
    return null;
  }
};

/**
 * Write-then-rename so a crash never leaves a half-written state file. The tmp name is random
 * and opened exclusively ('wx'), so a pre-planted file or symlink at that path is never followed.
 */
export const writeJsonAtomic = async (path: string, value: unknown): Promise<void> => {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await renameRetry(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
};

/** Error codes that mean "a Windows program has the file open right now" and are worth retrying. */
export const RETRY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRY_DELAYS_MS: readonly number[] = [10, 20, 40, 80, 160, 320, 640, 1000, 1000, 1000];

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** err.code of a caught value, if it has one. */
export const errCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | null)?.code;
const codeOf = errCode;
const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Runs `op`, retrying on `codes` with the given backoff. Only ever retries when `enabled` (win32). */
const withRetries = async (
  op: () => Promise<void>,
  enabled: boolean,
  delaysMs: readonly number[],
  codes: ReadonlySet<string> = RETRY_CODES,
): Promise<void> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (err) {
      const delay = delaysMs[attempt];
      if (!enabled || delay === undefined || !codes.has(codeOf(err) ?? '')) throw err;
      await sleep(delay);
    }
  }
};

export const sha256File = (path: string): Promise<string> =>
  new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (d) => hash.update(d))
      .once('error', reject)
      .once('end', () => resolveHash(hash.digest('hex')));
  });

/** Copies src to dst by lstat walk: links are recreated verbatim (never followed), files keep their mode. */
const copyTree = async (src: string, dst: string, platform: NodeJS.Platform): Promise<void> => {
  const st = await lstat(src);
  if (st.isSymbolicLink()) {
    const isDir = (await stat(src).catch(() => null))?.isDirectory() === true;
    await symlink(await readlink(src), dst, platform === 'win32' && isDir ? 'junction' : undefined);
  } else if (st.isDirectory()) {
    await mkdir(dst, { mode: st.mode & 0o777 });
    for (const name of await readdir(src)) await copyTree(join(src, name), join(dst, name), platform);
  } else if (st.isFile()) {
    await copyFile(src, dst, constants.COPYFILE_EXCL);
    await chmod(dst, st.mode & 0o777);
  } else {
    throw new Error(`unsupported file type at ${src}`);
  }
};

/** Throws if `b` is not an exact copy of `a` (type, size, sha256 for files, readlink target for links). */
const verifyTree = async (a: string, b: string): Promise<void> => {
  const [sa, sb] = await Promise.all([lstat(a), lstat(b)]);
  if (sa.isSymbolicLink() || sb.isSymbolicLink()) {
    if (!sa.isSymbolicLink() || !sb.isSymbolicLink() || (await readlink(a)) !== (await readlink(b))) {
      throw new Error(`link mismatch at ${b}`);
    }
  } else if (sa.isDirectory() || sb.isDirectory()) {
    if (!sa.isDirectory() || !sb.isDirectory()) throw new Error(`type mismatch at ${b}`);
    const [na, nb] = await Promise.all([readdir(a), readdir(b)]);
    if (na.length !== nb.length || na.some((n) => !nb.includes(n))) throw new Error(`entries differ in ${b}`);
    for (const name of na) await verifyTree(join(a, name), join(b, name));
  } else if (sa.isFile() && sb.isFile()) {
    if (sa.size !== sb.size || (await sha256File(a)) !== (await sha256File(b))) throw new Error(`content mismatch at ${b}`);
  } else {
    throw new Error(`type mismatch at ${b}`);
  }
};

const moveAcrossVolumes = async (src: string, dst: string, platform: NodeJS.Platform): Promise<void> => {
  if (await entryExists(dst)) {
    throw new CsmError(`Cannot move ${src} to ${dst} across volumes: destination exists`);
  }
  const tmp = join(dirname(dst), `.${basename(dst)}.csm-tmp-${randomBytes(3).toString('hex')}`);
  try {
    await copyTree(src, tmp, platform);
    await verifyTree(src, tmp);
    await renameRetry(tmp, dst, { platform });
  } catch (err) {
    await removeTreeSafe(tmp).catch(() => undefined);
    throw new CsmError(`Could not move ${src} to ${dst} across volumes: ${reasonOf(err)}. Nothing was changed.`);
  }
  try {
    await removeTreeSafe(src);
  } catch (err) {
    throw new CsmError(`moved to ${dst} but could not remove source ${src}: ${reasonOf(err)}`);
  }
};

/**
 * rename(src, dst) that survives Windows file locks (EPERM/EBUSY/EACCES are retried with backoff,
 * win32 only: elsewhere they are real permission errors) and cross-volume moves (EXDEV falls back
 * to a verified copy + delete that never follows symlinks). `opts.rename` is a test seam.
 */
export const renameRetry = async (
  src: string,
  dst: string,
  opts?: {
    platform?: NodeJS.Platform;
    delaysMs?: readonly number[];
    rename?: (src: string, dst: string) => Promise<void>;
  },
): Promise<void> => {
  const platform = opts?.platform ?? process.platform;
  const doRename = opts?.rename ?? fsRename;
  try {
    await withRetries(() => doRename(src, dst), platform === 'win32', opts?.delaysMs ?? RETRY_DELAYS_MS);
  } catch (err) {
    if (codeOf(err) !== 'EXDEV') throw err;
    await moveAcrossVolumes(src, dst, platform);
  }
};

const isWithin = (dir: string, target: string): boolean => {
  const rel = relative(dir, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel));
};

/** realpath of `path`, or of its nearest existing ancestor with the missing tail re-appended. */
const realResolve = async (path: string): Promise<string> => {
  const tail: string[] = [];
  for (let cur = resolve(path); ; cur = dirname(cur)) {
    try {
      return join(await realpath(cur), ...tail.reverse());
    } catch {
      if (dirname(cur) === cur) return resolve(path);
      tail.push(basename(cur));
    }
  }
};

const assertNotProtected = async (path: string): Promise<void> => {
  const p = resolve(path);
  const home = homedir();
  const realHome = await realResolve(home);
  // The entry's own location: parent followed, final component not (unlinking a link never touches its target).
  const realP = join(await realResolve(dirname(p)), basename(p));
  const fold = process.platform === 'win32' || process.platform === 'darwin';
  const norm = (x: string): string => (fold ? x.toLowerCase() : x);
  const protectedPaths = [home, join(home, '.claude'), realHome, join(realHome, '.claude')].map(norm);
  // dirname(x) === x only for a filesystem root; every ancestor of a protected path is covered too.
  for (const cand of [p, realP].map(norm)) {
    if (dirname(cand) === cand || protectedPaths.some((prot) => isWithin(cand, prot))) {
      throw new CsmError(`Refusing to delete ${p}: protected path`);
    }
  }
};

const RMDIR_CODES: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);

const removeEntry = async (path: string): Promise<void> => {
  const win = process.platform === 'win32';
  const st = await lstat(path).catch((err: unknown) => {
    if (codeOf(err) === 'ENOENT') return null;
    throw err;
  });
  if (st === null) return;
  if (st.isSymbolicLink()) {
    // Symlink or junction: remove the link itself, never recurse into what it points at.
    try {
      await unlink(path);
    } catch (err) {
      if (win && (codeOf(err) === 'EPERM' || codeOf(err) === 'EISDIR')) await rmdir(path);
      else throw err;
    }
  } else if (st.isDirectory()) {
    for (const name of await readdir(path)) await removeEntry(join(path, name));
    await withRetries(() => rmdir(path), win, RETRY_DELAYS_MS, RMDIR_CODES);
  } else {
    try {
      await unlink(path);
    } catch (err) {
      if (!win || codeOf(err) !== 'EPERM') throw err;
      // Read-only attribute on Windows blocks unlink; clear it and retry.
      await chmod(path, 0o666);
      await withRetries(() => unlink(path), true, RETRY_DELAYS_MS);
    }
  }
};

/** Delete a tree without ever following a symlink or junction. Missing top path is a no-op. */
export const removeTreeSafe = async (path: string): Promise<void> => {
  await assertNotProtected(path);
  await removeEntry(resolve(path));
};

const bigStat = async (path: string): Promise<{ dev: bigint; ino: bigint } | null> => {
  try {
    const { dev, ino } = await stat(path, { bigint: true });
    return { dev, ino };
  } catch {
    return null;
  }
};

/** Same file by (dev, ino) as bigint (Windows 64-bit file ids lose precision as numbers). Follows links. */
export const sameFile = async (a: string, b: string): Promise<boolean> => {
  const [sa, sb] = await Promise.all([bigStat(a), bigStat(b)]);
  return sa !== null && sb !== null && sa.ino !== 0n && sa.dev === sb.dev && sa.ino === sb.ino;
};

const nearestExisting = async (path: string): Promise<bigint | null> => {
  for (let p = resolve(path); ; p = dirname(p)) {
    const st = await bigStat(p);
    if (st !== null) return st.dev;
    if (dirname(p) === p) return null;
  }
};

/** true if both paths (or their nearest existing ancestors) sit on the same device. */
export const sameDevice = async (a: string, b: string): Promise<boolean> => {
  const [da, db] = await Promise.all([nearestExisting(a), nearestExisting(b)]);
  return da !== null && da === db;
};
