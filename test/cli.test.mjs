import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { CLI, ROOT, baseEnv, mkTemp, rmrf, runCli, skipOnWindows } from './support/helpers.mjs';

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const ISSUES = 'https://github.com/ilomon10/csm/issues';

const env = async (t, extra = {}) => {
  const csmHome = await mkTemp('csm-cli-');
  t.after(() => rmrf(csmHome));
  return baseEnv({ csmHome, extra });
};

test('--version, -v and version print exactly package.json version', async (t) => {
  const e = await env(t);
  for (const flag of ['--version', '-v', 'version']) {
    const res = await runCli([flag], { env: e });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.stdout, `${pkg.version}\n`);
  }
});

test('help documents the new commands and the pwsh Out-String fix', async (t) => {
  const res = await runCli(['help'], { env: await env(t) });
  assert.equal(res.code, 0);
  for (const s of ['csm setup', 'csm uninstall', 'csm doctor', '--version', 'shell-init pwsh | Out-String | Invoke-Expression']) {
    assert.ok(res.stdout.includes(s), `help lacks "${s}"`);
  }
});

test('CSM_TEST_THROW is an unexpected error: exit 2 with the issues URL, no stack by default', async (t) => {
  const res = await runCli(['list'], { env: await env(t, { CSM_TEST_THROW: 'boom', CSM_DEBUG: '0' }) });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /^csm: unexpected error: boom\n/);
  assert.ok(res.stderr.includes(ISSUES));
  assert.doesNotMatch(res.stderr, /\n\s+at /);
});

test('CSM_DEBUG=1 adds the stack trace', async (t) => {
  const res = await runCli(['list'], { env: await env(t, { CSM_TEST_THROW: 'boom', CSM_DEBUG: '1' }) });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /\n\s+at /);
});

test('user errors exit 1 without the issues URL; unknown command too', async (t) => {
  const e = await env(t);
  const res = await runCli(['use', 'nope'], { env: e });
  assert.equal(res.code, 1);
  assert.ok(!res.stderr.includes(ISSUES));
  const unknown = await runCli(['frobnicate'], { env: e });
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Unknown command "frobnicate"/);
  const proto = await runCli(['constructor'], { env: e });
  assert.equal(proto.code, 1, 'Object.prototype members are not commands');
});

test('describeError maps errno codes to plain messages', async () => {
  const { describeError } = await import('../dist/errors.js');
  const errno = (code, path) => Object.assign(new Error(code), { code, path });
  assert.deepEqual(describeError(errno('EACCES', '/x'), {}, 'linux'), {
    message: 'permission denied: /x. Check its owner/permissions.',
    exitCode: 1,
  });
  assert.match(describeError(errno('EPERM', 'C:\\x'), {}, 'win32').message, /antivirus/);
  assert.match(describeError(errno('EBUSY', '/x')).message, /in use by another program/);
  assert.match(describeError(errno('ENOSPC', '/x')).message, /no space left on device while writing \/x\./);
  assert.match(describeError(errno('EROFS', '/x')).message, /read-only file system/);
  assert.match(describeError(errno('ELOOP', '/x')).message, /csm doctor/);
  const odd = describeError(new Error('weird'));
  assert.equal(odd.exitCode, 2);
  assert.ok(odd.message.includes(ISSUES));
});

test('add releases the lock before claude launches (claude can run csm)', async (t) => {
  const e = await env(t);
  const res = await runCli(['add', 'p'], { env: e });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /FAKE_CLAUDE/);
  const again = await runCli(['list'], { env: e });
  assert.match(again.stdout, /p/);
});

test('CSM_TEST_THROW alone is ignored (needs CSM_DEBUG too)', async (t) => {
  const res = await runCli(['list'], { env: await env(t, { CSM_TEST_THROW: 'boom' }) });
  assert.equal(res.code, 0, res.stderr);
});

test('a relative CSM_HOME is refused before dispatch, but --version and help still work', async (t) => {
  const e = await env(t, { CSM_HOME: 'relative/dir' });
  const res = await runCli(['list'], { env: e });
  assert.equal(res.code, 1);
  assert.doesNotMatch(res.stderr, /unexpected error/);
  assert.equal((await runCli(['--version'], { env: e })).code, 0);
  assert.equal((await runCli(['help'], { env: e })).code, 0);
});

