'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import type { DiffPayload, FilePayload, UncommittedPayload } from '@/lib/repo-service';
import { api, hrefDiff, hrefOverview, hrefPatch, hrefUncommitted } from '@/lib/client/api';
import { fmtNum, worktreeLabel } from '@/lib/client/format';
import { ChangeSetView, type ChangeSetFile } from './ChangeSetView';
import { useRepo } from './RepoProvider';
import { MergeTags, Tag } from './Tags';

/** The committed diff of one worktree's branch against the base. */
export function DiffView() {
  const { repo, version } = useRepo();
  const searchParams = useSearchParams();
  const worktree = searchParams.get('worktree') ?? '';
  const base = searchParams.get('base') || repo?.defaultBase || '';
  const fileParam = searchParams.get('file');

  const [data, setData] = useState<DiffPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uncommitted, setUncommitted] = useState<UncommittedPayload | null | 'error'>(null);

  useEffect(() => {
    if (!repo || !worktree || !base) return;
    let stale = false;
    setData(null);
    setError(null);
    setUncommitted(null);
    api<DiffPayload>('/api/diff', { worktree, base })
      .then((d) => {
        if (stale) return;
        setData(d);
        document.title = `${worktreeLabel(d.worktree)} vs ${base}`;
      })
      .catch((err) => !stale && setError((err as Error).message));
    api<UncommittedPayload>('/api/uncommitted', { worktree })
      .then((u) => !stale && setUncommitted(u))
      .catch(() => !stale && setUncommitted('error'));
    return () => {
      stale = true;
    };
  }, [repo, worktree, base, version]);

  const fetchFile = useCallback(
    async (file: ChangeSetFile) => {
      const res = await api<FilePayload>('/api/file', { worktree, base, path: file.path, oldPath: file.oldPath });
      return res.diff;
    },
    [worktree, base],
  );

  const fetchPatch = useCallback(async () => {
    const res = await fetch(hrefPatch(worktree, base));
    if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error || res.statusText);
    return res.text();
  }, [worktree, base]);

  const hrefForFile = useCallback((path: string) => hrefDiff(worktree, base, path), [worktree, base]);

  if (!worktree) return <div className="error">No worktree selected. Go back to the overview.</div>;
  if (error) return <div className="error">{error}</div>;
  if (!repo || !data) return <div className="loading">Loading diff…</div>;

  const wt = data.worktree;
  const dirty = uncommitted !== null && uncommitted !== 'error' ? uncommitted.changed + uncommitted.untracked : 0;

  const meta = (
    <>
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
        dirty === 0 ? (
          <Tag kind="ok" title="Nothing uncommitted in this worktree">working tree clean</Tag>
        ) : (
          <Link
            className="tag-link"
            href={hrefUncommitted(wt.path, base)}
            title="Uncommitted changes are not part of this diff. Open them on their own screen."
          >
            <Tag kind="warn">
              {dirty} uncommitted {dirty === 1 ? 'change' : 'changes'} · view
            </Tag>
          </Link>
        )
      )}
    </>
  );

  return (
    <ChangeSetView
      scopeKey={`diff\0${worktree}\0${base}\0${version}`}
      nav={<Link href={hrefOverview(base)} className="back">← Overview</Link>}
      title={worktreeLabel(wt)}
      subtitle={wt.path}
      meta={meta}
      commits={data.commits}
      files={data.files}
      emptyMessage={data.noCommonHistory ? 'Nothing to compare.' : 'No committed changes relative to the base.'}
      initialFile={fileParam}
      hrefForFile={hrefForFile}
      fetchFile={fetchFile}
      fetchPatch={fetchPatch}
      patchHref={hrefPatch(worktree, base)}
    />
  );
}
