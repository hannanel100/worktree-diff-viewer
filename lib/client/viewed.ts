// Which files of a change set the reviewer has marked as viewed, remembered
// per browser. A mark belongs to one review scope (repository + worktree +
// base, commit or uncommitted changes) and to the content the file had when it
// was marked: once the file changes, the mark no longer applies.
//
// Everything is kept under one localStorage key and stays bounded: a scope
// only keeps marks for files still in its list, and the least recently used
// scopes are dropped past a cap.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { loadJson, saveJson } from './storage';

/** The parts of a changed file that say which version of it was reviewed. */
export interface ReviewedFile {
  path: string;
  oldBlob: string | null;
  blob: string | null;
  /** Working-tree size and mtime, for uncommitted files (which have no blob id on that side). */
  stamp?: string;
}

export interface ScopeEntry {
  /** When the entry was last written (ms since epoch); the least recent go first. */
  at: number;
  /** path -> content key of the file when it was marked viewed. */
  viewed: Record<string, string>;
  /** The file that was open last. */
  last?: string;
  /**
   * What the file list was computed from (merge base..head for a branch
   * diff) and how many files it had, so the Overview can show progress
   * without loading every list. Only meaningful while `rev` still matches.
   */
  rev?: string;
  total?: number;
}

export interface ViewedStore {
  scopes: Record<string, ScopeEntry>;
}

export const EMPTY_STORE: ViewedStore = { scopes: {} };

export const STORE_LIMITS = { maxScopes: 200, maxMarks: 5_000 };

const STORAGE_KEY = 'wtdiff.viewed';

/** Short blob prefixes are plenty to tell versions of one path apart, and keep the store small. */
const short = (sha: string | null) => (sha ? sha.slice(0, 16) : '-');

export function contentKey(f: ReviewedFile): string {
  return `${short(f.oldBlob)}:${short(f.blob)}${f.stamp ? `:${f.stamp}` : ''}`;
}

export type ReviewScopeKind = { base: string } | { commit: string } | 'uncommitted';

export function reviewScopeId(repoRoot: string, worktree: string, scope: ReviewScopeKind): string {
  const what =
    scope === 'uncommitted' ? 'uncommitted' : 'base' in scope ? `base:${scope.base}` : `commit:${scope.commit}`;
  return `${repoRoot}\0${worktree}\0${what}`;
}

/** Paths of `files` that are marked viewed in `entry` and have not changed since. */
export function viewedPaths(entry: ScopeEntry | undefined, files: ReviewedFile[]): Set<string> {
  const out = new Set<string>();
  if (!entry) return out;
  for (const f of files) {
    if (entry.viewed[f.path] === contentKey(f)) out.add(f.path);
  }
  return out;
}

/** Keep only marks for files still in the list with the same content. */
function prunedMarks(entry: ScopeEntry | undefined, files: ReviewedFile[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of viewedPaths(entry, files)) out[path] = entry!.viewed[path];
  return out;
}

/**
 * Drop the least recently used scopes until at most `maxScopes` remain and they
 * hold at most `maxMarks` marks together. `keep` is never dropped.
 */
export function capStore(store: ViewedStore, keep: string | null, limits = STORE_LIMITS): ViewedStore {
  const ids = Object.keys(store.scopes).sort((a, b) =>
    a === keep ? -1 : b === keep ? 1 : store.scopes[b].at - store.scopes[a].at,
  );
  const scopes: Record<string, ScopeEntry> = {};
  let marks = 0;
  for (const id of ids) {
    const entry = store.scopes[id];
    const n = Object.keys(entry.viewed).length;
    if (id !== keep && (Object.keys(scopes).length >= limits.maxScopes || marks + n > limits.maxMarks)) continue;
    scopes[id] = entry;
    marks += n;
  }
  return { scopes };
}

function withEntry(store: ViewedStore, id: string, entry: ScopeEntry): ViewedStore {
  const scopes = { ...store.scopes };
  if (Object.keys(entry.viewed).length === 0 && !entry.last) delete scopes[id];
  else scopes[id] = entry;
  return capStore({ scopes }, id);
}

/** Mark (or unmark) `paths` as viewed, pruning marks for files that left the list or changed. */
export function setViewed(
  store: ViewedStore,
  id: string,
  files: ReviewedFile[],
  paths: string[],
  viewed: boolean,
  now: number,
  rev?: string,
): ViewedStore {
  const prev = store.scopes[id];
  const marks = prunedMarks(prev, files);
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const path of paths) {
    const file = byPath.get(path);
    if (viewed && file) marks[path] = contentKey(file);
    else delete marks[path];
  }
  return withEntry(store, id, { ...prev, at: now, viewed: marks, ...(rev !== undefined && { rev, total: files.length }) });
}

