import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { lstat, readdir, symlink } from 'node:fs/promises';
import { baseEnv, isWin, mkTemp, mkdir, rmrf, runCli, sameTarget, skipUnlessSymlink, writeFile } from './support/helpers.mjs';

const setup = async (t) => {
  const csmHome = await mkTemp('csm-sync-');
  t.after(() => rmrf(csmHome));
  return { csmHome, env: baseEnv({ csmHome }) };
};

test('sync --repair relinks a foreign symlink without touching its target', async (t) => {
  if (await skipUnlessSymlink(t)) return;
  const { csmHome, env } = await setup(t);
  await mkdir(join(csmHome, 'shared'), { recursive: true });
  await writeFile(join(csmHome, 'shared', 'CLAUDE.md'), 'shared');
  await runCli(['add', 'p', '--no-login'], { env });
  const elsewhere = join(csmHome, 'elsewhere.md');
  await writeFile(elsewhere, 'precious');
  const link = join(csmHome, 'profiles', 'p', 'CLAUDE.md');
  await rmrf(link);
  await symlink(elsewhere, link);

  for (const mode of ['discard', 'adopt']) {
    const res = await runCli(['sync', 'p', `--repair=${mode}`], { env });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /CLAUDE\.md relinked \(was a link to .*elsewhere\.md\)/);
    assert.ok(await sameTarget(link, join(csmHome, 'shared', 'CLAUDE.md')));
    assert.ok((await lstat(elsewhere)).isFile());
    await rmrf(link);
    await symlink(elsewhere, link);
  }
});

test('sync --repair=adopt skips pooled projects, discard still backs up', async (t) => {
  const { csmHome, env } = await setup(t);
  await mkdir(join(csmHome, 'shared', 'projects'), { recursive: true });
  await writeFile(join(csmHome, 'shared', 'projects', 'other.jsonl'), 'x');
  await runCli(['add', 'p', '--no-login'], { env });
  const link = join(csmHome, 'profiles', 'p', 'projects');
  await rmrf(link);
  await mkdir(link);
  await writeFile(join(link, 'mine.jsonl'), 'y');

  const res = await runCli(['sync', 'p', '--repair=adopt'], { env });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /projects skipped/);
  assert.deepEqual(await readdir(join(csmHome, 'shared')), ['projects']);
  assert.deepEqual(await readdir(join(csmHome, 'shared', 'projects')), ['other.jsonl']);

  const res2 = await runCli(['sync', 'p', '--repair=discard'], { env });
  assert.match(res2.stdout, /projects discarded/);
  assert.ok((await lstat(link)).isSymbolicLink());
});

test('share-history rejects a symlinked projects dir', async (t) => {
  const { csmHome, env } = await setup(t);
  await runCli(['add', 'p', '--no-login'], { env });
  const real = join(csmHome, 'real-projects');
  await mkdir(real);
  await symlink(real, join(csmHome, 'profiles', 'p', 'projects'), isWin ? 'junction' : 'dir');
  const res = await runCli(['share-history', 'p'], { env });
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /no real "projects" directory/);
});
