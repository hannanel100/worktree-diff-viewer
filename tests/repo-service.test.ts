import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { normalizePath } from '@/lib/git';
import { HttpError, RepoService } from '@/lib/repo-service';
import { createFixture, type Fixture } from './fixture';

let fx: Fixture;
let service: RepoService;

beforeAll(async () => {
  fx = createFixture();
  // Open from inside the feature worktree, like a developer would.
  service = await RepoService.open(fx.featureDir);
});

afterAll(() => fx.cleanup());

const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 200;
  } catch (err) {
    if (err instanceof HttpError) return err.status;
    throw err;
  }
};

describe('RepoService', () => {
  test('info lists every worktree and marks the current one', async () => {
    const info = await service.info();
    expect(info.repoRoot).toBe(normalizePath(fx.mainDir));
    expect(info.currentWorktree).toBe(normalizePath(fx.featureDir));
    expect(info.defaultBase).toBe('main');
    expect(info.worktrees).toHaveLength(6);
    expect(info.worktrees.find((w) => w.isCurrent)?.branch).toBe('feature');
    expect(info.worktrees[0]).toMatchObject({ isMain: true, branch: 'main' });
  });

  test('branches are listed with shortened names', async () => {
    const b = await service.branches();
    expect(b.local.map((x) => x.name).sort()).toEqual(['conflict', 'feature', 'main', 'merged-feature', 'orphan', 'squashed']);
    expect(b.remote).toEqual([]);
    expect(b.local.find((x) => x.name === 'feature')).toMatchObject({ ref: 'refs/heads/feature' });
  });

  test('summary counts only committed changes since the fork', async () => {
    const s = await service.summary({ worktree: fx.featureDir, base: 'main' });
    expect(s.mergeBase).toBe(fx.shas.c1);
    expect(s.ahead).toBe(2);
    expect(s.behind).toBe(4); // c2, m1, the merge commit c3 and c4 on main are not part of the diff
    expect(s.sameAsBase).toBe(false);
    expect(s.totals).toEqual({ files: 5, additions: 3, deletions: 2 });
    expect('uncommitted' in s).toBe(false);
  });

  test('uncommitted edits and untracked files are reported separately', async () => {
    expect(await service.uncommitted({ worktree: fx.featureDir })).toMatchObject({ changed: 1, untracked: 1 });
    expect(await service.uncommitted({ worktree: fx.mainDir })).toMatchObject({ changed: 0, untracked: 0 });
    expect(await status(service.uncommitted({}))).toBe(400);
  });

  test('a worktree can be addressed by id as well as by path', async () => {
    const info = await service.info();
    const feature = info.worktrees.find((w) => w.branch === 'feature')!;
    const s = await service.summary({ worktree: feature.id, base: 'main' });
    expect(s.worktree.path).toBe(normalizePath(fx.featureDir));
  });

  test('the main worktree compared to itself is "same as base"', async () => {
    const s = await service.summary({ worktree: fx.mainDir, base: 'main' });
    expect(s.sameAsBase).toBe(true);
    expect(s.ahead).toBe(0);
    expect(s.totals?.files).toBe(0);
    expect(s.merge).toEqual({ state: 'same', via: null, conflicts: null });
  });

  test('merge status tells merged (by ancestry or squash) from unmerged and conflicting', async () => {
    const merge = async (dir: string) => (await service.summary({ worktree: dir, base: 'main' })).merge;

    const merged = await service.summary({ worktree: fx.mergedDir, base: 'main' });
    expect(merged.merge).toEqual({ state: 'merged', via: 'ancestry', conflicts: null });
    expect(merged.ahead).toBe(0);
    expect(merged.totals?.files).toBe(0);

    const squashed = await service.summary({ worktree: fx.squashedDir, base: 'main' });
    expect(squashed.merge).toEqual({ state: 'merged', via: 'squash', conflicts: [] });
    expect(squashed.ahead).toBe(1);
    expect(squashed.totals?.files).toBe(1);

    expect(await merge(fx.featureDir)).toEqual({ state: 'unmerged', via: null, conflicts: [] });
    expect(await merge(fx.conflictDir)).toEqual({ state: 'unmerged', via: null, conflicts: ['README.md'] });
    expect(await merge(fx.orphanDir)).toEqual({ state: 'unknown', via: null, conflicts: null });

    // merge-tree must leave no trace apart from loose objects
    expect((await service.branches({ force: true })).local).toHaveLength(6);
    expect(await service.uncommitted({ worktree: fx.mainDir })).toMatchObject({ changed: 0, untracked: 0 });
  });

  test('a branch with no shared history is reported, not crashed on', async () => {
    const s = await service.summary({ worktree: fx.orphanDir, base: 'main' });
    expect(s.noCommonHistory).toBe(true);
    expect(s.mergeBase).toBeNull();
    const d = await service.diff({ worktree: fx.orphanDir, base: 'main' });
    expect(d.files).toEqual([]);
    expect(await status(service.file({ worktree: fx.orphanDir, base: 'main', path: 'alone.txt' }))).toBe(409);
  });

  test('diff lists commits and files with statuses and rename detection', async () => {
    const d = await service.diff({ worktree: fx.featureDir, base: 'main' });
    expect(d.commits.map((c) => c.subject)).toEqual(['f2: binary and delete', 'f1: modify, add, rename']);
    expect(d.commits[0]).toMatchObject({ sha: fx.shas.f2, author: 'Test Author' });
    expect(d.merge.conflicts).toEqual([]);

    const byPath = Object.fromEntries(d.files.map((f) => [f.path, f]));
    expect(byPath['lib/a.js']).toMatchObject({ status: 'M', additions: 2, deletions: 1 });
    expect(byPath['lib/b.js'].status).toBe('A');
    expect(byPath['gone.txt'].status).toBe('D');
    expect(byPath['assets/logo.bin']).toMatchObject({ status: 'M', binary: true });
    expect(byPath['new-name.txt']).toMatchObject({ status: 'R', oldPath: 'old-name.txt', similarity: 100 });
    expect(byPath['README.md'], 'changes made on main after the fork must not appear').toBeUndefined();
  });

  test('file diff returns a unified patch and ignores uncommitted edits', async () => {
    const f = await service.file({ worktree: fx.featureDir, base: 'main', path: 'lib/b.js' });
    expect(f.diff).toMatch(/^diff --git a\/lib\/b\.js b\/lib\/b\.js/);
    expect(f.diff).toMatch(/\+export const hello/);
    expect(f.diff).not.toMatch(/uncommitted edit/);
  });

  test('file diff of a rename carries both paths', async () => {
    const f = await service.file({ worktree: fx.featureDir, base: 'main', path: 'new-name.txt', oldPath: 'old-name.txt' });
    expect(f.diff).toMatch(/rename from old-name\.txt/);
    expect(f.diff).toMatch(/rename to new-name\.txt/);
  });

  test('patch is the whole diff with a download-friendly name', async () => {
    const p = await service.patch({ worktree: fx.featureDir, base: 'main' });
    expect(p.filename).toBe('feature-vs-main.patch');
    expect(p.text).toMatch(/diff --git a\/lib\/a\.js/);
    expect(p.text).toMatch(/diff --git a\/lib\/b\.js/);
    expect(p.text).toMatch(/Binary files/);
  });

  test('any ref works as a base, including a sha', async () => {
    const s = await service.summary({ worktree: fx.featureDir, base: fx.shas.c1 });
    expect(s.ahead).toBe(2);
    expect(s.behind).toBe(0);
  });

  test('bad input is rejected with a clear status', async () => {
    expect(await status(service.summary({ worktree: fx.featureDir, base: 'nope' }))).toBe(404);
    expect(await status(service.summary({ worktree: fx.featureDir, base: '--output=x' }))).toBe(404);
    expect(await status(service.summary({ worktree: fx.featureDir, base: 'main..feature' }))).toBe(404);
    expect(await status(service.summary({ worktree: fx.featureDir }))).toBe(400);
    expect(await status(service.summary({ base: 'main' }))).toBe(400);
    expect(await status(service.summary({ worktree: fx.root, base: 'main' }))).toBe(404);
    expect(await status(service.file({ worktree: fx.featureDir, base: 'main' }))).toBe(400);
  });

  test('refuses to open outside a git repository', async () => {
    await expect(RepoService.open(fx.root)).rejects.toThrow(/Not inside a git repository/);
  });
});
