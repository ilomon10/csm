import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CsmError } from './errors.js';

export const ROOT: string = process.env['CSM_HOME'] || join(homedir(), '.claude-sessions');
/** Marker file in ROOT (content `csm data dir\n`) proving the directory is csm's, so purge never trusts a guess. */
export const ROOT_MARKER = '.csm-home';

/** ROOT must be absolute (a relative CSM_HOME would move with the cwd). An empty CSM_HOME counts as unset. */
export const assertRootValid = (): void => {
  if (!isAbsolute(ROOT)) {
    throw new CsmError(`CSM_HOME must be an absolute path (got "${ROOT}"). Set it to a full path or unset it.`);
  }
};

export const PROFILES_DIR: string = join(ROOT, 'profiles');
/** Files placed here are symlinked into every profile (settings, CLAUDE.md, commands...). */
export const SHARED_DIR: string = join(ROOT, 'shared');
export const STATE_FILE: string = join(ROOT, 'state.json');
export const LOCK_FILE: string = join(ROOT, '.lock');

export const profileDir = (name: string): string => join(PROFILES_DIR, name);

/**
 * True if `dir` is PROFILES_DIR itself or somewhere underneath it (lexically; pass a realpath to follow links).
 * `base` lets callers compare against a realpath'd PROFILES_DIR when CSM_HOME sits behind a symlink.
 */
export const isInsideProfilesDir = (dir: string, base: string = PROFILES_DIR): boolean => {
  const rel = relative(base, resolve(dir));
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
