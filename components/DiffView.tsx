'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ChangedFile } from '@/lib/git';
import type { DiffPayload, FilePayload, UncommittedPayload } from '@/lib/repo-service';
import { api, hrefDiff, hrefOverview, hrefPatch, pool } from '@/lib/client/api';
import { fmtNum, relTime, splitPath, statusName, worktreeLabel } from '@/lib/client/format';
import { DiffPane, type DiffFormat } from './DiffPane';
import { useRepo } from './RepoProvider';
import { MergeTags, Tag } from './Tags';

const FORMAT_KEY = 'wtdiff.format';
const DRAWER_KEY = 'wtdiff.drawer';

export function DiffView() {
  const { repo, version } = useRepo();
  const searchParams = useSearchParams();
  const worktree = searchParams.get('worktree') ?? '';
  const base = searchParams.get('base') || repo?.defaultBase || '';
  const fileParam = searchParams.get('file');

  const [data, setData] = useState<DiffPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uncommitted, setUncommitted] = useState<UncommittedPayload | null | 'error'>(null);
  const [activePath, setActivePath] = useState<string | null>(fileParam);
  const [format, setFormat] = useState<DiffFormat>(
    () => (localStorage.getItem(FORMAT_KEY) as DiffFormat | null) ?? 'side-by-side',
  );
  const [allFiles, setAllFiles] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState<boolean>(() => localStorage.getItem(DRAWER_KEY) !== 'closed');
  const [filter, setFilter] = useState('');
  const [text, setText] = useState<string | null>(null);
  const [loadingLabel, setLoadingLabel] = useState<string | null>(null);
  const [paneError, setPaneError] = useState<string | null>(null);

  const cache = useRef(new Map<string, string>());
  const token = useRef(0);
  const renderRef = useRef<HTMLDivElement>(null);

  // --- load the diff summary ---------------------------------------------
  useEffect(() => {
    if (!repo || !worktree || !base) return;
    const myToken = ++token.current;
    setData(null);
    setError(null);
    setUncommitted(null);
    setText(null);
    setPaneError(null);
    cache.current.clear();
    api<DiffPayload>('/api/diff', { worktree, base })
      .then((d) => {
        if (myToken !== token.current) return;
        setData(d);
        document.title = `${worktreeLabel(d.worktree)} vs ${base}`;
      })
      .catch((err) => myToken === token.current && setError((err as Error).message));
    api<UncommittedPayload>('/api/uncommitted', { worktree })
      .then((u) => myToken === token.current && setUncommitted(u))
      .catch(() => myToken === token.current && setUncommitted('error'));
  }, [repo, worktree, base, version]);

  const files = data?.files ?? [];
  const activeFile = useMemo(() => files.find((f) => f.path === activePath) ?? files[0] ?? null, [files, activePath]);

  const fetchFile = useCallback(
    async (file: ChangedFile) => {
      const key = file.path;
      const hit = cache.current.get(key);
      if (hit !== undefined) return hit;
      const res = await api<FilePayload>('/api/file', { worktree, base, path: file.path, oldPath: file.oldPath });
      cache.current.set(key, res.diff);
      return res.diff;
    },
    [worktree, base],
  );

  // --- load whatever should be in the pane --------------------------------
  useEffect(() => {
    if (!data) return;
    const myToken = token.current;
    setPaneError(null);
    if (allFiles) {
      setLoadingLabel('Loading full patch…');
      fetch(hrefPatch(worktree, base))
        .then(async (res) => {
          if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error || res.statusText);
          return res.text();
        })
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
      fetchFile(activeFile)
        .then((t) => {
          if (myToken !== token.current || activeFile.path !== (activePath ?? files[0]?.path)) return;
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
    pool(files.slice(idx + 1, idx + 4), 1, (f) => (myToken === token.current ? fetchFile(f) : Promise.resolve()));
  }, [data, activeFile, allFiles, fetchFile, worktree, base]); // eslint-disable-line react-hooks/exhaustive-deps

  // In all-files mode, selecting a file scrolls to it instead of reloading.
  useEffect(() => {
    if (!allFiles || !activeFile || text === null) return;
    const headers = renderRef.current?.querySelectorAll('.d2h-file-name') ?? [];
    const header = [...headers].find((el) => el.textContent?.trim().endsWith(activeFile.path));
    header?.closest('.d2h-file-wrapper')?.scrollIntoView({ block: 'start' });
  }, [allFiles, activeFile, text]);

  const selectFile = useCallback(
    (file: ChangedFile) => {
      setActivePath(file.path);
      window.history.replaceState(null, '', hrefDiff(worktree, base, file.path));
    },
    [worktree, base],
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

  // --- keyboard navigation (j/k or arrows, f toggles the file drawer) -------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.matches('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'f') {
        e.preventDefault();
        toggleDrawer();
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
  }, [visibleFiles, activeFile, selectFile, toggleDrawer]);

  const changeFormat = (f: DiffFormat) => {
    setFormat(f);
    localStorage.setItem(FORMAT_KEY, f);
  };

  if (!worktree) return <div className="error">No worktree selected. Go back to the overview.</div>;
  if (error) return <div className="error">{error}</div>;
  if (!repo || !data) return <div className="loading">Loading diff…</div>;

  const wt = data.worktree;
  const activeIndex = activeFile ? files.indexOf(activeFile) + 1 : 0;

  return (
    <section className="diff-view">
      <div className="diff-head">
        <div className="diff-title">
          <Link href={hrefOverview(base)} className="back">← Overview</Link>
          <h1>{worktreeLabel(wt)}</h1>
          <span className="path muted" title={wt.path}>{wt.path}</span>
        </div>
        <div className="diff-meta">
          <span>
            base <code>{base}</code> <span className="muted mono">{data.baseSha.slice(0, 10)}</span>
          </span>
          {data.noCommonHistory ? (
            <Tag kind="warn">no common history with base</Tag>
          ) : (
            <>
              <span title="Merge base: where the branch forked from the base">
                forked at <code>{data.mergeBase?.slice(0, 10)}</code>
              </span>
              <span>
                <b>{fmtNum(data.ahead)}</b> commits ahead, <b>{fmtNum(data.behind)}</b> behind
              </span>
              <span>
                <b>{fmtNum(data.totals?.files)}</b> files, <span className="plus">+{fmtNum(data.totals?.additions)}</span>{' '}
                <span className="minus">−{fmtNum(data.totals?.deletions)}</span>
              </span>
              <span><MergeTags merge={data.merge} /></span>
            </>
          )}
          {uncommitted === null && <span className="muted">checking working tree…</span>}
          {uncommitted !== null && uncommitted !== 'error' && (
            uncommitted.changed + uncommitted.untracked === 0 ? (
              <Tag kind="ok" title="Nothing uncommitted in this worktree">working tree clean</Tag>
            ) : (
              <Tag kind="warn" title="Uncommitted changes are not part of this diff">
                {uncommitted.changed + uncommitted.untracked} uncommitted{' '}
                {uncommitted.changed + uncommitted.untracked === 1 ? 'change' : 'changes'} not shown
              </Tag>
            )
          )}
        </div>
      </div>

      <div className={`diff-body${drawerOpen ? '' : ' is-drawer-closed'}`}>
        <aside className="sidebar" id="diff-drawer" aria-hidden={!drawerOpen}>
          <details className="commits" open={data.commits.length > 0 && data.commits.length <= 8}>
            <summary>
              Commits <span className="count">({data.commits.length})</span>
            </summary>
            <ol>
              {data.commits.map((c) => (
                <li key={c.sha} title={`${c.sha}\n${c.author} <${c.email}>\n${c.date}`}>
                  <span className="sha">{c.shortSha}</span>
                  <span className="subject">{c.subject}</span>
                  <span className="who">{c.author} · {relTime(c.date)}</span>
                </li>
              ))}
              {data.commits.length === 0 && <li className="muted">No commits beyond the base.</li>}
            </ol>
          </details>
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
            {files.length === 0 && (
              <li className="empty">
                {data.noCommonHistory ? 'Nothing to compare.' : 'No committed changes relative to the base.'}
              </li>
            )}
            {files.length > 0 && visibleFiles.length === 0 && <li className="empty">No files match the filter.</li>}
          </ul>
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
            <a className="btn btn-quiet" href={hrefPatch(worktree, base)} download>
              Download .patch
            </a>
          </div>
          <div ref={renderRef} className="render-host">
            <DiffPane text={text} format={format} loading={loadingLabel} error={paneError} />
          </div>
        </div>
      </div>
    </section>
  );
}
