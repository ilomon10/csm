import { appendFile, chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CsmError } from './errors.js';
import {
  entryExists,
  errCode,
  exists,
  readJson,
  readJsonLenient,
  removeTreeSafe,
  renameRetry,
  sameFile,
  sha256File,
  writeJsonAtomic,
} from './fsx.js';
import { NAME_RE, ensureRoot, looksLikeCsmHome } from './root.js';
import { PROFILES_DIR, ROOT, SHARED_DIR, STATE_FILE, assertRootValid, isInsideProfilesDir, profileDir } from './paths.js';

export { ensureRoot, looksLikeCsmHome };

export interface ProfileInfo {
  readonly name: string;
  readonly dir: string;
  readonly email: string | null;
  readonly isCurrent: boolean;
}

interface State {
  readonly current: string | null;
  /** Config dir last passed to adoptConfig; lets csm notice hardlink-seeded shared files going stale. */
  readonly adoptedFrom?: string;
  /** Shared items adoptConfig itself seeded from adoptedFrom; only these can go stale. */
  readonly adoptedItems?: readonly string[];
}

export type LinkMode = 'symlink' | 'junction' | 'hardlink';

/** A shared item could not be linked into place. Callers report it and carry on (never abort). */
export class LinkError extends CsmError {
  readonly item: string;
  readonly code: string | undefined;
  constructor(message: string, item: string, code?: string) {
    super(message);
    this.item = item;
    this.code = code;
  }
}

/** Config items adoptConfig() seeds into shared/ from an existing config dir (e.g. ~/.claude). */
const CONFIG_ITEMS = ['settings.json', 'CLAUDE.md', 'commands', 'agents', 'skills'] as const;
/**
 * `projects` (Claude Code's per-project session transcripts, used for `--resume`, and the
 * per-project memory/) and `history.jsonl` (prompt history) are opt-in: they only get symlinked
 * once `<CSM_HOME>/shared/<item>` exists, which is exactly what linkShared already does for any
 * item missing from shared/ (see enableHistorySharing and adoptConfig --history).
 */
const SHARED_ITEMS = [...CONFIG_ITEMS, 'projects', 'history.jsonl'] as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const assertValidName = (name: string): void => {
  if (!NAME_RE.test(name)) {
    throw new CsmError(`Invalid profile name "${name}" (use letters, digits, "-" or "_", max 32 chars).`);
  }
};

const readState = async (): Promise<State> => {
  const raw = await readJson(STATE_FILE);
  if (!isRecord(raw)) return { current: null };
  const current = typeof raw['current'] === 'string' ? raw['current'] : null;
  if (typeof raw['adoptedFrom'] !== 'string') return { current };
  const items = raw['adoptedItems'];
  const adoptedItems = Array.isArray(items) ? items.filter((i): i is string => typeof i === 'string') : [];
  return { current, adoptedFrom: raw['adoptedFrom'], adoptedItems };
};

/** Merges `patch` over the stored state, so fields (and unknown keys) it doesn't mention survive. */
const writeState = async (patch: {
  readonly current?: string | null;
  readonly adoptedFrom?: string;
  readonly adoptedItems?: readonly string[];
}): Promise<void> => {
  const raw = await readJson(STATE_FILE);
  await ensureRoot();
  await writeJsonAtomic(STATE_FILE, { current: null, ...(isRecord(raw) ? raw : {}), ...patch });
};

export const getAdoptedFrom = async (): Promise<string | null> => (await readState()).adoptedFrom ?? null;

/**
 * Claude Code keeps the logged-in account under oauthAccount in <config dir>/.claude.json.
 * Lenient on purpose: this file's format is Claude Code's, not csm's, so a listing shouldn't
 * blow up over a file csm doesn't own.
 */
const readEmail = async (dir: string): Promise<string | null> => {
  const raw = await readJsonLenient(join(dir, '.claude.json'));
  if (!isRecord(raw)) return null;
  const account = raw['oauthAccount'];
  return isRecord(account) && typeof account['emailAddress'] === 'string' ? account['emailAddress'] : null;
};

