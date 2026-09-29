// Unit tests for the cross-platform fs core (fsx, lock, linkItem, shared status). They import dist/*.js
// directly, so CSM_HOME/HOME must be set before the first import (paths.ts reads them at load time).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { chmod, link, lstat, mkdtemp, mkdir, readFile, readdir, readlink, realpath, rename, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { isWin, rmrf, runCli, baseEnv, sameTarget, skipOnWindows, skipUnlessSymlink } from './support/helpers.mjs';

const HOME = await mkdtemp(join(tmpdir(), 'csm-fscore-'));
const CSM_HOME = join(HOME, '.claude-sessions');
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.CSM_HOME = CSM_HOME;

const fsx = await import('../dist/fsx.js');
const lock = await import('../dist/lock.js');
const profiles = await import('../dist/profiles.js');
const shell = await import('../dist/shell.js');
const { CsmError } = await import('../dist/errors.js');

const fresh = async (t) => {
  const dir = await mkdtemp(join(HOME, 't-'));
  t.after(() => rmrf(dir));
  return dir;
};
/** Resets csm's data dir so each profile-level test starts empty. */
const resetRoot = async (t) => {
  await rmrf(CSM_HOME);
  t.after(() => rmrf(CSM_HOME));
};
const errWith = (code) => Object.assign(new Error(code), { code });

test.after(() => rmrf(HOME));

// ---------------------------------------------------------------- renameRetry

test('renameRetry retries EPERM/EBUSY/EACCES with backoff on win32', async () => {
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls <= 2) throw errWith(calls === 1 ? 'EPERM' : 'EBUSY');
  };
  await fsx.renameRetry('a', 'b', { platform: 'win32', delaysMs: [1, 1, 1], rename: flaky });
  assert.equal(calls, 3);
});

test('renameRetry gives up after the last delay and rethrows the original error', async () => {
  let calls = 0;
  const locked = async () => {
    calls++;
    throw errWith('EACCES');
  };
  await assert.rejects(fsx.renameRetry('a', 'b', { platform: 'win32', delaysMs: [1, 1], rename: locked }), { code: 'EACCES' });
  assert.equal(calls, 3); // first try + one per delay
});

test('renameRetry never retries permission errors on POSIX', async () => {
  let calls = 0;
  const denied = async () => {
    calls++;
    throw errWith('EPERM');
  };
  await assert.rejects(fsx.renameRetry('a', 'b', { platform: 'linux', delaysMs: [1], rename: denied }), { code: 'EPERM' });
  assert.equal(calls, 1);
});

test('renameRetry rethrows other errors unchanged', async () => {
  await assert.rejects(fsx.renameRetry('a', 'b', { platform: 'win32', rename: async () => { throw errWith('ENOENT'); } }), { code: 'ENOENT' });
});

const exdev = async () => {
  throw errWith('EXDEV');
};

test('renameRetry EXDEV falls back to verified copy + remove, links kept verbatim', async (t) => {
  const dir = await fresh(t);
  const src = join(dir, 'src');
  await mkdir(join(src, 'sub'), { recursive: true });
  await writeFile(join(src, 'a.txt'), 'hello');
  await writeFile(join(src, 'sub', 'b.txt'), 'world', { mode: 0o755 });
  const outside = join(dir, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'keep.txt'), 'keep');
  let haveLink = true;
  try {
    await symlink(outside, join(src, 'lnk'), isWin ? 'junction' : 'dir');
  } catch {
    haveLink = false;
  }

  const dst = join(dir, 'dst');
  await fsx.renameRetry(src, dst, { rename: exdev });

  assert.equal(await readFile(join(dst, 'a.txt'), 'utf8'), 'hello');
  assert.equal(await readFile(join(dst, 'sub', 'b.txt'), 'utf8'), 'world');
  if (!isWin) assert.equal((await stat(join(dst, 'sub', 'b.txt'))).mode & 0o777, 0o755);
  await assert.rejects(lstat(src), /ENOENT/);
  if (haveLink) {
    assert.ok((await lstat(join(dst, 'lnk'))).isSymbolicLink());
    assert.equal(await readlink(join(dst, 'lnk')), outside);
  }
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep', 'link target must survive the src removal');
  assert.deepEqual((await readdir(dir)).filter((e) => e.includes('csm-tmp')), []);
});

test('renameRetry EXDEV refuses an existing destination', async (t) => {
  const dir = await fresh(t);
  await writeFile(join(dir, 'src'), 'x');
  await writeFile(join(dir, 'dst'), 'y');
  await assert.rejects(
    fsx.renameRetry(join(dir, 'src'), join(dir, 'dst'), { rename: exdev }),
    (err) => err instanceof CsmError && /across volumes: destination exists/.test(err.message),
  );
  assert.equal(await readFile(join(dir, 'src'), 'utf8'), 'x');
});

test('renameRetry EXDEV: a failed source removal after a good copy says where the data went', async (t) => {
  if (skipOnWindows(t, 'directory permissions differ on Windows')) return;
  if (process.getuid?.() === 0) return t.skip('root ignores directory permissions');
  const dir = await fresh(t);
  const ro = join(dir, 'ro');
  await mkdir(join(ro, 'src'), { recursive: true });
  await writeFile(join(ro, 'src', 'a.txt'), 'a');
  await chmod(ro, 0o500); // src itself cannot be removed from its parent
  const dst = join(dir, 'dst');
  try {
    await assert.rejects(
      fsx.renameRetry(join(ro, 'src'), dst, { rename: exdev }),
      (err) => err instanceof CsmError && err.message.startsWith(`moved to ${dst} but could not remove source ${join(ro, 'src')}: `),
    );
  } finally {
    await chmod(ro, 0o700);
  }
  assert.equal(await readFile(join(dst, 'a.txt'), 'utf8'), 'a');
});

