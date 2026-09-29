import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './support/helpers.mjs';

const { buildShimCommandLine, escapeCmdShimArg, resolveWindowsClaude } = await import(
  pathToFileURL(join(ROOT, 'dist', 'winquote.js')).href
);

test('winquote: shim args double-escape cmd.exe metacharacters (BatBadBut)', () => {
  // Each metacharacter needs two carets: one for cmd.exe's parse, one for the shim's `%*` re-parse.
  assert.equal(escapeCmdShimArg('%PATH%'), '^^^"^^^%PATH^^^%^^^"');
  assert.equal(escapeCmdShimArg('a&calc'), '^^^"a^^^&calc^^^"');
  assert.equal(escapeCmdShimArg('x^y'), '^^^"x^^^^y^^^"');
  assert.equal(escapeCmdShimArg(''), '^^^"^^^"');
});

test('winquote: embedded quotes and trailing backslashes survive the C-runtime argv rules', () => {
  // `a"b` -> "a\"b" before caret-escaping; `dir\` -> "dir\\" so the closing quote isn't escaped.
  assert.equal(escapeCmdShimArg('a"b'), '^^^"a\\^^^"b^^^"');
  assert.equal(escapeCmdShimArg('dir\\'), '^^^"dir\\\\^^^"');
});

test('winquote: newlines are rejected rather than silently truncating the command line', () => {
  assert.throws(() => escapeCmdShimArg('line1\nline2'), /newlines/);
  assert.throws(() => escapeCmdShimArg('a\rb'), /newlines/);
});

test('winquote: full shim command line escapes the command path once and args twice', () => {
  assert.equal(
    buildShimCommandLine('C:\\Program Files\\claude.cmd', ['-p', 'a b']),
    '"C:\\Program^ Files\\claude.cmd ^^^"-p^^^" ^^^"a^^^ b^^^""',
  );
});

test('winquote: PATH search prefers .exe, skips relative PATH entries, and errors when not found', () => {
  const env = { PATH: '.;relative\\bin;C:\\tools;C:\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  // Windows paths are case-insensitive (PATHEXT yields claude.EXE), so compare lower-cased.
  const present = new Set(['.\\claude.exe', 'relative\\bin\\claude.exe', 'c:\\npm\\claude.cmd', 'c:\\npm\\claude.exe']);
  const access = (p) => present.has(p.toLowerCase());
  const resolve = () => resolveWindowsClaude('claude', env, access).toLowerCase();

  assert.equal(resolve(), 'c:\\npm\\claude.exe');
  present.delete('c:\\npm\\claude.exe');
  assert.equal(resolve(), 'c:\\npm\\claude.cmd');
  present.delete('c:\\npm\\claude.cmd');
  // Only the CWD/relative candidates remain: must not be used.
  assert.throws(resolve, /not found on PATH/);

  // An explicit path (CSM_CLAUDE_BIN) is trusted as-is.
  assert.equal(resolveWindowsClaude('D:\\x\\claude.exe', env, () => false), 'D:\\x\\claude.exe');
});
