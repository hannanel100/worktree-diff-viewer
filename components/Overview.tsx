'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import type { SummaryPayload, UncommittedPayload } from '@/lib/repo-service';
import { api, pool } from '@/lib/client/api';
import { useRepo } from './RepoProvider';
import { OverviewTable, type OverviewRow } from './OverviewTable';

type SummaryMap = Record<string, { data: SummaryPayload | null; error: string | null }>;
type UncommittedMap = Record<string, { data: UncommittedPayload | null; error: string | null }>;

export function Overview() {
  const { repo, error, version } = useRepo();
  const searchParams = useSearchParams();
  const base = searchParams.get('base') || repo?.defaultBase || '';

  const [summaries, setSummaries] = useState<SummaryMap>({});
  const [uncommitted, setUncommitted] = useState<UncommittedMap>({});
  const token = useRef(0);

  useEffect(() => {
    if (!repo) return;
    const myToken = ++token.current;
    setSummaries({});
    setUncommitted({});
    const live = repo.worktrees.filter((w) => !w.bare && !w.prunable);

    // Uncommitted counts need a working-tree scan, which is the slowest git
    // call, so they load in their own lane and never hold up the diff numbers.
    pool(live, 2, async (wt) => {
      try {
        const data = await api<UncommittedPayload>('/api/uncommitted', { worktree: wt.path });
        if (myToken === token.current) setUncommitted((m) => ({ ...m, [wt.path]: { data, error: null } }));
      } catch (err) {
        if (myToken === token.current) {
          setUncommitted((m) => ({ ...m, [wt.path]: { data: null, error: (err as Error).message } }));
        }
      }
    });

    if (!base) return;
    pool(live, 4, async (wt) => {
      try {
        const data = await api<SummaryPayload>('/api/summary', { worktree: wt.path, base });
        if (myToken === token.current) setSummaries((m) => ({ ...m, [wt.path]: { data, error: null } }));
      } catch (err) {
        if (myToken === token.current) {
          setSummaries((m) => ({ ...m, [wt.path]: { data: null, error: (err as Error).message } }));
        }
      }
    });
  }, [repo, base, version]);

  useEffect(() => {
    document.title = `Worktrees · ${base}`;
  }, [base]);

  if (error) return <div className="error">{error}</div>;
  if (!repo) return <div className="loading">Loading repository…</div>;

  const rows: OverviewRow[] = repo.worktrees.map((wt) => ({
    wt,
    summary: summaries[wt.path]?.data ?? null,
    summaryError: summaries[wt.path]?.error ?? null,
    uncommitted: uncommitted[wt.path]?.data ?? null,
    uncommittedError: uncommitted[wt.path]?.error ?? null,
  }));

  return (
    <section className="overview">
      <div className="overview-head">
        <h1>Worktrees</h1>
        <p className="muted">
          {base ? `Each worktree's committed changes since it forked from ${base}.` : 'No base branch chosen.'}
        </p>
      </div>
      <OverviewTable rows={rows} base={base} repoRoot={repo.repoRoot} />
    </section>
  );
}