test('renameRetry EXDEV failure leaves src untouched and cleans the tmp copy', async (t) => {
  if (skipOnWindows(t, 'unix sockets are not portable to Windows temp dirs')) return;
  const dir = await fresh(t);
  const src = join(dir, 'src');
  await mkdir(src);
  await writeFile(join(src, 'a.txt'), 'a');
  // A socket cannot be copied, so the fallback must abort halfway through the walk.
  const server = createServer();
  await new Promise((r) => server.listen(join(src, 's.sock'), r));
  t.after(() => server.close());

  await assert.rejects(
    fsx.renameRetry(src, join(dir, 'dst'), { rename: exdev }),
    (err) => err instanceof CsmError && /Could not move .* across volumes: .* Nothing was changed\./.test(err.message),
  );
  assert.equal(await readFile(join(src, 'a.txt'), 'utf8'), 'a');
  assert.deepEqual((await readdir(dir)).sort(), ['src']);
});

test('writeJsonAtomic still round-trips through renameRetry', async (t) => {
  const dir = await fresh(t);
  await fsx.writeJsonAtomic(join(dir, 'x.json'), { a: 1 });
  assert.deepEqual(await fsx.readJson(join(dir, 'x.json')), { a: 1 });
  assert.deepEqual(await readdir(dir), ['x.json']);
});

// ------------------------------------------------------------- removeTreeSafe

test('removeTreeSafe removes links, never their targets', async (t) => {
  if (await skipUnlessSymlink(t)) return;
  const dir = await fresh(t);
  const target = join(dir, 'target');
  await mkdir(join(target, 'deep'), { recursive: true });
  await writeFile(join(target, 'deep', 'f.txt'), 'precious');
  const tree = join(dir, 'tree');
  await mkdir(tree);
  await writeFile(join(tree, 'own.txt'), 'own');
  await symlink(target, join(tree, 'dirlink'), isWin ? 'junction' : 'dir');
  await symlink(join(target, 'deep', 'f.txt'), join(tree, 'filelink'), 'file');

  await fsx.removeTreeSafe(tree);
  await assert.rejects(lstat(tree), /ENOENT/);
  assert.equal(await readFile(join(target, 'deep', 'f.txt'), 'utf8'), 'precious');
});

test('removeTreeSafe: missing path is a no-op, protected paths are refused', async (t) => {
  const dir = await fresh(t);
  await fsx.removeTreeSafe(join(dir, 'nope'));
  await mkdir(join(HOME, '.claude'), { recursive: true });
  await writeFile(join(HOME, '.claude', 'keep'), 'k');
  for (const p of [HOME, join(HOME, '.claude'), join(HOME, '..'), join(HOME, '.claude', '..', '..'), '/']) {
    await assert.rejects(fsx.removeTreeSafe(p), (err) => err instanceof CsmError && /protected path/.test(err.message), p);
  }
  assert.equal(await readFile(join(HOME, '.claude', 'keep'), 'utf8'), 'k');
  assert.ok((await lstat(dir)).isDirectory());
});

test('removeTreeSafe: a symlink alias of home is refused, not just the literal path', async (t) => {
  if (await skipUnlessSymlink(t)) return;
  const dir = await fresh(t);
  const alias = join(dir, 'alias');
  await symlink(HOME, alias, isWin ? 'junction' : 'dir');
  await mkdir(join(HOME, '.claude'), { recursive: true });
  await writeFile(join(HOME, '.claude', 'keep'), 'k');
  for (const p of [join(alias, '.claude'), join(alias, '.claude', 'keep', '..'), join(alias, 'not-yet', '..', '.claude')]) {
    await assert.rejects(fsx.removeTreeSafe(p), (err) => err instanceof CsmError && /protected path/.test(err.message), p);
  }
  assert.equal(await readFile(join(HOME, '.claude', 'keep'), 'utf8'), 'k');
  await fsx.removeTreeSafe(alias); // the link itself is fine to remove
  await assert.rejects(lstat(alias), /ENOENT/);
  assert.ok((await lstat(HOME)).isDirectory());
});

test('csm rm of a profile whose skills/ links to a dir with files keeps that dir', async (t) => {
  if (await skipUnlessSymlink(t)) return;
  await resetRoot(t);
  const env = baseEnv({ csmHome: CSM_HOME, home: HOME });
  const skills = join(HOME, '.claude', 'skills');
  await mkdir(join(skills, 'my-skill'), { recursive: true });
  await writeFile(join(skills, 'my-skill', 'SKILL.md'), 'skill');
  await mkdir(join(CSM_HOME, 'shared'), { recursive: true });
  await symlink(skills, join(CSM_HOME, 'shared', 'skills'), isWin ? 'junction' : 'dir');

  assert.equal((await runCli(['add', 'doomed', '--no-login'], { env })).code, 0);
  assert.ok((await lstat(join(CSM_HOME, 'profiles', 'doomed', 'skills'))).isSymbolicLink());
  const res = await runCli(['rm', 'doomed', '--yes'], { env });
  assert.equal(res.code, 0, res.stderr);
  await assert.rejects(lstat(join(CSM_HOME, 'profiles', 'doomed')), /ENOENT/);
  assert.equal(await readFile(join(skills, 'my-skill', 'SKILL.md'), 'utf8'), 'skill');
});

// --------------------------------------------------------------- sameFile / sameDevice

test('sameFile compares dev+ino and follows links; false when missing', async (t) => {
  const dir = await fresh(t);
  await writeFile(join(dir, 'a'), 'x');
  await link(join(dir, 'a'), join(dir, 'b'));
  await writeFile(join(dir, 'c'), 'x');
  assert.equal(await fsx.sameFile(join(dir, 'a'), join(dir, 'b')), true);
  assert.equal(await fsx.sameFile(join(dir, 'a'), join(dir, 'c')), false);
  assert.equal(await fsx.sameFile(join(dir, 'a'), join(dir, 'missing')), false);
  assert.equal(await fsx.sameDevice(join(dir, 'a'), join(dir, 'not', 'yet', 'there')), true);
});

// ------------------------------------------------------------------- withLock

