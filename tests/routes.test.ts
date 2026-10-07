// Route handlers are plain functions (Request -> Response), so they can be
// exercised without booting Next. The repository is selected through WTDIFF_CWD
// exactly as the CLI does it.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { resetRepoService } from '@/lib/context';
import { GET as repo } from '@/app/api/repo/route';
import { GET as branches } from '@/app/api/branches/route';
import { GET as summary } from '@/app/api/summary/route';
import { GET as uncommitted } from '@/app/api/uncommitted/route';
import { GET as diff } from '@/app/api/diff/route';
import { GET as file } from '@/app/api/file/route';
import { GET as patch } from '@/app/api/patch/route';
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

describe('API routes', () => {
  test('repo and branches answer JSON with no-store caching', async () => {
    const res = await repo(req('repo'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.worktrees).toHaveLength(6);
    expect(body.defaultBase).toBe('main');

    const b = await (await branches(req('branches', { refresh: '1' }))).json();
    expect(b.local.map((x: { name: string }) => x.name)).toContain('feature');
  });

  test('summary, uncommitted, diff and file return the same data as the service', async () => {
    const s = await (await summary(req('summary', { worktree: fx.featureDir, base: 'main' }))).json();
    expect(s).toMatchObject({ ahead: 2, behind: 4, merge: { state: 'unmerged', conflicts: [] } });

    const u = await (await uncommitted(req('uncommitted', { worktree: fx.featureDir }))).json();
    expect(u).toMatchObject({ changed: 1, untracked: 1 });

    const d = await (await diff(req('diff', { worktree: fx.featureDir, base: 'main' }))).json();
    expect(d.files).toHaveLength(5);
    expect(d.commits).toHaveLength(2);

    const f = await (await file(req('file', { worktree: fx.featureDir, base: 'main', path: 'lib/b.js' }))).json();
    expect(f.diff).toMatch(/\+export const hello/);
  });

  test('patch streams text with a download header', async () => {
    const res = await patch(req('patch', { worktree: fx.featureDir, base: 'main' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/x-patch/);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="feature-vs-main.patch"');
    expect(await res.text()).toMatch(/diff --git a\/lib\/a\.js/);
  });

  test('errors map to HTTP statuses', async () => {
    expect((await summary(req('summary', { worktree: fx.featureDir, base: 'nope' }))).status).toBe(404);
    expect((await summary(req('summary', { worktree: fx.featureDir }))).status).toBe(400);
    expect((await summary(req('summary', { worktree: 'C:/definitely/not/a/worktree', base: 'main' }))).status).toBe(404);
    expect((await file(req('file', { worktree: fx.featureDir, base: 'main' }))).status).toBe(400);
    const body = await (await patch(req('patch', { worktree: fx.orphanDir, base: 'main' }))).json();
    expect(body.error).toMatch(/No common history/);
  });
});
