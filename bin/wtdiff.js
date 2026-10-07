#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../src/server.js';
import { openInBrowser } from '../src/open.js';
import { GitError } from '../src/git.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const HELP = `wtdiff ${pkg.version} - view what each worktree's branch changed against a base branch

Usage:
  wtdiff [base] [options]

Arguments:
  base                 Branch (or any ref) to compare against. Defaults to the
                       repository's default branch (origin/HEAD, main, master, ...).
                       Can be changed later in the UI.

Options:
  -b, --base <ref>     Same as the positional argument.
      --here           Open the diff of the current worktree directly instead of
                       the overview of all worktrees.
  -p, --port <n>       Port to listen on (default 4747). Falls back to a free
                       port when busy unless --strict-port is given.
      --strict-port    Fail instead of picking another port when busy.
      --host <addr>    Address to bind (default 127.0.0.1). Keep it local.
      --cwd <path>     Run as if started from this directory.
      --no-open        Do not open the browser automatically.
  -h, --help           Show this help.
  -v, --version        Show the version.

Examples:
  wtdiff                     overview of all worktrees vs the default branch
  wtdiff develop --here      this worktree's diff against develop
  wtdiff -b origin/main -p 5000 --no-open
`;

function fail(message, code = 1) {
  process.stderr.write(`wtdiff: ${message}\n`);
  process.exit(code);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: 'string', short: 'b' },
      here: { type: 'boolean', default: false },
      port: { type: 'string', short: 'p' },
      'strict-port': { type: 'boolean', default: false },
      host: { type: 'string', default: '127.0.0.1' },
      cwd: { type: 'string' },
      'no-open': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
} catch (err) {
  fail(`${err.message}\n\n${HELP}`);
}

const { values, positionals } = parsed;

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (values.version) {
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}
if (positionals.length > 1) fail(`unexpected arguments: ${positionals.slice(1).join(' ')}\n\n${HELP}`);

const base = values.base ?? positionals[0] ?? null;
const cwd = values.cwd ? path.resolve(values.cwd) : process.cwd();
const port = values.port === undefined ? 4747 : Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`invalid port: ${values.port}`);

try {
  const { url, repo, service } = await startServer({
    cwd,
    host: values.host,
    port,
    strictPort: values['strict-port'],
  });

  // Build the initial route so the browser lands on the requested screen.
  const hash = new URLSearchParams();
  if (base) hash.set('base', base);
  let route = '#/overview';
  if (values.here) {
    route = '#/diff';
    hash.set('worktree', repo.currentWorktree);
  }
  const query = hash.toString();
  const fullUrl = `${url}${route}${query ? `?${query}` : ''}`;

  const worktrees = await service.worktrees().catch(() => []);
  process.stdout.write(
    [
      `Repository : ${repo.repoRoot}`,
      `Worktree   : ${repo.currentWorktree}`,
      `Worktrees  : ${worktrees.length}`,
      base ? `Base       : ${base}` : null,
      '',
      `Serving at ${fullUrl}`,
      'Press Ctrl+C to stop.',
      '',
    ]
      .filter((l) => l !== null)
      .join('\n'),
  );

  if (!values['no-open']) openInBrowser(fullUrl);

  const shutdown = () => process.exit(0);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (err) {
  if (err instanceof GitError) fail(err.message);
  if (err?.code === 'EADDRINUSE') fail(`port ${port} is already in use (drop --strict-port to pick another)`);
  if (err?.code === 'ENOENT' && /git/.test(err.message)) fail('git executable not found on PATH');
  fail(err?.stack || String(err));
}
