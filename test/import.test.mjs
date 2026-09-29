import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { baseEnv, isWin, mkTemp, rmrf, runCli, skipOnWindows } from './support/helpers.mjs';

const DUMMY_CREDS = JSON.stringify({ accessToken: 'dummy-token-not-real' });
const claudeJson = (email) => JSON.stringify({ oauthAccount: { emailAddress: email } });

const modeOf = async (path) => (await stat(path)).mode & 0o777;

test('import: copies .credentials.json + .claude.json from $HOME/.claude, chmod 0600, email shows in list', async (t) => {
  const csmHome = await mkTemp('csm-import-home-');
  const fakeHome = await mkTemp('csm-import-fakehome-');
  t.after(() => Promise.all([rmrf(csmHome), rmrf(fakeHome)]));

  await mkdir(join(fakeHome, '.claude'), { recursive: true });
  await writeFile(join(fakeHome, '.claude', '.credentials.json'), DUMMY_CREDS);
  await writeFile(join(fakeHome, '.claude.json'), claudeJson('qa-import-test@example.com'));

  const env = baseEnv({ csmHome, home: fakeHome });
  const res = await runCli(['import', 'imported'], { env });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /Imported profile "imported" at/);
  assert.match(res.stdout, /"imported" is now the current profile\./);

  const dir = join(csmHome, 'profiles', 'imported');
  // Windows has no POSIX modes: stat() reports 0o666 regardless of chmod.
  if (!isWin) {
    assert.equal(await modeOf(join(dir, '.credentials.json')), 0o600);
    assert.equal(await modeOf(join(dir, '.claude.json')), 0o600);
  }

  const list = await runCli(['list'], { env });
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /imported\s+qa-import-test@example\.com/);
});

test('import: respects an inherited CLAUDE_CONFIG_DIR (creds + state file alongside each other)', async (t) => {
  const csmHome = await mkTemp('csm-import-home2-');
  const fakeHome = await mkTemp('csm-import-fakehome2-');
  const externalConfigDir = await mkTemp('csm-import-external-');
  t.after(() => Promise.all([rmrf(csmHome), rmrf(fakeHome), rmrf(externalConfigDir)]));

  await writeFile(join(externalConfigDir, '.credentials.json'), DUMMY_CREDS);
  await writeFile(join(externalConfigDir, '.claude.json'), claudeJson('other@example.com'));

  const env = baseEnv({ csmHome, home: fakeHome, extra: { CLAUDE_CONFIG_DIR: externalConfigDir } });
  const res = await runCli(['import', 'ext'], { env });
  assert.equal(res.code, 0, res.stderr);

  const list = await runCli(['list'], { env });
  assert.match(list.stdout, /ext\s+other@example\.com/);
});

