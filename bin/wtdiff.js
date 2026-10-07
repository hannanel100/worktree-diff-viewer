#!/usr/bin/env node
// CLI launcher. Production: starts the bundled Node server (dist/server.mjs),
// which serves the static UI export (out/) and the API, bound to 127.0.0.1.
// --dev: runs `next dev` for working on wtdiff itself.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
const port = values.port === undefined ? 4747 : Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`invalid port: ${values.port}`);
if (!existsSync(cwd)) fail(`directory does not exist: ${cwd}`);

function initialUrl(origin, currentWorktree) {
  const query = new URLSearchParams();
  if (base) query.set('base', base);
  let route = '/';
  if (values.here) {
    route = '/diff';
    query.set('worktree', currentWorktree);
  }
  const qs = query.toString();
  return `${origin}${route}${qs ? `?${qs}` : ''}`;
}

// ---------------------------------------------------------------------------
// --dev: Next.js dev server with the API routes mounted
// ---------------------------------------------------------------------------

if (values.dev) {
  const nextBin = path.join(pkgRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!existsSync(nextBin)) fail('--dev needs the dev dependencies; run "npm install" in the wtdiff package.');
  const child = spawn(
    process.execPath,
    [nextBin, 'dev', '--port', String(port), '--hostname', host],
    { cwd: pkgRoot, stdio: 'inherit', env: { ...process.env, WTDIFF_CWD: cwd } },
  );
  child.on('exit', (code) => process.exit(code ?? 0));
  if (!values['no-open']) {
    setTimeout(() => openInBrowser(initialUrl(`http://${host}:${port}`, cwd)), 3000).unref();
  }
} else {
  // -------------------------------------------------------------------------
  // Production: bundled server + static export
  // -------------------------------------------------------------------------
  const serverFile = path.join(pkgRoot, 'dist', 'server.mjs');
  const staticDir = path.join(pkgRoot, 'out');
  if (!existsSync(serverFile) || !existsSync(path.join(staticDir, 'index.html'))) {
    fail('no build found. Run "npm run build" in the wtdiff package first (or use --dev).');
  }

  try {
    const { startServer } = await import(pathToFileURL(serverFile).href);
    const { url, info } = await startServer({ cwd, staticDir, host, port, strictPort: values['strict-port'] });
    const fullUrl = initialUrl(url.replace(/\/$/, ''), info.currentWorktree);

    process.stdout.write(
      [
        `Repository : ${info.repoRoot}`,
        `Worktree   : ${info.currentWorktree}`,
        `Worktrees  : ${info.worktrees.length}`,
        `Base       : ${base ?? info.defaultBase ?? '(none found)'}`,
        '',
        `Serving at ${fullUrl}`,
        'Press Ctrl+C to stop.',
        '',
      ].join('\n'),
    );

    if (!values['no-open']) openInBrowser(fullUrl);

    const shutdown = () => process.exit(0);
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    if (err?.name === 'GitError') fail(err.message);
    if (err?.code === 'EADDRINUSE') fail(`port ${port} is already in use (drop --strict-port to pick another)`);
    if (err?.code === 'ENOENT' && /git/.test(String(err.message))) fail('git executable not found on PATH');
    fail(err?.stack || String(err));
  }
}