const lockInfo = (over = {}) => ({
  pid: process.pid,
  host: hostname(),
  startedAt: new Date().toISOString(),
  ts: Date.now(),
  cmd: 'use x',
  token: 'planted',
  ...over,
});

const deadPid = async () => {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise((r) => child.once('exit', r));
  return child.pid;
};

test('withLock: acquires, runs fn, releases; serializes concurrent callers', async (t) => {
  const dir = await fresh(t);
  const path = join(dir, '.lock');
  const order = [];
  const run = (id) =>
    lock.withLock(
      async () => {
        order.push(`in${id}`);
        await new Promise((r) => setTimeout(r, 150));
        order.push(`out${id}`);
        return id;
      },
      { path, waitMs: 5000 },
    );
  assert.deepEqual(await Promise.all([run(1), run(2)]), [1, 2]);
  assert.ok(order.join() === 'in1,out1,in2,out2' || order.join() === 'in2,out2,in1,out1', order.join());
  await assert.rejects(lstat(path), /ENOENT/);
});

test('withLock: a live holder yields LockHeldError naming the pid', async (t) => {
  const dir = await fresh(t);
  const path = join(dir, '.lock');
  await writeFile(path, JSON.stringify(lockInfo({ cmd: 'use' })));
  let ran = false;
  await assert.rejects(
    lock.withLock(async () => { ran = true; }, { path, waitMs: 250 }),
    (err) =>
      err instanceof lock.LockHeldError &&
      err instanceof CsmError &&
      err.message.includes(`pid ${process.pid} on ${hostname()}`) &&
      err.message.includes('running "csm use"') &&
      err.message.includes(path) &&
      err.holder?.token === 'planted',
  );
  assert.equal(ran, false);
  assert.ok(JSON.parse(await readFile(path, 'utf8')).token === 'planted', 'foreign lock is left alone');
});

test('withLock: takes over a dead-pid lock, an old-ts lock and an old unparsable lock', async (t) => {
  const dir = await fresh(t);
  const path = join(dir, '.lock');
  const cases = [
    ['dead pid', async () => writeFile(path, JSON.stringify(lockInfo({ pid: await deadPid() })))],
    ['old ts', async () => writeFile(path, JSON.stringify(lockInfo({ host: 'some-other-host', ts: Date.now() - 60_000 })))],
    [
      'unparsable+old',
      async () => {
        await writeFile(path, '{"pid":');
        const old = new Date(Date.now() - 60_000);
        await utimes(path, old, old);
      },
    ],
  ];
  for (const [label, plant] of cases) {
    await plant();
    const got = await lock.withLock(async () => 'ok', { path, waitMs: 250, staleMs: 30_000 });
    assert.equal(got, 'ok', label);
    await assert.rejects(lstat(path), /ENOENT/, label);
  }
  assert.deepEqual((await readdir(dir)).filter((e) => e.includes('stale')), []);
});

test('withLock: a live same-host pid is never taken over, however old the lock', async (t) => {
  const dir = await fresh(t);
  const path = join(dir, '.lock');
  await writeFile(path, JSON.stringify(lockInfo({ ts: Date.now() - 3_600_000 })));
  await assert.rejects(lock.withLock(async () => 1, { path, waitMs: 150, staleMs: 1000 }), lock.LockHeldError);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).token, 'planted');
});

test('withLock: a live .lock.breaking sub-lock blocks breaking and is named in the error; a crashed one self-heals', async (t) => {
  const dir = await fresh(t);
  const path = join(dir, '.lock');
  const breaking = `${path}.breaking`;
  const planted = JSON.stringify(lockInfo({ pid: await deadPid() }));
  await writeFile(path, planted);
  await writeFile(breaking, '1');
  // A breaker that keeps touching its sub-lock is alive: we wait out breakingStaleMs, then report it.
  const beat = setInterval(() => utimes(breaking, new Date(), new Date()).catch(() => undefined), 40);
  try {
    await assert.rejects(
      lock.withLock(async () => 1, { path, waitMs: 100, breakingStaleMs: 500 }),
      (e) => e instanceof lock.LockHeldError && e.message.includes(`${path}.breaking`),
    );
  } finally {
    clearInterval(beat);
  }
  assert.equal(await readFile(path, 'utf8'), planted, 'stale lock untouched while another breaker holds the sub-lock');
  // Crashed breaker: even with a short waitMs, the wait covers the sub-lock's staleness and then takes over.
  const old = new Date(Date.now() - 9_000);
  await utimes(breaking, old, old);
  assert.equal(await lock.withLock(async () => 'ok', { path, waitMs: 100, breakingStaleMs: 10_000 }), 'ok');
  await assert.rejects(lstat(breaking), /ENOENT/);
  assert.deepEqual((await readdir(dir)).filter((e) => e.includes('stale') || e.includes('breaking')), []);
});

test('withLock: a legacy lock with a raw argv cmd is never echoed in the error', async (t) => {
  const dir = await fresh(t);
  const path = join(dir, '.lock');
  await writeFile(path, JSON.stringify(lockInfo({ cmd: 'adopt-config --from /secret/alice@corp.example' })));
  await assert.rejects(
    lock.withLock(async () => 1, { path, waitMs: 100 }),
    (e) => e instanceof lock.LockHeldError && e.message.includes('running "csm unknown"') && !/secret|alice/.test(e.message),
  );
});

test('withLock: on win32 a create failing EPERM/EACCES/EBUSY is contention (retried), elsewhere it is rethrown', async (t) => {
  const dir = await fresh(t);
  const path = join(dir, '.lock');
  let calls = 0;
  const flaky = (codes) => async (p, data) => {
    if (calls < codes.length) throw errWith(codes[calls++]);
    calls++;
    await writeFile(p, data, { flag: 'wx' });
  };
  assert.equal(
    await lock.withLock(async () => 'got', { path, waitMs: 2000, platform: 'win32', create: flaky(['EPERM', 'EBUSY', 'EACCES']) }),
    'got',
  );
  assert.equal(calls, 4);
  // Persistent EPERM on win32 ends as LockHeldError at the deadline, not a raw EPERM.
  await assert.rejects(
    lock.withLock(async () => 1, { path, waitMs: 120, platform: 'win32', create: async () => { throw errWith('EPERM'); } }),
    lock.LockHeldError,
  );
  // Off Windows the same error is a real permission problem.
  await assert.rejects(
    lock.withLock(async () => 1, { path, waitMs: 120, platform: 'linux', create: async () => { throw errWith('EPERM'); } }),
    (e) => e.code === 'EPERM',
  );
});

