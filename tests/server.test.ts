// The production server end to end: API over HTTP plus static-export serving.
// A small fake export directory stands in for Next's out/ so the tests do not
// need a web build.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { isInside } from '@/server/http';
import { startServer, type Started } from '@/server/main';
import { createFixture, type Fixture } from './fixture';

let fx: Fixture;
let staticDir: string;
let started: Started;

/** Raw GET that keeps the path exactly as given (fetch would normalise `..`). */
function raw(p: string, method = 'GET'): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: started.host, port: started.port, path: p, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const get = (p: string) => fetch(`${started.url.replace(/\/$/, '')}${p}`);

beforeAll(async () => {
  fx = createFixture();
  staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtdiff-static-'));
  const write = (rel: string, content: string) => {
    const full = path.join(staticDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  write('index.html', '<!doctype html><title>Worktree Diff</title>overview');
  write('diff.html', '<!doctype html><title>Diff</title>diff');
  write('404.html', '<!doctype html><title>Not found</title>nope');
  write('icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  write('_next/static/chunks/app.js', 'console.log(1)');
  write('docs/index.html', 'folder index');
  write('__next.__PAGE__.txt', 'root payload');
  write('diff/__next.diff/__PAGE__.txt', 'diff payload');
  started = await startServer({ cwd: fx.featureDir, staticDir, port: 0 });
});

afterAll(async () => {
  await new Promise((r) => started.server.close(r));
  fs.rmSync(staticDir, { recursive: true, force: true });
  fx.cleanup();
});

describe('production server', () => {
  test('starts bound to localhost and reports the repository', () => {
    expect(started.host).toBe('127.0.0.1');
    expect(started.info.worktrees).toHaveLength(6);
    expect(started.info.currentWorktree.endsWith('wt-feature')).toBe(true);
  });

  test('serves the static export with Next export file mapping', async () => {
    const index = await get('/');
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toMatch(/text\/html/);
    expect(await index.text()).toContain('overview');

    const diff = await get('/diff?worktree=x&base=main');
    expect(diff.status).toBe(200);
    expect(await diff.text()).toContain('diff');

    expect(await (await get('/docs')).text()).toBe('folder index');
    expect((await get('/icon.svg')).headers.get('content-type')).toBe('image/svg+xml');

    const chunk = await get('/_next/static/chunks/app.js');
    expect(chunk.headers.get('cache-control')).toMatch(/immutable/);
    expect((await get('/')).headers.get('cache-control')).toBe('no-cache');

    const missing = await get('/no/such/page');
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('nope');
  });

  test('serves Next segment prefetch payloads under both spellings', async () => {
    expect(await (await get('/__next.__PAGE__.txt?_rsc=abc')).text()).toBe('root payload');
    expect(await (await get('/diff/__next.diff.__PAGE__.txt?_rsc=abc')).text()).toBe('diff payload');
    expect(await (await get('/diff/__next.diff/__PAGE__.txt')).text()).toBe('diff payload');
    expect((await get('/diff/__next.other.__PAGE__.txt')).status).toBe(404);
  });

  test('never serves files outside the export directory', async () => {
    for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%5cpackage.json', '/..%2fpackage.json']) {
      const res = await raw(p);
      expect([403, 404], p).toContain(res.status);
      expect(res.body, p).not.toMatch(/"name": "worktree-diff-viewer"/);
    }
    expect(isInside('/a/b', '/a/b/c.txt')).toBe(true);
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b', '/a/bc/x')).toBe(false);
    expect(isInside('/a/b', '/a/x')).toBe(false);
  });

  test('answers the API over HTTP through the shared handlers', async () => {
    const repo = await get('/api/repo');
    expect(repo.status).toBe(200);
    expect(repo.headers.get('cache-control')).toBe('no-store');
    expect((await repo.json()).worktrees).toHaveLength(6);

    const url = `/api/summary?worktree=${encodeURIComponent(fx.featureDir)}&base=main`;
    expect(await (await get(url)).json()).toMatchObject({ ahead: 2, behind: 4 });

    const patch = await get(`/api/patch?worktree=${encodeURIComponent(fx.featureDir)}&base=main`);
    expect(patch.headers.get('content-disposition')).toBe('attachment; filename="feature-vs-main.patch"');
    expect(await patch.text()).toMatch(/diff --git/);

    expect((await get('/api/summary?worktree=x&base=main')).status).toBe(404);
    expect((await get('/api/nope')).status).toBe(404);
    expect((await get('/api/constructor')).status).toBe(404);
    expect((await raw('/api/repo', 'POST')).status).toBe(405);
    expect((await raw('/', 'POST')).status).toBe(405);
    const head = await raw('/api/repo', 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
  });

  test('falls back to a free port when the requested one is busy', async () => {
    const second = await startServer({ cwd: fx.featureDir, staticDir, port: started.port });
    try {
      expect(second.port).not.toBe(started.port);
    } finally {
      await new Promise((r) => second.server.close(r));
    }
    await expect(startServer({ cwd: fx.featureDir, staticDir, port: started.port, strictPort: true })).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
  });

  test('refuses to start outside a git repository', async () => {
    await expect(startServer({ cwd: fx.root, staticDir, port: 0 })).rejects.toThrow(/Not inside a git repository/);
  });
});
