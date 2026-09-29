import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { baseEnv, hasCommand, mkTemp, pathWith, readLog, rmrf, runCli, skipOnWindows, spawnCapture, writeCsmShim } from './support/helpers.mjs';

const setup = async (t) => {
  const csmHome = await mkTemp('csm-shellinit-');
  // csmHome must hold only csm's own files, so the shim and log live in a separate dir.
  const work = await mkTemp('csm-shellinit-work-');
  const binDir = join(work, 'bin');
  t.after(() => Promise.all([rmrf(csmHome), rmrf(work)]));
  await writeCsmShim(binDir);
  const testLog = join(work, 'claude.log');
  const env = baseEnv({
    csmHome,
    extra: { CSM_TEST_LOG: testLog, PATH: pathWith(binDir) },
  });
  return { csmHome, binDir, testLog, env };
};

for (const shellBin of ['bash', 'zsh']) {
  test(`shell-init (${shellBin}): plain \`claude\` follows the current profile, args and exit code intact`, async (t) => {
    if (skipOnWindows(t, 'POSIX shell wrapper')) return;
    if (!hasCommand(shellBin)) {
      t.skip(`${shellBin} not installed`);
      return;
    }
    const { env, testLog } = await setup(t);
    const script = `
      csm add p --no-login >/dev/null || { echo SETUP_FAILED; exit 1; }
      csm use p >/dev/null || { echo SETUP_FAILED; exit 1; }
      eval "$(csm shell-init ${shellBin === 'zsh' ? 'zsh' : 'bash'})"
      FAKE_CLAUDE_EXIT_CODE=5 claude 'x y' ''
      echo "EXITCODE:$?"
    `;
    const res = await spawnCapture(shellBin, ['-c', script], { env });
    assert.equal(res.code, 0, `wrapper script itself should not fail: ${res.stderr}`);
    assert.match(res.stdout, /EXITCODE:5/);

    const [record] = await readLog(testLog);
    assert.deepEqual(record.argv, ['x y', '']);
    assert.equal(record.env.CLAUDE_CONFIG_DIR, join(env.CSM_HOME, 'profiles', 'p'));
  });
}

test('shell-init (fish): plain `claude` follows the current profile, args and exit code intact', async (t) => {
  if (skipOnWindows(t, 'POSIX shell wrapper')) return;
  if (!hasCommand('fish')) {
    t.skip('fish not installed');
    return;
  }
  const { env, testLog } = await setup(t);
  const script = `
    csm add p --no-login >/dev/null
    csm use p >/dev/null
    csm shell-init fish | source
    set -x FAKE_CLAUDE_EXIT_CODE 5
    claude 'x y' ''
    echo "EXITCODE:$status"
  `;
  const res = await spawnCapture('fish', ['-c', script], { env });
  assert.equal(res.code, 0, `wrapper script itself should not fail: ${res.stderr}`);
  assert.match(res.stdout, /EXITCODE:5/);

  const [record] = await readLog(testLog);
  assert.deepEqual(record.argv, ['x y', '']);
  assert.equal(record.env.CLAUDE_CONFIG_DIR, join(env.CSM_HOME, 'profiles', 'p'));
});

test('shell-init (pwsh): plain `claude` follows the current profile, args and exit code intact', async (t) => {
  if (!hasCommand('pwsh')) {
    t.skip('pwsh not installed');
    return;
  }
  const { env, testLog } = await setup(t);
  const script = `
    csm add p --no-login | Out-Null
    csm use p | Out-Null
    (csm shell-init pwsh | Out-String) | Invoke-Expression
    $env:FAKE_CLAUDE_EXIT_CODE = '5'
    claude 'x y' ''
    "EXITCODE:$LASTEXITCODE"
    "PS73:$($PSVersionTable.PSVersion -ge [version]'7.3')"
  `;
  const res = await spawnCapture('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { env });
  assert.equal(res.code, 0, `wrapper script itself should not fail: ${res.stderr}`);
  assert.match(res.stdout, /EXITCODE:5/);

  const [record] = await readLog(testLog);
  assert.ok(record.argv.includes('x y'));
  // Older PowerShell drops empty-string args to native commands; 7.3+ passes them through.
  if (/PS73:True/.test(res.stdout)) assert.deepEqual(record.argv, ['x y', '']);
  assert.equal(record.env.CLAUDE_CONFIG_DIR, join(env.CSM_HOME, 'profiles', 'p'));
});

test('shell-init: unknown shell name is rejected', async (t) => {
  const { env } = await setup(t);
  const res = await runCli(['shell-init', 'bogus'], { env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Unknown shell "bogus"\. Supported: bash, zsh, fish, pwsh\./);
});