test('withLock: lock cmd is only the subcommand name, never argv', async (t) => {
  const dir = await fresh(t);
  const path = join(dir, '.lock');
  await lock.withLock(async () => assert.equal((await lock.readLock(path))?.cmd, 'adopt-config'), { path, cmd: 'adopt-config' });
  await lock.withLock(async () => assert.equal((await lock.readLock(path))?.cmd, 'unknown'), { path, cmd: 'use --token=secret /x/y' });
  await lock.withLock(async () => assert.match((await lock.readLock(path))?.cmd ?? '', /^[a-z][a-z0-9-]*$|^unknown$/), { path });
});

test('withLock: a fresh unparsable lock and a live foreign-host lock are respected', async (t) => {
  const dir = await fresh(t);
  const path = join(dir, '.lock');
  await writeFile(path, 'garbage');
  await assert.rejects(lock.withLock(async () => 1, { path, waitMs: 150 }), (e) => e instanceof lock.LockHeldError && /pid unknown/.test(e.message));
  await writeFile(path, JSON.stringify(lockInfo({ host: 'some-other-host', pid: 1 })));
  await assert.rejects(lock.withLock(async () => 1, { path, waitMs: 150 }), lock.LockHeldError);
});

test('withLock: release is token-checked and happens even when fn throws', async (t) => {
  const dir = await fresh(t);
  const path = join(dir, '.lock');
  await lock.withLock(
    async () => {
      // Simulate our lock being taken over while fn runs.
      await writeFile(path, JSON.stringify(lockInfo({ token: 'someone-else' })));
    },
    { path },
  );
  assert.equal((await lock.readLock(path))?.token, 'someone-else');
  await rmrf(path);
  await assert.rejects(lock.withLock(async () => { throw new Error('boom'); }, { path }), /boom/);
  await assert.rejects(lstat(path), /ENOENT/);
  // uninstall --purge removes ROOT under us: release must not throw.
  await lock.withLock(async () => rmrf(dir), { path: join(dir, 'sub', '.lock') });
});

test('isLockStale / readLock', async (t) => {
  const now = Date.now();
  // Same host: only a dead pid is stale, however old the lock is.
  assert.equal(lock.isLockStale(lockInfo({ ts: now - 1000 }), now, now, 500), false);
  assert.equal(lock.isLockStale(lockInfo({ pid: await deadPid() }), now, now), true);
  assert.equal(lock.isLockStale(lockInfo(), now, now), false);
  // Other hosts (pid not probeable): the age rule.
  assert.equal(lock.isLockStale(lockInfo({ host: 'elsewhere', pid: 1 }), now, now), false);
  assert.equal(lock.isLockStale(lockInfo({ host: 'elsewhere', pid: 1, ts: now - 1000 }), now, now, 500), true);
  assert.equal(lock.isLockStale(null, now - 20_000, now), true);
  assert.equal(lock.isLockStale(null, now - 1000, now), false);
  const dir = await fresh(t);
  assert.equal(await lock.readLock(join(dir, 'none')), null);
  await writeFile(join(dir, 'bad'), 'x');
  assert.equal(await lock.readLock(join(dir, 'bad')), null);
});

// ------------------------------------------------------ linkItem fallback chain

const denySymlink = (code) => async () => {
  throw errWith(code);
};

test('linkItem: file symlink EPERM falls back to a hardlink of the real file', async (t) => {
  const dir = await fresh(t);
  await writeFile(join(dir, 'real.md'), 'content');
  let haveLink = true;
  try {
    await symlink(join(dir, 'real.md'), join(dir, 'via.md'), 'file');
  } catch {
    haveLink = false;
  }
  // Source is itself a symlink: link() on that path would hardlink the link, so realpath must be used.
  const src = haveLink ? join(dir, 'via.md') : join(dir, 'real.md');
  const mode = await profiles.linkItem('CLAUDE.md', src, join(dir, 'out.md'), 'win32', { symlink: denySymlink('EPERM') });
  assert.equal(mode, 'hardlink');
  assert.ok(!(await lstat(join(dir, 'out.md'))).isSymbolicLink());
  assert.equal(await fsx.sameFile(join(dir, 'out.md'), join(dir, 'real.md')), true);
});

test('linkItem: real symlink wins when available; dirs use symlink/junction', async (t) => {
  if (await skipUnlessSymlink(t)) return;
  const dir = await fresh(t);
  await writeFile(join(dir, 'f'), 'x');
  await mkdir(join(dir, 'd'));
  assert.equal(await profiles.linkItem('f', join(dir, 'f'), join(dir, 'f.lnk')), 'symlink');
  assert.equal(await profiles.linkItem('d', join(dir, 'd'), join(dir, 'd.lnk')), isWin ? 'junction' : 'symlink');
  assert.ok(await sameTarget(join(dir, 'd.lnk'), join(dir, 'd')));
});

