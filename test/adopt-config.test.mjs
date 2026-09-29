import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { link, lstat, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { baseEnv, isWin, mkTemp, mkdir, readFile, rmrf, runCli, sameTarget, skipUnlessSymlink, writeFile } from './support/helpers.mjs';

/** Temp HOME with a populated ~/.claude, a CSM_HOME inside it, and one profile "p" with local copies. */
const setup = async (t) => {
  const home = await mkTemp('csm-adopt-');
  t.after(() => rmrf(home));
  const csmHome = join(home, '.claude-sessions');
  const env = baseEnv({ csmHome, home });
  const main = join(home, '.claude');
  await mkdir(join(main, 'skills', 'my-skill'), { recursive: true });
  await writeFile(join(main, 'skills', 'my-skill', 'SKILL.md'), 'skill');
  await mkdir(join(main, 'agents'));
  await writeFile(join(main, 'agents', 'dev.md'), 'agent');
  await writeFile(join(main, 'settings.json'), '{"main":true}');
  const res = await runCli(['add', 'p', '--no-login'], { env });
  assert.equal(res.code, 0, res.stderr);
  const profile = join(csmHome, 'profiles', 'p');
  await writeFile(join(profile, 'settings.json'), '{"theme":"dark"}');
  await mkdir(join(profile, 'skills', 'synced'), { recursive: true });
  return { home, csmHome, env, main, profile };
};

test('adopt-config links shared/ to ~/.claude and relinks profile copies with backups', async (t) => {
  if (await skipUnlessSymlink(t)) return;
  const { csmHome, env, main, profile } = await setup(t);
  const res = await runCli(['adopt-config'], { env });
  assert.equal(res.code, 0, res.stderr);

  for (const item of ['settings.json', 'agents', 'skills']) {
    assert.ok(await sameTarget(join(csmHome, 'shared', item), join(main, item)), item);
    assert.ok((await lstat(join(profile, item))).isSymbolicLink(), item);
    assert.equal(await realpath(join(profile, item)), await realpath(join(main, item)));
  }
  assert.equal(await readFile(join(profile, 'skills', 'my-skill', 'SKILL.md'), 'utf8'), 'skill');
  const entries = await readdir(profile);
  assert.ok(entries.some((e) => e.startsWith('settings.json.csm-bak-')), entries.join());
  assert.ok(entries.some((e) => e.startsWith('skills.csm-bak-')), entries.join());
  // Without --history, transcripts stay per-profile.
  assert.ok(!(await readdir(join(csmHome, 'shared'))).includes('projects'));

  const sync = await runCli(['sync'], { env });
  assert.equal(sync.stderr, '');

  const again = await runCli(['adopt-config'], { env });
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /shared\/skills: already linked/);
  assert.match(again.stdout, /p: up to date/);
});

test('adopt-config never overwrites a shared item that points elsewhere', async (t) => {
  const { csmHome, env } = await setup(t);
  await mkdir(join(csmHome, 'shared'), { recursive: true });
  await writeFile(join(csmHome, 'shared', 'settings.json'), '{"shared":true}');
  const res = await runCli(['adopt-config'], { env });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /shared\/settings\.json: skipped/);
  assert.equal(await readFile(join(csmHome, 'shared', 'settings.json'), 'utf8'), '{"shared":true}');
});

test('adopt-config --history merges projects no-clobber and pools history.jsonl', async (t) => {
  if (await skipUnlessSymlink(t)) return;
  const { csmHome, env, main, profile } = await setup(t);
  await mkdir(join(main, 'projects', 'proj-a', 'memory'), { recursive: true });
  await writeFile(join(main, 'projects', 'proj-a', 'memory', 'MEMORY.md'), 'main memory');
  await writeFile(join(main, 'history.jsonl'), '{"n":1}');
  await mkdir(join(profile, 'projects', 'proj-a', 'memory'), { recursive: true });
  await writeFile(join(profile, 'projects', 'proj-a', 'memory', 'MEMORY.md'), 'profile memory');
  await writeFile(join(profile, 'projects', 'proj-a', 'memory', 'note.md'), 'note');
  await writeFile(join(profile, 'projects', 'proj-a', 'uuid.jsonl'), 'transcript');
  await mkdir(join(profile, 'projects', 'proj-b'));
  await writeFile(join(profile, 'history.jsonl'), '{"n":2}\n');

  const res = await runCli(['adopt-config', '--history'], { env });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /1 colliding file\(s\) kept in .*projects\.csm-bak-\d+: proj-a\/memory\/MEMORY\.md/);

  assert.equal(await readFile(join(main, 'projects', 'proj-a', 'memory', 'MEMORY.md'), 'utf8'), 'main memory');
  assert.equal(await readFile(join(main, 'projects', 'proj-a', 'memory', 'note.md'), 'utf8'), 'note');
  assert.equal(await readFile(join(main, 'projects', 'proj-a', 'uuid.jsonl'), 'utf8'), 'transcript');
  assert.ok((await lstat(join(main, 'projects', 'proj-b'))).isDirectory());
  assert.equal(await readFile(join(main, 'history.jsonl'), 'utf8'), '{"n":1}\n{"n":2}\n');

  const backup = (await readdir(profile)).find((e) => e.startsWith('projects.csm-bak-'));
  assert.equal(await readFile(join(profile, backup, 'proj-a', 'memory', 'MEMORY.md'), 'utf8'), 'profile memory');
  assert.deepEqual(await readdir(join(profile, backup, 'proj-a')), ['memory']);

  for (const item of ['projects', 'history.jsonl']) {
    assert.ok(await sameTarget(join(csmHome, 'shared', item), join(main, item)), item);
    assert.equal(await realpath(join(profile, item)), await realpath(join(main, item)));
  }
});

