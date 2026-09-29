import { execFile } from 'node:child_process';
import { accessSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { constants, copyFile, lstat, mkdir, readFile, readdir, readlink, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { CsmError } from './errors.js';
import { RETRY_CODES, exists, removeTreeSafe, renameRetry } from './fsx.js';
import { ROOT } from './paths.js';
import { looksLikeCsmHome } from './profiles.js';
import type { Shell } from './shell.js';
import { SHELLS } from './shell.js';
import { resolveWindowsClaude } from './winquote.js';

export const START_MARKER = '# >>> csm >>>';
export const END_MARKER = '# <<< csm <<<';

export interface SetupResult {
  readonly file: string;
  readonly action: 'created' | 'appended' | 'updated' | 'unchanged';
  readonly backup?: string;
}
export interface UninstallResult {
  readonly file: string;
  readonly action: 'removed' | 'deleted' | 'none';
  readonly backup?: string;
}

/** The one line the block runs, also printed as the "run this to activate now" hint. */
export const sourceLine = (shell: Shell): string => {
  switch (shell) {
    case 'bash':
    case 'zsh':
      return `eval "$(csm shell-init ${shell})"`;
    case 'fish':
      return 'csm shell-init fish | source';
    case 'pwsh':
      return 'csm shell-init pwsh | Out-String | Invoke-Expression';
  }
};

/**
 * The marked block, without a trailing newline. It sources the wrapper at shell start rather
 * than inlining it, so upgrading csm changes the behavior without re-running setup.
 */
export const rcBlock = (shell: Shell, eol: '\n' | '\r\n' = '\n'): string => {
  let guarded: string;
  switch (shell) {
    case 'bash':
    case 'zsh':
      guarded = `if command -v csm >/dev/null 2>&1; then ${sourceLine(shell)}; fi`;
      break;
    case 'fish':
      guarded = `if command -q csm; ${sourceLine(shell)}; end`;
      break;
    case 'pwsh':
      guarded = `if (Get-Command csm -CommandType Application -ErrorAction SilentlyContinue) { ${sourceLine(shell)} }`;
      break;
  }
  const note = '# Managed by "csm setup"; remove with "csm uninstall". Do not edit inside this block.';
  return [START_MARKER, note, guarded, END_MARKER].join(eol);
};

const START_RE = /^# >>> csm >>>/m;
const END_RE = /^# <<< csm <<<[ \t]*/m;

/** [start, end) of the first complete block; `end` excludes the line terminator. */
const findBlock = (content: string, from = 0): { start: number; end: number } | null => {
  const rest = content.slice(from);
  const s = START_RE.exec(rest);
  if (s === null) return null;
  const afterStart = rest.slice(s.index + s[0].length);
  const e = END_RE.exec(afterStart);
  if (e === null) return null;
  const start = from + s.index;
  return { start, end: start + s[0].length + e.index + e[0].length };
};

export const hasBlock = (content: string): boolean => findBlock(content) !== null;

const canAccess = (path: string): boolean => {
  try {
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Absolute path of `pwsh` / Windows PowerShell, or null. Never a bare name: a relative PATH entry
 * (or the current directory on Windows) must not be able to plant a fake pwsh that we would run.
 */
export const resolvePwsh = (
  name: 'pwsh' | 'powershell',
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  access: (path: string) => boolean = canAccess,
): string | null => {
  if (platform === 'win32') {
    try {
      return resolveWindowsClaude(name, env, access);
    } catch {
      if (name === 'pwsh') return null;
    }
    const root = env['SystemRoot'] || env['SYSTEMROOT'] || 'C:\\Windows';
    return win32.isAbsolute(root) ? win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null;
  }
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (dir !== '' && isAbsolute(dir) && access(join(dir, name))) return join(dir, name);
  }
  return null;
};

const queryPwshProfile = (name: 'pwsh' | 'powershell', env: NodeJS.ProcessEnv): Promise<string | null> =>
  new Promise((res) => {
    const exe = resolvePwsh(name, env);
    if (exe === null) return res(null);
    execFile(
      exe,
      ['-NoProfile', '-NonInteractive', '-Command', '$PROFILE.CurrentUserAllHosts'],
      { timeout: 10_000, windowsHide: true, env, cwd: homedir() },
      (err, stdout) => {
        const out = err === null ? String(stdout).trim() : '';
        res(out !== '' && isAbsolute(out) ? out : null);
      },
    );
  });

/** Every rc file that gets (or may hold) the csm block for `shell`. See docs: pwsh discovery order. */
export const rcTargets = async (
  shell: Shell,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<readonly string[]> => {
  const home = homedir();
  const xdg = env['XDG_CONFIG_HOME'] || join(home, '.config');
  switch (shell) {
    case 'bash':
      return platform === 'darwin' || platform === 'win32'
        ? [join(home, '.bashrc'), join(home, '.bash_profile')]
        : [join(home, '.bashrc')];
    case 'zsh':
      return [join(env['ZDOTDIR'] || home, '.zshrc')];
    case 'fish':
      return [join(xdg, 'fish', 'conf.d', 'csm.fish')];
    case 'pwsh': {
      const override = env['CSM_PWSH_PROFILE'];
      if (override !== undefined && override !== '') return [override];
      const found = [await queryPwshProfile('pwsh', env)];
      if (platform === 'win32') found.push(await queryPwshProfile('powershell', env));
      const paths = [...new Set(found.filter((p): p is string => p !== null))];
      if (paths.length > 0) return paths;
      return [platform === 'win32' ? join(home, 'Documents', 'PowerShell', 'profile.ps1') : join(xdg, 'powershell', 'profile.ps1')];
    }
  }
};

/** Follows a symlinked rc (dotfile managers) so the write lands on the real file and the link survives. */
const resolveTarget = async (file: string): Promise<string> => {
  try {
    return await realpath(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  try {
    if ((await lstat(file)).isSymbolicLink()) return resolve(dirname(file), await readlink(file));
  } catch {
    // Not there at all: the file itself is the target.
  }
  return file;
};

interface RcFile {
  readonly content: string;
  readonly mode: number;
  /** A UTF-8 BOM was present; it is stripped from `content` and written back. */
  readonly bom: boolean;
}

/** Reads as bytes: UTF-16 (BOM or NUL bytes) is refused, since editing it as UTF-8 would corrupt it. */
const readIfExists = async (path: string): Promise<RcFile | null> => {
  try {
    const [buf, st] = await Promise.all([readFile(path), stat(path)]);
    const utf16Bom = buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff));
    if (utf16Bom || buf.includes(0)) {
      throw new CsmError(`${path} is not UTF-8 (UTF-16?). Re-save it as UTF-8 (in PowerShell: "Save As" > encoding UTF-8), then re-run.`);
    }
    const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    return { content: buf.toString('utf8', bom ? 3 : 0), mode: st.mode & 0o777, bom };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
};

/** Reads every file of `files` (validating encoding) without writing anything. */
const preflightRc = async (files: readonly string[]): Promise<void> => {
  for (const file of files) await readIfExists(await resolveTarget(file));
};

/** Backs up (if the file existed), then writes via a same-dir tmp file opened 'wx' + rename. */
const writeRc = async (
  target: string,
  existing: RcFile | null,
  content: string,
): Promise<string | undefined> => {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  let backup: string | undefined;
  if (existing !== null) {
    backup = `${target}.csm-bak-${Date.now()}`;
    await copyFile(target, backup, constants.COPYFILE_EXCL);
  }
  const tmp = `${target}.csm-tmp-${randomBytes(3).toString('hex')}`;
  const mode = existing?.mode ?? 0o644;
  try {
    await writeFile(tmp, existing?.bom === true ? `\uFEFF${content}` : content, { mode, flag: 'wx' });
    await renameRetry(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return backup;
};

const eolOf = (content: string): '\n' | '\r\n' => (content.includes('\r\n') ? '\r\n' : '\n');

const setupFile = async (file: string, shell: Shell): Promise<SetupResult> => {
  const target = await resolveTarget(file);
  const existing = await readIfExists(target);
  const content = existing?.content ?? '';
  const eol = eolOf(content);
  const block = rcBlock(shell, eol);

  const found = findBlock(content);
  let next: string;
  let action: SetupResult['action'];
  if (found !== null) {
    if (content.slice(found.start, found.end) === block) return { file, action: 'unchanged' };
    next = content.slice(0, found.start) + block + content.slice(found.end);
    action = 'updated';
  } else {
    let sep = '';
    if (content !== '') {
      if (!content.endsWith(eol)) sep += eol;
      if (!(content + sep).endsWith(eol + eol)) sep += eol;
    }
    next = `${content}${sep}${block}${eol}`;
    action = existing === null ? 'created' : 'appended';
  }
  const backup = await writeRc(target, existing, next);
  return { file, action, ...(backup !== undefined && { backup }) };
};

/** Writes the csm block into every rc file of `shell`; a no-op for files that already hold it. */
export const setup = async (shell: Shell): Promise<readonly SetupResult[]> => {
  const files = await rcTargets(shell);
  await preflightRc(files);
  const results: SetupResult[] = [];
  for (const file of files) results.push(await setupFile(file, shell));
  return results;
};

/** Removes every block plus the single blank line `setup` put before it. */
const stripBlocks = (content: string): string => {
  let out = content;
  for (let found = findBlock(out); found !== null; found = findBlock(out)) {
    let { start, end } = found;
    const eol = eolOf(out);
    if (out.startsWith(eol, end)) end += eol.length;
    if (start >= eol.length * 2 && out.slice(start - eol.length * 2, start) === eol + eol) start -= eol.length;
    out = out.slice(0, start) + out.slice(end);
  }
  return out;
};

/** unlink with the same transient-lock retry as renameRetry (Windows antivirus/indexers). */
const unlinkRetry = async (path: string): Promise<void> => {
  for (let attempt = 0; ; attempt++) {
    try {
      await unlink(path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (code === 'ENOENT') return;
      if (!RETRY_CODES.has(code) || attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
};

const uninstallFile = async (file: string): Promise<UninstallResult> => {
  const target = await resolveTarget(file);
  const existing = await readIfExists(target);
  if (existing === null || !hasBlock(existing.content)) return { file, action: 'none' };
  const next = stripBlocks(existing.content);
  if (basename(target) === 'csm.fish' && next.trim() === '') {
    const backup = `${target}.csm-bak-${Date.now()}`;
    await copyFile(target, backup, constants.COPYFILE_EXCL);
    await unlinkRetry(target);
    return { file, action: 'deleted', backup };
  }
  const backup = await writeRc(target, existing, next);
  return { file, action: 'removed', ...(backup !== undefined && { backup }) };
};

/**
 * Validates that ROOT may be purged and returns its top-level entries (null when it does not
 * exist). Throws before anything is touched, so callers run it ahead of any rc edit.
 */
export const preflightPurge = async (): Promise<string[] | null> => {
  if (!(await exists(ROOT))) return null;
  const verdict = await looksLikeCsmHome(ROOT);
  if (!verdict.ok) {
    throw new CsmError(
      `Refusing to purge ${ROOT}: it does not look like a csm data dir (${verdict.reason}). Unexpected entries: ${verdict.entries.join(', ')}. Nothing was changed.`,
    );
  }
  return (await readdir(ROOT)).filter((e) => e !== '.lock');
};

/** Deletes ROOT after re-validating it; false when there was nothing to delete. */
export const purgeData = async (): Promise<boolean> => {
  if ((await preflightPurge()) === null) return false;
  await removeTreeSafe(ROOT);
  return true;
};

/** Removes the csm block from every shell's rc files (regardless of $SHELL); `purge` also deletes CSM_HOME. */
export const uninstall = async (opts: { purge: boolean }): Promise<readonly UninstallResult[]> => {
  const files: string[] = [];
  for (const shell of SHELLS) {
    for (const file of await rcTargets(shell)) if (!files.includes(file)) files.push(file);
  }
  // Everything that can refuse runs before the first write, so a refusal leaves no partial edits.
  await preflightRc(files);
  if (opts.purge) await preflightPurge();
  const results: UninstallResult[] = [];
  for (const file of files) results.push(await uninstallFile(file));
  if (opts.purge) await purgeData();
  return results;
};
