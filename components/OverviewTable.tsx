'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type DragEvent } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnOrderState,
  type SortingState,
  type VisibilityState,
} from '@tanstack/react-table';

import type { MergeStatus, SummaryPayload, UncommittedPayload, WorktreeRow } from '@/lib/repo-service';
import { hrefDiff } from '@/lib/client/api';
import { displayPath, fmtNum, worktreeLabel } from '@/lib/client/format';
import { loadJson, saveJson } from '@/lib/client/storage';
import { MergeTags, Skeleton, UncommittedTag, WorktreeTags } from './Tags';

export interface OverviewRow {
  wt: WorktreeRow;
  summary: SummaryPayload | null;
  summaryError: string | null;
  uncommitted: UncommittedPayload | null;
  uncommittedError: string | null;
}

type MergeFilter = 'all' | 'merged' | 'unmerged' | 'conflicts' | 'same';
type UncommittedFilter = 'all' | 'clean' | 'dirty';

interface Persisted {
  sorting: SortingState;
  columnOrder: ColumnOrderState;
  columnVisibility: VisibilityState;
  globalFilter: string;
  mergeFilter: MergeFilter;
  uncommittedFilter: UncommittedFilter;
}

const STORAGE_KEY = 'wtdiff.overview.table.v1';
const DEFAULT_ORDER = ['branch', 'path', 'ahead', 'behind', 'merge', 'files', 'lines', 'uncommitted'];
const DEFAULTS: Persisted = {
  sorting: [],
  columnOrder: DEFAULT_ORDER,
  columnVisibility: {},
  globalFilter: '',
  mergeFilter: 'all',
  uncommittedFilter: 'all',
};

/** Sort key: same < merged < squash-merged < clean < conflicts < unknown. */
function mergeRank(m: MergeStatus | null | undefined): number | undefined {
  if (!m) return undefined;
  if (m.state === 'same') return 0;
  if (m.state === 'merged') return m.via === 'squash' ? 2 : 1;
  if (m.state === 'unmerged') return m.conflicts?.length ? 4 : 3;
  return 5;
}

function matchesMerge(row: OverviewRow, f: MergeFilter): boolean {
  if (f === 'all') return true;
  const m = row.summary?.merge;
  if (!m) return false;
  if (f === 'same') return m.state === 'same';
  if (f === 'merged') return m.state === 'merged';
  if (f === 'unmerged') return m.state === 'unmerged';
  return m.state === 'unmerged' && (m.conflicts?.length ?? 0) > 0;
}

function matchesUncommitted(row: OverviewRow, f: UncommittedFilter): boolean {
  if (f === 'all') return true;
  const u = row.uncommitted;
  if (!u) return false;
  const dirty = u.changed + u.untracked > 0;
  return f === 'dirty' ? dirty : !dirty;
}

