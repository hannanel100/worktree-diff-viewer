import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createFixture } from './fixture.js';
import { startServer } from '../src/server.js';
import { normalizePath } from '../src/git.js';

let fx;
let srv;

const get = async (route, params = {}) => {
  const url = new URL(route, srv.url);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, body, headers: res.headers };
};

before(async () => {
  fx = createFixture();
  // Start from inside the feature worktree, like a developer would.
  srv = await startServer({ cwd: fx.featureDir, port: 0 });
});

after(async () => {
  await new Promise((r) => srv.server.close(r));
  fx.cleanup();
});

test('repo info lists every worktree and marks the current one', async () => {
  const { status, body } = await get('/api/repo');
  assert.equal(status, 200);
  assert.equal(body.repoRoot, normalizePath(fx.mainDir));
  assert.equal(body.currentWorktree, normalizePath(fx.featureDir));
  assert.equal(body.defaultBase, 'main');
  assert.equal(body.worktrees.length, 6);
  const current = body.worktrees.find((w) => w.isCurrent);
  assert.equal(current.branch, 'feature');
  assert.equal(body.worktrees[0].isMain, true);
  assert.equal(body.worktrees[0].branch, 'main');
  assert.equal(body.branches, undefined, 'branch list is served separately');
});

test('branch list is served on its own and names are shortened', async () => {
  const { status, body } = await get('/api/branches');
  assert.equal(status, 200);
  assert.deepEqual(
    body.local.map((b) => b.name).sort(),
    ['conflict', 'feature', 'main', 'merged-feature', 'orphan', 'squashed'],
  );
  assert.deepEqual(body.remote, []);
  const feature = body.local.find((b) => b.name === 'feature');
  assert.equal(feature.ref, 'refs/heads/feature');
  assert.match(feature.sha, /^[0-9a-f]{7,}$/);
  assert.equal((await get('/api/branches', { refresh: 1 })).status, 200);
});

test('summary counts only committed changes since the fork', async () => {
  const { status, body } = await get('/api/summary', { worktree: fx.featureDir, base: 'main' });
  assert.equal(status, 200);
  assert.equal(body.mergeBase, fx.shas.c1);
  assert.equal(body.ahead, 2);
  assert.equal(body.behind, 4); // c2, m1, the merge commit c3 and c4 on main are not part of the diff
  assert.equal(body.sameAsBase, false);
  // a.js modified, b.js added, rename, binary, delete
  assert.equal(body.totals.files, 5);
  assert.equal(body.totals.additions, 3); // a.js +2, b.js +1
  assert.equal(body.totals.deletions, 2); // a.js -1, gone.txt -1
  assert.equal(body.uncommitted, undefined, 'uncommitted edits are never folded into the diff');
});

test('uncommitted edits and untracked files are reported separately', async () => {
  const { status, body } = await get('/api/uncommitted', { worktree: fx.featureDir });
  assert.equal(status, 200);
  assert.equal(body.changed, 1);
  assert.equal(body.untracked, 1);
  const main = (await get('/api/uncommitted', { worktree: fx.mainDir })).body;
  assert.deepEqual([main.changed, main.untracked], [0, 0]);
  assert.equal((await get('/api/uncommitted', {})).status, 400);
});

test('summary accepts a worktree by id as well as by path', async () => {
  const repo = (await get('/api/repo')).body;
  const feature = repo.worktrees.find((w) => w.branch === 'feature');
  const { status, body } = await get('/api/summary', { worktree: feature.id, base: 'main' });
  assert.equal(status, 200);
  assert.equal(body.worktree.path, normalizePath(fx.featureDir));
});

test('the main worktree compared to itself is "same as base"', async () => {
  const { body } = await get('/api/summary', { worktree: fx.mainDir, base: 'main' });
  assert.equal(body.sameAsBase, true);
  assert.equal(body.ahead, 0);
  assert.equal(body.totals.files, 0);
  assert.deepEqual(body.merge, { state: 'same', via: null, conflicts: null });
});

