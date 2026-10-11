'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import { buildUrl, hrefOverview } from '@/lib/client/api';
import { useRepo } from './RepoProvider';

/** A branch glyph: trunk with two nodes and a branch forking off to the side. */
function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 16 16" width="20" height="20" aria-hidden="true" focusable="false">
      <path
        d="M4 5v6M4 11c0-2.2 8-1.3 8-3"
        fill="none"
        stroke="var(--fg-muted)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="4" cy="3" r="2.2" fill="#60a5fa" />
      <circle cx="12" cy="6" r="2.2" fill="#34d399" />
      <circle cx="4" cy="13" r="2.2" fill="var(--fg-muted)" />
    </svg>
  );
}

export function TopBar() {
  const { repo, branches, refresh } = useRepo();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const base = searchParams.get('base') || repo?.defaultBase || '';
  const [value, setValue] = useState(base);
  const [refreshing, setRefreshing] = useState(false);

  // Keep the box in sync when the URL or the default base changes.
  useEffect(() => setValue(base), [base]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const next = value.trim();
    if (!next) return;
    const params: Record<string, string | null> = { base: next };
    if (pathname === '/diff') params.worktree = searchParams.get('worktree');
    router.push(buildUrl(pathname, params));
    (e.currentTarget as HTMLFormElement).querySelector('input')?.blur();
  };

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <header className="topbar">
      <Link className="brand" href={hrefOverview(base)} title="Overview of all worktrees">
        <BrandMark />
        <span className="brand-name">Worktree Diff</span>
      </Link>
      <span className="repo-root" title={repo ? `Repository root: ${repo.repoRoot}` : ''}>
        {repo?.repoRoot ?? ''}
      </span>
      <form className="base-picker" onSubmit={onSubmit} autoComplete="off">
        <label htmlFor="base-input">Base</label>
        <input
          id="base-input"
          list="base-list"
          placeholder="branch or ref"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <datalist id="base-list">
          {branches?.local.map((b) => (
            <option key={b.ref} value={b.name}>{`local · ${b.sha}`}</option>
          ))}
          {branches?.remote.map((b) => (
            <option key={b.ref} value={b.name}>{`remote · ${b.sha}`}</option>
          ))}
        </datalist>
        <button type="submit" className="btn">Compare</button>
      </form>
      <button type="button" className="btn btn-quiet" onClick={onRefresh} disabled={refreshing} title="Reload branches and worktrees">
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </button>
    </header>
  );
}
