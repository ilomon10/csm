import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { baseEnv, mkTemp, readLog, rmrf, runCli } from './support/helpers.mjs';

const setup = async (t) => {
  const csmHome = await mkTemp('csm-wrap-');
  t.after(() => rmrf(csmHome));
  const testLog = join(csmHome, 'claude.log');
  return { csmHome, testLog };
};

test('run --from-wrapper: no profile selected -> claude runs with no CLAUDE_CONFIG_DIR override', async (t) => {
  const { csmHome, testLog } = await setup(t);
  const env = baseEnv({ csmHome, extra: { CSM_TEST_LOG: testLog } });
  // No `add`/`use` at all: fresh install, no current profile.

  const res = await runCli(['run', '--from-wrapper'], { env });
  assert.equal(res.code, 0, res.stderr);
  const [record] = await readLog(testLog);
  assert.equal(record.env.CLAUDE_CONFIG_DIR, null);
});

test('run --from-wrapper: an external CLAUDE_CONFIG_DIR (outside PROFILES_DIR) wins outright', async (t) => {
  const { csmHome, testLog } = await setup(t);
  const foreignDir = await mkTemp('csm-foreign-');
  t.after(() => rmrf(foreignDir));
  const env = baseEnv({ csmHome, extra: { CSM_TEST_LOG: testLog, CLAUDE_CONFIG_DIR: foreignDir } });
  await runCli(['add', 'p', '--no-login'], { env });
  await runCli(['use', 'p'], { env });

  const res = await runCli(['run', '--from-wrapper'], { env });
  assert.equal(res.code, 0, res.stderr);
  const [record] = await readLog(testLog);
  assert.equal(record.env.CLAUDE_CONFIG_DIR, foreignDir);
});

test('run --from-wrapper: a stale CLAUDE_CONFIG_DIR inside PROFILES_DIR follows the current profile instead', async (t) => {
  const { csmHome, testLog } = await setup(t);
  const env = baseEnv({ csmHome, extra: { CSM_TEST_LOG: testLog } });
  await runCli(['add', 'stale', '--no-login'], { env });
  await runCli(['add', 'fresh', '--no-login'], { env });
  await runCli(['use', 'fresh'], { env });

  // Simulate a leftover `eval "$(csm env stale)"` from an earlier shell session.
  const staleConfigDir = join(csmHome, 'profiles', 'stale');
  const wrapperEnv = { ...env, CLAUDE_CONFIG_DIR: staleConfigDir };

  const res = await runCli(['run', '--from-wrapper'], { env: wrapperEnv });
  assert.equal(res.code, 0, res.stderr);
  const [record] = await readLog(testLog);
  assert.equal(record.env.CLAUDE_CONFIG_DIR, join(csmHome, 'profiles', 'fresh'));
  assert.notEqual(record.env.CLAUDE_CONFIG_DIR, staleConfigDir);
});

test('run --from-wrapper: explicit name still takes precedence over any CLAUDE_CONFIG_DIR', async (t) => {
  const { csmHome, testLog } = await setup(t);
  const env = baseEnv({ csmHome, extra: { CSM_TEST_LOG: testLog } });
  await runCli(['add', 'a', '--no-login'], { env });
  await runCli(['add', 'b', '--no-login'], { env });
  await runCli(['use', 'a'], { env });

  const res = await runCli(['run', '--from-wrapper', 'b'], { env });
  assert.equal(res.code, 0, res.stderr);
  const [record] = await readLog(testLog);
  assert.equal(record.env.CLAUDE_CONFIG_DIR, join(csmHome, 'profiles', 'b'));
});

test('run --from-wrapper: passthrough args after -- still forwarded exactly', async (t) => {
  const { csmHome, testLog } = await setup(t);
  const env = baseEnv({ csmHome, extra: { CSM_TEST_LOG: testLog } });
  await runCli(['add', 'p', '--no-login'], { env });
  await runCli(['use', 'p'], { env });

  const res = await runCli(['run', '--from-wrapper', '--', 'x y', '', '--foo'], { env });
  assert.equal(res.code, 0, res.stderr);
  const [record] = await readLog(testLog);
  assert.deepEqual(record.argv, ['x y', '', '--foo']);
});

test('run --from-wrapper: an empty CLAUDE_CONFIG_DIR is treated as unset', async (t) => {
  const { csmHome, testLog } = await setup(t);
  const env = baseEnv({ csmHome, extra: { CSM_TEST_LOG: testLog, CLAUDE_CONFIG_DIR: '' } });
  await runCli(['add', 'p', '--no-login'], { env });
  await runCli(['use', 'p'], { env });

  const res = await runCli(['run', '--from-wrapper'], { env });
  assert.equal(res.code, 0, res.stderr);
  const [record] = await readLog(testLog);
  assert.equal(record.env.CLAUDE_CONFIG_DIR, join(csmHome, 'profiles', 'p'));
});
