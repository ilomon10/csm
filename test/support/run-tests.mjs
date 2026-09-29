// Portable test runner: Node 20 does not expand globs passed to `node --test`.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => join(testDir, f));
const res = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(res.status ?? 1);
