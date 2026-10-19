'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { ChangedFile, Commit, UncommittedArea } from '@/lib/git';
import { pool } from '@/lib/client/api';
import { CONTEXT_CHOICES, contextLabel, parseContext, type DiffOptions } from '@/lib/client/diff-options';
import { EDITORS, editorLabel, editorUrl, joinPath, useEditor, type EditorId } from '@/lib/client/editor';
import { relTime, splitPath, statusName } from '@/lib/client/format';
import { lastFile, nextUnviewed, useViewed, type ReviewScope } from '@/lib/client/viewed';
import { DiffPane, type DiffFormat, type PaneReview } from './DiffPane';

export type ChangeSetFile = ChangedFile & { area?: UncommittedArea; stamp?: string };

export interface ChangeSetViewProps {
  /** Identifies the change set (worktree + base, or worktree + reload); a new key resets caches. */
  scopeKey: string;
  /** Where viewed marks of these files are kept; null while it is not known yet. */
  reviewScope: ReviewScope | null;
  /** The worktree directory, for "open in editor" links. */
  worktreePath: string;
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
  /** Fetchers must honour `diffOptions`; a new `scopeKey` should follow a change of them. */
  fetchFile: (file: ChangeSetFile) => Promise<string>;
  fetchPatch: () => Promise<string>;
  /** The download link; always the plain patch, whatever the display options, so it applies cleanly. */
  patchHref: string;
  diffOptions: DiffOptions;
  onDiffOptionsChange: (patch: Partial<DiffOptions>) => void;
}

const COMMITS_HELP =
  'Click a commit to see only what it changed (against its first parent).\n' +
  'Keys: ] moves down the list to the next older commit, [ moves up to the newer one and back to the whole branch.';

