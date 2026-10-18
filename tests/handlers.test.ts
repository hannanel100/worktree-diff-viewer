// The API handlers are plain functions (Request -> Response) shared by
// `next dev` and the production server, so they can be exercised directly.
// The repository is selected through WTDIFF_CWD exactly as the CLI does it.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { resetRepoService } from '@/lib/context';
import { apiHandlers, isApiName } from '@/lib/handlers';
import { createFixture, type Fixture } from './fixture';

let fx: Fixture;

const req = (route: string, params: Record<string, string> = {}) =>
  new Request(`http://localhost/api/${route}?${new URLSearchParams(params)}`);

beforeAll(() => {
  fx = createFixture();
  process.env.WTDIFF_CWD = fx.featureDir;
  resetRepoService();
});

afterAll(() => {
  delete process.env.WTDIFF_CWD;
  resetRepoService();
  fx.cleanup();
});

describe('API handlers', () => {
  test('route names are a closed set', () => {
    expect(Object.keys(apiHandlers).sort()).toEqual([
      'branches', 'commit', 'commit-file', 'commit-patch', 'diff', 'file', 'patch', 'repo', 'summary',
      'uncommitted', 'uncommitted-file', 'uncommitted-files', 'uncommitted-patch',
    ]);
    expect(isApiName('repo')).toBe(true);
    expect(isApiName('constructor')).toBe(false);
    expect(isApiName('__proto__')).toBe(false);
  });

  test('repo and branches answer JSON with no-store caching', async () => {
    const res = await apiHandlers.repo(req('repo'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.worktrees).toHaveLength(6);
    expect(body.defaultBase).toBe('main');

    const b = await (await apiHandlers.branches(req('branches', { refresh: '1' }))).json();
    expect(b.local.map((x: { name: string }) => x.name)).toContain('feature');
  });

  test('summary, uncommitted, diff and file return the same data as the service', async () => {
    const s = await (await apiHandlers.summary(req('summary', { worktree: fx.featureDir, base: 'main' }))).json();
    expect(s).toMatchObject({ ahead: 2, behind: 4, merge: { state: 'unmerged', conflicts: [] } });

    const u = await (await apiHandlers.uncommitted(req('uncommitted', { worktree: fx.featureDir }))).json();
    expect(u).toMatchObject({ changed: 2, untracked: 1 });

    const uf = await (await apiHandlers['uncommitted-files'](req('uncommitted-files', { worktree: fx.featureDir }))).json();
    expect(uf.files.map((f: { path: string }) => f.path).sort()).toEqual(['lib/b.js', 'scratch.txt', 'staged.txt']);
    const one = await (await apiHandlers['uncommitted-file'](req('uncommitted-file', { worktree: fx.featureDir, path: 'scratch.txt' }))).json();
    expect(one.diff).toMatch(/\+untracked/);
    const up = await apiHandlers['uncommitted-patch'](req('uncommitted-patch', { worktree: fx.featureDir }));
    expect(up.headers.get('content-disposition')).toBe('attachment; filename="feature-uncommitted.patch"');
    expect(await up.text()).toMatch(/uncommitted edit/);

    const d = await (await apiHandlers.diff(req('diff', { worktree: fx.featureDir, base: 'main' }))).json();
    expect(d.files).toHaveLength(5);
    expect(d.commits).toHaveLength(2);

    const f = await (await apiHandlers.file(req('file', { worktree: fx.featureDir, base: 'main', path: 'lib/b.js' }))).json();
    expect(f.diff).toMatch(/\+export const hello/);
  });

  test('patch streams text with a download header', async () => {
    const res = await apiHandlers.patch(req('patch', { worktree: fx.featureDir, base: 'main' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/x-patch/);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="feature-vs-main.patch"');
    expect(await res.text()).toMatch(/diff --git a\/lib\/a\.js/);
  });

  test('commit, commit-file and commit-patch serve one commit', async () => {
    const c = await (await apiHandlers.commit(req('commit', { worktree: fx.featureDir, commit: fx.shas.f1 }))).json();
    expect(c.commit).toMatchObject({ sha: fx.shas.f1, subject: 'f1: modify, add, rename' });
    expect(c.parents).toEqual([fx.shas.c1]);
    expect(c.files.map((f: { path: string }) => f.path).sort()).toEqual(['lib/a.js', 'lib/b.js', 'new-name.txt']);

    const f = await (await apiHandlers['commit-file'](req('commit-file', { worktree: fx.featureDir, commit: fx.shas.f1, path: 'lib/a.js' }))).json();
    expect(f.diff).toMatch(/\+export const d = 4;/);

    const p = await apiHandlers['commit-patch'](req('commit-patch', { worktree: fx.featureDir, commit: fx.shas.f1 }));
    expect(p.status).toBe(200);
    expect(p.headers.get('content-type')).toMatch(/text\/x-patch/);
    expect(p.headers.get('content-disposition')).toBe(`attachment; filename="feature-${c.commit.shortSha}.patch"`);
    expect(await p.text()).not.toMatch(/gone\.txt/);

    const ws = await (
      await apiHandlers['commit-file'](
        req('commit-file', { worktree: fx.featureDir, commit: fx.shas.w2, path: 'ws.js', whitespace: 'ignore', context: 'all' }),
      )
    ).json();
    expect(ws.diff).toMatch(/^@@ -1,40 \+1,40 @@/m);
    expect(ws.diff).not.toMatch(/^\+    line 5$/m);

    expect((await apiHandlers.commit(req('commit', { worktree: fx.featureDir, commit: 'nope' }))).status).toBe(404);
    expect((await apiHandlers.commit(req('commit', { worktree: fx.featureDir }))).status).toBe(400);
  });

  test('errors map to HTTP statuses', async () => {
    expect((await apiHandlers.summary(req('summary', { worktree: fx.featureDir, base: 'nope' }))).status).toBe(404);
    expect((await apiHandlers.summary(req('summary', { worktree: fx.featureDir }))).status).toBe(400);
    expect((await apiHandlers.summary(req('summary', { worktree: 'C:/definitely/not/a/worktree', base: 'main' }))).status).toBe(404);
    expect((await apiHandlers.file(req('file', { worktree: fx.featureDir, base: 'main' }))).status).toBe(400);
    const body = await (await apiHandlers.patch(req('patch', { worktree: fx.orphanDir, base: 'main' }))).json();
    expect(body.error).toMatch(/No common history/);
  });
});
