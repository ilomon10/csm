import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { baseEnv, mkTemp, rmrf, runCli, skipOnWindows } from './support/helpers.mjs';

const sandbox = async (t, extra = {}) => {
  const dir = await mkTemp('csm-doctor-');
  t.after(() => rmrf(dir));
  const home = join(dir, 'home');
  const csmHome = join(dir, 'csm');
  await mkdir(home, { recursive: true });
  const env = baseEnv({ csmHome, home, extra: { SHELL: '/bin/bash', ...extra } });
  return { dir, home, csmHome, env };
};

const byId = (report) => Object.fromEntries(report.checks.map((c) => [c.id, c]));

test('doctor --json: healthy install exits 0 with the documented shape', async (t) => {
  if (skipOnWindows(t, 'POSIX rc paths')) return;
  const { env } = await sandbox(t);
  assert.equal((await runCli(['setup', 'bash', '--yes'], { env })).code, 0);
  assert.equal((await runCli(['add', 'p', '--no-login'], { env })).code, 0);

  const res = await runCli(['doctor', '--json'], { env });
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.ok, true);
  for (const key of ['version', 'platform', 'arch', 'runtime']) assert.equal(typeof report[key], 'string');
  const checks = byId(report);
  for (const c of report.checks) assert.ok(['ok', 'warn', 'fail'].includes(c.status));
  for (const id of ['runtime', 'claude', 'csm-on-path', 'wrapper', 'rc-block', 'csm-home', 'lock', 'state', 'links', 'shared', 'profile:p', 'overrides']) {
    assert.ok(checks[id], `missing check ${id}`);
  }
  assert.equal(checks['rc-block'].status, 'ok');
  assert.equal(checks['claude'].status, 'ok');
  assert.equal(checks['profile:p'].status, 'warn', 'a profile without a login only warns');
  assert.equal(checks['wrapper'].status, 'warn');
});

test('doctor: text output has one marker line per check, ASCII when not a TTY', async (t) => {
  if (skipOnWindows(t, 'POSIX rc paths')) return;
  const { env } = await sandbox(t);
  await runCli(['setup', 'bash', '--yes'], { env });
  const res = await runCli(['doctor'], { env });
  assert.equal(res.code, 0, res.stdout);
  assert.match(res.stdout, /^OK runtime: /m);
  assert.match(res.stdout, /^WARN wrapper: .*\n\s+-> restart your shell/m);
  assert.doesNotMatch(res.stdout, /[✓✗]/);
});

test('doctor: missing rc block fails with the csm setup hint and exits 1', async (t) => {
  if (skipOnWindows(t, 'POSIX rc paths')) return;
  const { env } = await sandbox(t);
  const res = await runCli(['doctor', '--json'], { env });
  assert.equal(res.code, 1);
  const report = JSON.parse(res.stdout);
  assert.equal(report.ok, false);
  const rc = byId(report)['rc-block'];
  assert.equal(rc.status, 'fail');
  assert.equal(rc.hint, 'csm setup');
  assert.equal(byId(report)['csm-home'].status, 'warn', 'absent CSM_HOME only warns');
});

test('doctor: claude missing from CSM_CLAUDE_BIN fails', async (t) => {
  if (skipOnWindows(t, 'POSIX rc paths')) return;
  const { dir, env } = await sandbox(t);
  await runCli(['setup', 'bash', '--yes'], { env });
  const res = await runCli(['doctor', '--json'], { env: { ...env, CSM_CLAUDE_BIN: join(dir, 'nope') } });
  assert.equal(res.code, 1);
  assert.equal(byId(JSON.parse(res.stdout))['claude'].status, 'fail');
});

test('doctor: a drifted shared item fails that profile with a sync hint; overrides warn', async (t) => {
  if (skipOnWindows(t, 'POSIX rc paths')) return;
  const { csmHome, env } = await sandbox(t, { ANTHROPIC_API_KEY: 'sk-test' });
  await runCli(['setup', 'bash', '--yes'], { env });
  await runCli(['add', 'p', '--no-login'], { env });
  await mkdir(join(csmHome, 'shared'), { recursive: true });
  await writeFile(join(csmHome, 'shared', 'settings.json'), '{}');
  await writeFile(join(csmHome, 'profiles', 'p', 'settings.json'), '{"x":1}');

  const res = await runCli(['doctor', '--json'], { env });
  assert.equal(res.code, 1);
  const checks = byId(JSON.parse(res.stdout));
  assert.equal(checks['profile:p'].status, 'fail');
  assert.match(checks['profile:p'].hint, /csm sync p --repair=adopt\|discard/);
  assert.equal(checks['overrides'].status, 'warn');
  assert.match(checks['overrides'].message, /ANTHROPIC_API_KEY/);
});

test('doctor never creates CSM_HOME or writes into it beyond its probe', async (t) => {
  const { csmHome, home, env } = await sandbox(t);
  await runCli(['doctor'], { env });
  await assert.rejects(readdir(csmHome), { code: 'ENOENT' });
  assert.deepEqual(await readdir(home), []);
});

test('doctor is read-only: an existing CSM_HOME gains no profiles dir and no probe leftovers', async (t) => {
  const { csmHome, env } = await sandbox(t);
  await mkdir(csmHome, { recursive: true });
  await writeFile(join(csmHome, 'state.json'), '{}');
  await runCli(['doctor', '--json'], { env });
  assert.deepEqual((await readdir(csmHome)).sort(), ['state.json']);
});

test('doctor redacts emails and lock argv by default; --no-redact shows them', async (t) => {
  if (skipOnWindows(t, 'POSIX rc paths')) return;
  const { csmHome, env } = await sandbox(t);
  await runCli(['add', 'p', '--no-login'], { env });
  await writeFile(join(csmHome, 'profiles', 'p', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'alice@example.com' } }));
  const now = Date.now();
  await writeFile(
    join(csmHome, '.lock'),
    JSON.stringify({ pid: process.pid, host: 'h', startedAt: new Date(now).toISOString(), ts: now, cmd: 'add secret-name', token: 't' }),
  );
  const red = await runCli(['doctor', '--json'], { env });
  assert.ok(!red.stdout.includes('alice@example.com'));
  assert.ok(!red.stdout.includes('secret-name'));
  assert.equal(byId(JSON.parse(red.stdout))['profile:p'].message, 'a***@example.com');
  assert.match(byId(JSON.parse(red.stdout))['lock'].message, /\(csm add\)/);
  const text = await runCli(['doctor'], { env });
  assert.ok(!text.stdout.includes('alice@example.com'));

  const full = await runCli(['doctor', '--json', '--no-redact'], { env });
  assert.equal(byId(JSON.parse(full.stdout))['profile:p'].message, 'alice@example.com');
});

test('doctor warns (not fails) on an unparsable lock file', async (t) => {
  const { csmHome, env } = await sandbox(t);
  await mkdir(csmHome, { recursive: true });
  await writeFile(join(csmHome, '.lock'), 'garbage');
  const res = await runCli(['doctor', '--json'], { env });
  const lock = byId(JSON.parse(res.stdout))['lock'];
  assert.equal(lock.status, 'warn');
  assert.match(lock.message, /cannot be parsed/);
});

test('doctor rejects unknown flags', async (t) => {
  const { env } = await sandbox(t);
  const res = await runCli(['doctor', '--bogus'], { env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Usage: csm doctor \[--json\] \[--no-redact\]/);
});
