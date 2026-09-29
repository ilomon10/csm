import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { baseEnv, mkTemp, rmrf, runCli, skipOnWindows } from './support/helpers.mjs';

const START = '# >>> csm >>>';
const count = (s) => s.split(START).length - 1;

const sandbox = async (t, extra = {}) => {
  const dir = await mkTemp('csm-setup-');
  t.after(() => rmrf(dir));
  const home = join(dir, 'home');
  const csmHome = join(dir, 'csm');
  await mkdir(home, { recursive: true });
  const env = baseEnv({ csmHome, home, extra: { SHELL: '/bin/bash', ...extra } });
  return { dir, home, csmHome, env };
};

test('setup twice leaves exactly one block and only backs up on change', async (t) => {
  if (skipOnWindows(t, 'POSIX rc paths')) return;
  const { home, env } = await sandbox(t);
  await writeFile(join(home, '.bashrc'), 'export A=1\n');

  const first = await runCli(['setup', 'bash', '--yes'], { env });
  assert.equal(first.code, 0, first.stderr);
  const once = await readFile(join(home, '.bashrc'), 'utf8');
  assert.equal(count(once), 1);
  assert.match(once, /^export A=1\n\n# >>> csm >>>\n/);
  assert.match(once, /eval "\$\(csm shell-init bash\)"/);
  assert.match(first.stdout, /restart your shell or run: eval/);

  const second = await runCli(['setup', 'bash', '--yes'], { env });
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /already set up/);
  assert.equal(await readFile(join(home, '.bashrc'), 'utf8'), once);
  const baks = (await readdir(home)).filter((f) => f.includes('.csm-bak-'));
  assert.equal(baks.length, 1, 'only the first (changing) run backs up');
  assert.equal(await readFile(join(home, baks[0]), 'utf8'), 'export A=1\n');
});