test('merge status tells merged (by ancestry or squash) from unmerged and conflicting', async () => {
  const merge = async (dir) => (await get('/api/summary', { worktree: dir, base: 'main' })).body.merge;

  const merged = await get('/api/summary', { worktree: fx.mergedDir, base: 'main' });
  assert.deepEqual(merged.body.merge, { state: 'merged', via: 'ancestry', conflicts: null });
  assert.equal(merged.body.ahead, 0);
  assert.equal(merged.body.totals.files, 0, 'a merged branch has nothing left to show');

  const squashed = await get('/api/summary', { worktree: fx.squashedDir, base: 'main' });
  assert.deepEqual(squashed.body.merge, { state: 'merged', via: 'squash', conflicts: [] });
  assert.equal(squashed.body.ahead, 1, 'its commit is not an ancestor of main');
  assert.equal(squashed.body.totals.files, 1, 'the diff still shows what the branch did');

  assert.deepEqual(await merge(fx.featureDir), { state: 'unmerged', via: null, conflicts: [] });
  assert.deepEqual(await merge(fx.conflictDir), { state: 'unmerged', via: null, conflicts: ['README.md'] });
  assert.deepEqual(await merge(fx.orphanDir), { state: 'unknown', via: null, conflicts: null });

  const diff = await get('/api/diff', { worktree: fx.conflictDir, base: 'main' });
  assert.deepEqual(diff.body.merge.conflicts, ['README.md'], 'the diff screen gets the same answer');

  // merge-tree must leave no trace in the repository apart from loose objects
  const refs = (await get('/api/branches')).body.local.map((b) => b.name).sort();
  assert.deepEqual(refs, ['conflict', 'feature', 'main', 'merged-feature', 'orphan', 'squashed']);
  const mainClean = (await get('/api/uncommitted', { worktree: fx.mainDir })).body;
  assert.deepEqual([mainClean.changed, mainClean.untracked], [0, 0]);
});

test('a branch with no shared history is reported, not crashed on', async () => {
  const { status, body } = await get('/api/summary', { worktree: fx.orphanDir, base: 'main' });
  assert.equal(status, 200);
  assert.equal(body.noCommonHistory, true);
  assert.equal(body.mergeBase, null);
  const diff = await get('/api/diff', { worktree: fx.orphanDir, base: 'main' });
  assert.equal(diff.status, 200);
  assert.deepEqual(diff.body.files, []);
});

test('diff lists commits and files with statuses and rename detection', async () => {
  const { status, body } = await get('/api/diff', { worktree: fx.featureDir, base: 'main' });
  assert.equal(status, 200);
  assert.deepEqual(
    body.commits.map((c) => c.subject),
    ['f2: binary and delete', 'f1: modify, add, rename'],
  );
  assert.equal(body.commits[0].sha, fx.shas.f2);
  assert.equal(body.commits[0].author, 'Test Author');

  const byPath = Object.fromEntries(body.files.map((f) => [f.path, f]));
  assert.equal(byPath['lib/a.js'].status, 'M');
  assert.equal(byPath['lib/a.js'].additions, 2);
  assert.equal(byPath['lib/a.js'].deletions, 1);
  assert.equal(byPath['lib/b.js'].status, 'A');
  assert.equal(byPath['gone.txt'].status, 'D');
  assert.equal(byPath['assets/logo.bin'].status, 'M');
  assert.equal(byPath['assets/logo.bin'].binary, true);
  assert.equal(byPath['new-name.txt'].status, 'R');
  assert.equal(byPath['new-name.txt'].oldPath, 'old-name.txt');
  assert.equal(byPath['new-name.txt'].similarity, 100);
  assert.equal(byPath['README.md'], undefined, 'changes made on main after the fork must not appear');
});

