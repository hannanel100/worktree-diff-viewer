import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { normalizePath } from '@/lib/git';
import { diffOptions, FULL_CONTEXT, HttpError, RepoService } from '@/lib/repo-service';
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
    expect(await service.uncommitted({ worktree: fx.featureDir })).toMatchObject({ changed: 2, untracked: 1 });
    expect(await service.uncommitted({ worktree: fx.mainDir })).toMatchObject({ changed: 0, untracked: 0 });
    expect(await status(service.uncommitted({}))).toBe(400);
  });

  test('uncommitted files list staged, unstaged and untracked changes with counts', async () => {
    const u = await service.uncommittedFiles({ worktree: fx.featureDir });
    expect(u.worktree.branch).toBe('feature');
    expect(u.head).toBe(fx.shas.f2);
    expect(u.counts).toEqual({ changed: 2, untracked: 1 });
    const byPath = Object.fromEntries(u.files.map((f) => [f.path, f]));
    expect(byPath['lib/b.js']).toMatchObject({ status: 'M', area: 'unstaged', additions: 1, deletions: 0, binary: false });
    expect(byPath['staged.txt']).toMatchObject({ status: 'A', area: 'staged', additions: 1, deletions: 0 });
    expect(byPath['scratch.txt']).toMatchObject({ status: 'A', area: 'untracked', additions: 1, deletions: 0, binary: false });
    expect(u.totals).toEqual({ files: 3, additions: 3, deletions: 0 });

    const clean = await service.uncommittedFiles({ worktree: fx.mainDir });
    expect(clean.files).toEqual([]);
    expect(clean.totals).toEqual({ files: 0, additions: 0, deletions: 0 });
  });

  test('uncommitted file diffs come from the working tree, untracked files included', async () => {
    const edited = await service.uncommittedFile({ worktree: fx.featureDir, path: 'lib/b.js' });
    expect(edited.area).toBe('unstaged');
    expect(edited.diff).toMatch(/^diff --git a\/lib\/b\.js b\/lib\/b\.js/);
    expect(edited.diff).toMatch(/\+\/\/ uncommitted edit/);

    const staged = await service.uncommittedFile({ worktree: fx.featureDir, path: 'staged.txt' });
    expect(staged.area).toBe('staged');
    expect(staged.diff).toMatch(/new file mode 100644/);
    expect(staged.diff).toMatch(/\+staged content/);

    const untracked = await service.uncommittedFile({ worktree: fx.featureDir, path: 'scratch.txt' });
    expect(untracked.area).toBe('untracked');
    expect(untracked.diff).toBe(
      'diff --git a/scratch.txt b/scratch.txt\nnew file mode 100644\n--- /dev/null\n+++ b/scratch.txt\n@@ -0,0 +1,1 @@\n+untracked\n',
    );

    // Only paths git reports as changed can be read; nothing else on disk.
    expect(await status(service.uncommittedFile({ worktree: fx.featureDir, path: 'README.md' }))).toBe(404);
    expect(await status(service.uncommittedFile({ worktree: fx.featureDir, path: '../repo/README.md' }))).toBe(404);
    expect(await status(service.uncommittedFile({ worktree: fx.featureDir }))).toBe(400);
  });

  test('uncommitted patch bundles tracked and untracked changes', async () => {
    const p = await service.uncommittedPatch({ worktree: fx.featureDir });
    expect(p.filename).toBe('feature-uncommitted.patch');
    expect(p.text).toMatch(/diff --git a\/lib\/b\.js/);
    expect(p.text).toMatch(/diff --git a\/staged\.txt/);
    expect(p.text).toMatch(/diff --git a\/scratch\.txt b\/scratch\.txt\nnew file mode 100644/);
    expect(p.text).toMatch(/\+untracked/);
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

  test('commit shows one commit against its first parent, with rename detection', async () => {
    const c = await service.commit({ worktree: fx.featureDir, commit: fx.shas.f1 });
    expect(c.worktree.branch).toBe('feature');
    expect(c.commit).toMatchObject({ sha: fx.shas.f1, subject: 'f1: modify, add, rename', author: 'Test Author' });
    expect(c.commit.shortSha).toBe(fx.shas.f1.slice(0, c.commit.shortSha.length));
    expect(c.parents).toEqual([fx.shas.c1]);
    expect(c.parent).toBe(fx.shas.c1);

    const byPath = Object.fromEntries(c.files.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual(['lib/a.js', 'lib/b.js', 'new-name.txt']);
    expect(byPath['lib/a.js']).toMatchObject({ status: 'M', additions: 2, deletions: 1, binary: false });
    expect(byPath['lib/b.js']).toMatchObject({ status: 'A', additions: 1, deletions: 0 });
    expect(byPath['new-name.txt']).toMatchObject({ status: 'R', oldPath: 'old-name.txt', similarity: 100 });
    expect(c.totals).toEqual({ files: 3, additions: 3, deletions: 1 });
    expect(byPath['gone.txt'], 'f2 is not part of f1').toBeUndefined();
  });

  test('commit reports binary changes and deletions', async () => {
    const c = await service.commit({ worktree: fx.featureDir, commit: fx.shas.f2 });
    expect(c.commit.subject).toBe('f2: binary and delete');
    expect(c.parents).toEqual([fx.shas.f1]);
    const byPath = Object.fromEntries(c.files.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual(['assets/logo.bin', 'gone.txt']);
    expect(byPath['assets/logo.bin']).toMatchObject({ status: 'M', binary: true, additions: 0, deletions: 0 });
    expect(byPath['gone.txt']).toMatchObject({ status: 'D', additions: 0, deletions: 1 });
    expect(c.totals).toEqual({ files: 2, additions: 0, deletions: 1 });
  });

  test('a root commit is diffed against the empty tree: every file is added', async () => {
    const c = await service.commit({ worktree: fx.featureDir, commit: fx.shas.c1 });
    expect(c.commit.subject).toBe('c1: initial');
    expect(c.parents).toEqual([]);
    expect(c.parent).toBeNull();
    expect(c.files.map((f) => f.path).sort()).toEqual(['README.md', 'assets/logo.bin', 'gone.txt', 'lib/a.js', 'old-name.txt']);
    expect(c.files.every((f) => f.status === 'A')).toBe(true);
    expect(c.totals).toEqual({ files: 5, additions: 13, deletions: 0 });

    const readme = await service.commitFile({ worktree: fx.featureDir, commit: fx.shas.c1, path: 'README.md' });
    expect(readme.parent).toBeNull();
    expect(readme.diff).toMatch(/new file mode 100644/);
    expect(readme.diff).toMatch(/\+# Fixture/);
  });

  test('a merge commit is diffed against its first parent only', async () => {
    const c = await service.commit({ worktree: fx.mainDir, commit: fx.shas.c3 });
    expect(c.commit.subject).toBe('c3: merge merged-feature');
    expect(c.parents).toHaveLength(2);
    expect(c.parents[0]).toBe(fx.shas.c2);
    expect(c.parent).toBe(fx.shas.c2);
    expect(c.files.map((f) => f.path)).toEqual(['merged.txt']);
    expect(c.files[0]).toMatchObject({ status: 'A', additions: 1 });
  });

  test('commit file diffs are scoped to the commit and carry rename paths', async () => {
    const f = await service.commitFile({ worktree: fx.featureDir, commit: fx.shas.f1, path: 'lib/a.js' });
    expect(f).toMatchObject({ path: 'lib/a.js', oldPath: null, commit: fx.shas.f1, parent: fx.shas.c1 });
    expect(f.diff).toMatch(/^diff --git a\/lib\/a\.js b\/lib\/a\.js/);
    expect(f.diff).toMatch(/\+export const d = 4;/);
    expect(f.diff).toMatch(/-export const a = 1;/);

    const r = await service.commitFile({ worktree: fx.featureDir, commit: fx.shas.f1, path: 'new-name.txt', oldPath: 'old-name.txt' });
    expect(r.diff).toMatch(/rename from old-name\.txt/);
    expect(r.diff).toMatch(/rename to new-name\.txt/);

    // A file the commit did not touch has nothing to show.
    const none = await service.commitFile({ worktree: fx.featureDir, commit: fx.shas.f1, path: 'gone.txt' });
    expect(none.diff).toBe('');
  });

  test('commit patch is only that commit, named after the branch and the short sha', async () => {
    const c = await service.commit({ worktree: fx.featureDir, commit: fx.shas.f1 });
    const p = await service.commitPatch({ worktree: fx.featureDir, commit: fx.shas.f1 });
    expect(p.filename).toBe(`feature-${c.commit.shortSha}.patch`);
    expect(p.text).toMatch(/diff --git a\/lib\/a\.js/);
    expect(p.text).toMatch(/diff --git a\/lib\/b\.js/);
    expect(p.text).toMatch(/rename from old-name\.txt/);
    expect(p.text).not.toMatch(/gone\.txt/);
    expect(p.text).not.toMatch(/Binary files/);
  });

  test('bad or missing commits are rejected with a clear status', async () => {
    expect(await status(service.commit({ worktree: fx.featureDir, commit: 'nope' }))).toBe(404);
    expect(await status(service.commit({ worktree: fx.featureDir, commit: '--output=x' }))).toBe(404);
    expect(await status(service.commit({ worktree: fx.featureDir, commit: 'main..feature' }))).toBe(404);
    expect(await status(service.commit({ worktree: fx.featureDir, commit: 'HEAD~1' }))).toBe(404);
    // A tree is not a commit.
    expect(await status(service.commit({ worktree: fx.featureDir, commit: '4b825dc642cb6eb9a060e54bf8d69288fbee4904' }))).toBe(404);
    expect(await status(service.commit({ worktree: fx.featureDir }))).toBe(400);
    expect(await status(service.commit({ commit: fx.shas.f1 }))).toBe(400);
    expect(await status(service.commit({ worktree: fx.root, commit: fx.shas.f1 }))).toBe(404);
    expect(await status(service.commitFile({ worktree: fx.featureDir, commit: fx.shas.f1 }))).toBe(400);
    expect(await status(service.commitFile({ worktree: fx.featureDir, commit: 'nope', path: 'lib/a.js' }))).toBe(404);
    expect(await status(service.commitPatch({ worktree: fx.featureDir, commit: 'nope' }))).toBe(404);
  });

  test('diff options are parsed leniently, falling back to git defaults', () => {
    expect(diffOptions({})).toEqual({ context: 3, ignoreWhitespace: false });
    expect(diffOptions({ context: '0' })).toEqual({ context: 0, ignoreWhitespace: false });
    expect(diffOptions({ context: '10', whitespace: 'ignore' })).toEqual({ context: 10, ignoreWhitespace: true });
    expect(diffOptions({ context: 'all' }).context).toBe(FULL_CONTEXT);
    expect(diffOptions({ context: '99999999' }).context).toBe(FULL_CONTEXT);
    expect(diffOptions({ context: '-5' }).context).toBe(0);
    expect(diffOptions({ context: 'lots' }).context).toBe(3);
    expect(diffOptions({ context: '' }).context).toBe(3);
    expect(diffOptions({ whitespace: 'yes' }).ignoreWhitespace).toBe(false);
  });

  test('ignoring whitespace drops whitespace-only hunks and keeps real ones', async () => {
    const wt = fx.featureDir;
    const plain = await service.commitFile({ worktree: wt, commit: fx.shas.w2, path: 'ws.js' });
    expect(plain.diff).toMatch(/^\+    line 5$/m);
    expect(plain.diff).toMatch(/^\+line thirty$/m);

    const ignored = await service.commitFile({ worktree: wt, commit: fx.shas.w2, path: 'ws.js', whitespace: 'ignore' });
    expect(ignored.diff).not.toMatch(/^[-+] *line 5$/m);
    expect(ignored.diff).toMatch(/^\+line thirty$/m);

    // A file that only changed whitespace keeps its header but has no hunk at all.
    const only = await service.commitFile({ worktree: wt, commit: fx.shas.w2, path: 'ws-only.txt', whitespace: 'ignore' });
    expect(only.diff).not.toMatch(/^@@ /m);

    const patch = await service.commitPatch({ worktree: wt, commit: fx.shas.w2, whitespace: 'ignore' });
    expect(patch.text).toMatch(/^\+line thirty$/m);
    expect(patch.text).not.toMatch(/^\+a  b  $/m);
    expect((await service.commitPatch({ worktree: wt, commit: fx.shas.w2 })).text).toMatch(/^\+a  b  $/m);
  });

  test('context widens to the whole file or narrows to the changed lines only', async () => {
    const wt = fx.featureDir;
    const hunks = (diff: string) => diff.match(/^@@ [^@]* @@/gm) ?? [];

    const normal = await service.commitFile({ worktree: wt, commit: fx.shas.w2, path: 'ws.js' });
    expect(hunks(normal.diff)).toEqual(['@@ -2,7 +2,7 @@', '@@ -27,7 +27,7 @@']);

    const whole = await service.commitFile({ worktree: wt, commit: fx.shas.w2, path: 'ws.js', context: 'all' });
    expect(hunks(whole.diff)).toEqual(['@@ -1,40 +1,40 @@']);
    expect(whole.diff).toMatch(/^ line 1$/m);
    expect(whole.diff).toMatch(/^ line 40$/m);

    const tight = await service.commitFile({ worktree: wt, commit: fx.shas.w2, path: 'ws.js', context: '0' });
    expect(hunks(tight.diff)).toEqual(['@@ -5 +5 @@', '@@ -30 +30 @@']);

    // The branch diff and its patch take the same options.
    const file = await service.file({ worktree: wt, base: 'main', path: 'lib/a.js', context: '0' });
    expect(hunks(file.diff)).toHaveLength(2);
    expect(hunks((await service.file({ worktree: wt, base: 'main', path: 'lib/a.js' })).diff)).toHaveLength(1);
    const patch = await service.patch({ worktree: wt, base: 'main', context: '0' });
    expect(patch.text).not.toMatch(/^ export const b = 2;$/m);
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