test('setup detects the shell and rewrites a modified block in place', async (t) => {
  if (skipOnWindows(t, 'POSIX rc paths')) return;
  const { home, env } = await sandbox(t, { SHELL: '/usr/bin/zsh' });
  const zshrc = join(home, '.zshrc');
  await writeFile(zshrc, `before\n${START}\nstale line\n# <<< csm <<<\nafter\n`);
  const res = await runCli(['setup', '--yes'], { env });
  assert.equal(res.code, 0, res.stderr);
  const out = await readFile(zshrc, 'utf8');
  assert.equal(count(out), 1);
  assert.match(out, /^before\n# >>> csm >>>\n/);
  assert.match(out, /shell-init zsh/);
  assert.doesNotMatch(out, /stale line/);
  assert.match(out, /# <<< csm <<<\nafter\n$/);
});

test('setup fish creates conf.d/csm.fish; ZDOTDIR and XDG_CONFIG_HOME are honored', async (t) => {
  if (skipOnWindows(t, 'POSIX rc paths')) return;
  const { dir, env } = await sandbox(t);
  const xdg = join(dir, 'xdg');
  const zdot = join(dir, 'zdot');
  await mkdir(zdot);
  const fishEnv = { ...env, XDG_CONFIG_HOME: xdg, ZDOTDIR: zdot };

  assert.equal((await runCli(['setup', 'fish', '--yes'], { env: fishEnv })).code, 0);
  const fish = await readFile(join(xdg, 'fish', 'conf.d', 'csm.fish'), 'utf8');
  assert.match(fish, /if command -q csm; csm shell-init fish \| source; end/);

  assert.equal((await runCli(['setup', 'zsh', '--yes'], { env: fishEnv })).code, 0);
  assert.equal(count(await readFile(join(zdot, '.zshrc'), 'utf8')), 1);
});

test('setup pwsh writes to CSM_PWSH_PROFILE with the Out-String fix', async (t) => {
  const { dir, env } = await sandbox(t);
  const profile = join(dir, 'ps', 'nested', 'profile.ps1');
  const res = await runCli(['setup', 'pwsh', '--yes'], { env: { ...env, CSM_PWSH_PROFILE: profile } });
  assert.equal(res.code, 0, res.stderr);
  const out = await readFile(profile, 'utf8');
  assert.match(out, /csm shell-init pwsh \| Out-String \| Invoke-Expression/);
  assert.equal(count(out), 1);
});

test('setup writes through a symlinked rc file and keeps the link', async (t) => {
  if (skipOnWindows(t, 'symlinks')) return;
  const { dir, home, env } = await sandbox(t);
  const real = join(dir, 'dotfiles', 'bashrc');
  await mkdir(join(dir, 'dotfiles'));
  await writeFile(real, 'export B=2\n');
  await symlink(real, join(home, '.bashrc'));

  const res = await runCli(['setup', 'bash', '--yes'], { env });
  assert.equal(res.code, 0, res.stderr);
  assert.ok((await lstat(join(home, '.bashrc'))).isSymbolicLink());
  assert.equal(count(await readFile(real, 'utf8')), 1);
});

test('setup preserves CRLF line endings of an existing rc file', async (t) => {
  const { dir, env } = await sandbox(t);
  const profile = join(dir, 'profile.ps1');
  await writeFile(profile, 'a\r\nb\r\n');
  const res = await runCli(['setup', 'pwsh', '--yes'], { env: { ...env, CSM_PWSH_PROFILE: profile } });
  assert.equal(res.code, 0, res.stderr);
  const out = await readFile(profile, 'utf8');
  assert.equal(out.replace(/\r\n/g, ''), out.replace(/\r\n/g, '').replace(/\n/g, ''), 'no bare LF');
  assert.match(out, /^a\r\nb\r\n\r\n# >>> csm >>>\r\n/);
});

test('setup without --yes and without a TTY refuses and writes nothing', async (t) => {
  if (skipOnWindows(t, 'POSIX rc paths')) return;
  const { home, env } = await sandbox(t);
  const res = await runCli(['setup', 'bash'], { env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Refusing to modify your shell rc without confirmation. Re-run with --yes./);
  assert.deepEqual(await readdir(home), []);
});

test('setup rejects an unknown shell', async (t) => {
  const { env } = await sandbox(t);
  const res = await runCli(['setup', 'tcsh', '--yes'], { env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Unknown shell "tcsh"/);
});

test('uninstall removes every block, the blank separator line, and deletes csm.fish', async (t) => {
  if (skipOnWindows(t, 'POSIX rc paths')) return;
  const { dir, home, env } = await sandbox(t);
  const xdg = join(dir, 'xdg');
  const profile = join(dir, 'profile.ps1');
  const e = { ...env, XDG_CONFIG_HOME: xdg, CSM_PWSH_PROFILE: profile };
  await writeFile(join(home, '.bashrc'), 'export A=1\n');
  await writeFile(join(home, '.zshrc'), 'export Z=1\n');
  for (const shell of ['bash', 'zsh', 'fish', 'pwsh']) {
    assert.equal((await runCli(['setup', shell, '--yes'], { env: e })).code, 0);
  }

  const res = await runCli(['uninstall', '--yes'], { env: e });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(await readFile(join(home, '.bashrc'), 'utf8'), 'export A=1\n');
  assert.equal(await readFile(join(home, '.zshrc'), 'utf8'), 'export Z=1\n');
  assert.equal(count(await readFile(profile, 'utf8')), 0);
  await assert.rejects(lstat(join(xdg, 'fish', 'conf.d', 'csm.fish')));
  assert.match(res.stdout, /npm rm -g claude-session-manager|Remove the binary/);

  const again = await runCli(['uninstall', '--yes'], { env: e });
  assert.equal(again.code, 0);
  assert.match(again.stdout, /No csm rc blocks found/);
});

test('uninstall --purge --yes removes CSM_HOME but never the ~/.claude target linked into a profile', async (t) => {
  if (skipOnWindows(t, 'symlinks')) return;
  const { home, csmHome, env } = await sandbox(t);
  const claude = join(home, '.claude');
  await mkdir(join(claude, 'skills'), { recursive: true });
  await writeFile(join(claude, 'skills', 'keep.md'), 'precious');
  assert.equal((await runCli(['add', 'p', '--no-login'], { env })).code, 0);
  await mkdir(join(csmHome, 'shared'), { recursive: true });
  await symlink(join(claude, 'skills'), join(csmHome, 'shared', 'skills'));
  await symlink(join(claude, 'skills'), join(csmHome, 'profiles', 'p', 'skills'));

  const res = await runCli(['uninstall', '--purge', '--yes'], { env });
  assert.equal(res.code, 0, res.stderr);
  await assert.rejects(lstat(csmHome));
  assert.equal(await readFile(join(claude, 'skills', 'keep.md'), 'utf8'), 'precious');
});

test('uninstall --purge refuses a directory that does not look like csm data', async (t) => {
  const { csmHome, env } = await sandbox(t);
  await mkdir(csmHome, { recursive: true });
  await writeFile(join(csmHome, 'notes.txt'), 'mine');
  const res = await runCli(['uninstall', '--purge', '--yes'], { env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /does not look like a csm data dir/);
  assert.equal(await readFile(join(csmHome, 'notes.txt'), 'utf8'), 'mine');
});

test('uninstall without --yes and without a TTY is refused', async (t) => {
  const { env } = await sandbox(t);
  const res = await runCli(['uninstall', '--purge'], { env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Refusing to purge .* without confirmation/);
});

test('uninstall --purge refuses a CSM_HOME with shared/ plus unrelated files and deletes nothing', async (t) => {
  const { home, csmHome, env } = await sandbox(t);
  await mkdir(join(csmHome, 'shared'), { recursive: true });
  await writeFile(join(csmHome, 'shared', 'x.md'), 'x');
  await writeFile(join(csmHome, 'photos.zip'), 'mine');
  await writeFile(join(home, '.bashrc'), 'export A=1\n');
  const res = await runCli(['uninstall', '--purge', '--yes'], { env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /does not look like a csm data dir/);
  assert.match(res.stderr, /photos\.zip/);
  assert.equal(await readFile(join(csmHome, 'photos.zip'), 'utf8'), 'mine');
  assert.equal(await readFile(join(csmHome, 'shared', 'x.md'), 'utf8'), 'x');
});

test('a refused purge leaves every rc file untouched (preflight runs before rc edits)', async (t) => {
  if (skipOnWindows(t, 'POSIX rc paths')) return;
  const { home, csmHome, env } = await sandbox(t);
  await writeFile(join(home, '.bashrc'), 'export A=1\n');
  assert.equal((await runCli(['setup', 'bash', '--yes'], { env })).code, 0);
  const before = await readFile(join(home, '.bashrc'), 'utf8');
  const baks = (await readdir(home)).length;
  await mkdir(csmHome, { recursive: true });
  await writeFile(join(csmHome, 'notes.txt'), 'mine');

  const res = await runCli(['uninstall', '--purge', '--yes'], { env });
  assert.equal(res.code, 1);
  assert.equal(await readFile(join(home, '.bashrc'), 'utf8'), before);
  assert.equal((await readdir(home)).length, baks, 'no new backup files');
});

const utf16 = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);

test('setup and uninstall refuse a UTF-16 PowerShell profile without touching anything', async (t) => {
  if (skipOnWindows(t, 'POSIX rc paths')) return;
  const { dir, home, env } = await sandbox(t);
  const profile = join(dir, 'profile.ps1');
  const e = { ...env, CSM_PWSH_PROFILE: profile };
  const raw = utf16('Write-Host hi\r\n');
  await writeFile(profile, raw);
  await writeFile(join(home, '.bashrc'), 'export A=1\n');
  assert.equal((await runCli(['setup', 'bash', '--yes'], { env: e })).code, 0);
  const bashrc = await readFile(join(home, '.bashrc'), 'utf8');

  const set = await runCli(['setup', 'pwsh', '--yes'], { env: e });
  assert.equal(set.code, 1);
  assert.match(set.stderr, /not UTF-8.*Re-save it as UTF-8/);
  assert.deepEqual(await readFile(profile), raw);

  const un = await runCli(['uninstall', '--yes'], { env: e });
  assert.equal(un.code, 1);
  assert.match(un.stderr, /Re-save it as UTF-8/);
  assert.equal(await readFile(join(home, '.bashrc'), 'utf8'), bashrc, 'other rc files stay untouched');

  await writeFile(profile, Buffer.from('a\0b\0'));
  assert.equal((await runCli(['setup', 'pwsh', '--yes'], { env: e })).code, 1, 'NUL bytes are refused too');
});

test('setup preserves a UTF-8 BOM', async (t) => {
  const { dir, env } = await sandbox(t);
  const profile = join(dir, 'profile.ps1');
  await writeFile(profile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\n')]));
  const e = { ...env, CSM_PWSH_PROFILE: profile };
  assert.equal((await runCli(['setup', 'pwsh', '--yes'], { env: e })).code, 0);
  const raw = await readFile(profile);
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(raw.subarray(3).toString('utf8').startsWith('a\n'), true);
  assert.equal(count(raw.toString('utf8')), 1);
  assert.equal((await runCli(['uninstall', '--yes'], { env: e })).code, 0);
  const after = await readFile(profile);
  assert.deepEqual([...after.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(after.subarray(3).toString('utf8'), 'a\n');
});

test('setup does not create CSM_HOME when it does not exist', async (t) => {
  if (skipOnWindows(t, 'POSIX rc paths')) return;
  const { csmHome, env } = await sandbox(t);
  assert.equal((await runCli(['setup', 'bash', '--yes'], { env })).code, 0);
  await assert.rejects(lstat(csmHome), { code: 'ENOENT' });
});

test('uninstall deletes a symlinked csm.fish via its resolved target (backup kept)', async (t) => {
  if (skipOnWindows(t, 'symlinks')) return;
  const { dir, env } = await sandbox(t);
  const xdg = join(dir, 'xdg');
  const e = { ...env, XDG_CONFIG_HOME: xdg };
  const real = join(dir, 'dotfiles', 'csm.fish');
  await mkdir(join(dir, 'dotfiles'));
  await mkdir(join(xdg, 'fish', 'conf.d'), { recursive: true });
  await writeFile(real, '');
  await symlink(real, join(xdg, 'fish', 'conf.d', 'csm.fish'));
  assert.equal((await runCli(['setup', 'fish', '--yes'], { env: e })).code, 0);
  const res = await runCli(['uninstall', '--yes'], { env: e });
  assert.equal(res.code, 0, res.stderr);
  await assert.rejects(lstat(real), { code: 'ENOENT' });
  assert.ok((await readdir(join(dir, 'dotfiles'))).some((f) => f.includes('.csm-bak-')));
});