test('linkItem: failures become LinkError with actionable messages', async (t) => {
  const dir = await fresh(t);
  await writeFile(join(dir, 'f'), 'x');
  await mkdir(join(dir, 'd'));
  const missingParent = join(dir, 'no', 'such', 'dst');

  await assert.rejects(
    profiles.linkItem('CLAUDE.md', join(dir, 'f'), missingParent, 'win32', { symlink: denySymlink('EPERM') }),
    (err) =>
      err instanceof profiles.LinkError &&
      err instanceof CsmError &&
      err.item === 'CLAUDE.md' &&
      err.code === 'ENOENT' &&
      /^could not link CLAUDE\.md: creating a symlink needs Developer Mode or admin rights on Windows/.test(err.message) &&
      /hardlink fallback failed \(ENOENT\)\./.test(err.message) &&
      /Enable Developer Mode, or move CSM_HOME to the same drive as .*then run "csm sync"\.$/.test(err.message),
  );
  await assert.rejects(
    profiles.linkItem('CLAUDE.md', join(dir, 'f'), missingParent, 'linux', { symlink: denySymlink('EPERM') }),
    (err) => err instanceof profiles.LinkError && !/Developer Mode/.test(err.message) && /hardlink fallback failed/.test(err.message),
  );
  await assert.rejects(
    profiles.linkItem('skills', join(dir, 'd'), missingParent, 'win32', { symlink: denySymlink('EPERM') }),
    (err) => err instanceof profiles.LinkError && /junctions are not supported at .* \(EPERM\)\. Put CSM_HOME on a local NTFS drive\.$/.test(err.message),
  );
  await assert.rejects(
    profiles.linkItem('skills', join(dir, 'd'), missingParent, 'linux', { symlink: denySymlink('EACCES') }),
    (err) => err instanceof profiles.LinkError && /^could not link skills: EACCES/.test(err.message),
  );
  // A non-permission symlink error on a file does not fall back to a hardlink.
  await assert.rejects(
    profiles.linkItem('f', join(dir, 'f'), join(dir, 'x'), 'linux', { symlink: denySymlink('ELOOP') }),
    (err) => err instanceof profiles.LinkError && err.code === 'ELOOP',
  );
  await assert.rejects(lstat(join(dir, 'x')), /ENOENT/);
});

// --------------------------------------------- shared status: hardlinks, drift, stale

/** A profile "p" plus shared/CLAUDE.md hardlinked to <adopted>/CLAUDE.md, and a profile hardlink to it. */
const hardlinkSetup = async (t) => {
  await resetRoot(t);
  const adopted = join(HOME, 'adopted-config');
  await rmrf(adopted);
  t.after(() => rmrf(adopted));
  await mkdir(adopted, { recursive: true });
  await writeFile(join(adopted, 'CLAUDE.md'), 'v1');
  await mkdir(join(CSM_HOME, 'shared'), { recursive: true });
  await link(join(adopted, 'CLAUDE.md'), join(CSM_HOME, 'shared', 'CLAUDE.md'));
  await profiles.createProfile('p'); // shared/CLAUDE.md is a plain file now: linkItem symlinks it
  const dst = join(CSM_HOME, 'profiles', 'p', 'CLAUDE.md');
  await rmrf(dst);
  await link(join(CSM_HOME, 'shared', 'CLAUDE.md'), dst);
  await writeFile(join(CSM_HOME, 'state.json'), JSON.stringify({ current: 'p', adoptedFrom: adopted, adoptedItems: ['CLAUDE.md'], extra: { keep: true } }));
  return { adopted, dst, shared: join(CSM_HOME, 'shared', 'CLAUDE.md') };
};
const statusOf = async (item) => (await profiles.inspectShared('p')).find((s) => s.item === item)?.status;
/** What Claude Code does on save: write a temp file and rename it over the original, breaking the inode. */
const rewrite = async (path, content) => {
  await writeFile(`${path}.tmp`, content);
  await rename(`${path}.tmp`, path);
};

test('status: a hardlinked profile file is linked (dev+ino) until write+rename breaks the inode', async (t) => {
  const { dst } = await hardlinkSetup(t);
  assert.equal(await statusOf('CLAUDE.md'), 'linked');
  await rewrite(dst, 'edited in profile');
  assert.equal(await statusOf('CLAUDE.md'), 'drifted');

  const res = await profiles.repairShared('p', 'discard');
  assert.match(res.find((r) => r.item === 'CLAUDE.md')?.action ?? '', /^discarded, profile copy backed up to /);
  assert.equal(await statusOf('CLAUDE.md'), 'linked');
});

test('status: other item kinds (missing, no-source, foreign, drifted copy)', async (t) => {
  const { dst } = await hardlinkSetup(t);
  assert.equal(await statusOf('settings.json'), 'no-source');
  await rmrf(dst);
  assert.equal(await statusOf('CLAUDE.md'), 'missing');
  await writeFile(dst, 'v1'); // same content, different inode
  assert.equal(await statusOf('CLAUDE.md'), 'drifted');
});

test('stale shared copy: detected, reported per profile, refreshed by repairShared without profile backups', async (t) => {
  const { adopted, dst, shared } = await hardlinkSetup(t);
  let src = await profiles.inspectSharedSources();
  assert.deepEqual(src.find((s) => s.item === 'CLAUDE.md'), { item: 'CLAUDE.md', status: 'ok', mode: 'hardlink', source: join(adopted, 'CLAUDE.md') });
  assert.deepEqual(src.find((s) => s.item === 'skills'), { item: 'skills', status: 'no-source', mode: null, source: null });

  await rewrite(join(adopted, 'CLAUDE.md'), 'v2');
  src = await profiles.inspectSharedSources();
  assert.deepEqual(src.find((s) => s.item === 'CLAUDE.md'), { item: 'CLAUDE.md', status: 'stale', mode: 'copy', source: join(adopted, 'CLAUDE.md') });
  assert.equal(await readFile(shared, 'utf8'), 'v1');
  assert.equal(await statusOf('CLAUDE.md'), 'stale');

  const res = await profiles.repairShared('p', 'discard');
  const refreshed = res.find((r) => r.action.startsWith('refreshed shared copy from'));
  assert.ok(refreshed, JSON.stringify(res));
  assert.match(refreshed.action, /stale copy backed up to .*CLAUDE\.md\.bak-\d+/);
  assert.equal(await readFile(shared, 'utf8'), 'v2');
  assert.equal(await readFile(dst, 'utf8'), 'v2');
  assert.ok(await sameTarget(shared, join(adopted, 'CLAUDE.md')));
  assert.equal(await statusOf('CLAUDE.md'), 'linked');
  const bak = (await readdir(join(CSM_HOME, 'shared'))).find((e) => e.startsWith('CLAUDE.md.bak-'));
  assert.equal(await readFile(join(CSM_HOME, 'shared', bak), 'utf8'), 'v1');
  // The profile only held the old inode's content, so nothing needed backing up there.
  assert.deepEqual((await readdir(join(CSM_HOME, 'profiles', 'p'))).filter((e) => e.includes('bak')), []);
  assert.ok((await profiles.inspectSharedSources()).every((s) => s.status !== 'stale'));
});