export function OverviewTable({ rows, base, repoRoot }: { rows: OverviewRow[]; base: string; repoRoot: string }) {
  const router = useRouter();
  const [persisted, setPersisted] = useState<Persisted>(() => loadJson(STORAGE_KEY, DEFAULTS));
  const { sorting, columnOrder, columnVisibility, globalFilter, mergeFilter, uncommittedFilter } = persisted;
  const patch = (p: Partial<Persisted>) => setPersisted((s) => ({ ...s, ...p }));

  useEffect(() => saveJson(STORAGE_KEY, persisted), [persisted]);

  const [dragging, setDragging] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = globalFilter.trim().toLowerCase();
    return rows.filter((r) => {
      if (q && !worktreeLabel(r.wt).toLowerCase().includes(q) && !displayPath(r.wt, repoRoot).toLowerCase().includes(q)) {
        return false;
      }
      return matchesMerge(r, mergeFilter) && matchesUncommitted(r, uncommittedFilter);
    });
  }, [rows, globalFilter, mergeFilter, uncommittedFilter, repoRoot]);

  const columns = useMemo<ColumnDef<OverviewRow>[]>(
    () => [
      {
        id: 'branch',
        header: 'Branch',
        accessorFn: (r) => worktreeLabel(r.wt),
        sortingFn: 'alphanumeric',
        cell: ({ row }) => (
          <div className="branch">
            {worktreeLabel(row.original.wt)} <WorktreeTags wt={row.original.wt} />
          </div>
        ),
      },
      {
        id: 'path',
        header: 'Path',
        accessorFn: (r) => displayPath(r.wt, repoRoot),
        sortingFn: 'alphanumeric',
        cell: ({ row, getValue }) => (
          <span className="path" title={row.original.wt.path}>
            {getValue<string>()}
          </span>
        ),
      },
      {
        id: 'ahead',
        header: 'Ahead',
        accessorFn: (r) => r.summary?.ahead ?? undefined,
        sortUndefined: 'last',
        meta: { num: true, title: 'Commits the worktree has that the base lacks' },
        cell: ({ row, getValue }) => numberCell(row.original, getValue<number | undefined>(), 'ahead'),
      },
      {
        id: 'behind',
        header: 'Behind',
        accessorFn: (r) => r.summary?.behind ?? undefined,
        sortUndefined: 'last',
        meta: { num: true, title: 'Commits the base gained since the fork' },
        cell: ({ row, getValue }) => numberCell(row.original, getValue<number | undefined>(), 'behind'),
      },
      {
        id: 'merge',
        header: 'Merge',
        accessorFn: (r) => mergeRank(r.summary?.merge),
        sortUndefined: 'last',
        meta: { title: 'Is this branch’s work in the base yet? Detects merge commits as well as squash/rebase merges, and lists files that would conflict.' },
        cell: ({ row }) => {
          const r = row.original;
          if (r.summaryError) return <span className="tag tag-warn" title={r.summaryError}>error</span>;
          if (!r.summary) return <Skeleton />;
          if (r.summary.noCommonHistory) return <span className="tag tag-warn">no common history</span>;
          return <MergeTags merge={r.summary.merge} />;
        },
      },
      {
        id: 'files',
        header: 'Files',
        accessorFn: (r) => r.summary?.totals?.files ?? undefined,
        sortUndefined: 'last',
        meta: { num: true },
        cell: ({ row, getValue }) => numberCell(row.original, getValue<number | undefined>()),
      },
      {
        id: 'lines',
        header: 'Lines',
        accessorFn: (r) => (r.summary?.totals ? r.summary.totals.additions + r.summary.totals.deletions : undefined),
        sortUndefined: 'last',
        meta: { num: true, title: 'Lines added and removed since the fork' },
        cell: ({ row }) => {
          const r = row.original;
          if (r.summaryError) return <span className="muted" title={r.summaryError}>{r.summaryError.slice(0, 60)}</span>;
          if (!r.summary) return <Skeleton />;
          if (!r.summary.totals) return <span className="muted">–</span>;
          return (
            <>
              <span className="plus">+{fmtNum(r.summary.totals.additions)}</span>{' '}
              <span className="minus">−{fmtNum(r.summary.totals.deletions)}</span>
            </>
          );
        },
      },
      {
        id: 'uncommitted',
        header: 'Uncommitted',
        accessorFn: (r) => (r.uncommitted ? r.uncommitted.changed + r.uncommitted.untracked : undefined),
        sortUndefined: 'last',
        meta: { title: 'Edits in the worktree directory not yet committed. Not part of the diff.' },
        cell: ({ row }) => {
          const r = row.original;
          if (r.uncommittedError) return <span className="muted" title={r.uncommittedError}>–</span>;
          if (!r.uncommitted) return <Skeleton />;
          return <UncommittedTag u={r.uncommitted} />;
        },
      },
      {
        id: 'actions',
        header: '',
        enableSorting: false,
        enableHiding: false,
        cell: ({ row }) =>
          isDisabled(row.original.wt, base) ? null : (
            <Link href={hrefDiff(row.original.wt.path, base)} onClick={(e) => e.stopPropagation()}>
              View diff
            </Link>
          ),
      },
    ],
    [repoRoot, base],
  );

  const table = useReactTable({
    data: filtered,
    columns,
    state: { sorting, columnOrder: [...columnOrder, 'actions'], columnVisibility },
    onSortingChange: (u) => patch({ sorting: typeof u === 'function' ? u(sorting) : u }),
    onColumnOrderChange: (u) => {
      const next = (typeof u === 'function' ? u(columnOrder) : u).filter((id) => id !== 'actions');
      patch({ columnOrder: next });
    },
    onColumnVisibilityChange: (u) => patch({ columnVisibility: typeof u === 'function' ? u(columnVisibility) : u }),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableMultiSort: true,
    isMultiSortEvent: (e) => (e as MouseEvent).shiftKey,
  });

  // --- column drag & drop --------------------------------------------------
  const onDragStart = (id: string) => (e: DragEvent) => {
    setDragging(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  };
  const onDragOver = (id: string) => (e: DragEvent) => {
    if (!dragging || dragging === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOver !== id) setDragOver(id);
  };
  const onDrop = (targetId: string) => (e: DragEvent) => {
    e.preventDefault();
    const sourceId = dragging ?? e.dataTransfer.getData('text/plain');
    setDragging(null);
    setDragOver(null);
    if (!sourceId || sourceId === targetId) return;
    const order = columnOrder.filter((id) => id !== sourceId);
    const at = order.indexOf(targetId);
    order.splice(at === -1 ? order.length : at, 0, sourceId);
    patch({ columnOrder: order });
  };
  const onDragEnd = () => {
    setDragging(null);
    setDragOver(null);
  };

  const filtersActive = globalFilter !== '' || mergeFilter !== 'all' || uncommittedFilter !== 'all';
  const loadingCount = rows.filter((r) => !r.summary && !r.summaryError).length;

  return (
    <>
      <div className="table-controls">
        <input
          type="search"
          className="table-filter"
          placeholder="Filter by branch or path"
          value={globalFilter}
          onChange={(e) => patch({ globalFilter: e.target.value })}
          spellCheck={false}
        />
        <label className="control">
          <span>Merge</span>
          <select value={mergeFilter} onChange={(e) => patch({ mergeFilter: e.target.value as MergeFilter })}>
            <option value="all">all</option>
            <option value="unmerged">unmerged</option>
            <option value="conflicts">unmerged with conflicts</option>
            <option value="merged">merged</option>
            <option value="same">same as base</option>
          </select>
        </label>
        <label className="control">
          <span>Uncommitted</span>
          <select value={uncommittedFilter} onChange={(e) => patch({ uncommittedFilter: e.target.value as UncommittedFilter })}>
            <option value="all">all</option>
            <option value="dirty">has uncommitted changes</option>
            <option value="clean">clean</option>
          </select>
        </label>
        {filtersActive && (
          <button type="button" className="btn btn-quiet" onClick={() => patch({ globalFilter: '', mergeFilter: 'all', uncommittedFilter: 'all' })}>
            Clear filters
          </button>
        )}
        <span className="spacer" />
        <span className="filter-summary muted">
          {filtered.length === rows.length ? `${rows.length} worktrees` : `${filtered.length} of ${rows.length} worktrees`}
          {loadingCount > 0 && ` · ${loadingCount} loading`}
        </span>
        <details className="menu">
          <summary className="btn btn-quiet">Columns</summary>
          <div className="menu-body">
            {table
              .getAllLeafColumns()
              .filter((c) => c.getCanHide())
              .map((c) => (
                <label key={c.id}>
                  <input type="checkbox" checked={c.getIsVisible()} onChange={c.getToggleVisibilityHandler()} />
                  {String(c.columnDef.header)}
                </label>
              ))}
            <hr />
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => patch({ sorting: [], columnOrder: DEFAULT_ORDER, columnVisibility: {} })}
            >
              Reset layout
            </button>
            <p className="muted small">Drag column headers to rearrange. Click to sort, shift-click for multi-sort.</p>
          </div>
        </details>
      </div>

      <table className="wt-table">
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((header) => {
                const col = header.column;
                const meta = (col.columnDef.meta ?? {}) as { num?: boolean; title?: string };
                const movable = col.id !== 'actions';
                const sorted = col.getIsSorted();
                return (
                  <th
                    key={header.id}
                    className={[
                      meta.num && 'num',
                      col.getCanSort() && 'sortable',
                      dragOver === col.id && 'drag-over',
                      dragging === col.id && 'dragging',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    title={meta.title}
                    draggable={movable}
                    onDragStart={movable ? onDragStart(col.id) : undefined}
                    onDragOver={movable ? onDragOver(col.id) : undefined}
                    onDrop={movable ? onDrop(col.id) : undefined}
                    onDragEnd={onDragEnd}
                    onClick={col.getToggleSortingHandler()}
                    aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
                  >
                    {flexRender(col.columnDef.header, header.getContext())}
                    {sorted && <span className="sort-indicator">{sorted === 'asc' ? '▲' : '▼'}</span>}
                    {sorted && sorting.length > 1 && <span className="sort-index">{col.getSortIndex() + 1}</span>}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => {
            const wt = row.original.wt;
            const disabled = isDisabled(wt, base);
            return (
              <tr
                key={wt.path}
                className={[wt.isCurrent && 'is-current', disabled && 'is-disabled'].filter(Boolean).join(' ')}
                onClick={() => !disabled && router.push(hrefDiff(wt.path, base))}
              >
                {row.getVisibleCells().map((cell) => {
                  const meta = (cell.column.columnDef.meta ?? {}) as { num?: boolean };
                  return (
                    <td key={cell.id} className={meta.num ? 'num' : undefined}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  );
                })}
              </tr>
            );
          })}
          {table.getRowModel().rows.length === 0 && (
            <tr className="is-disabled">
              <td colSpan={table.getVisibleLeafColumns().length} className="empty">
                {rows.length === 0 ? 'No worktrees.' : 'No worktrees match the current filters.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

function isDisabled(wt: WorktreeRow, base: string): boolean {
  return wt.bare || wt.prunable || !base;
}

function numberCell(r: OverviewRow, value: number | undefined, kind?: 'ahead' | 'behind') {
  if (r.summaryError) return <span className="muted">–</span>;
  if (!r.summary) return <Skeleton />;
  if (r.summary.noCommonHistory) return <span className="muted">–</span>;
  return <span className={kind}>{fmtNum(value)}</span>;
}
