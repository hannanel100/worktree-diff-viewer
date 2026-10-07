#!/usr/bin/env node
// CLI launcher: parses arguments, boots the pre-built Next.js app in-process
// bound to 127.0.0.1, prints where it is serving and opens the browser.
// Repository access happens inside the API routes (lib/repo-service.ts); the
// directory to inspect is handed over through WTDIFF_CWD.

import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import next from 'next';

import { openInBrowser } from './open.js';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));

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
      --cwd <path>     Inspect the repository containing this directory instead
                       of the current one. Any worktree or the main checkout works.
      --no-open        Do not open the browser automatically.
      --dev            Run the Next.js dev server (for working on wtdiff itself).
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
      dev: { type: 'boolean', default: false },
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
const host = values.host;
const requestedPort = values.port === undefined ? 4747 : Number(values.port);
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
  fail(`invalid port: ${values.port}`);
}
if (!existsSync(cwd)) fail(`directory does not exist: ${cwd}`);
if (!values.dev && !existsSync(path.join(pkgRoot, '.next', 'BUILD_ID'))) {
  fail('no production build found. Run "npm run build" in the wtdiff package first (or use --dev).');
}

process.env.WTDIFF_CWD = cwd;
process.env.NODE_ENV = values.dev ? 'development' : 'production';

/** Listen on the requested port, falling back to a random free one unless strict. */
function listen(server, port, strict) {
  return new Promise((resolve, reject) => {
    const attempt = (p) => {
      const onError = (err) => {
        server.off('listening', onListening);
        if (err.code === 'EADDRINUSE' && !strict && p !== 0) return attempt(0);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(server.address().port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p, host);
    };
    attempt(port);
  });
}

try {
  let handle = null;
  const server = http.createServer((req, res) => {
    if (!handle) {
      res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '1' });
      res.end('starting');
      return;
    }
    handle(req, res);
  });
  const port = await listen(server, requestedPort, values['strict-port']);

  const app = next({ dev: values.dev, dir: pkgRoot, hostname: host, port, quiet: !values.dev });
  await app.prepare();
  handle = app.getRequestHandler();

  const origin = `http://${host}:${port}`;
  const res = await fetch(`${origin}/api/repo`);
  const info = await res.json();
  if (!res.ok) {
    server.close();
    fail(info.error || `could not read repository (${res.status})`);
  }

  const query = new URLSearchParams();
  if (base) query.set('base', base);
  let route = '/';
  if (values.here) {
    route = '/diff';
    query.set('worktree', info.currentWorktree);
  }
  const qs = query.toString();
  const url = `${origin}${route}${qs ? `?${qs}` : ''}`;

  process.stdout.write(
    [
      `Repository : ${info.repoRoot}`,
      `Worktree   : ${info.currentWorktree}`,
      `Worktrees  : ${info.worktrees.length}`,
      `Base       : ${base ?? info.defaultBase ?? '(none found)'}`,
      '',
      `Serving at ${url}`,
      'Press Ctrl+C to stop.',
      '',
    ].join('\n'),
  );

  if (!values['no-open']) openInBrowser(url);

  const shutdown = () => process.exit(0);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (err) {
  if (err?.code === 'EADDRINUSE') fail(`port ${requestedPort} is already in use (drop --strict-port to pick another)`);
  fail(err?.stack || String(err));
}
