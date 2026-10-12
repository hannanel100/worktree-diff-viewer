'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import type { CommitFilePayload, CommitPayload, DiffPayload, FilePayload, UncommittedPayload } from '@/lib/repo-service';
import { api, hrefCommitPatch, hrefDiff, hrefOverview, hrefPatch, hrefUncommitted } from '@/lib/client/api';
import { fmtNum, relTime, worktreeLabel } from '@/lib/client/format';
import { ChangeSetView, type ChangeSetFile } from './ChangeSetView';
import { useRepo } from './RepoProvider';
import { MergeTags, Tag } from './Tags';

/**
 * The committed diff of one worktree's branch against the base, or - with
 * `commit` in the URL - a single commit of it against its first parent.
 */
export function DiffView() {
  const { repo, version } = useRepo();
  const searchParams = useSearchParams();
  const worktree = searchParams.get('worktree') ?? '';
  const base = searchParams.get('base') || repo?.defaultBase || '';
  const fileParam = searchParams.get('file');
  const commitParam = searchParams.get('commit');

  const [data, setData] = useState<DiffPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uncommitted, setUncommitted] = useState<UncommittedPayload | null | 'error'>(null);

  // The picked commit lives in state and is mirrored to the URL with
  // replaceState (like the file); a navigation that changes the URL wins.
  const [commitSha, setCommitSha] = useState<string | null>(commitParam || null);
  useEffect(() => setCommitSha(commitParam || null), [commitParam]);
  const [commitData, setCommitData] = useState<CommitPayload | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);

  useEffect(() => {
    if (!repo || !worktree || !base) return;
    let stale = false;
    setData(null);
    setError(null);
    setUncommitted(null);
    api<DiffPayload>('/api/diff', { worktree, base })
      .then((d) => !stale && setData(d))
      .catch((err) => !stale && setError((err as Error).message));
    api<UncommittedPayload>('/api/uncommitted', { worktree })
      .then((u) => !stale && setUncommitted(u))
      .catch(() => !stale && setUncommitted('error'));
    return () => {
      stale = true;
    };
  }, [repo, worktree, base, version]);

  useEffect(() => {
    setCommitData(null);
    setCommitError(null);
    if (!repo || !worktree || !commitSha) return;
    let stale = false;
    api<CommitPayload>('/api/commit', { worktree, commit: commitSha })
      .then((c) => !stale && setCommitData(c))
      .catch((err) => !stale && setCommitError((err as Error).message));
    return () => {
      stale = true;
    };
  }, [repo, worktree, commitSha, version]);

  useEffect(() => {
    if (!data || (commitSha && !commitData && !commitError)) return; // keep the old title while a commit loads
    const label = worktreeLabel(data.worktree);
    document.title =
      commitSha && commitData ? `${commitData.commit.shortSha} ${commitData.commit.subject} · ${label}` : `${label} vs ${base}`;
  }, [data, commitSha, commitData, base]);

  const selectCommit = useCallback(
    (sha: string | null) => {
      setCommitSha(sha);
      window.history.replaceState(null, '', hrefDiff(worktree, base, null, sha));
    },
    [worktree, base],
  );

  const fetchFile = useCallback(
    async (file: ChangeSetFile) => {
      if (commitSha) {
        const res = await api<CommitFilePayload>('/api/commit-file', {
          worktree,
          commit: commitSha,
          path: file.path,
          oldPath: file.oldPath,
        });
        return res.diff;
      }
      const res = await api<FilePayload>('/api/file', { worktree, base, path: file.path, oldPath: file.oldPath });
      return res.diff;
    },
    [worktree, base, commitSha],
  );

  const patchHref = commitSha ? hrefCommitPatch(worktree, commitSha) : hrefPatch(worktree, base);

  const fetchPatch = useCallback(async () => {
    const res = await fetch(patchHref);
    if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error || res.statusText);
    return res.text();
  }, [patchHref]);

  const hrefForFile = useCallback((path: string) => hrefDiff(worktree, base, path, commitSha), [worktree, base, commitSha]);

  if (!worktree) return <div className="error">No worktree selected. Go back to the overview.</div>;
  if (error) return <div className="error">{error}</div>;
  if (!repo || !data) return <div className="loading">Loading diff…</div>;

  const wt = data.worktree;
  const dirty = uncommitted !== null && uncommitted !== 'error' ? uncommitted.changed + uncommitted.untracked : 0;
  const commit = commitSha ? commitData : null;

  const branchMeta = (
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
          {!commitSha && (
            <span>
              <b>{fmtNum(data.totals?.files)}</b> files, <span className="plus">+{fmtNum(data.totals?.additions)}</span>{' '}
              <span className="minus">−{fmtNum(data.totals?.deletions)}</span>
            </span>
          )}
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

  // In commit mode the commit's own facts come first; the branch facts follow after a divider.
  const commitMeta = commitSha && (
    <>
      {commit ? (
        <>
          <span className="meta-commit" title={`${commit.commit.sha}\n${commit.commit.author} <${commit.commit.email}>\n${commit.commit.date}`}>
            <code>{commit.commit.shortSha}</code> <b className="subject">{commit.commit.subject}</b>
          </span>
          <span>
            {commit.commit.author} · {relTime(commit.commit.date)}
          </span>
          {commit.parents.length === 0 ? (
            <Tag kind="main" title="The first commit of the repository: every file is new">root commit</Tag>
          ) : (
            <span title={commit.parents.length > 1 ? `Merge commit with ${commit.parents.length} parents; shown against the first one` : 'The commit is shown against its parent'}>
              {commit.parents.length > 1 ? 'merge, first parent' : 'parent'} <code>{commit.parents[0].slice(0, 10)}</code>
            </span>
          )}
          <span>
            <b>{fmtNum(commit.totals.files)}</b> files, <span className="plus">+{fmtNum(commit.totals.additions)}</span>{' '}
            <span className="minus">−{fmtNum(commit.totals.deletions)}</span>
          </span>
        </>
      ) : commitError ? (
        <span className="meta-commit">
          <code>{commitSha.slice(0, 10)}</code> <Tag kind="warn">{commitError}</Tag>
        </span>
      ) : (
        <span className="meta-commit">
          <code>{commitSha.slice(0, 10)}</code> <span className="muted">loading…</span>
        </span>
      )}
      <span className="meta-sep" aria-hidden="true" />
      <span className="muted" title="The branch this commit belongs to">branch</span>
    </>
  );

  const files = commitSha ? (commit?.files ?? []) : data.files;

  return (
    <ChangeSetView
      scopeKey={`diff\0${worktree}\0${base}\0${version}\0${commitSha ?? ''}`}
      nav={
        <>
          <Link href={hrefOverview(base)} className="back">← Overview</Link>
          {commitSha && (
            <a
              href={hrefDiff(worktree, base)}
              className="back"
              title="Back to the diff of every commit of the branch against the base"
              onClick={(e) => {
                e.preventDefault();
                selectCommit(null);
              }}
            >
              Whole branch
            </a>
          )}
        </>
      }
      title={worktreeLabel(wt)}
      badge={commitSha ? <Tag kind="current" title="Showing one commit against its first parent">single commit</Tag> : undefined}
      subtitle={wt.path}
      meta={
        <>
          {commitMeta}
          {branchMeta}
        </>
      }
      commits={data.commits}
      activeCommit={commitSha && (commit?.commit.sha ?? commitSha)}
      onSelectCommit={selectCommit}
      files={files}
      emptyMessage={
        commitSha
          ? commitError
            ? 'The commit could not be loaded.'
            : 'This commit changed no files.'
          : data.noCommonHistory
            ? 'Nothing to compare.'
            : 'No committed changes relative to the base.'
      }
      loading={commitSha && !commit && !commitError ? 'Loading commit…' : null}
      error={commitSha ? commitError : null}
      initialFile={fileParam}
      hrefForFile={hrefForFile}
      fetchFile={fetchFile}
      fetchPatch={fetchPatch}
      patchHref={patchHref}
    />
  );
}