const FORMAT_KEY = 'wtdiff.format';
const HIDE_VIEWED_KEY = 'wtdiff.hideViewed';
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
  reviewScope,
  worktreePath,
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
  diffOptions,
  onDiffOptionsChange,
}: ChangeSetViewProps) {
  // Without a file in the URL, reopen the one that was open last in this scope.
  const [activePath, setActivePath] = useState<string | null>(() => initialFile ?? lastFile(reviewScope?.id ?? null));
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
  const [hideViewed, setHideViewed] = useState<boolean>(() => localStorage.getItem(HIDE_VIEWED_KEY) === 'true');
  const [editor, setEditor] = useEditor();
  const review = useViewed(reviewScope, files);
  const { viewed, setViewed, rememberLast } = review;
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
    renderRef.current
      ?.querySelector(`.d2h-file-wrapper[data-file="${CSS.escape(activeFile.path)}"]`)
      ?.scrollIntoView({ block: 'start' });
  }, [allFiles, activeFile, text]);

  const selectFile = useCallback(
    (file: ChangeSetFile) => {
      setActivePath(file.path);
      window.history.replaceState(null, '', hrefForFile(file.path));
      rememberLast(file.path);
    },
    [hrefForFile, rememberLast],
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

  const matchingFiles = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files;
  }, [files, filter]);

  // Hidden viewed files stay listed while they are the open one.
  const visibleFiles = useMemo(
    () => (hideViewed ? matchingFiles.filter((f) => !viewed.has(f.path) || f.path === activeFile?.path) : matchingFiles),
    [matchingFiles, hideViewed, viewed, activeFile],
  );

  /** Mark or unmark a file; with `advance`, marking moves on to the next unviewed file. */
  const toggleViewed = useCallback(
    (path: string, value: boolean, advance: boolean) => {
      setViewed([path], value);
      if (!value || !advance) return;
      const next = nextUnviewed(matchingFiles, new Set(viewed).add(path), path);
      const file = next === null ? null : matchingFiles.find((f) => f.path === next);
      if (!file) return;
      selectFile(file);
      document.querySelector(`.file-list [data-path="${CSS.escape(file.path)}"]`)?.scrollIntoView({ block: 'nearest' });
    },
    [setViewed, matchingFiles, viewed, selectFile],
  );

  const openUrl = useCallback(
    (path: string, line: number | null) => editorUrl(editor, joinPath(worktreePath, path), line),
    [editor, worktreePath],
  );

  // In the all-files view a viewed file folds in place; in the one-file view marking it moves on.
  const paneReview = useMemo<PaneReview | null>(
    () =>
      reviewScope ? { viewed, collapse: allFiles, onToggle: (path, value) => toggleViewed(path, value, !allFiles) } : null,
    [reviewScope, viewed, allFiles, toggleViewed],
  );

  const toggleHideViewed = (value: boolean) => {
    setHideViewed(value);
    localStorage.setItem(HIDE_VIEWED_KEY, String(value));
  };

  const changeEditor = (id: EditorId) => {
    if (id !== 'custom') return setEditor({ ...editor, editor: id });
    const template = window.prompt(
      'Editor URL, with {path} for the absolute file path and {line} for the line.\nExample: idea://open?file={path}&line={line}',
      editor.template || 'idea://open?file={path}&line={line}',
    );
    if (template && template.includes('{path}')) setEditor({ editor: 'custom', template });
  };

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

  // --- keyboard: j/k or arrows move between files, f toggles the drawer, w whitespace, [ ] between commits,
  // v marks the open file viewed (and moves on), o opens it in the editor
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.matches('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'f') {
        e.preventDefault();
        toggleDrawer();
        return;
      }
      if (e.key === 'w') {
        e.preventDefault();
        onDiffOptionsChange({ ignoreWhitespace: !diffOptions.ignoreWhitespace });
        return;
      }
      if (e.key === 'v') {
        if (!activeFile || !reviewScope) return;
        e.preventDefault();
        toggleViewed(activeFile.path, !viewed.has(activeFile.path), true);
        return;
      }
      if (e.key === 'o') {
        if (!activeFile || activeFile.status === 'D') return;
        const wrapper = renderRef.current?.querySelector<HTMLElement>(
          `.d2h-file-wrapper[data-file="${CSS.escape(activeFile.path)}"]`,
        );
        const url = openUrl(activeFile.path, Number(wrapper?.dataset.line) || null);
        if (!url) return;
        e.preventDefault();
        window.location.assign(url);
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
  }, [
    visibleFiles,
    activeFile,
    selectFile,
    toggleDrawer,
    onSelectCommit,
    stepCommit,
    diffOptions,
    onDiffOptionsChange,
    reviewScope,
    viewed,
    toggleViewed,
    openUrl,
  ]);

  const changeFormat = (f: DiffFormat) => {
    setFormat(f);
    localStorage.setItem(FORMAT_KEY, f);
  };

  const activeIndex = activeFile ? files.indexOf(activeFile) + 1 : 0;
  const worktreeUrl = editorUrl(editor, worktreePath);

  // With whitespace ignored, a file whose only changes are whitespace comes back without hunks.
  const whitespaceOnly =
    diffOptions.ignoreWhitespace &&
    !allFiles &&
    !loadingLabel &&
    text !== null &&
    activeFile !== null &&
    !activeFile.binary &&
    activeFile.additions + activeFile.deletions > 0 &&
    !/^@@ /m.test(text);

  const contextChoices = CONTEXT_CHOICES.includes(diffOptions.context)
    ? CONTEXT_CHOICES
    : [...CONTEXT_CHOICES, diffOptions.context];

  return (
    <section className="diff-view">
      <div className="diff-head">
        <div className="diff-title">
          <span className="diff-nav">{nav}</span>
          <h1>{title}</h1>
          {badge}
          <span className="path muted" title={subtitle}>{subtitle}</span>
          {worktreeUrl && (
            <a className="open-worktree" href={worktreeUrl} title={`Open this worktree in ${editorLabel(editor)}`}>
              Open in {editorLabel(editor)}
            </a>
          )}
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
              {reviewScope && (
                <label className="check" title="Leave viewed files out of the list (the open file stays)">
                  <input type="checkbox" checked={hideViewed} onChange={(e) => toggleHideViewed(e.target.checked)} /> Hide
                  viewed
                </label>
              )}
            </div>
            <ul className={`file-list${reviewScope ? ' has-viewed' : ''}`}>
              {visibleFiles.map((f) => {
                const [dir, name] = splitPath(f.path);
                const areaLabel = f.area ? AREA_LABEL[f.area] : null;
                const isViewed = viewed.has(f.path);
                return (
                  <li
                    key={f.path}
                    data-path={f.path}
                    className={[f.path === activeFile?.path && 'is-active', isViewed && 'is-viewed'].filter(Boolean).join(' ') || undefined}
                    title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                    onClick={() => selectFile(f)}
                  >
                    {reviewScope && (
                      <input
                        type="checkbox"
                        className="viewed-check"
                        checked={isViewed}
                        title={isViewed ? 'Viewed. Click to mark as not viewed.' : 'Mark as viewed (v)'}
                        aria-label={`Viewed: ${f.path}`}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => toggleViewed(f.path, e.target.checked, false)}
                      />
                    )}
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
              {files.length > 0 && visibleFiles.length === 0 && (
                <li className="empty">{matchingFiles.length > 0 ? 'Every file is viewed.' : 'No files match the filter.'}</li>
              )}
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
            {reviewScope && files.length > 0 && (
              <span
                className={`viewed-progress${viewed.size === files.length ? ' is-done' : ''}`}
                title="Files marked as viewed. A mark is dropped when the file changes. v marks the open file and moves on."
              >
                <span className="viewed-bar" aria-hidden="true">
                  <span style={{ width: `${(viewed.size / files.length) * 100}%` }} />
                </span>
                {viewed.size} / {files.length} viewed
              </span>
            )}
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
            <label className="check" title="Hide changes that only add, remove or alter whitespace (w)">
              <input
                type="checkbox"
                checked={diffOptions.ignoreWhitespace}
                onChange={(e) => onDiffOptionsChange({ ignoreWhitespace: e.target.checked })}
              />{' '}
              Ignore whitespace
            </label>
            <label className="check" title="Unchanged lines shown around each change">
              Context
              <select
                className="toolbar-select"
                value={String(diffOptions.context)}
                onChange={(e) => onDiffOptionsChange({ context: parseContext(e.target.value) ?? 3 })}
              >
                {contextChoices.map((c) => (
                  <option key={c} value={String(c)}>
                    {contextLabel(c)}
                  </option>
                ))}
              </select>
            </label>
            <span className="spacer" />
            <label className="check" title="The editor that file links and the o key open">
              Editor
              <select className="toolbar-select" value={editor.editor} onChange={(e) => changeEditor(e.target.value as EditorId)}>
                {EDITORS.map((ed) => (
                  <option key={ed.id} value={ed.id}>
                    {ed.label}
                  </option>
                ))}
              </select>
            </label>
            <a className="btn btn-quiet" href={patchHref} download>
              Download .patch
            </a>
          </div>
          <div ref={renderRef} className="render-host">
            <DiffPane
              text={text}
              format={format}
              review={paneReview}
              openUrl={editor.editor === 'none' ? null : openUrl}
              singlePath={allFiles ? null : (activeFile?.path ?? null)}
              loading={loading ?? loadingLabel}
              error={error ?? paneError}
              notice={
                whitespaceOnly ? (
                  <>
                    This file only changes whitespace.
                    <br />
                    <button type="button" className="btn" onClick={() => onDiffOptionsChange({ ignoreWhitespace: false })}>
                      Show whitespace changes
                    </button>
                  </>
                ) : null
              }
            />
          </div>
        </div>
      </div>
    </section>
  );
}