/**
 * Bring a scope's entry in line with the current file list: drop stale marks
 * and record `rev`. Returns the same store when nothing would change, so
 * callers can skip the write.
 */
export function syncScope(store: ViewedStore, id: string, files: ReviewedFile[], rev: string | undefined, now: number): ViewedStore {
  const prev = store.scopes[id];
  if (!prev) return store;
  const marks = prunedMarks(prev, files);
  const sameMarks = Object.keys(marks).length === Object.keys(prev.viewed).length;
  const sameRev = rev === undefined || (prev.rev === rev && prev.total === files.length);
  if (sameMarks && sameRev) return store;
  return withEntry(store, id, { ...prev, at: now, viewed: marks, ...(rev !== undefined && { rev, total: files.length }) });
}

export function rememberLast(store: ViewedStore, id: string, path: string, now: number): ViewedStore {
  const prev = store.scopes[id];
  if (prev?.last === path) return store;
  return withEntry(store, id, { ...prev, viewed: prev?.viewed ?? {}, at: now, last: path });
}

/** The next file after `from` (wrapping around) that is not viewed, or null when every other file is. */
export function nextUnviewed(files: { path: string }[], viewed: Set<string>, from: string | null): string | null {
  const start = files.findIndex((f) => f.path === from);
  for (let step = 1; step <= files.length; step++) {
    const f = files[(start + step + files.length) % files.length];
    if (f.path !== from && !viewed.has(f.path)) return f.path;
  }
  return null;
}

/** Viewed progress of a scope for the Overview, or null when nothing is known for this exact `rev`. */
export function scopeProgress(store: ViewedStore, id: string, rev: string): { viewed: number; total: number } | null {
  const entry = store.scopes[id];
  if (!entry || entry.rev !== rev || entry.total === undefined) return null;
  const viewed = Object.keys(entry.viewed).length;
  return viewed > 0 ? { viewed, total: entry.total } : null;
}

// ---------------------------------------------------------------------------
// Browser side
// ---------------------------------------------------------------------------

export function loadViewedStore(): ViewedStore {
  const store = loadJson<ViewedStore>(STORAGE_KEY, EMPTY_STORE);
  return store.scopes && typeof store.scopes === 'object' ? store : EMPTY_STORE;
}

function update(change: (store: ViewedStore) => ViewedStore): ViewedStore {
  // Read before every write so marks made in another tab are not lost.
  const before = loadViewedStore();
  const after = change(before);
  if (after !== before) saveJson(STORAGE_KEY, after);
  return after;
}

function useStoreState() {
  const state = useState(loadViewedStore);
  const setStore = state[1];
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY || e.key === null) setStore(loadViewedStore());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [setStore]);
  return state;
}

/** The whole store, kept current when another tab writes it. */
export function useViewedStore(): ViewedStore {
  return useStoreState()[0];
}

export interface ReviewScope {
  id: string;
  /** See ScopeEntry.rev; only branch diffs record one. */
  rev?: string;
}

export interface ViewedState {
  viewed: Set<string>;
  setViewed(paths: string[], viewed: boolean): void;
  rememberLast(path: string): void;
}

/** Viewed marks of one review scope (null: marks are off, e.g. while the list loads). */
export function useViewed(scope: ReviewScope | null, files: ReviewedFile[]): ViewedState {
  const [store, setStore] = useStoreState();
  const id = scope?.id ?? null;
  const rev = scope?.rev;
  const filesRef = useRef(files);
  filesRef.current = files;

  // A fresh list drops stale marks and records what the list was computed from.
  useEffect(() => {
    if (id === null || files.length === 0) return;
    setStore(update((s) => syncScope(s, id, files, rev, Date.now())));
  }, [id, rev, files]);

  const viewed = useMemo(() => (id === null ? new Set<string>() : viewedPaths(store.scopes[id], files)), [store, id, files]);

  const set = useCallback(
    (paths: string[], value: boolean) => {
      if (id === null) return;
      setStore(update((s) => setViewed(s, id, filesRef.current, paths, value, Date.now(), rev)));
    },
    [id, rev],
  );

  // Moving through files writes often (j/k), so the last file is saved a moment later.
  const lastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const remember = useCallback(
    (path: string) => {
      if (id === null) return;
      clearTimeout(lastTimer.current);
      lastTimer.current = setTimeout(() => update((s) => rememberLast(s, id, path, Date.now())), 400);
    },
    [id],
  );
  useEffect(() => () => clearTimeout(lastTimer.current), []);

  return { viewed, setViewed: set, rememberLast: remember };
}

/** The file that was open last in a scope, if any. */
export function lastFile(id: string | null): string | null {
  return id === null ? null : (loadViewedStore().scopes[id]?.last ?? null);
}