test('stale shared copy: a profile with its own edits is backed up, not silently relinked', async (t) => {
  const { adopted, dst } = await hardlinkSetup(t);
  await rewrite(join(adopted, 'CLAUDE.md'), 'v2');
  await rewrite(dst, 'profile edit');
  await profiles.repairShared('p', 'discard');
  const bak = (await readdir(join(CSM_HOME, 'profiles', 'p'))).find((e) => e.startsWith('CLAUDE.md.csm-bak-'));
  assert.ok(bak);
  assert.equal(await readFile(join(CSM_HOME, 'profiles', 'p', bak), 'utf8'), 'profile edit');
  assert.equal(await readFile(dst, 'utf8'), 'v2');
});

test('stale detection only covers items adoptConfig seeded (hand-placed shared files are never stale)', async (t) => {
  const { adopted } = await hardlinkSetup(t);
  await writeFile(join(CSM_HOME, 'state.json'), JSON.stringify({ current: 'p', adoptedFrom: adopted })); // legacy: no adoptedItems
  await rewrite(join(adopted, 'CLAUDE.md'), 'v2');
  const src = await profiles.inspectSharedSources();
  assert.equal(src.find((s) => s.item === 'CLAUDE.md')?.status, 'ok');
  assert.equal(await statusOf('CLAUDE.md'), 'linked');
  const res = await profiles.repairShared('p', 'discard');
  assert.ok(!res.some((r) => r.action.startsWith('refreshed')), JSON.stringify(res));
});

test('state.json: writes merge, keeping adoptedFrom and unknown keys', async (t) => {
  const { adopted } = await hardlinkSetup(t);
  assert.equal(await profiles.getAdoptedFrom(), adopted);
  await profiles.createProfile('q');
  await profiles.setCurrent('q');
  await profiles.removeProfile('q'); // clears current
  const state = JSON.parse(await readFile(join(CSM_HOME, 'state.json'), 'utf8'));
  assert.deepEqual(state, { current: null, adoptedFrom: adopted, adoptedItems: ['CLAUDE.md'], extra: { keep: true } });
});

test('adoptConfig records adoptedFrom; a stale hardlinked seed is refreshed on re-adopt', async (t) => {
  await resetRoot(t);
  const source = join(HOME, 'adopt-src');
  t.after(() => rmrf(source));
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'CLAUDE.md'), 'v1');
  await profiles.createProfile('p');
  assert.equal(await profiles.getAdoptedFrom(), null);

  const first = await profiles.adoptConfig({ from: source });
  assert.match(first.shared.find((s) => s.item === 'CLAUDE.md')?.action ?? '', /^linked to /);
  assert.equal(await profiles.getAdoptedFrom(), source);
  assert.deepEqual(JSON.parse(await readFile(join(CSM_HOME, 'state.json'), 'utf8')).adoptedItems, ['CLAUDE.md']);
  assert.equal((await profiles.getCurrent()), null); // merged write did not invent a current profile

  // Turn the seed into a plain hardlink (as the fallback would), then break the inode.
  const sharedMd = join(CSM_HOME, 'shared', 'CLAUDE.md');
  await rmrf(sharedMd);
  await link(join(source, 'CLAUDE.md'), sharedMd);
  await rewrite(join(source, 'CLAUDE.md'), 'v2');

  const again = await profiles.adoptConfig({ from: source });
  assert.match(again.shared.find((s) => s.item === 'CLAUDE.md')?.action ?? '', /^refreshed shared copy from .* \(stale copy backed up to /);
  assert.equal(await readFile(sharedMd, 'utf8'), 'v2');
});

// ---------------------------------------------------------- probeLinkSupport / shell / paths

test('probeLinkSupport reports each kind, picks modes and leaves nothing behind', async (t) => {
  const dir = await fresh(t);
  const res = await profiles.probeLinkSupport(dir);
  assert.equal(res.dir, dir);
  for (const key of ['symlinkFile', 'symlinkDir', 'hardlink']) assert.equal(typeof res[key], 'boolean', key);
  assert.equal(res.junction, isWin ? res.junction : null);
  assert.equal(res.fileMode, res.symlinkFile ? 'symlink' : res.hardlink ? 'hardlink' : null);
  assert.equal(res.dirMode, isWin ? (res.junction ? 'junction' : null) : res.symlinkDir ? 'symlink' : null);
  assert.equal(typeof res.errors, 'object');
  assert.deepEqual(await readdir(dir), []);

  const bad = await profiles.probeLinkSupport(join(dir, 'does-not-exist'));
  assert.equal(bad.fileMode, null);
  assert.equal(bad.dirMode, null);
  assert.ok(bad.errors['probe']);
});

test('detectShell: Windows honours Git Bash / MSYS $SHELL', () => {
  assert.equal(shell.detectShell({ SHELL: '/usr/bin/bash' }, 'win32'), 'bash');
  assert.equal(shell.detectShell({ SHELL: 'C:\\Program Files\\Git\\bin\\bash.exe' }, 'win32'), 'bash');
  assert.equal(shell.detectShell({ SHELL: '/usr/bin/zsh' }, 'win32'), 'zsh');
  assert.equal(shell.detectShell({ SHELL: 'C:\\tools\\fish.EXE' }, 'win32'), 'fish');
  assert.equal(shell.detectShell({}, 'win32'), 'pwsh');
  assert.equal(shell.detectShell({ SHELL: 'C:\\Windows\\System32\\cmd.exe' }, 'win32'), 'pwsh');
  assert.equal(shell.detectShell({ SHELL: '/bin/zsh' }, 'linux'), 'zsh');
  assert.equal(shell.detectShell({ SHELL: '/bin/dash' }, 'linux'), 'bash');
  assert.equal(shell.detectShell({}, 'darwin'), 'bash');
});