test('describeError maps ENOENT/ENOTDIR/EEXIST/ENAMETOOLONG/EMFILE/ENOTEMPTY/EISDIR to exit 1', async () => {
  const { describeError } = await import('../dist/errors.js');
  const errno = (code, path, syscall = 'open') => Object.assign(new Error(`${code}: msg`), { code, path, syscall });
  for (const code of ['ENOENT', 'ENOTDIR', 'EEXIST', 'ENAMETOOLONG', 'EMFILE', 'ENOTEMPTY', 'EISDIR']) {
    const r = describeError(errno(code, '/some/p'), {}, 'linux');
    assert.equal(r.exitCode, 1, code);
    assert.ok(r.message.includes('open /some/p'), `${code}: ${r.message}`);
  }
  assert.match(describeError(errno('ENAMETOOLONG', 'C:\\p'), {}, 'win32').message, /long paths/);
  const noPath = describeError(Object.assign(new Error('raw text'), { code: 'ENOENT' }));
  assert.equal(noPath.exitCode, 1);
  assert.match(noPath.message, /raw text/);
});

test('resolvePwsh never returns a bare name and skips relative PATH entries', async () => {
  const { resolvePwsh } = await import('../dist/setup.js');
  const seen = [];
  const access = (p) => (seen.push(p), p === 'C:\\tools\\pwsh.EXE');
  const env = { PATH: '.;C:\\tools', PATHEXT: '.COM;.EXE;.BAT;.CMD', SystemRoot: 'C:\\Windows' };
  assert.equal(resolvePwsh('pwsh', env, 'win32', access), 'C:\\tools\\pwsh.EXE');
  assert.ok(seen.every((p) => p.startsWith('C:')), 'relative entries are never probed');
  assert.equal(resolvePwsh('pwsh', env, 'win32', () => false), null);
  assert.equal(
    resolvePwsh('powershell', env, 'win32', () => false),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );
  assert.equal(resolvePwsh('pwsh', { PATH: 'rel:/opt/bin' }, 'linux', (p) => p === '/opt/bin/pwsh'), '/opt/bin/pwsh');
  assert.equal(resolvePwsh('pwsh', { PATH: 'rel' }, 'linux', () => true), null);
});

test('sync does not print "up to date" for a profile it just reported as drifted', async (t) => {
  if (skipOnWindows(t, 'symlinks')) return;
  const e = await env(t);
  const csmHome = e.CSM_HOME;
  await runCli(['add', 'p', '--no-login'], { env: e });
  await mkdir(join(csmHome, 'shared'), { recursive: true });
  await writeFile(join(csmHome, 'shared', 'settings.json'), '{}');
  await writeFile(join(csmHome, 'profiles', 'p', 'settings.json'), '{"x":1}');
  const res = await runCli(['sync'], { env: e });
  assert.match(res.stderr, /settings\.json drifted/);
  assert.doesNotMatch(res.stdout, /up to date/);
});

test('use prints the shell-init tip only when no rc block exists yet', async (t) => {
  if (skipOnWindows(t, 'POSIX rc paths')) return;
  const csmHome = await mkTemp('csm-cli-');
  const home = await mkTemp('csm-cli-home-');
  t.after(() => Promise.all([rmrf(csmHome), rmrf(home)]));
  const e = baseEnv({ csmHome, home, extra: { SHELL: '/bin/bash' } });
  await runCli(['add', 'p', '--no-login'], { env: e });
  assert.match((await runCli(['use', 'p'], { env: e })).stdout, /Tip:/);
  assert.equal((await runCli(['setup', 'bash', '--yes'], { env: e })).code, 0);
  assert.doesNotMatch((await runCli(['use', 'p'], { env: e })).stdout, /Tip:/);
});

test('Ctrl-D at a confirmation prompt prints Cancelled and exits 0', async (t) => {
  if (skipOnWindows(t, 'needs a pty')) return;
  const probe = spawnSync('script', ['--version'], { stdio: 'ignore' });
  if (probe.error !== undefined || probe.status !== 0) return t.skip('util-linux script(1) not available');
  const e = await env(t);
  await runCli(['add', 'p', '--no-login'], { env: e });
  const res = spawnSync('script', ['-qec', `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} rm p`, '/dev/null'], {
    env: e,
    input: '\x04',
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.match(res.stdout, /Cancelled\./);
  assert.equal(res.status, 0);
  assert.match((await runCli(['list'], { env: e })).stdout, /p/);
});

test('describeError: unmapped errno codes are system errors (exit 1); codeless errors stay bugs', async () => {
  const { describeError } = await import('../dist/errors.js');
  const eio = Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO', syscall: 'read', path: '/x/y' });
  assert.deepEqual(describeError(eio), {
    message: 'system error: read /x/y: EIO (EIO: i/o error, read)',
    exitCode: 1,
  });
  const timeout = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
  assert.deepEqual(describeError(timeout), { message: 'system error: ETIMEDOUT (timed out)', exitCode: 1 });
  assert.equal(describeError(new Error('boom')).exitCode, 2);
  assert.match(describeError(new Error('boom')).message, /This is a bug/);
  assert.equal(describeError(Object.assign(new Error('x'), { code: 'not_errno' })).exitCode, 2);
});