test('file diff returns a unified patch and ignores uncommitted edits', async () => {
  const { status, body } = await get('/api/file', { worktree: fx.featureDir, base: 'main', path: 'lib/b.js' });
  assert.equal(status, 200);
  assert.match(body.diff, /^diff --git a\/lib\/b\.js b\/lib\/b\.js/);
  assert.match(body.diff, /\+export const hello/);
  assert.doesNotMatch(body.diff, /uncommitted edit/);
});

test('file diff of a rename carries both paths', async () => {
  const { body } = await get('/api/file', {
    worktree: fx.featureDir,
    base: 'main',
    path: 'new-name.txt',
    oldPath: 'old-name.txt',
  });
  assert.match(body.diff, /rename from old-name\.txt/);
  assert.match(body.diff, /rename to new-name\.txt/);
});

test('patch download is the whole diff with a download header', async () => {
  const { status, body, headers } = await get('/api/patch', { worktree: fx.featureDir, base: 'main' });
  assert.equal(status, 200);
  assert.match(headers.get('content-disposition'), /attachment; filename="feature-vs-main\.patch"/);
  assert.match(body, /diff --git a\/lib\/a\.js/);
  assert.match(body, /diff --git a\/lib\/b\.js/);
  assert.match(body, /Binary files/);
});

test('any ref works as a base, including a sha', async () => {
  const { status, body } = await get('/api/summary', { worktree: fx.featureDir, base: fx.shas.c1 });
  assert.equal(status, 200);
  assert.equal(body.ahead, 2);
  assert.equal(body.behind, 0);
});

test('bad input is rejected with a clear error', async () => {
  assert.equal((await get('/api/summary', { worktree: fx.featureDir, base: 'nope' })).status, 404);
  assert.equal((await get('/api/summary', { worktree: fx.featureDir, base: '--output=x' })).status, 404);
  assert.equal((await get('/api/summary', { worktree: fx.featureDir, base: 'main..feature' })).status, 404);
  assert.equal((await get('/api/summary', { worktree: fx.featureDir })).status, 400);
  assert.equal((await get('/api/summary', { base: 'main' })).status, 400);
  assert.equal((await get('/api/summary', { worktree: fx.root, base: 'main' })).status, 404);
  assert.equal((await get('/api/file', { worktree: fx.featureDir, base: 'main' })).status, 400);
  assert.equal((await get('/api/nope')).status, 404);
  const post = await fetch(new URL('/api/repo', srv.url), { method: 'POST' });
  assert.equal(post.status, 405);
});

test('static files are served and traversal stays inside public/', async () => {
  const index = await get('/');
  assert.equal(index.status, 200);
  assert.match(index.body, /<title>Worktree Diff<\/title>/);
  assert.equal((await get('/app.js')).status, 200);
  assert.equal((await get('/vendor/diff2html-ui.min.js')).status, 200);
  assert.equal((await get('/vendor/nope.js')).status, 404);
  for (const raw of ['/../package.json', '/%2e%2e/package.json', '/..%5cpackage.json', '/src/git.js']) {
    const res = await fetch(`${srv.url.replace(/\/$/, '')}${raw}`);
    const text = await res.text();
    assert.doesNotMatch(text, /"name": "worktree-diff-viewer"/, `${raw} leaked package.json`);
    assert.doesNotMatch(text, /execFile\(/, `${raw} leaked source`);
  }
});

test('falls back to a free port when the requested one is busy', async () => {
  const second = await startServer({ cwd: fx.featureDir, port: srv.port });
  try {
    assert.notEqual(second.port, srv.port);
  } finally {
    await new Promise((r) => second.server.close(r));
  }
  await assert.rejects(startServer({ cwd: fx.featureDir, port: srv.port, strictPort: true }), /EADDRINUSE/);
});

test('refuses to start outside a git repository', async () => {
  await assert.rejects(startServer({ cwd: fx.root, port: 0 }), /Not inside a git repository/);
});