test('adopt-config --dry-run changes nothing', async (t) => {
  const { csmHome, env, profile } = await setup(t);
  await mkdir(join(profile, 'projects', 'x'), { recursive: true });
  const before = (await readdir(profile)).sort();
  const res = await runCli(['adopt-config', '--history', '--dry-run'], { env });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /\[dry run\]/);
  assert.match(res.stdout, /would back up its own settings\.json and link it/);
  assert.deepEqual((await readdir(profile)).sort(), before);
  assert.deepEqual(await readdir(join(csmHome, 'shared')), []);
  assert.ok((await lstat(join(profile, 'settings.json'))).isFile());
});

test('adopt-config refuses a source inside the csm data dir', async (t) => {
  const { env, profile } = await setup(t);
  const res = await runCli(['adopt-config', '--from', profile], { env });
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /inside csm's data dir/);
});

test('adopt-config --history refuses when shared/projects points elsewhere', async (t) => {
  const { csmHome, env, home } = await setup(t);
  const other = join(home, 'other-projects');
  await mkdir(other);
  await mkdir(join(csmHome, 'shared'), { recursive: true });
  await symlink(other, join(csmHome, 'shared', 'projects'), isWin ? 'junction' : 'dir');
  const res = await runCli(['adopt-config', '--history'], { env });
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /merge it by hand/);
});

test('adopt-config --history rerun works in hardlink mode and never appends a history file to itself', async (t) => {
  if (await skipUnlessSymlink(t)) return;
  const { csmHome, env, main, profile } = await setup(t);
  await writeFile(join(main, 'history.jsonl'), '{"n":1}\n');
  await writeFile(join(profile, 'history.jsonl'), '{"n":2}\n');
  const first = await runCli(['adopt-config', '--history'], { env });
  assert.equal(first.code, 0, first.stderr);
  assert.equal(await readFile(join(main, 'history.jsonl'), 'utf8'), '{"n":1}\n{"n":2}\n');

  // What the hardlink fallback leaves behind (no symlink rights): same file, not the same path.
  const shared = join(csmHome, 'shared', 'history.jsonl');
  await rm(shared);
  await link(join(main, 'history.jsonl'), shared);
  await rm(join(profile, 'history.jsonl'));
  await link(shared, join(profile, 'history.jsonl'));

  const baks = async () => (await readdir(profile)).filter((e) => e.startsWith('history.jsonl.csm-bak-')).length;
  const bakCount = await baks();
  const again = await runCli(['adopt-config', '--history'], { env });
  assert.equal(again.code, 0, again.stderr);
  assert.doesNotMatch(again.stderr, /merge it by hand/);
  assert.equal(await readFile(join(main, 'history.jsonl'), 'utf8'), '{"n":1}\n{"n":2}\n', 'no self-append');
  assert.equal(await baks(), bakCount, 'no backup of a file that is the source');

  // Source history hardlinked straight into the profile (never went through shared/): still skipped.
  await rm(join(profile, 'history.jsonl'));
  await link(join(main, 'history.jsonl'), join(profile, 'history.jsonl'));
  const third = await runCli(['adopt-config', '--history'], { env });
  assert.equal(third.code, 0, third.stderr);
  assert.equal(await readFile(join(main, 'history.jsonl'), 'utf8'), '{"n":1}\n{"n":2}\n');
});

test('adopt-config records adoptedFrom + adoptedItems even when an item was skipped', async (t) => {
  const { csmHome, env, main } = await setup(t);
  await mkdir(join(csmHome, 'shared'), { recursive: true });
  await writeFile(join(csmHome, 'shared', 'settings.json'), '{"shared":true}'); // hand-placed
  const res = await runCli(['adopt-config'], { env });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /shared\/settings\.json: skipped/);
  const state = JSON.parse(await readFile(join(csmHome, 'state.json'), 'utf8'));
  assert.equal(state.adoptedFrom, main);
  assert.deepEqual(state.adoptedItems.sort(), ['agents', 'skills']);
  // The hand-placed file is never reported stale, even though it differs from the source.
  const sync = await runCli(['sync'], { env });
  assert.doesNotMatch(sync.stdout + sync.stderr, /stale/);
});
