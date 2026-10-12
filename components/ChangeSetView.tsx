'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { ChangedFile, Commit, UncommittedArea } from '@/lib/git';
import { pool } from '@/lib/client/api';
import { relTime, splitPath, statusName } from '@/lib/client/format';
import { DiffPane, type DiffFormat } from './DiffPane';

export type ChangeSetFile = ChangedFile & { area?: UncommittedArea };

export interface ChangeSetViewProps {
  /** Identifies the change set (worktree + base, or worktree + reload); a new key resets caches. */
  scopeKey: string;
  /** Links at the left of the header, e.g. back to the overview. */
  nav: ReactNode;
  title: string;
  /** Shown next to the title, e.g. a tag saying what kind of change set this is. */
  badge?: ReactNode;
  subtitle: string;
  /** Facts about the change set, shown in the header. */
  meta: ReactNode;
  commits?: Commit[];
  /**
   * Sha of the commit the files belong to, or null for the whole change set.
   * With `onSelectCommit` the commits panel becomes a picker: each entry shows
   * only that commit, a "Whole branch" entry on top goes back.
   */
  activeCommit?: string | null;
  onSelectCommit?: (sha: string | null) => void;
  files: ChangeSetFile[];
  emptyMessage: string;
  /** While the caller is still fetching the file list: shown in place of the files and the diff. */
  loading?: string | null;
  /** The caller could not fetch the file list; shown in the diff pane. */
  error?: string | null;
  /** File preselected from the URL. */
  initialFile: string | null;
  hrefForFile: (path: string) => string;
  fetchFile: (file: ChangeSetFile) => Promise<string>;
  fetchPatch: () => Promise<string>;
  patchHref: string;
}

const COMMITS_HELP =
  'Click a commit to see only what it changed (against its first parent).\n' +
  'Keys: ] moves down the list to the next older commit, [ moves up to the newer one and back to the whole branch.';

const FORMAT_KEY = 'wtdiff.format';
const DRAWER_KEY = 'wtdiff.drawer';
const DRAWER_WIDTH_KEY = 'wtdiff.drawerWidth';
const DRAWER_DEFAULT_WIDTH = 340;
const DRAWER_MIN_WIDTH = 200;

const AREA_LABEL: Record<UncommittedArea, string | null> = {
  staged: 'staged',
  unstaged: null,
  both: 'staged + unstaged',
  untracked: 'untracked',
  conflict: 'conflict',
};

function clampDrawerWidth(w: number): number {
  const max = Math.max(DRAWER_MIN_WIDTH, Math.floor(window.innerWidth * 0.7));
  return Math.min(max, Math.max(DRAWER_MIN_WIDTH, Math.round(w)));
}

function loadDrawerWidth(): number {
  const stored = Number(localStorage.getItem(DRAWER_WIDTH_KEY));
  return Number.isFinite(stored) && stored > 0 ? clampDrawerWidth(stored) : DRAWER_DEFAULT_WIDTH;
}

/**
 * The shared "list of files on the left, one diff on the right" screen used
 * for a worktree's committed diff and for its uncommitted changes.
 */