test('paths: CSM_HOME="" counts as unset; LOCK_FILE lives in ROOT', async (t) => {
  const home = await fresh(t);
  const out = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['-e', `import(${JSON.stringify(new URL('../dist/paths.js', import.meta.url).href)}).then(m => console.log(JSON.stringify([m.ROOT, m.LOCK_FILE])))`],
      { env: { ...process.env, CSM_HOME: '', HOME: home, USERPROFILE: home }, stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let data = '';
    child.stdout.on('data', (d) => (data += d));
    child.once('error', reject);
    child.once('exit', () => resolve(data));
  });
  assert.deepEqual(JSON.parse(out), [join(home, '.claude-sessions'), join(home, '.claude-sessions', '.lock')]);
});

// ------------------------------------------------- ROOT marker / permissions / looksLikeCsmHome

const inChild = (code, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, out, err }));
  });

test('assertRootValid: a relative CSM_HOME is a CsmError; absolute passes', async () => {
  const mod = JSON.stringify(new URL('../dist/paths.js', import.meta.url).href);
  const bad = await inChild(`const m = await import(${mod}); try { m.assertRootValid(); console.log('no error'); } catch (e) { console.log(e.name + ':' + e.message); }`, { CSM_HOME: 'relative/dir' });
  assert.match(bad.out, /^CsmError:CSM_HOME must be an absolute path/);
  const ok = await inChild(`const m = await import(${mod}); m.assertRootValid(); console.log('fine');`, { CSM_HOME: HOME });
  assert.equal(ok.out.trim(), 'fine');
});

test('ensureRoot writes the marker, tightens permissions, and listProfiles({create:false}) never creates', async (t) => {
  await resetRoot(t);
  assert.deepEqual(await profiles.listProfiles({ create: false }), []);
  await assert.rejects(lstat(CSM_HOME), /ENOENT/);
  if (!isWin) {
    await mkdir(CSM_HOME, { mode: 0o755 });
    await chmod(CSM_HOME, 0o755);
  }
  await profiles.ensureRoot();
  const paths = await import('../dist/paths.js');
  assert.equal(paths.ROOT_MARKER, '.csm-home');
  assert.equal(await readFile(join(CSM_HOME, paths.ROOT_MARKER), 'utf8'), 'csm data dir\n');
  if (!isWin) assert.equal((await stat(CSM_HOME)).mode & 0o077, 0);
  await profiles.ensureRoot(); // idempotent (marker EEXIST ignored)
  assert.deepEqual(await profiles.listProfiles({ create: false }), []);
});

test('looksLikeCsmHome: strict allowlist with and without the marker', async (t) => {
  const dir = await fresh(t);
  const mk = async (name, files = {}, dirs = []) => {
    const d = join(dir, name);
    await mkdir(d);
    for (const [f, c] of Object.entries(files)) await writeFile(join(d, f), c);
    for (const sub of dirs) await mkdir(join(d, sub), { recursive: true });
    return d;
  };
  const MARK = 'csm data dir\n';
  assert.equal((await profiles.looksLikeCsmHome(await mk('empty'))).ok, true);

  const marked = await mk('marked', { '.csm-home': MARK, 'state.json': '{"current":null}' }, ['profiles/work', 'shared']);
  assert.equal((await profiles.looksLikeCsmHome(marked)).ok, true);

  // The marker never vouches for foreign contents.
  const markedFiles = await mk('marked-files', { '.csm-home': MARK, 'anything.txt': 'x' });
  const r1 = await profiles.looksLikeCsmHome(markedFiles);
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /anything\.txt/);

  // Marker must be a regular file with exact content.
  assert.equal((await profiles.looksLikeCsmHome(await mk('bad-marker', { '.csm-home': 'hello' }))).ok, false);
  assert.equal((await profiles.looksLikeCsmHome(await mk('dir-marker', {}, ['.csm-home']))).ok, false);

  const legacy = await mk('legacy', { 'state.json': '{"current":"work"}', '.lock': '', '.lock.breaking': '1', 'state.json.0123456789ab.tmp': '{}' }, ['profiles/work', 'shared']);
  assert.equal((await profiles.looksLikeCsmHome(legacy)).ok, true);

  // shared/ may only hold shared items and their .bak-<ts> copies; OS junk files are ignored.
  const junk = await mk('junk', { '.DS_Store': '', 'Thumbs.db': '' }, ['shared/skills', 'shared/settings.json.bak-1790000000000']);
  await writeFile(join(junk, 'shared', 'desktop.ini'), '');
  assert.equal((await profiles.looksLikeCsmHome(junk)).ok, true);
  const photos = await profiles.looksLikeCsmHome(await mk('shared-photos', {}, ['shared/photos']));
  assert.equal(photos.ok, false);
  assert.match(photos.reason, /shared\/photos/);

  // Bad state.json, bad profiles entries, wrong types, non-csm tmp names.
  for (const [name, files, dirs, re] of [
    ['st-junk', { 'state.json': 'not json' }, [], /state\.json/],
    ['st-empty-obj', { 'state.json': '{}' }, ['profiles/stuff'], /state\.json/],
    ['st-array', { 'state.json': '[]' }, [], /state\.json/],
    ['prof-file', { 'state.json': '{"current":null}' }, ['profiles'], null],
    ['prof-badname', {}, ['profiles/.git'], /profiles\/\.git/],
    ['tmp-foreign', { 'x.tmp': '' }, [], /x\.tmp/],
    ['probe-foreign', { '.csm-probe-1': '' }, [], /\.csm-probe-1/],
    ['notes', { 'notes.txt': 'x', lock: 'x' }, ['profiles'], /notes\.txt/],
    ['lock-dir', {}, ['.lock'], /\.lock/],
    ['shared-file', { shared: 'x' }, [], /shared/],
  ]) {
    const d = await mk(name, files, dirs);
    if (name === 'prof-file') await writeFile(join(d, 'profiles', 'file.txt'), 'x');
    const res = await profiles.looksLikeCsmHome(d);
    assert.equal(res.ok, false, name);
    assert.match(res.reason, re ?? /profiles/, name);
  }
});

