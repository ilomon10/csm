import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { baseEnv, mkTemp, readLog, rmrf, runCli } from './support/helpers.mjs';

const setup = async (t) => {
  const csmHome = await mkTemp('csm-run-');
  t.after(() => rmrf(csmHome));
  const testLog = join(csmHome, 'claude.log');
  return { csmHome, testLog };
};

test('run: passes argv exactly (spaces, empty string, quotes, shell metacharacters)', async (t) => {
  const { csmHome, testLog } = await setup(t);
  const env = baseEnv({ csmHome, extra: { CSM_TEST_LOG: testLog } });
  await runCli(['add', 'p', '--no-login'], { env });

  const tricky = [
    'hello world', // internal space
    '', // empty string arg
    `it's "quoted"`, // single+double quotes
    'a&b|c;d$(echo x)`echo y`', // shell metacharacters that must NOT be interpreted
    '--flag=value',
    '-- literal dashdash inside value --',
  ];
  const res = await runCli(['run', '--', ...tricky], { env });
  assert.equal(res.code, 0, res.stderr);

  const records = await readLog(testLog);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].argv, tricky);
});

test('run: sets CLAUDE_CONFIG_DIR to the resolved profile dir', async (t) => {
  const { csmHome, testLog } = await setup(t);
  const env = baseEnv({ csmHome, extra: { CSM_TEST_LOG: testLog } });
  await runCli(['add', 'p', '--no-login'], { env });

  const res = await runCli(['run', 'p'], { env });
  assert.equal(res.code, 0, res.stderr);
  const [record] = await readLog(testLog);
  assert.equal(record.env.CLAUDE_CONFIG_DIR, join(csmHome, 'profiles', 'p'));
});

test('run: propagates the child exit code', async (t) => {
  const { csmHome, testLog } = await setup(t);
  const env = baseEnv({ csmHome, extra: { CSM_TEST_LOG: testLog, FAKE_CLAUDE_EXIT_CODE: '17' } });
  await runCli(['add', 'p', '--no-login'], { env });

  const res = await runCli(['run', 'p'], { env });
  assert.equal(res.code, 17);
});

test('run: errors in strict mode (no --from-wrapper) when there is no current profile', async (t) => {
  const { csmHome } = await setup(t);
  const env = baseEnv({ csmHome });
  const res = await runCli(['run'], { env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /No current profile\. Run "csm use <name>" or "csm add <name>"\./);
});

test('run: ignores an inherited CLAUDE_CONFIG_DIR (plain `csm run`, not --from-wrapper)', async (t) => {
  const { csmHome, testLog } = await setup(t);
  const foreignDir = await mkTemp('csm-foreign-');
  t.after(() => rmrf(foreignDir));
  const env = baseEnv({ csmHome, extra: { CSM_TEST_LOG: testLog, CLAUDE_CONFIG_DIR: foreignDir } });
  await runCli(['add', 'p', '--no-login'], { env });
  await runCli(['use', 'p'], { env });

  const res = await runCli(['run'], { env });
  assert.equal(res.code, 0, res.stderr);
  const [record] = await readLog(testLog);
  assert.equal(record.env.CLAUDE_CONFIG_DIR, join(csmHome, 'profiles', 'p'));
  assert.notEqual(record.env.CLAUDE_CONFIG_DIR, foreignDir);
});

test('run <name>: explicit name overrides current profile', async (t) => {
  const { csmHome, testLog } = await setup(t);
  const env = baseEnv({ csmHome, extra: { CSM_TEST_LOG: testLog } });
  await runCli(['add', 'a', '--no-login'], { env });
  await runCli(['add', 'b', '--no-login'], { env });
  await runCli(['use', 'a'], { env });

  const res = await runCli(['run', 'b'], { env });
  assert.equal(res.code, 0, res.stderr);
  const [record] = await readLog(testLog);
  assert.equal(record.env.CLAUDE_CONFIG_DIR, join(csmHome, 'profiles', 'b'));
});

test('run: rejects more than one positional name', async (t) => {
  const { csmHome } = await setup(t);
  const env = baseEnv({ csmHome });
  const res = await runCli(['run', 'a', 'b'], { env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Usage: csm run \[name\] \[-- claude args\.\.\.\]/);
});

test('run: unknown explicit profile name errors', async (t) => {
  const { csmHome } = await setup(t);
  const env = baseEnv({ csmHome });
  const res = await runCli(['run', 'nope'], { env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Profile "nope" not found/);
});

test('windowsCmdExe: absolute ComSpec wins, otherwise SystemRoot\\System32, never a bare cmd.exe', async () => {
  const { windowsCmdExe } = await import('../dist/runner.js');
  assert.equal(windowsCmdExe({ ComSpec: 'C:\\Windows\\System32\\cmd.exe' }), 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(windowsCmdExe({ ComSpec: 'cmd.exe', SystemRoot: 'D:\\Win' }), 'D:\\Win\\System32\\cmd.exe');
  assert.equal(windowsCmdExe({ ComSpec: 'C:\\evil\\powershell.exe', SystemRoot: 'D:\\Win' }), 'D:\\Win\\System32\\cmd.exe');
  assert.equal(windowsCmdExe({ ComSpec: '.\\cmd.exe' }), 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(windowsCmdExe({}), 'C:\\Windows\\System32\\cmd.exe');
});
