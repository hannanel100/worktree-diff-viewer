'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import { buildUrl, hrefOverview } from '@/lib/client/api';
import { useRepo } from './RepoProvider';

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
        <span className="brand-mark" />
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
