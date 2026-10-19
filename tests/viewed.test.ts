import { describe, expect, test } from 'vitest';

import {
  EMPTY_STORE,
  capStore,
  contentKey,
  nextUnviewed,
  rememberLast,
  reviewScopeId,
  scopeProgress,
  setViewed,
  syncScope,
  viewedPaths,
  type ReviewedFile,
  type ViewedStore,
} from '@/lib/client/viewed';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

const files: ReviewedFile[] = [
  { path: 'one.ts', oldBlob: A, blob: B },
  { path: 'two.ts', oldBlob: null, blob: C },
  { path: 'gone.ts', oldBlob: A, blob: null },
];

const ID = reviewScopeId('C:/repo', 'C:/repo/wt', { base: 'dev' });

describe('viewed marks', () => {
  test('scope ids separate repositories, worktrees and what a worktree is compared with', () => {
    const ids = new Set([
      ID,
      reviewScopeId('C:/other', 'C:/repo/wt', { base: 'dev' }),
      reviewScopeId('C:/repo', 'C:/repo/wt2', { base: 'dev' }),
      reviewScopeId('C:/repo', 'C:/repo/wt', { base: 'main' }),
      reviewScopeId('C:/repo', 'C:/repo/wt', { commit: A }),
      reviewScopeId('C:/repo', 'C:/repo/wt', 'uncommitted'),
    ]);
    expect(ids.size).toBe(6);
  });

  test('content keys change with either side of the diff and with the working-tree stamp', () => {
    const base = contentKey(files[0]);
    expect(contentKey({ ...files[0], blob: C })).not.toBe(base);
    expect(contentKey({ ...files[0], oldBlob: C })).not.toBe(base);
    expect(contentKey({ path: 'x', oldBlob: A, blob: null, stamp: '10:1' })).not.toBe(
      contentKey({ path: 'x', oldBlob: A, blob: null, stamp: '10:2' }),
    );
    expect(base.length).toBeLessThan(40); // short prefixes keep the store small
  });

  test('a mark holds until the file changes', () => {
    let store = setViewed(EMPTY_STORE, ID, files, ['one.ts', 'gone.ts'], true, 1);
    expect([...viewedPaths(store.scopes[ID], files)].sort()).toEqual(['gone.ts', 'one.ts']);

    const changed = files.map((f) => (f.path === 'one.ts' ? { ...f, blob: C } : f));
    expect([...viewedPaths(store.scopes[ID], changed)]).toEqual(['gone.ts']);

    store = setViewed(store, ID, files, ['gone.ts'], false, 2);
    expect([...viewedPaths(store.scopes[ID], files)]).toEqual(['one.ts']);
  });

  test('marks for files that left the list or changed are pruned on the next write', () => {
    let store = setViewed(EMPTY_STORE, ID, files, ['one.ts', 'two.ts'], true, 1);
    const later = [{ ...files[0], blob: A }, files[2]]; // one.ts changed, two.ts is gone
    store = setViewed(store, ID, later, ['gone.ts'], true, 2);
    expect(Object.keys(store.scopes[ID].viewed)).toEqual(['gone.ts']);
  });

  test('syncScope drops stale marks and records the revision, or returns the store untouched', () => {
    const store = setViewed(EMPTY_STORE, ID, files, ['one.ts', 'two.ts'], true, 1, 'mb..h1');
    expect(syncScope(store, ID, files, 'mb..h1', 2)).toBe(store);
    expect(syncScope(EMPTY_STORE, ID, files, 'mb..h1', 2)).toBe(EMPTY_STORE);

    const synced = syncScope(store, ID, files.slice(1), 'mb..h2', 3);
    expect(synced.scopes[ID]).toMatchObject({ viewed: { 'two.ts': contentKey(files[1]) }, rev: 'mb..h2', total: 2, at: 3 });
  });

  test('an entry with no marks and no remembered file is removed', () => {
    const store = setViewed(EMPTY_STORE, ID, files, ['one.ts'], true, 1);
    expect(setViewed(store, ID, files, ['one.ts'], false, 2).scopes[ID]).toBeUndefined();
    const withLast = rememberLast(store, ID, 'two.ts', 2);
    expect(setViewed(withLast, ID, files, ['one.ts'], false, 3).scopes[ID]).toMatchObject({ viewed: {}, last: 'two.ts' });
  });

  test('rememberLast keeps the marks and skips a write when nothing changed', () => {
    const store = rememberLast(setViewed(EMPTY_STORE, ID, files, ['one.ts'], true, 1), ID, 'two.ts', 2);
    expect(store.scopes[ID]).toMatchObject({ last: 'two.ts', viewed: { 'one.ts': contentKey(files[0]) } });
    expect(rememberLast(store, ID, 'two.ts', 3)).toBe(store);
  });

  test('capStore drops the least recently used scopes past either limit, never the one in use', () => {
    const entry = (at: number, marks: number) => ({
      at,
      viewed: Object.fromEntries(Array.from({ length: marks }, (_, i) => [`f${i}`, 'k'])),
    });
    const store: ViewedStore = { scopes: { old: entry(1, 2), mid: entry(2, 2), recent: entry(3, 2), current: entry(0, 2) } };
    expect(Object.keys(capStore(store, 'current', { maxScopes: 2, maxMarks: 100 }).scopes).sort()).toEqual(['current', 'recent']);
    expect(Object.keys(capStore(store, 'current', { maxScopes: 10, maxMarks: 5 }).scopes).sort()).toEqual(['current', 'recent']);
    expect(Object.keys(capStore(store, 'current', { maxScopes: 0, maxMarks: 0 }).scopes)).toEqual(['current']);
  });

  test('nextUnviewed walks forward, wraps around and gives up when everything else is viewed', () => {
    const list = [{ path: 'a' }, { path: 'b' }, { path: 'c' }, { path: 'd' }];
    expect(nextUnviewed(list, new Set(['b']), 'a')).toBe('c');
    expect(nextUnviewed(list, new Set(['a']), 'd')).toBe('b');
    expect(nextUnviewed(list, new Set(['a', 'b', 'd']), 'c')).toBeNull();
    expect(nextUnviewed(list, new Set(), 'gone')).toBe('a');
    expect(nextUnviewed([], new Set(), null)).toBeNull();
  });

  test('scopeProgress only reports for the revision the marks were made on', () => {
    const store = setViewed(EMPTY_STORE, ID, files, ['one.ts'], true, 1, 'mb..h1');
    expect(scopeProgress(store, ID, 'mb..h1')).toEqual({ viewed: 1, total: 3 });
    expect(scopeProgress(store, ID, 'mb..h2')).toBeNull();
    expect(scopeProgress(store, 'other', 'mb..h1')).toBeNull();
  });
});