export function ChangeSetView({
  scopeKey,
  nav,
  title,
  badge,
  subtitle,
  meta,
  commits,
  activeCommit = null,
  onSelectCommit,
  files,
  emptyMessage,
  loading = null,
  error = null,
  initialFile,
  hrefForFile,
  fetchFile,
  fetchPatch,
  patchHref,
}: ChangeSetViewProps) {
  const [activePath, setActivePath] = useState<string | null>(initialFile);
  // The commits panel folds itself for long lists, but stays open while a commit is picked.
  const [commitsOpen, setCommitsOpen] = useState<boolean>(
    () => activeCommit !== null || (commits !== undefined && commits.length > 0 && commits.length <= 8),
  );
  const [format, setFormat] = useState<DiffFormat>(
    () => (localStorage.getItem(FORMAT_KEY) as DiffFormat | null) ?? 'side-by-side',
  );
  const [allFiles, setAllFiles] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState<boolean>(() => localStorage.getItem(DRAWER_KEY) !== 'closed');
  const [drawerWidth, setDrawerWidth] = useState<number>(loadDrawerWidth);
  const [resizing, setResizing] = useState(false);
  const [filter, setFilter] = useState('');
  const [text, setText] = useState<string | null>(null);
  const [loadingLabel, setLoadingLabel] = useState<string | null>(null);
  const [paneError, setPaneError] = useState<string | null>(null);

  const drawerWidthRef = useRef(drawerWidth);
  drawerWidthRef.current = drawerWidth;
  const sidebarRef = useRef<HTMLElement>(null);
  const renderRef = useRef<HTMLDivElement>(null);
  const cache = useRef(new Map<string, string>());
  const token = useRef(0);

  // A new change set invalidates cached patches and in-flight loads.
  const lastScope = useRef(scopeKey);
  if (lastScope.current !== scopeKey) {
    lastScope.current = scopeKey;
    cache.current.clear();
    token.current++;
  }

  const activeFile = useMemo(() => files.find((f) => f.path === activePath) ?? files[0] ?? null, [files, activePath]);

  const loadFile = useCallback(
    async (file: ChangeSetFile) => {
      const hit = cache.current.get(file.path);
      if (hit !== undefined) return hit;
      const diff = await fetchFile(file);
      cache.current.set(file.path, diff);
      return diff;
    },
    [fetchFile],
  );

  // --- load whatever should be in the pane --------------------------------
  useEffect(() => {
    const myToken = token.current;
    setPaneError(null);
    if (allFiles) {
      setLoadingLabel('Loading full patch…');
      fetchPatch()
        .then((t) => {
          if (myToken !== token.current) return;
          setText(t);
          setLoadingLabel(null);
        })
        .catch((err) => {
          if (myToken !== token.current) return;
          setPaneError((err as Error).message);
          setLoadingLabel(null);
        });
      return;
    }
    if (!activeFile) {
      setText(null);
      setLoadingLabel(null);
      return;
    }
    const cached = cache.current.get(activeFile.path);
    if (cached !== undefined) {
      setText(cached);
      setLoadingLabel(null);
    } else {
      setLoadingLabel(`Loading ${activeFile.path}…`);
      loadFile(activeFile)
        .then((t) => {
          if (myToken !== token.current) return;
          setText(t);
          setLoadingLabel(null);
        })
        .catch((err) => {
          if (myToken !== token.current) return;
          setPaneError((err as Error).message);
          setLoadingLabel(null);
        });
    }
    // Warm the cache for the next few files so j/k navigation feels instant.
    const idx = files.indexOf(activeFile);
    pool(files.slice(idx + 1, idx + 4), 1, (f) => (myToken === token.current ? loadFile(f) : Promise.resolve()));
  }, [files, activeFile, allFiles, loadFile, fetchPatch, scopeKey]);

  // In all-files mode, selecting a file scrolls to it instead of reloading.
  useEffect(() => {
    if (!allFiles || !activeFile || text === null) return;
    const headers = renderRef.current?.querySelectorAll('.d2h-file-name') ?? [];
    const header = [...headers].find((el) => el.textContent?.trim().endsWith(activeFile.path));
    header?.closest('.d2h-file-wrapper')?.scrollIntoView({ block: 'start' });
  }, [allFiles, activeFile, text]);

  const selectFile = useCallback(
    (file: ChangeSetFile) => {
      setActivePath(file.path);
      window.history.replaceState(null, '', hrefForFile(file.path));
    },
    [hrefForFile],
  );

  // A picked commit keeps the panel open and is scrolled into view.
  useEffect(() => {
    if (activeCommit === null) return;
    setCommitsOpen(true);
    sidebarRef.current
      ?.querySelector(`.commits li[data-sha="${CSS.escape(activeCommit)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeCommit]);

  // [ and ] walk the commits panel: the "Whole branch" entry on top, then newest
  // to oldest. The cursor is advanced at once so that key repeat does not step
  // from a stale position while the parent is still re-rendering.
  const commitCursor = useRef(activeCommit);
  commitCursor.current = activeCommit;
  const stepCommit = useCallback(
    (delta: 1 | -1) => {
      if (!onSelectCommit || !commits || commits.length === 0) return;
      const order: (string | null)[] = [null, ...commits.map((c) => c.sha)];
      const idx = Math.max(0, order.indexOf(commitCursor.current));
      const next = order[Math.min(order.length - 1, Math.max(0, idx + delta))];
      if (next === commitCursor.current) return;
      commitCursor.current = next;
      onSelectCommit(next);
    },
    [commits, onSelectCommit],
  );

  const visibleFiles = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files;
  }, [files, filter]);

  const toggleDrawer = useCallback(() => {
    setDrawerOpen((open) => {
      localStorage.setItem(DRAWER_KEY, open ? 'closed' : 'open');
      return !open;
    });
  }, []);

  const applyDrawerWidth = useCallback((w: number) => {
    const next = clampDrawerWidth(w);
    setDrawerWidth(next);
    localStorage.setItem(DRAWER_WIDTH_KEY, String(next));
  }, []);

  // --- drawer resize: drag the handle, double-click to fit the longest name --
  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const handle = e.currentTarget;
      const startX = e.clientX;
      const startWidth = drawerWidthRef.current;
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic events have no real pointer to capture */
      }
      setResizing(true);
      const onMove = (ev: PointerEvent) => setDrawerWidth(clampDrawerWidth(startWidth + ev.clientX - startX));
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        setResizing(false);
        applyDrawerWidth(drawerWidthRef.current);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    },
    [applyDrawerWidth],
  );

  const fitDrawerToNames = useCallback(() => {
    const items = sidebarRef.current?.querySelectorAll<HTMLLIElement>('.file-list li[data-path]') ?? [];
    let needed = DRAWER_MIN_WIDTH;
    for (const li of items) {
      const name = li.querySelector<HTMLElement>('.name');
      const textEl = name?.firstElementChild as HTMLElement | null;
      if (!name || !textEl) continue;
      // Everything in the row except the clipped name, plus the name's full text width.
      const chrome = li.getBoundingClientRect().width - name.getBoundingClientRect().width;
      needed = Math.max(needed, Math.ceil(chrome + textEl.getBoundingClientRect().width + 4));
    }
    const scrollbar = sidebarRef.current
      ? sidebarRef.current.offsetWidth - (sidebarRef.current.querySelector<HTMLElement>('.sidebar-inner')?.clientWidth ?? 0)
      : 0;
    applyDrawerWidth(needed + Math.max(0, scrollbar));
  }, [applyDrawerWidth]);

  // --- keyboard: j/k or arrows move between files, f toggles the drawer, [ ] between commits
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.matches('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'f') {
        e.preventDefault();
        toggleDrawer();
        return;
      }
      if (e.key === '[' || e.key === ']') {
        if (!onSelectCommit) return;
        e.preventDefault();
        stepCommit(e.key === ']' ? 1 : -1);
        return;
      }
      const down = e.key === 'j' || e.key === 'ArrowDown';
      const up = e.key === 'k' || e.key === 'ArrowUp';
      if (!down && !up) return;
      if (!visibleFiles.length) return;
      const idx = visibleFiles.findIndex((f) => f.path === activeFile?.path);
      const next = visibleFiles[Math.min(visibleFiles.length - 1, Math.max(0, idx + (down ? 1 : -1)))];
      if (next && next.path !== activeFile?.path) {
        e.preventDefault();
        selectFile(next);
        document.querySelector(`[data-path="${CSS.escape(next.path)}"]`)?.scrollIntoView({ block: 'nearest' });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [visibleFiles, activeFile, selectFile, toggleDrawer, onSelectCommit, stepCommit]);

  const changeFormat = (f: DiffFormat) => {
    setFormat(f);
    localStorage.setItem(FORMAT_KEY, f);
  };

  const activeIndex = activeFile ? files.indexOf(activeFile) + 1 : 0;

  return (
    <section className="diff-view">
      <div className="diff-head">
        <div className="diff-title">
          <span className="diff-nav">{nav}</span>
          <h1>{title}</h1>
          {badge}
          <span className="path muted" title={subtitle}>{subtitle}</span>
        </div>
        <div className="diff-meta">{meta}</div>
      </div>

      <div className={`diff-body${drawerOpen ? '' : ' is-drawer-closed'}${resizing ? ' is-resizing' : ''}`}>
        <aside
          ref={sidebarRef}
          className="sidebar"
          id="diff-drawer"
          aria-hidden={!drawerOpen}
          style={{ width: drawerOpen ? drawerWidth : 0 }}
        >
          <div className="sidebar-inner" style={{ width: drawerWidth }}>
            {commits && (
              <details
                className={`commits${onSelectCommit ? ' is-selectable' : ''}`}
                open={commitsOpen}
                onToggle={(e) => setCommitsOpen(e.currentTarget.open)}
                title={onSelectCommit ? COMMITS_HELP : undefined}
              >
                <summary>
                  Commits <span className="count">({commits.length})</span>
                </summary>
                <ol>
                  {onSelectCommit && commits.length > 0 && (
                    <li
                      className={`whole-branch${activeCommit === null ? ' is-active' : ''}`}
                      aria-current={activeCommit === null ? 'true' : undefined}
                      title="Every commit together: the whole diff of the branch against the base"
                      onClick={() => onSelectCommit(null)}
                    >
                      <span className="sha" aria-hidden="true">all</span>
                      <span className="subject">Whole branch</span>
                    </li>
                  )}
                  {commits.map((c) => (
                    <li
                      key={c.sha}
                      data-sha={c.sha}
                      className={c.sha === activeCommit ? 'is-active' : undefined}
                      aria-current={c.sha === activeCommit ? 'true' : undefined}
                      title={`${c.sha}\n${c.author} <${c.email}>\n${c.date}`}
                      onClick={onSelectCommit ? () => onSelectCommit(c.sha) : undefined}
                    >
                      <span className="sha">{c.shortSha}</span>
                      <span className="subject">{c.subject}</span>
                      <span className="who">{c.author} · {relTime(c.date)}</span>
                    </li>
                  ))}
                  {commits.length === 0 && <li className="muted">No commits beyond the base.</li>}
                </ol>
              </details>
            )}
            <div className="file-filter">
              <input
                type="search"
                placeholder="Filter files"
                spellCheck={false}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            <ul className="file-list">
              {visibleFiles.map((f) => {
                const [dir, name] = splitPath(f.path);
                const areaLabel = f.area ? AREA_LABEL[f.area] : null;
                return (
                  <li
                    key={f.path}
                    data-path={f.path}
                    className={f.path === activeFile?.path ? 'is-active' : undefined}
                    title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                    onClick={() => selectFile(f)}
                  >
                    <span className={`status status-${f.status}`} title={statusName(f.status)}>{f.status}</span>
                    <span className="name">
                      <span>
                        <span className="dir">{dir}</span>
                        {name}
                      </span>
                    </span>
                    <span className="counts">
                      {areaLabel && <span className={`area area-${f.area}`}>{areaLabel}</span>}
                      {f.binary ? (
                        <span className="muted">bin</span>
                      ) : (
                        <>
                          <span className="plus">+{f.additions}</span> <span className="minus">−{f.deletions}</span>
                        </>
                      )}
                    </span>
                  </li>
                );
              })}
              {files.length === 0 && <li className="empty">{loading ?? emptyMessage}</li>}
              {files.length > 0 && visibleFiles.length === 0 && <li className="empty">No files match the filter.</li>}
            </ul>
          </div>
          <div
            className="drawer-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the file list"
            title="Drag to resize. Double-click to fit the longest file name."
            onPointerDown={onHandlePointerDown}
            onDoubleClick={fitDrawerToNames}
          />
        </aside>

        <div className="content">
          <div className="toolbar">
            <button
              type="button"
              className="btn btn-quiet drawer-toggle"
              onClick={toggleDrawer}
              aria-expanded={drawerOpen}
              aria-controls="diff-drawer"
              title={`${drawerOpen ? 'Hide' : 'Show'} the file list (f)`}
            >
              <span className="chevron" aria-hidden="true">{drawerOpen ? '◀' : '▶'}</span>
              Files
              {files.length > 0 && (
                <span className="muted"> {activeIndex}/{files.length}</span>
              )}
            </button>
            {!drawerOpen && activeFile && (
              <span className="toolbar-file mono" title={activeFile.path}>
                {activeFile.path}
              </span>
            )}
            <div className="seg" role="group" aria-label="Layout">
              <button type="button" className={format === 'side-by-side' ? 'is-active' : undefined} onClick={() => changeFormat('side-by-side')}>
                Side by side
              </button>
              <button type="button" className={format === 'line-by-line' ? 'is-active' : undefined} onClick={() => changeFormat('line-by-line')}>
                Unified
              </button>
            </div>
            <label className="check">
              <input type="checkbox" checked={allFiles} onChange={(e) => setAllFiles(e.target.checked)} /> All files
            </label>
            <span className="spacer" />
            <a className="btn btn-quiet" href={patchHref} download>
              Download .patch
            </a>
          </div>
          <div ref={renderRef} className="render-host">
            <DiffPane text={text} format={format} loading={loading ?? loadingLabel} error={error ?? paneError} />
          </div>
        </div>
      </div>
    </section>
  );
}
