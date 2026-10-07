import type { ReactNode } from 'react';

import type { MergeStatus, UncommittedPayload, WorktreeRow } from '@/lib/repo-service';

export function Tag({ kind, title, children }: { kind: 'ok' | 'main' | 'warn' | 'current' | 'detached' | 'locked'; title?: string; children: ReactNode }) {
  return (
    <span className={`tag tag-${kind}`} title={title}>
      {children}
    </span>
  );
}

export function WorktreeTags({ wt }: { wt: WorktreeRow }) {
  return (
    <>
      {wt.isCurrent && <Tag kind="current" title="Where wtdiff was started">current</Tag>}
      {wt.isMain && <Tag kind="main">main worktree</Tag>}
      {wt.detached && <Tag kind="detached">detached</Tag>}
      {wt.locked && <Tag kind="locked">locked</Tag>}
      {wt.prunable && <Tag kind="warn">missing</Tag>}
    </>
  );
}

/** Tags describing whether the worktree's work is in the base. */
export function MergeTags({ merge }: { merge: MergeStatus | null | undefined }) {
  if (!merge) return <span className="muted">–</span>;
  switch (merge.state) {
    case 'same':
      return <Tag kind="main" title="The worktree is checked out at the base commit">same as base</Tag>;
    case 'merged':
      return (
        <>
          <Tag
            kind="ok"
            title={
              merge.via === 'squash'
                ? 'The branch’s changes are already in the base (squash or rebase merge)'
                : 'Every commit of this branch is reachable from the base'
            }
          >
            merged
          </Tag>
          {merge.via === 'squash' && <span className="muted small"> squash</span>}
        </>
      );
    case 'unmerged':
      return (
        <>
          <Tag kind="main" title={merge.conflicts?.length === 0 ? 'Merges cleanly into the base' : undefined}>
            unmerged
          </Tag>
          {merge.conflicts && merge.conflicts.length > 0 && (
            <>
              {' '}
              <Tag kind="warn" title={`Would conflict in:\n${merge.conflicts.join('\n')}`}>
                conflicts ({merge.conflicts.length})
              </Tag>
            </>
          )}
        </>
      );
    default:
      return <span className="muted">–</span>;
  }
}

export function UncommittedTag({ u }: { u: UncommittedPayload | null | undefined }) {
  if (!u) return <span className="muted">–</span>;
  const total = u.changed + u.untracked;
  if (total === 0) return <Tag kind="ok">clean</Tag>;
  const parts: string[] = [];
  if (u.changed) parts.push(`${u.changed} changed`);
  if (u.untracked) parts.push(`${u.untracked} untracked`);
  return <Tag kind="warn" title="Not part of the diff">{parts.join(', ')}</Tag>;
}

export function Skeleton() {
  return <span className="skeleton" />;
}
