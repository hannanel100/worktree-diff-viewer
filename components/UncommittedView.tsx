'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import type { UncommittedFilePayload, UncommittedFilesPayload } from '@/lib/repo-service';
import { api, hrefDiff, hrefOverview, hrefUncommitted, hrefUncommittedPatch } from '@/lib/client/api';
import { fmtNum, worktreeLabel } from '@/lib/client/format';
import { ChangeSetView, type ChangeSetFile } from './ChangeSetView';
import { useRepo } from './RepoProvider';
import { Tag } from './Tags';

/**
 * A worktree's uncommitted changes: index and working tree against HEAD,
 * plus untracked files. Kept apart from the committed diff on purpose.
 */
export function UncommittedView() {
  const { repo, version } = useRepo();
  const searchParams = useSearchParams();
  const worktree = searchParams.get('worktree') ?? '';
  const base = searchParams.get('base') || repo?.defaultBase || '';
  const fileParam = searchParams.get('file');

  const [data, setData] = useState<UncommittedFilesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!repo || !worktree) return;
    let stale = false;
    setError(null);
    api<UncommittedFilesPayload>('/api/uncommitted-files', { worktree })
      .then((d) => {
        if (stale) return;
        setData(d);
        document.title = `${worktreeLabel(d.worktree)} · uncommitted`;
      })
      .catch((err) => !stale && setError((err as Error).message))
      .finally(() => !stale && setRefreshing(false));
    return () => {
      stale = true;
    };
  }, [repo, worktree, version, reloads]);

  const refresh = () => {
    setRefreshing(true);
    setReloads((n) => n + 1);
  };

  const fetchFile = useCallback(
    async (file: ChangeSetFile) => {
      const res = await api<UncommittedFilePayload>('/api/uncommitted-file', {
        worktree,
        path: file.path,
        oldPath: file.oldPath,
      });
      return res.diff;
    },
    [worktree],
  );

  const fetchPatch = useCallback(async () => {
    const res = await fetch(hrefUncommittedPatch(worktree));
    if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error || res.statusText);
    return res.text();
  }, [worktree]);

  const hrefForFile = useCallback((path: string) => hrefUncommitted(worktree, base, path), [worktree, base]);

  if (!worktree) return <div className="error">No worktree selected. Go back to the overview.</div>;
  if (error) return <div className="error">{error}</div>;
  if (!repo || !data) return <div className="loading">Loading uncommitted changes…</div>;

  const wt = data.worktree;
  const total = data.counts.changed + data.counts.untracked;

  const meta = (
    <>
      <span title="Index and working tree compared with the current commit of this worktree">
        working tree vs <code>HEAD</code> <span className="muted mono">{data.head.slice(0, 10)}</span>
      </span>
      {total === 0 ? (
        <Tag kind="ok">working tree clean</Tag>
      ) : (
        <span>
          <b>{fmtNum(data.counts.changed)}</b> changed, <b>{fmtNum(data.counts.untracked)}</b> untracked,{' '}
          <span className="plus">+{fmtNum(data.totals.additions)}</span>{' '}
          <span className="minus">−{fmtNum(data.totals.deletions)}</span>
        </span>
      )}
      <span className="muted" title="These edits are not part of any commit, so the committed diff against the base does not include them.">
        not in the committed diff
      </span>
      <button type="button" className="btn btn-quiet" onClick={refresh} disabled={refreshing} title="Re-read the working tree">
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </button>
    </>
  );

  return (
    <ChangeSetView
      scopeKey={`uncommitted\0${worktree}\0${version}\0${reloads}`}
      nav={
        <>
          <Link href={hrefOverview(base)} className="back">← Overview</Link>
          <Link href={hrefDiff(wt.path, base)} className="back" title="The committed diff of this worktree against the base">
            Committed diff
          </Link>
        </>
      }
      title={worktreeLabel(wt)}
      badge={<Tag kind="warn">uncommitted changes</Tag>}
      subtitle={wt.path}
      meta={meta}
      files={data.files}
      emptyMessage="Nothing uncommitted in this worktree."
      initialFile={fileParam}
      hrefForFile={hrefForFile}
      fetchFile={fetchFile}
      fetchPatch={fetchPatch}
      patchHref={hrefUncommittedPatch(worktree)}
    />
  );
}