export const profileExists = async (name: string): Promise<boolean> =>
  NAME_RE.test(name) && exists(profileDir(name));

const requireExisting = async (name: string): Promise<void> => {
  assertValidName(name);
  if (!(await profileExists(name))) {
    throw new CsmError(`Profile "${name}" not found. Run "csm list" to see profiles.`);
  }
};

export const getCurrent = async (): Promise<string | null> => {
  const { current } = await readState();
  return current !== null && (await profileExists(current)) ? current : null;
};

export const listProfiles = async (opts?: { readonly create?: boolean }): Promise<readonly ProfileInfo[]> => {
  if (opts?.create === false) assertRootValid();
  else await ensureRoot();
  const current = await getCurrent();
  const entries = await readdir(PROFILES_DIR, { withFileTypes: true }).catch((err: unknown) => {
    if (opts?.create === false && errCode(err) === 'ENOENT') return [];
    throw err;
  });
  const names = entries
    .filter((e) => e.isDirectory() && NAME_RE.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  return Promise.all(
    names.map(async (name): Promise<ProfileInfo> => {
      const dir = profileDir(name);
      return { name, dir, email: await readEmail(dir), isCurrent: name === current };
    }),
  );
};

const isDirStat = async (src: string): Promise<boolean> => (await stat(src)).isDirectory();

/**
 * Create dst as a link to src and say which kind worked. Directories get a symlink (junction on
 * Windows, no admin rights needed). Files get a symlink, or on EPERM/EACCES/ENOTSUP (Windows
 * without Developer Mode, some FUSE mounts) a hardlink to the real file. Throws LinkError.
 * `impl.symlink` is a test seam for forcing the fallback.
 */
export const linkItem = async (
  item: string,
  src: string,
  dst: string,
  platform: NodeJS.Platform = process.platform,
  impl?: { readonly symlink?: typeof symlink },
): Promise<LinkMode> => {
  const doSymlink = impl?.symlink ?? symlink;
  if (await isDirStat(src)) {
    try {
      await doSymlink(src, dst, platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      const msg =
        platform === 'win32'
          ? `could not link ${item}: junctions are not supported at ${dst} (${errCode(err) ?? String(err)}). Put CSM_HOME on a local NTFS drive.`
          : `could not link ${item}: ${err instanceof Error ? err.message : String(err)}`;
      throw new LinkError(msg, item, errCode(err));
    }
    return platform === 'win32' ? 'junction' : 'symlink';
  }
  try {
    await doSymlink(src, dst, 'file');
    return 'symlink';
  } catch (err) {
    const code = errCode(err);
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOTSUP') {
      throw new LinkError(`could not link ${item}: ${err instanceof Error ? err.message : String(err)}`, item, code);
    }
  }
  // link() on a symlink path would hardlink the symlink itself on Linux, so use the real file.
  const real = await realpath(src);
  try {
    await link(real, dst);
    return 'hardlink';
  } catch (err) {
    const code = errCode(err);
    const hint = code === 'EXDEV' ? ': CSM_HOME is on a different drive' : '';
    const why =
      platform === 'win32'
        ? 'creating a symlink needs Developer Mode or admin rights on Windows (Settings > System > For developers > Developer Mode), and the hardlink fallback failed'
        : 'creating a symlink is not permitted here, and the hardlink fallback failed';
    const fix = platform === 'win32' ? 'Enable Developer Mode, or move' : 'Move';
    throw new LinkError(
      `could not link ${item}: ${why} (${code ?? String(err)})${hint}. ${fix} CSM_HOME to the same drive as ${real}, then run "csm sync".`,
      item,
      code,
    );
  }
};

/** linkItem for callers that keep going on failure: warn on stderr, return null. */
const linkQuiet = async (item: string, src: string, dst: string): Promise<LinkMode | null> => {
  try {
    return await linkItem(item, src, dst);
  } catch (err) {
    if (!(err instanceof LinkError)) throw err;
    process.stderr.write(`warning: ${err.message}\n`);
    return null;
  }
};

export interface LinkedItem {
  readonly item: string;
  readonly mode: LinkMode;
}

/** Link shared config into a profile. Never overwrites a file the profile already has. */
export const linkSharedDetailed = async (name: string): Promise<readonly LinkedItem[]> => {
  const dir = profileDir(name);
  const linked: LinkedItem[] = [];
  for (const item of SHARED_ITEMS) {
    const src = join(SHARED_DIR, item);
    const dst = join(dir, item);
    if (!(await exists(src)) || (await entryExists(dst))) continue;
    const mode = await linkQuiet(item, src, dst);
    if (mode !== null) linked.push({ item, mode });
  }
  return linked;
};

export const linkShared = async (name: string): Promise<readonly string[]> =>
  (await linkSharedDetailed(name)).map((i) => i.item);

export const createProfile = async (name: string): Promise<string> => {
  assertValidName(name);
  await ensureRoot();
  const dir = profileDir(name);
  if (await exists(dir)) throw new CsmError(`Profile "${name}" already exists.`);
  await mkdir(dir, { mode: 0o700 });
  await linkShared(name);
  return dir;
};

export const setCurrent = async (name: string): Promise<void> => {
  await requireExisting(name);
  await writeState({ current: name });
};

export const removeProfile = async (name: string): Promise<void> => {
  await requireExisting(name);
  // Links are removed as links; shared targets are untouched.
  await removeTreeSafe(profileDir(name));
  if ((await readState()).current === name) await writeState({ current: null });
};

/** Explicit name wins, otherwise the current profile. */
export const resolveProfile = async (name: string | undefined): Promise<string> => {
  if (name !== undefined) {
    await requireExisting(name);
    return name;
  }
  const current = await getCurrent();
  if (current === null) throw new CsmError('No current profile. Run "csm use <name>" or "csm add <name>".');
  return current;
};

export type SharedStatus = 'linked' | 'missing' | 'drifted' | 'foreign' | 'no-source' | 'stale';

export interface SharedSourceStatus {
  readonly item: string;
  readonly status: 'ok' | 'stale' | 'no-source';
  readonly mode: LinkMode | 'copy' | null;
  readonly source: string | null;
}

/**
 * shared/-level health, independent of any profile. A shared item is 'stale' when adoptConfig
 * seeded it (state.adoptedItems; hand-placed files never are) and it is a plain
 * file (hardlink-seeded, or it became a copy) that no longer is the same file as
 * <adoptedFrom>/<item>: the source was rewritten (write+rename breaks a hardlink) and shared/ kept
 * the old content. Directories are never stale because links follow their target.
 */
export const inspectSharedSources = async (): Promise<readonly SharedSourceStatus[]> => {
  const { adoptedFrom = null, adoptedItems = [] } = await readState();
  return Promise.all(
    SHARED_ITEMS.map(async (item): Promise<SharedSourceStatus> => {
      const src = join(SHARED_DIR, item);
      if (!(await exists(src))) return { item, status: 'no-source', mode: null, source: null };
      const st = await lstat(src);
      if (st.isSymbolicLink()) {
        const isDir = (await stat(src)).isDirectory();
        const source = await readlink(src).catch(() => null);
        return { item, status: 'ok', mode: isDir && process.platform === 'win32' ? 'junction' : 'symlink', source };
      }
      const adoptedItem = adoptedFrom === null ? null : join(adoptedFrom, item);
      const adoptedExists = adoptedItem !== null && (await exists(adoptedItem));
      if (!st.isFile() || adoptedItem === null || !adoptedExists || !adoptedItems.includes(item)) {
        return { item, status: 'ok', mode: 'copy', source: null };
      }
      if (await sameFile(src, adoptedItem)) return { item, status: 'ok', mode: 'hardlink', source: adoptedItem };
      return { item, status: 'stale', mode: 'copy', source: adoptedItem };
    }),
  );
};

const staleItems = async (): Promise<ReadonlySet<string>> =>
  new Set((await inspectSharedSources()).filter((s) => s.status === 'stale').map((s) => s.item));

/**
 * Symlinks/junctions are judged by resolved (real) paths rather than raw readlink targets so a
 * Windows junction and a POSIX symlink are treated alike, and a chain of links still counts as
 * "linked". A hardlinked file is "linked" only while it is still the same inode as shared/<item>.
 */
const sharedItemStatus = async (profileDirPath: string, item: string, stale: ReadonlySet<string>): Promise<SharedStatus> => {
  const src = join(SHARED_DIR, item);
  const dst = join(profileDirPath, item);
  if (!(await exists(src))) return 'no-source';
  if (!(await entryExists(dst))) return 'missing';
  const dstLstat = await lstat(dst);
  let result: SharedStatus;
  if (dstLstat.isSymbolicLink()) {
    try {
      const [dstReal, srcReal] = await Promise.all([realpath(dst), realpath(src)]);
      result = dstReal === srcReal ? 'linked' : 'foreign';
    } catch {
      // Dangling symlink: it's a link, but not to a valid shared item.
      result = 'foreign';
    }
  } else if (dstLstat.isFile() && (await sameFile(dst, src))) {
    result = 'linked';
  } else {
    result = 'drifted';
  }
  return result === 'linked' && stale.has(item) ? 'stale' : result;
};

/** Report how each shared item stands relative to a profile: linked, drifted, missing, etc. */
export const inspectShared = async (
  name: string,
): Promise<ReadonlyArray<{ readonly item: string; readonly status: SharedStatus }>> => {
  await requireExisting(name);
  const dir = profileDir(name);
  const stale = await staleItems();
  return Promise.all(SHARED_ITEMS.map(async (item) => ({ item, status: await sharedItemStatus(dir, item, stale) })));
};

const timestampSuffix = (): string => String(Date.now());

/**
 * Fix drift for one profile: link anything missing, and for anything drifted either `adopt` the
 * profile's copy (it becomes the new shared item; the old shared item is backed up first) or
 * `discard` it (the profile's copy is backed up, then the profile is relinked to the untouched
 * shared item). Never deletes data outright - drifted content is always moved to a `.bak-<ts>` /
 * `.csm-bak-<ts>` sibling first.
 */
export const repairShared = async (
  name: string,
  mode: 'adopt' | 'discard',
): Promise<ReadonlyArray<{ readonly item: string; readonly action: string }>> => {
  await requireExisting(name);
  const dir = profileDir(name);
  const results: Array<{ item: string; action: string }> = [];

  /** Link and record the outcome; a LinkError becomes a 'failed' result, never an abort. */
  const relink = async (item: string, from: string, dst: string, okAction: string): Promise<void> => {
    try {
      const linkMode = await linkItem(item, from, dst);
      results.push({ item, action: okAction + (linkMode === 'hardlink' ? ' (hardlink)' : '') });
    } catch (err) {
      if (!(err instanceof LinkError)) throw err;
      results.push({ item, action: `failed: ${err.message}` });
    }
  };

  // First pass: refresh stale shared copies (hardlink-seeded files whose source was rewritten).
  const staleBackups = new Map<string, string>();
  for (const source of await inspectSharedSources()) {
    if (source.status !== 'stale' || source.source === null) continue;
    const item = source.item;
    const src = join(SHARED_DIR, item);
    const backup = `${src}.bak-${timestampSuffix()}`;
    await renameRetry(src, backup);
    try {
      const linkMode = await linkItem(item, source.source, src);
      staleBackups.set(item, backup);
      results.push({
        item,
        action: `refreshed shared copy from ${source.source} (stale copy backed up to ${backup})${linkMode === 'hardlink' ? ' (hardlink)' : ''}`,
      });
    } catch (err) {
      await renameRetry(backup, src); // put the old shared copy back before reporting
      if (!(err instanceof LinkError)) throw err;
      results.push({ item, action: `failed: ${err.message}` });
    }
  }

  for (const item of SHARED_ITEMS) {
    const status = await sharedItemStatus(dir, item, new Set());
    if (status !== 'missing' && status !== 'drifted' && status !== 'foreign') continue;

    const src = join(SHARED_DIR, item);
    const dst = join(dir, item);

    if (status === 'foreign') {
      // A link elsewhere (or dangling) has no local content to adopt, so both modes relink.
      // unlink removes only the link itself - never follows it or touches its target.
      const oldTarget = await readlink(dst).catch(() => '<unreadable>');
      await unlink(dst);
      await relink(item, src, dst, `relinked (was a link to ${oldTarget})`);
      continue;
    }

    if (status === 'missing') {
      await relink(item, src, dst, 'linked');
      continue;
    }

    // A profile still hardlinked to the pre-refresh inode holds exactly the stale backup's
    // content, so nothing is lost by relinking without a backup.
    const staleBackup = staleBackups.get(item);
    if (
      staleBackup !== undefined &&
      (await lstat(dst)).isFile() &&
      (await sha256File(dst)) === (await sha256File(staleBackup))
    ) {
      await unlink(dst);
      await relink(item, src, dst, 'relinked to refreshed shared copy');
      continue;
    }

    if (mode === 'adopt') {
      // shared/projects pools every profile's history; replacing it with one profile's copy
      // would hide everyone else's transcripts.
      if (item === 'projects') {
        results.push({ item, action: 'skipped: shared history is pooled, merge manually or use --repair=discard' });
        continue;
      }
      const backup = `${src}.bak-${timestampSuffix()}`;
      await renameRetry(src, backup);
      try {
        await renameRetry(dst, src);
      } catch (err: unknown) {
        await renameRetry(backup, src); // restore the shared item before surfacing the failure
        throw err;
      }
      await relink(item, src, dst, `adopted, old shared backed up to ${backup}`);
    } else {
      const backup = `${dst}.csm-bak-${timestampSuffix()}`;
      await renameRetry(dst, backup);
      await relink(item, src, dst, `discarded, profile copy backed up to ${backup}`);
    }
  }

  return results;
};

/**
 * Opt-in history sharing: move a profile's own `projects/` (session transcripts, used by
 * `--resume`) into shared/, then relink it into every profile whose `projects/` is absent -
 * including the source profile, since its own copy just moved away. Refuses if shared/projects
 * already exists so it never silently merges two profiles' histories. Profiles that keep their
 * own `projects/` show up via inspectShared as 'drifted' until repaired.
 */
export const enableHistorySharing = async (fromProfile: string): Promise<void> => {
  await requireExisting(fromProfile);
  const sharedProjects = join(SHARED_DIR, 'projects');
  if (await exists(sharedProjects)) {
    throw new CsmError('Shared history is already enabled ("projects" already exists in shared/).');
  }
  const sourceDir = join(profileDir(fromProfile), 'projects');
  // lstat, not stat: a symlink here isn't the profile's own history and moving it would
  // pool whatever it points at.
  const sourceStat = await lstat(sourceDir).catch(() => null);
  if (sourceStat === null || !sourceStat.isDirectory()) {
    throw new CsmError(`Profile "${fromProfile}" has no real "projects" directory to share.`);
  }
  await mkdir(SHARED_DIR, { recursive: true, mode: 0o700 });
  await renameRetry(sourceDir, sharedProjects);

  for (const { dir } of await listProfiles()) {
    const dst = join(dir, 'projects');
    if (await entryExists(dst)) continue; // has its own history, or already linked - leave alone
    await linkQuiet('projects', sharedProjects, dst);
  }
};

export interface AdoptOptions {
  /** Config dir to adopt from. Defaults to ~/.claude (CLAUDE_CONFIG_DIR is ignored on purpose:
   *  inside a csm-launched session it points at a profile, never at the original config). */
  readonly from?: string;
  /** Also pool projects/ (transcripts + memory) and history.jsonl with the source. */
  readonly history?: boolean;
  readonly dryRun?: boolean;
}

export interface AdoptResult {
  readonly source: string;
  readonly shared: ReadonlyArray<{ readonly item: string; readonly action: string }>;
  readonly profiles: ReadonlyArray<{ readonly name: string; readonly actions: readonly string[] }>;
}

const isRealDir = async (path: string): Promise<boolean> => (await lstat(path).catch(() => null))?.isDirectory() === true;
const isRealFile = async (path: string): Promise<boolean> => (await lstat(path).catch(() => null))?.isFile() === true;

/**
 * Move everything from `src` into `dst` without ever overwriting: entries missing from `dst` are
 * renamed over, real directories present on both sides are merged recursively, and anything else
 * that collides stays in `src`. Returns the colliding paths (relative to the top-level `src`).
 */
const mergeInto = async (src: string, dst: string, dryRun: boolean, rel = ''): Promise<{ moved: number; collisions: string[] }> => {
  let moved = 0;
  const collisions: string[] = [];
  for (const name of await readdir(src)) {
    const from = join(src, name);
    const to = join(dst, name);
    const relPath = rel === '' ? name : join(rel, name);
    if (!(await entryExists(to))) {
      if (!dryRun) await renameRetry(from, to);
      moved++;
    } else if ((await isRealDir(from)) && (await isRealDir(to))) {
      const sub = await mergeInto(from, to, dryRun, relPath);
      moved += sub.moved;
      collisions.push(...sub.collisions);
    } else {
      collisions.push(relPath);
    }
  }
  return { moved, collisions };
};

/** rmdir every directory under (and including) `dir` that is empty after a merge. Never removes files. */
const pruneEmptyDirs = async (dir: string): Promise<boolean> => {
  for (const name of await readdir(dir)) {
    const child = join(dir, name);
    if (await isRealDir(child)) await pruneEmptyDirs(child);
  }
  if ((await readdir(dir)).length > 0) return false;
  await rmdir(dir);
  return true;
};

/**
 * Make an existing Claude Code config dir (default ~/.claude) the shared config for every
 * profile: shared/<item> becomes a symlink to <source>/<item> for each config item the source has,
 * and every profile's local copies are backed up and relinked (repairShared 'discard'). With
 * `history`, each profile's projects/ is merged into <source>/projects (no-clobber; leftovers
 * kept as a backup) and its history.jsonl appended to <source>/history.jsonl, then both are
 * shared too. Never overwrites an existing shared/ item that points elsewhere.
 */
export const adoptConfig = async (opts?: AdoptOptions): Promise<AdoptResult> => {
  const dryRun = opts?.dryRun === true;
  const source = resolve(opts?.from ?? join(homedir(), '.claude'));
  if (!(await exists(source))) throw new CsmError(`No config dir found at ${source}.`);
  // Adopting from a profile (or from csm's own store) would link profiles to each other's
  // per-account state, or shared/ to itself.
  const realRoot = await realpath(ROOT).catch(() => ROOT);
  if (isInsideProfilesDir(await realpath(source), realRoot)) {
    throw new CsmError(`${source} is inside csm's data dir (${ROOT}); pass the original config dir with --from.`);
  }

  const shared: Array<{ item: string; action: string }> = [];
  const profileActions = new Map<string, string[]>();
  const note = (name: string, action: string): void => {
    profileActions.set(name, [...(profileActions.get(name) ?? []), action]);
  };
  const profiles = await listProfiles();
  if (!dryRun) await mkdir(SHARED_DIR, { recursive: true, mode: 0o700 });

  const willShare = new Set<string>();
  const prior = await readState();
  const adoptedFrom = prior.adoptedFrom ?? null;
  // Items this run linked or refreshed itself; with earlier runs' items (same source) they may go stale.
  const seeded = new Set<string>();
  const seed = async (item: string): Promise<void> => {
    const target = join(source, item);
    const link = join(SHARED_DIR, item);
    if (await entryExists(link)) {
      const [linkReal, targetReal] = await Promise.all([realpath(link).catch(() => null), realpath(target).catch(() => undefined)]);
      if (linkReal === targetReal || (await sameFile(link, target))) {
        shared.push({ item, action: 'already linked' });
        willShare.add(item);
      } else if (adoptedFrom === source && (prior.adoptedItems ?? []).includes(item) && (await isRealFile(link)) && (await isRealFile(target))) {
        // A copy seeded from this same source that has since fallen behind it: refresh, don't skip.
        const backup = `${link}.bak-${timestampSuffix()}`;
        if (dryRun) {
          shared.push({ item, action: `would refresh stale shared copy from ${target}` });
          willShare.add(item);
          return;
        }
        await renameRetry(link, backup);
        try {
          const linkMode = await linkItem(item, target, link);
          shared.push({
            item,
            action: `refreshed shared copy from ${target} (stale copy backed up to ${backup})${linkMode === 'hardlink' ? ' (hardlink)' : ''}`,
          });
          willShare.add(item);
          seeded.add(item);
        } catch (err) {
          await renameRetry(backup, link);
          if (!(err instanceof LinkError)) throw err;
          shared.push({ item, action: `skipped: ${err.message}` });
        }
      } else {
        shared.push({ item, action: `skipped: ${link} already exists and does not point to ${target}` });
      }
      return;
    }
    if (dryRun) {
      shared.push({ item, action: `would link to ${target}` });
      willShare.add(item);
      return;
    }
    try {
      const linkMode = await linkItem(item, target, link);
      shared.push({ item, action: `linked to ${target}${linkMode === 'hardlink' ? ' (hardlink)' : ''}` });
      willShare.add(item);
      seeded.add(item);
    } catch (err) {
      if (!(err instanceof LinkError)) throw err;
      shared.push({ item, action: `skipped: ${err.message}` });
    }
  };

  for (const item of CONFIG_ITEMS) {
    if (await exists(join(source, item))) await seed(item);
  }

  if (opts?.history === true) {
    const sourceProjects = join(source, 'projects');
    const sourceHistory = join(source, 'history.jsonl');
    for (const [item, target] of [['projects', sourceProjects], ['history.jsonl', sourceHistory]] as const) {
      const link = join(SHARED_DIR, item);
      if (!(await entryExists(link))) continue;
      const linkReal = await realpath(link).catch(() => null);
      const targetReal = await realpath(target).catch(() => null);
      // A hardlink-seeded history.jsonl is the same file, not the same path.
      if (linkReal === null || (linkReal !== targetReal && !(await sameFile(link, target)))) {
        throw new CsmError(
          `Shared ${item} already exists at ${link} and does not point to ${target}; merge it by hand before adopting history.`,
        );
      }
    }

    for (const { name, dir } of profiles) {
      const own = join(dir, 'projects');
      // A profile projects dir that is the source dir itself (e.g. CSM profile dir aliasing it) must not merge into itself.
      if ((await isRealDir(own)) && !(await sameFile(own, sourceProjects))) {
        if (!dryRun) await mkdir(sourceProjects, { recursive: true, mode: 0o700 });
        const { moved, collisions } = (await exists(sourceProjects))
          ? await mergeInto(own, sourceProjects, dryRun)
          : { moved: (await readdir(own)).length, collisions: [] };
        let action = `${dryRun ? 'would merge' : 'merged'} ${moved} project entr${moved === 1 ? 'y' : 'ies'} into ${sourceProjects}`;
        if (collisions.length > 0) {
          const backup = `${own}.csm-bak-${timestampSuffix()}`;
          if (!dryRun) {
            await pruneEmptyDirs(own);
            await renameRetry(own, backup);
          }
          action += `; ${collisions.length} colliding file(s) ${dryRun ? 'would be ' : ''}kept in ${backup}: ${collisions.join(', ')}`;
        } else if (!dryRun) {
          await pruneEmptyDirs(own);
        }
        note(name, action);
      }
      const history = join(dir, 'history.jsonl');
      if ((await isRealFile(history)) && !(await sameFile(history, sourceHistory))) {
        const backup = `${history}.csm-bak-${timestampSuffix()}`;
        if (!dryRun) {
          const lines = await readFile(history, 'utf8');
          const existing = await readFile(sourceHistory, 'utf8').catch(() => '');
          const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
          await appendFile(sourceHistory, sep + lines, { mode: 0o600 });
          await renameRetry(history, backup);
        }
        note(name, `${dryRun ? 'would append' : 'appended'} history.jsonl to ${sourceHistory} (original ${dryRun ? 'would be ' : ''}kept as ${backup})`);
      }
    }

    if (!dryRun) {
      await mkdir(sourceProjects, { recursive: true, mode: 0o700 });
      if (!(await exists(sourceHistory))) await writeFile(sourceHistory, '', { mode: 0o600 });
    }
    await seed('projects');
    await seed('history.jsonl');
  }

  for (const { name, dir } of profiles) {
    if (dryRun) {
      for (const item of willShare) {
        const dst = join(dir, item);
        // projects/history.jsonl were already merged into the source above, so nothing is left to back up.
        const merged = opts?.history === true && (item === 'projects' || item === 'history.jsonl');
        if (!(await entryExists(dst)) || (merged && !(await lstat(dst)).isSymbolicLink())) note(name, `would link ${item}`);
        else if (!(await lstat(dst)).isSymbolicLink()) note(name, `would back up its own ${item} and link it`);
        else if ((await realpath(dst).catch(() => null)) !== (await realpath(join(source, item)).catch(() => undefined))) {
          note(name, `would relink ${item}`);
        }
      }
      continue;
    }
    for (const { item, action } of await repairShared(name, 'discard')) note(name, `${item} ${action}`);
  }

  // adoptedItems limits stale detection to what we seeded, so skipped/hand-placed items are never flagged.
  if (!dryRun) {
    const kept = adoptedFrom === source ? (prior.adoptedItems ?? []) : [];
    const items = SHARED_ITEMS.filter((i) => seeded.has(i) || kept.includes(i));
    await writeState({ adoptedFrom: source, adoptedItems: items });
  }

  return {
    source,
    shared,
    profiles: profiles.map(({ name }) => ({ name, actions: profileActions.get(name) ?? [] })),
  };
};

export interface LinkSupport {
  /** Where the probe ran. */
  readonly dir: string;
  readonly symlinkFile: boolean;
  readonly symlinkDir: boolean;
  /** null = not applicable (non-win32). */
  readonly junction: boolean | null;
  readonly hardlink: boolean;
  /** What linkItem would pick for a file / directory; null = none works. */
  readonly fileMode: LinkMode | null;
  readonly dirMode: LinkMode | null;
  /** Probe name -> err.code (or message). */
  readonly errors: Readonly<Record<string, string>>;
}

/**
 * Tries each link kind in a throwaway mkdtemp under `dir` (which must exist), then removes it.
 * Never throws: a probe that cannot even run reports every kind as unsupported.
 */
export const probeLinkSupport = async (dir: string): Promise<LinkSupport> => {
  const errors: Record<string, string> = {};
  const isWin = process.platform === 'win32';
  const attempt = async (name: string, op: () => Promise<unknown>): Promise<boolean> => {
    try {
      await op();
      return true;
    } catch (err) {
      errors[name] = errCode(err) ?? (err instanceof Error ? err.message : String(err));
      return false;
    }
  };
  let symlinkFile = false;
  let symlinkDir = false;
  let junction: boolean | null = isWin ? false : null;
  let hardlink = false;
  let tmp: string | null = null;
  try {
    tmp = await mkdtemp(join(dir, '.csm-probe-'));
    const file = join(tmp, 'file');
    const sub = join(tmp, 'dir');
    await writeFile(file, 'x');
    await mkdir(sub);
    symlinkFile = await attempt('symlinkFile', () => symlink(file, join(tmp as string, 'file.lnk'), 'file'));
    symlinkDir = await attempt('symlinkDir', () => symlink(sub, join(tmp as string, 'dir.lnk'), 'dir'));
    if (isWin) junction = await attempt('junction', () => symlink(sub, join(tmp as string, 'dir.jct'), 'junction'));
    hardlink = await attempt('hardlink', () => link(file, join(tmp as string, 'file.hl')));
  } catch (err) {
    errors['probe'] = errCode(err) ?? (err instanceof Error ? err.message : String(err));
  } finally {
    if (tmp !== null) await removeTreeSafe(tmp).catch(() => undefined);
  }
  const fileMode: LinkMode | null = symlinkFile ? 'symlink' : hardlink ? 'hardlink' : null;
  const dirMode: LinkMode | null = isWin ? (junction === true ? 'junction' : null) : symlinkDir ? 'symlink' : null;
  return { dir, symlinkFile, symlinkDir, junction, hardlink, fileMode, dirMode, errors };
};
