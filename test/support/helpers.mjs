// Shared test support. Not a test file itself (no .test.mjs suffix, so `node --test
// "test/**/*.test.mjs"` never tries to execute it directly).
import { spawn, execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod, realpath, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
export const CLI = join(ROOT, 'dist', 'cli.js');

export const isWin = process.platform === 'win32';

// CSM_TEST_CLI (absolute path to a compiled csm binary) makes every runCli/shim use it instead of
// `node dist/cli.js`, so the same suite can exercise a bun-compiled binary.
export const CLI_CMD = process.env.CSM_TEST_CLI ? [process.env.CSM_TEST_CLI] : [process.execPath, CLI];

// On win32 the fake claude is a .cmd launcher (CRLF) that runs fake-claude.mjs via CSM_TEST_NODE.
export const FAKE_CLAUDE = join(HERE, isWin ? 'fake-claude.cmd' : 'fake-claude.mjs');

export const pathWith = (dir, base = process.env.PATH) => `${dir}${path.delimiter}${base}`;

/** Sync "is this command on PATH": `where` on win32, `command -v` via /bin/sh elsewhere. */
export const hasCommand = (name) => {
  try {
    if (isWin) execFileSync('where', [name], { stdio: 'ignore' });
    else execFileSync('/bin/sh', ['-c', `command -v ${name}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

let symlinkOk;
/** Memoized: can this process create a file symlink here? (false on Windows without Developer Mode.) */
export const canSymlink = async () => {
  if (symlinkOk !== undefined) return symlinkOk;
  const dir = await mkdtemp(join(tmpdir(), 'csm-symprobe-'));
  try {
    await writeFile(join(dir, 'a'), 'x');
    await symlink(join(dir, 'a'), join(dir, 'b'), 'file');
    symlinkOk = true;
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') symlinkOk = false;
    else throw err;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return symlinkOk;
};

/** Skips the test (returns true) on win32. */
export const skipOnWindows = (t, reason) => {
  if (!isWin) return false;
  t.skip(reason);
  return true;
};

/** Skips the test (returns true) when symlinks cannot be created. */
export const skipUnlessSymlink = async (t) => {
  if (await canSymlink()) return false;
  t.skip('cannot create symlinks on this host');
  return true;
};

/** Same target: realpath equality, or equal bigint dev+ino (junction/hardlink-safe). */
export const sameTarget = async (a, b) => {
  try {
    if ((await realpath(a)) === (await realpath(b))) return true;
    const [sa, sb] = await Promise.all([stat(a, { bigint: true }), stat(b, { bigint: true })]);
    return sa.dev === sb.dev && sa.ino === sb.ino && sa.ino !== 0n;
  } catch {
    return false;
  }
};

/** Fresh temp dir under the OS tmp dir (never anywhere near a real ~/.claude*). */
export const mkTemp = async (prefix) => mkdtemp(join(tmpdir(), prefix));

/**
 * Base env for a csm child process: fresh CSM_HOME/HOME, a fake claude binary, and every
 * ambient override var explicitly unset so a developer's real shell env can never leak in.
 * Callers layer test-specific vars with `extra`.
 */
const siblingHomes = new Set();
process.on('exit', () => {
  for (const dir of siblingHomes) rmSync(dir, { recursive: true, force: true });
});

// csm refuses CSM_HOME == HOME, so the default HOME is a sibling of csmHome (removed at process exit).
export const baseEnv = ({ csmHome, home: homeOpt, claudeBin = FAKE_CLAUDE, extra = {} }) => {
  let home = homeOpt;
  if (home === undefined) {
    home = `${csmHome.replace(/[\\/]+$/, '')}-home`;
    siblingHomes.add(home);
  }
  const env = {
    PATH: process.env.PATH,
    CSM_HOME: csmHome,
    HOME: home,
    CSM_CLAUDE_BIN: claudeBin,
    CSM_TEST_NODE: process.execPath,
    ...extra,
  };
  if (isWin) {
    env.USERPROFILE = home;
    for (const key of ['SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR']) {
      if (process.env[key] !== undefined && !(key in extra)) env[key] = process.env[key];
    }
  }
  // Never let these leak from the ambient environment into a test run.
  for (const key of [
    'CLAUDE_CONFIG_DIR',
    'ZDOTDIR',
    'XDG_CONFIG_HOME',
    'CSM_SHELL_INIT',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_PROFILE',
    'ANTHROPIC_FEDERATION_RULE_ID',
    'ANTHROPIC_ORGANIZATION_ID',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
  ]) {
    if (!(key in env)) delete env[key];
  }
  return env;
};

/** Generic "spawn a command, capture stdout/stderr/exit" used by runCli and shell-init tests. */
export const spawnCapture = (command, args, { env, input, cwd, stdinIsTTY = false } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      cwd,
      stdio: [stdinIsTTY ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    if (input !== undefined) child.stdin.end(input);
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });

/**
 * Spawns `CLI_CMD <args>` (never a shell) with a controlled env, and resolves once it
 * exits. Never uses the real `claude`: CSM_CLAUDE_BIN defaults to the fake binary above.
 */
export const runCli = (args, opts = {}) => spawnCapture(CLI_CMD[0], [...CLI_CMD.slice(1), ...args], opts);

/** Reads a CSM_TEST_LOG file of newline-delimited JSON records into an array (empty if absent). */
export const readLog = async (path) => {
  try {
    const raw = await readFile(path, 'utf8');
    return raw
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
};

/** Writes a tiny shim on PATH so `csm` inside a spawned shell resolves to our build. */
export const writeCsmShim = async (binDir) => {
  await mkdir(binDir, { recursive: true });
  if (isWin) {
    const shimPath = join(binDir, 'csm.cmd');
    const [exe, ...rest] = CLI_CMD;
    const args = rest.map((a) => `"${a}"`).join(' ');
    await writeFile(shimPath, `@"${exe}" ${args ? `${args} ` : ''}%*\r\n`);
    return shimPath;
  }
  const shimPath = join(binDir, 'csm');
  const cmd = CLI_CMD.map((a) => `"${a}"`).join(' ');
  await writeFile(shimPath, `#!/usr/bin/env sh\nexec ${cmd} "$@"\n`);
  await chmod(shimPath, 0o755);
  return shimPath;
};

export const rmrf = (path) => rm(path, { recursive: true, force: true });

export { mkdtemp, mkdir, readFile, rm, writeFile, chmod };