test('import: missing credentials file errors clearly and leaves no partial profile dir', async (t) => {
  const csmHome = await mkTemp('csm-import-home3-');
  const fakeHome = await mkTemp('csm-import-fakehome3-');
  t.after(() => Promise.all([rmrf(csmHome), rmrf(fakeHome)]));
  // No .claude/.credentials.json at all.

  const env = baseEnv({ csmHome, home: fakeHome });
  const res = await runCli(['import', 'nope'], { env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /No file-based login found at/);
  assert.match(res.stderr, /\.credentials\.json/);

  const dir = join(csmHome, 'profiles', 'nope');
  await assert.rejects(stat(dir), /ENOENT/);
});

test('import: missing .claude.json (state file) errors clearly and leaves no partial profile dir', async (t) => {
  const csmHome = await mkTemp('csm-import-home4-');
  const fakeHome = await mkTemp('csm-import-fakehome4-');
  t.after(() => Promise.all([rmrf(csmHome), rmrf(fakeHome)]));

  await mkdir(join(fakeHome, '.claude'), { recursive: true });
  await writeFile(join(fakeHome, '.claude', '.credentials.json'), DUMMY_CREDS);
  // No ~/.claude.json.

  const env = baseEnv({ csmHome, home: fakeHome });
  const res = await runCli(['import', 'nope2'], { env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /No account state file found at/);

  const dir = join(csmHome, 'profiles', 'nope2');
  await assert.rejects(stat(dir), /ENOENT/);
});

test('import: a mid-copy failure cleans up the partially-created profile dir (atomic on error)', async (t) => {
  const csmHome = await mkTemp('csm-import-home5-');
  const fakeHome = await mkTemp('csm-import-fakehome5-');
  t.after(() => Promise.all([rmrf(csmHome), rmrf(fakeHome)]));

  await mkdir(join(fakeHome, '.claude'), { recursive: true });
  await writeFile(join(fakeHome, '.claude', '.credentials.json'), DUMMY_CREDS);
  // Make the "state file" a directory instead of a file, so copyFile fails after the profile
  // dir has already been created (exercises import.ts's cleanup-on-error path).
  await mkdir(join(fakeHome, '.claude.json'), { recursive: true });

  const env = baseEnv({ csmHome, home: fakeHome });
  const res = await runCli(['import', 'partial'], { env });
  assert.notEqual(res.code, 0); // a raw EISDIR is an unexpected error (exit 2), not a CsmError

  const dir = join(csmHome, 'profiles', 'partial');
  await assert.rejects(stat(dir), /ENOENT/, 'profile dir must not survive a failed import');
});

test('import: refuses to clobber an existing profile', async (t) => {
  const csmHome = await mkTemp('csm-import-home6-');
  const fakeHome = await mkTemp('csm-import-fakehome6-');
  t.after(() => Promise.all([rmrf(csmHome), rmrf(fakeHome)]));

  await mkdir(join(fakeHome, '.claude'), { recursive: true });
  await writeFile(join(fakeHome, '.claude', '.credentials.json'), DUMMY_CREDS);
  await writeFile(join(fakeHome, '.claude.json'), claudeJson('a@example.com'));

  const env = baseEnv({ csmHome, home: fakeHome });
  await runCli(['add', 'dup', '--no-login'], { env });
  const res = await runCli(['import', 'dup'], { env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Profile "dup" already exists\./);
});

test('import: refuses to copy a login out of another csm profile unless --force', async (t) => {
  const csmHome = await mkTemp('csm-import-home7-');
  t.after(() => rmrf(csmHome));
  const env = baseEnv({ csmHome });
  await runCli(['add', 'src', '--no-login'], { env });
  const srcDir = join(csmHome, 'profiles', 'src');
  await writeFile(join(srcDir, '.credentials.json'), DUMMY_CREDS);
  await writeFile(join(srcDir, '.claude.json'), claudeJson('src@example.com'));

  const withDir = { ...env, CLAUDE_CONFIG_DIR: srcDir };
  const res = await runCli(['import', 'copy'], { env: withDir });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /already a csm profile/);
  await assert.rejects(stat(join(csmHome, 'profiles', 'copy')), /ENOENT/);

  const forced = await runCli(['import', 'copy', '--force'], { env: withDir });
  assert.equal(forced.code, 0, forced.stderr);
});

test('import --move: removes the source credentials only after a successful import; default prints a sharing note', async (t) => {
  const csmHome = await mkTemp('csm-import-home8-');
  const fakeHome = await mkTemp('csm-import-fakehome8-');
  t.after(() => Promise.all([rmrf(csmHome), rmrf(fakeHome)]));
  await mkdir(join(fakeHome, '.claude'), { recursive: true });
  const creds = join(fakeHome, '.claude', '.credentials.json');
  await writeFile(creds, DUMMY_CREDS);
  await writeFile(join(fakeHome, '.claude.json'), claudeJson('m@example.com'));
  const env = baseEnv({ csmHome, home: fakeHome });

  const copied = await runCli(['import', 'a'], { env });
  assert.equal(copied.code, 0, copied.stderr);
  assert.match(copied.stderr, /still holds the same login/);
  await stat(creds); // still there

  const moved = await runCli(['import', 'b', '--move'], { env });
  assert.equal(moved.code, 0, moved.stderr);
  assert.match(moved.stdout, /Moved the login out of/);
  await assert.rejects(stat(creds), /ENOENT/);
  await stat(join(csmHome, 'profiles', 'b', '.credentials.json'));

  const bad = await runCli(['import', 'c', '--bogus'], { env });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Unknown flag/);
});

test('import: an existing profile dir is never deleted by a failed import (non-recursive mkdir)', async (t) => {
  const csmHome = await mkTemp('csm-import-home9-');
  const fakeHome = await mkTemp('csm-import-fakehome9-');
  t.after(() => Promise.all([rmrf(csmHome), rmrf(fakeHome)]));
  await mkdir(join(fakeHome, '.claude'), { recursive: true });
  await writeFile(join(fakeHome, '.claude', '.credentials.json'), DUMMY_CREDS);
  await writeFile(join(fakeHome, '.claude.json'), claudeJson('x@example.com'));
  const env = baseEnv({ csmHome, home: fakeHome });

  // A dir that isn't a valid-looking profile yet (e.g. mid-creation by another run).
  const dir = join(csmHome, 'profiles', 'racy');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'keep.txt'), 'mine');

  const res = await runCli(['import', 'racy'], { env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /already exists/);
  await stat(join(dir, 'keep.txt'));
});

