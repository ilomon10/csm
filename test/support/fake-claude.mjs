#!/usr/bin/env node
// Fake `claude` binary used by tests (never the real one). Logs every invocation as one JSON
// line to CSM_TEST_LOG (if set) and exits with FAKE_CLAUDE_EXIT_CODE (default 0). Also echoes a
// human-readable line to stdout so tests that only capture stdout (e.g. through a shell) can
// assert on it without reading the log file.
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const record = {
  argv: args,
  cwd: process.cwd(),
  env: {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
  },
};

process.stdout.write(`FAKE_CLAUDE ARGS=${JSON.stringify(args)} CONFIG_DIR=${record.env.CLAUDE_CONFIG_DIR ?? ''}\n`);

const logPath = process.env.CSM_TEST_LOG;
if (logPath) {
  appendFileSync(logPath, `${JSON.stringify(record)}\n`);
}

const code = process.env.FAKE_CLAUDE_EXIT_CODE ? Number.parseInt(process.env.FAKE_CLAUDE_EXIT_CODE, 10) : 0;
process.exit(Number.isFinite(code) ? code : 0);