// -------------------------------------------- ensureRoot refusal (N1/N2/N3), end to end via the CLI

const rootSandbox = async (t) => {
  const dir = await mkdtemp(join(HOME, 'r-'));
  t.after(() => rmrf(dir));
  const home = join(dir, 'home');
  await mkdir(home);
  return { dir, home, env: (csmHome) => baseEnv({ csmHome, home }) };
};

test('ensureRoot: a foreign non-empty CSM_HOME is refused by list/add, untouched, and never purgeable', async (t) => {
  const { dir, env } = await rootSandbox(t);
  const proj = join(dir, 'Projects');
  await mkdir(join(proj, 'repo'), { recursive: true });
  await writeFile(join(proj, 'repo', 'main.c'), 'code');
  await writeFile(join(proj, 'README'), 'hi');
  if (!isWin) await chmod(proj, 0o755);
  const before = (await readdir(proj)).sort();
  for (const args of [['list'], ['add', 'w', '--no-login']]) {
    const res = await runCli(args, { env: env(proj) });
    assert.equal(res.code, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /exists and is not a csm data dir \(unexpected: .*\)\. Point CSM_HOME at an empty or new directory\./);
    assert.deepEqual((await readdir(proj)).sort(), before, 'nothing created (no marker, profiles, shared, lock)');
    if (!isWin) assert.equal((await stat(proj)).mode & 0o777, 0o755, 'permissions unchanged');
  }
  const purge = await runCli(['uninstall', '--purge', '--yes'], { env: env(proj) });
  assert.notEqual(purge.code, 0);
  assert.ok((await stat(join(proj, 'repo', 'main.c'))).isFile(), 'purge refused; data intact');
});

test('ensureRoot: CSM_HOME=$HOME and CSM_HOME=~/.claude are refused', async (t) => {
  const { home, env } = await rootSandbox(t);
  await mkdir(join(home, '.claude'));
  for (const target of [home, join(home, '.claude')]) {
    const res = await runCli(['list'], { env: env(target) });
    assert.equal(res.code, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /home or Claude config directory|not a csm data dir/);
  }
  assert.deepEqual(await readdir(join(home, '.claude')), []);
});

test('ensureRoot: a fresh CSM_HOME works end to end (0700, marker)', async (t) => {
  const { dir, env } = await rootSandbox(t);
  const csmHome = join(dir, 'fresh', 'nested');
  const e = env(csmHome);
  assert.equal((await runCli(['add', 'a', '--no-login'], { env: e })).code, 0);
  const list = await runCli(['list'], { env: e });
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /\ba\b/);
  assert.equal(await readFile(join(csmHome, '.csm-home'), 'utf8'), 'csm data dir\n');
  if (!isWin) assert.equal((await stat(csmHome)).mode & 0o777, 0o700);
});

test('ensureRoot: a legacy csm dir (state.json + valid profiles + shared) is adopted and marked', async (t) => {
  const { dir, env } = await rootSandbox(t);
  const csmHome = join(dir, 'legacy');
  await mkdir(join(csmHome, 'profiles', 'work'), { recursive: true });
  await mkdir(join(csmHome, 'shared'));
  await writeFile(join(csmHome, 'state.json'), '{"current":"work"}');
  if (!isWin) await chmod(csmHome, 0o755);
  const res = await runCli(['list'], { env: env(csmHome) });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /work/);
  assert.equal(await readFile(join(csmHome, '.csm-home'), 'utf8'), 'csm data dir\n');
  if (!isWin) assert.equal((await stat(csmHome)).mode & 0o077, 0);
});

test('ensureRoot: state.json + profiles/stuff/f (not csm state) is refused', async (t) => {
  const { dir, env } = await rootSandbox(t);
  const app = join(dir, 'app');
  await mkdir(join(app, 'profiles', 'stuff'), { recursive: true });
  await writeFile(join(app, 'profiles', 'stuff', 'f'), 'data');
  await writeFile(join(app, 'state.json'), '{}');
  const res = await runCli(['list'], { env: env(app) });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /not a csm data dir/);
  assert.deepEqual((await readdir(app)).sort(), ['profiles', 'state.json']);
});

test('ensureRoot: an invalid marker (wrong content or a directory) is refused', async (t) => {
  const { dir, env } = await rootSandbox(t);
  const a = join(dir, 'a');
  await mkdir(a);
  await writeFile(join(a, '.csm-home'), 'nope');
  const b = join(dir, 'b');
  await mkdir(join(b, '.csm-home'), { recursive: true });
  for (const d of [a, b]) {
    const res = await runCli(['list'], { env: env(d) });
    assert.equal(res.code, 1, res.stderr);
    assert.match(res.stderr, /not a csm data dir \(unexpected: \.csm-home/);
  }
});

test('withLock on the real lock path runs ensureRoot first (refuses a foreign dir, hardens a pre-existing one)', async (t) => {
  const { dir, env } = await rootSandbox(t);
  const foreign = join(dir, 'foreign');
  await mkdir(foreign);
  await writeFile(join(foreign, 'keep.txt'), 'x');
  const res = await runCli(['use', 'x'], { env: env(foreign) });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /not a csm data dir/);
  assert.deepEqual(await readdir(foreign), ['keep.txt'], 'no lock file or marker created');
  if (isWin) return;
  const open = join(dir, 'open');
  await mkdir(open, { mode: 0o755 });
  await chmod(open, 0o755);
  assert.equal((await runCli(['add', 'a', '--no-login'], { env: env(open) })).code, 0);
  assert.equal((await stat(open)).mode & 0o077, 0);
  assert.ok((await stat(join(open, '.csm-home'))).isFile());
});