test('import: guard follows symlinks when CSM_HOME is a symlink and CLAUDE_CONFIG_DIR is the real profile path', async (t) => {
  const realHome = await mkTemp('csm-import-real-');
  const linkParent = await mkTemp('csm-import-linkparent-');
  t.after(() => Promise.all([rmrf(realHome), rmrf(linkParent)]));
  const csmHome = join(linkParent, 'link');
  // A junction needs no privileges on Windows; elsewhere the type argument is ignored.
  await symlink(realHome, csmHome, isWin ? 'junction' : 'dir');
  const env = baseEnv({ csmHome });
  await runCli(['add', 'src', '--no-login'], { env });
  const realSrc = join(realHome, 'profiles', 'src');
  await writeFile(join(realSrc, '.credentials.json'), DUMMY_CREDS);
  await writeFile(join(realSrc, '.claude.json'), claudeJson('src@example.com'));

  const res = await runCli(['import', 'copy'], { env: { ...env, CLAUDE_CONFIG_DIR: realSrc } });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /already a csm profile/);
  await assert.rejects(stat(join(realHome, 'profiles', 'copy')), /ENOENT/);
});

test('import --move: failure to remove the source credentials is a clear CsmError, profile is kept', async (t) => {
  if (skipOnWindows(t, 'directory permission bits do not block unlink on Windows')) return;
  const csmHome = await mkTemp('csm-import-home10-');
  const fakeHome = await mkTemp('csm-import-fakehome10-');
  t.after(async () => {
    await chmod(join(fakeHome, '.claude'), 0o700).catch(() => {});
    await Promise.all([rmrf(csmHome), rmrf(fakeHome)]);
  });
  const cfg = join(fakeHome, '.claude');
  await mkdir(cfg, { recursive: true });
  await writeFile(join(cfg, '.credentials.json'), DUMMY_CREDS);
  await writeFile(join(fakeHome, '.claude.json'), claudeJson('m@example.com'));
  await chmod(cfg, 0o500); // readable, but entries can't be unlinked
  const env = baseEnv({ csmHome, home: fakeHome });

  const res = await runCli(['import', 'kept', '--move'], { env });
  if (process.getuid?.() === 0) return; // root ignores dir permissions
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Profile "kept" was imported, but the source credentials at .*\.credentials\.json could not be removed/);
  assert.doesNotMatch(res.stderr, /\n\s+at /);
  await stat(join(csmHome, 'profiles', 'kept', '.credentials.json'));
});

test('import: into a pre-existing empty 0755 CSM_HOME tightens it to 0700 and writes the marker', async (t) => {
  if (skipOnWindows(t, 'POSIX modes')) return;
  const csmHome = await mkTemp('csm-import-home11-');
  const fakeHome = await mkTemp('csm-import-fakehome11-');
  t.after(() => Promise.all([rmrf(csmHome), rmrf(fakeHome)]));
  await chmod(csmHome, 0o755);
  await mkdir(join(fakeHome, '.claude'), { recursive: true });
  await writeFile(join(fakeHome, '.claude', '.credentials.json'), DUMMY_CREDS);
  await writeFile(join(fakeHome, '.claude.json'), claudeJson('imp@example.com'));
  const res = await runCli(['import', 'imp'], { env: baseEnv({ csmHome, home: fakeHome }) });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(await modeOf(csmHome), 0o700);
  assert.ok((await stat(join(csmHome, '.csm-home'))).isFile());
});

test('import: a foreign non-empty CSM_HOME is refused and left untouched', async (t) => {
  const csmHome = await mkTemp('csm-import-home12-');
  const fakeHome = await mkTemp('csm-import-fakehome12-');
  t.after(() => Promise.all([rmrf(csmHome), rmrf(fakeHome)]));
  await writeFile(join(csmHome, 'thesis.txt'), 'precious');
  await mkdir(join(fakeHome, '.claude'), { recursive: true });
  await writeFile(join(fakeHome, '.claude', '.credentials.json'), DUMMY_CREDS);
  await writeFile(join(fakeHome, '.claude.json'), claudeJson('imp@example.com'));
  const res = await runCli(['import', 'imp'], { env: baseEnv({ csmHome, home: fakeHome }) });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /not a csm data dir/);
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(csmHome), ['thesis.txt']);
});
