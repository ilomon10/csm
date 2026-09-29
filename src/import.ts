import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, realpath, unlink } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { CsmError } from './errors.js';
import { errCode, exists, removeTreeSafe } from './fsx.js';
import { PROFILES_DIR, isInsideProfilesDir, profileDir } from './paths.js';
import { assertValidName, linkShared } from './profiles.js';
import { ensureRoot } from './root.js';

/** COPYFILE_EXCL: never write through anything that appeared at `dest` after we created the dir. */
const copyWithMode = async (src: string, dest: string, mode: number): Promise<void> => {
  await copyFile(src, dest, constants.COPYFILE_EXCL);
  await chmod(dest, mode);
};

export interface ImportOptions {
  readonly configDir?: string;
  readonly stateFile?: string;
  /** Allow importing from a config dir that is itself a csm profile. */
  readonly force?: boolean;
  /** Remove the source's .credentials.json afterwards, so the login isn't live in two places. */
  readonly move?: boolean;
}

export interface ImportResult {
  readonly dir: string;
  /** Where the credentials came from (and, unless moved, still are). */
  readonly source: string;
  readonly moved: boolean;
}

/**
 * Imports an existing file-based claude login into a new csm profile, without going through
 * `claude`'s OAuth flow. This is how logins are stored on Linux/Windows (and on macOS as a
 * fallback when the Keychain write fails); a macOS Keychain-only login can't be file-copied.
 * Copies only the two account-identifying files csm needs — .credentials.json and the
 * .claude.json holding oauthAccount — nothing else (no projects/, plugins/, history, etc).
 */
export const importProfile = async (name: string, opts?: ImportOptions): Promise<ImportResult> => {
  assertValidName(name);
  const dir = profileDir(name);

  // .claude.json normally lives outside the config dir (~/.claude.json), unless the config
  // dir itself was overridden, in which case Claude Code keeps it alongside .credentials.json.
  const envConfigDir = process.env['CLAUDE_CONFIG_DIR'];
  const configDirDefaulted = opts?.configDir === undefined && envConfigDir === undefined;
  const configDir = opts?.configDir ?? envConfigDir ?? join(homedir(), '.claude');
  const stateFile = opts?.stateFile ?? join(configDirDefaulted ? homedir() : configDir, '.claude.json');

  const credentialsPath = join(configDir, '.credentials.json');
  if (!(await exists(credentialsPath))) {
    const keychainHint =
      platform() === 'darwin'
        ? ' On macOS, Claude Code normally stores logins in the Keychain, which csm cannot import; run "csm add" to log in fresh instead.'
        : '';
    throw new CsmError(`No file-based login found at ${credentialsPath}.${keychainHint}`);
  }
  if (!(await exists(stateFile))) {
    throw new CsmError(`No account state file found at ${stateFile} (expected the .claude.json holding the login).`);
  }

  // Copying another csm profile's login would leave one refresh token live in two profiles;
  // when either rotates it, the other is silently logged out.
  // Both sides must be real paths: CSM_HOME may itself be behind a symlink (e.g. /tmp on macOS).
  const realProfilesDir = await realpath(PROFILES_DIR).catch(() => PROFILES_DIR);
  if (isInsideProfilesDir(await realpath(configDir), realProfilesDir) && opts?.force !== true) {
    throw new CsmError(
      `${configDir} is already a csm profile; importing it would share one login between two profiles. Unset CLAUDE_CONFIG_DIR, or pass --force.`,
    );
  }

  await ensureRoot();
  // Non-recursive on purpose: EEXIST means the name is taken (possibly by a concurrent run), and
  // it also proves this run created the dir, so the cleanup below can never delete someone else's.
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (err) {
    if (errCode(err) === 'EEXIST') throw new CsmError(`Profile "${name}" already exists.`);
    throw err;
  }
  try {
    await copyWithMode(credentialsPath, join(dir, '.credentials.json'), 0o600);
    await copyWithMode(stateFile, join(dir, '.claude.json'), 0o600);
    await linkShared(name);
  } catch (err) {
    // Atomic-ish: don't leave a half-imported profile lying around.
    await removeTreeSafe(dir);
    throw err;
  }
  // Only after the profile is complete, so a failed import never loses the source login.
  if (opts?.move === true) {
    try {
      await unlink(credentialsPath);
    } catch (err) {
      throw new CsmError(
        `Profile "${name}" was imported, but the source credentials at ${credentialsPath} could not be removed: ${(err as Error).message}`,
      );
    }
  }
  return { dir, source: credentialsPath, moved: opts?.move === true };
};
