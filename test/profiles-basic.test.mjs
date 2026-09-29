import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { baseEnv, mkTemp, readLog, rmrf, runCli } from './support/helpers.mjs';

const withHome = async (t) => {
  const csmHome = await mkTemp('csm-home-');
  t.after(() => rmrf(csmHome));
  return csmHome;
};

test('list: no profiles yet prints hint and exits 0', async (t) => {
  const csmHome = await withHome(t);
  const res = await runCli(['list'], { env: baseEnv({ csmHome }) });
  assert.equal(res.code, 0);
  assert.match(res.stdout, /No profiles yet\. Create one with: csm add <name>/);
});

test('add --no-login creates a profile, becomes current on first add, list/current reflect it', async (t) => {
  const csmHome = await withHome(t);
  const env = baseEnv({ csmHome });

  const add = await runCli(['add', 'alice', '--no-login'], { env });
  assert.equal(add.code, 0, add.stderr);
  assert.match(add.stdout, /Created profile "alice" at/);
  assert.match(add.stdout, /"alice" is now the current profile\./);

  const current = await runCli(['current'], { env });
  assert.equal(current.code, 0);
  assert.equal(current.stdout.trim(), 'alice');

  const list = await runCli(['list'], { env });
  assert.equal(list.code, 0);
  assert.match(list.stdout, /\* alice\s+\(not logged in\)/);
});

test('add without --no-login launches claude for login (fake claude invoked with profile dir, no args)', async (t) => {
  const csmHome = await withHome(t);
  const testLog = join(csmHome, 'claude.log');
  const env = baseEnv({ csmHome, extra: { CSM_TEST_LOG: testLog } });

  const add = await runCli(['add', 'bob'], { env });
  assert.equal(add.code, 0, add.stderr);
  assert.match(add.stdout, /Launching claude — complete the login, then type \/exit\./);

  const records = await readLog(testLog);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].argv, []);
  assert.equal(records[0].env.CLAUDE_CONFIG_DIR, join(csmHome, 'profiles', 'bob'));
});

test('second add does not steal "current" from the first profile', async (t) => {
  const csmHome = await withHome(t);
  const env = baseEnv({ csmHome });
  await runCli(['add', 'first', '--no-login'], { env });
  await runCli(['add', 'second', '--no-login'], { env });
  const current = await runCli(['current'], { env });
  assert.equal(current.stdout.trim(), 'first');
});

test('use switches current profile; unknown name is rejected', async (t) => {
  const csmHome = await withHome(t);
  const env = baseEnv({ csmHome });
  await runCli(['add', 'a', '--no-login'], { env });
  await runCli(['add', 'b', '--no-login'], { env });

  const use = await runCli(['use', 'b'], { env });
  assert.equal(use.code, 0);
  assert.match(use.stdout, /Switched to "b"\./);
  const current = await runCli(['current'], { env });
  assert.equal(current.stdout.trim(), 'b');

  const bad = await runCli(['use', 'nope'], { env });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Profile "nope" not found/);
});

test('current: errors when no profile has ever been selected', async (t) => {
  const csmHome = await withHome(t);
  const env = baseEnv({ csmHome });
  const res = await runCli(['current'], { env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /No current profile\./);
});

test('add rejects invalid names: empty via missing arg, bad characters, and too long', async (t) => {
  const csmHome = await withHome(t);
  const env = baseEnv({ csmHome });

  const noName = await runCli(['add'], { env });
  assert.equal(noName.code, 1);
  assert.match(noName.stderr, /Usage: csm add <name>/);

  const badChars = await runCli(['add', 'bad name!'], { env });
  assert.equal(badChars.code, 1);
  assert.match(badChars.stderr, /Invalid profile name "bad name!"/);

  const tooLong = await runCli(['add', 'a'.repeat(33)], { env });
  assert.equal(tooLong.code, 1);
  assert.match(tooLong.stderr, /Invalid profile name/);
});

test('add rejects unknown flags', async (t) => {
  const csmHome = await withHome(t);
  const env = baseEnv({ csmHome });
  const res = await runCli(['add', 'carol', '--bogus'], { env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Unknown flag\(s\) for "csm add": --bogus\. Supported: --no-login\./);
});

test('add refuses to clobber an existing profile', async (t) => {
  const csmHome = await withHome(t);
  const env = baseEnv({ csmHome });
  await runCli(['add', 'dup', '--no-login'], { env });
  const res = await runCli(['add', 'dup', '--no-login'], { env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Profile "dup" already exists\./);
});

test('rm without --yes refuses when stdin is not a TTY (non-interactive)', async (t) => {
  const csmHome = await withHome(t);
  const env = baseEnv({ csmHome });
  await runCli(['add', 'doomed', '--no-login'], { env });

  const res = await runCli(['rm', 'doomed'], { env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Refusing to delete profile "doomed" without confirmation\. Re-run with --yes\./);

  // Profile must still exist.
  const list = await runCli(['list'], { env });
  assert.match(list.stdout, /doomed/);
});

test('rm --yes deletes without prompting, and clears "current" if it was the deleted profile', async (t) => {
  const csmHome = await withHome(t);
  const env = baseEnv({ csmHome });
  await runCli(['add', 'gone', '--no-login'], { env });

  const res = await runCli(['rm', 'gone', '--yes'], { env });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /Removed profile "gone"\./);

  const list = await runCli(['list'], { env });
  assert.match(list.stdout, /No profiles yet/);

  const current = await runCli(['current'], { env });
  assert.equal(current.code, 1);
});

test('rm -y is accepted as a short alias for --yes', async (t) => {
  const csmHome = await withHome(t);
  const env = baseEnv({ csmHome });
  await runCli(['add', 'short', '--no-login'], { env });
  const res = await runCli(['rm', 'short', '-y'], { env });
  assert.equal(res.code, 0, res.stderr);
});

test('rm of unknown profile errors', async (t) => {
  const csmHome = await withHome(t);
  const env = baseEnv({ csmHome });
  const res = await runCli(['rm', 'ghost', '--yes'], { env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Profile "ghost" not found/);
});

test('add and import reject extra positional args', async (t) => {
  const env = baseEnv({ csmHome: await withHome(t) });
  for (const args of [['add', 'a', 'b', '--no-login'], ['import', 'a', 'b']]) {
    const res = await runCli(args, { env });
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /Usage: csm/);
  }
});
