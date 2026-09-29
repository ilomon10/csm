import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { baseEnv, isWin, mkTemp, rmrf, runCli, skipOnWindows, spawnCapture } from './support/helpers.mjs';

test('env: POSIX single-quoting round-trips a CLAUDE_CONFIG_DIR containing a single quote', async (t) => {
  if (skipOnWindows(t, 'POSIX sh round-trip')) return;
  // The profile name itself can't contain a quote (NAME_RE forbids it), but CSM_HOME can be
  // anywhere on disk - including a path a user chose that happens to contain one.
  const parent = await mkTemp('csm-env-');
  t.after(() => rmrf(parent));
  const csmHome = join(parent, "it's a dir");
  await mkdir(csmHome, { recursive: true });

  const env = baseEnv({ csmHome });
  const add = await runCli(['add', 'p', '--no-login'], { env });
  assert.equal(add.code, 0, add.stderr);

  const envLine = await runCli(['env', 'p'], { env });
  assert.equal(envLine.code, 0, envLine.stderr);
  assert.match(envLine.stdout, /^export CLAUDE_CONFIG_DIR='/);

  // Round-trip it for real: eval the emitted line in `sh` and print the resulting var back out.
  const expected = join(csmHome, 'profiles', 'p');
  const evalScript = `${envLine.stdout}\nprintf '%s' "$CLAUDE_CONFIG_DIR"`;
  const res = await spawnCapture('sh', ['-c', evalScript], { env: { PATH: process.env.PATH } });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout, expected);
});

test('env: uses the current profile when no name is given, and rejects an unknown explicit name', async (t) => {
  const csmHome = await mkTemp('csm-env2-');
  t.after(() => rmrf(csmHome));
  const env = baseEnv({ csmHome });
  const add = await runCli(['add', 'q', '--no-login'], { env });
  assert.equal(add.code, 0, add.stderr);

  const envLine = await runCli(['env'], { env });
  assert.equal(envLine.code, 0, envLine.stderr);
  const dir = join(csmHome, 'profiles', 'q');
  if (isWin) assert.ok(envLine.stdout.includes(`$env:CLAUDE_CONFIG_DIR = '${dir}'`), envLine.stdout);
  else assert.ok(envLine.stdout.includes(`export CLAUDE_CONFIG_DIR='${dir}'`), envLine.stdout);

  const bad = await runCli(['env', 'nope'], { env });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Profile "nope" not found/);
});

test('run: warns on ANTHROPIC_BASE_URL and on an empty-looking-but-set token like "0"', async (t) => {
  const csmHome = await mkTemp('csm-warn-');
  t.after(() => rmrf(csmHome));
  const env = baseEnv({ csmHome, extra: { ANTHROPIC_BASE_URL: 'https://proxy.example', ANTHROPIC_API_KEY: '0' } });
  await runCli(['add', 'p', '--no-login'], { env });
  const res = await runCli(['run'], { env });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stderr, /ANTHROPIC_BASE_URL .*endpoint/);
  assert.match(res.stderr, /ANTHROPIC_API_KEY is set/);

  const quiet = await runCli(['run'], { env: baseEnv({ csmHome, extra: { CLAUDE_CODE_USE_BEDROCK: '0' } }) });
  assert.doesNotMatch(quiet.stderr, /warning/);
});

test('run: warns when the profile settings.json sets apiKeyHelper or an override env var', async (t) => {
  const csmHome = await mkTemp('csm-warn2-');
  t.after(() => rmrf(csmHome));
  const env = baseEnv({ csmHome });
  await runCli(['add', 'p', '--no-login'], { env });
  await writeFile(
    join(csmHome, 'profiles', 'p', 'settings.json'),
    JSON.stringify({ apiKeyHelper: '/bin/get-key', env: { ANTHROPIC_AUTH_TOKEN: 'x', UNRELATED: 'y' } }),
  );
  const res = await runCli(['run'], { env });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stderr, /settings\.json sets apiKeyHelper, env\.ANTHROPIC_AUTH_TOKEN;/);
  assert.doesNotMatch(res.stderr, /UNRELATED/);
});

test('run: boolean switches only warn for 1/true/yes/on; settings.json env uses the same rule', async (t) => {
  const csmHome = await mkTemp('csm-bool-');
  t.after(() => rmrf(csmHome));
  const env = baseEnv({ csmHome });
  await runCli(['add', 'p', '--no-login'], { env });

  for (const v of ['false', 'no', 'off', '0', '']) {
    const res = await runCli(['run'], { env: baseEnv({ csmHome, extra: { CLAUDE_CODE_USE_BEDROCK: v } }) });
    assert.doesNotMatch(res.stderr, /warning/, `value ${JSON.stringify(v)}`);
  }
  for (const v of ['1', 'TRUE', ' yes ', 'On']) {
    const res = await runCli(['run'], { env: baseEnv({ csmHome, extra: { CLAUDE_CODE_USE_BEDROCK: v } }) });
    assert.match(res.stderr, /CLAUDE_CODE_USE_BEDROCK is set/, `value ${JSON.stringify(v)}`);
  }

  const settings = join(csmHome, 'profiles', 'p', 'settings.json');
  await writeFile(settings, JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: '0', ANTHROPIC_API_KEY: 'k' } }));
  const res = await runCli(['run'], { env });
  assert.match(res.stderr, /sets env\.ANTHROPIC_API_KEY;/);
  assert.doesNotMatch(res.stderr, /env\.CLAUDE_CODE_USE_BEDROCK/);
});
