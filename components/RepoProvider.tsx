'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import type { Branches } from '@/lib/git';
import type { RepoPayload } from '@/lib/repo-service';
import { api } from '@/lib/client/api';

interface RepoContextValue {
  repo: RepoPayload | null;
  branches: Branches | null;
  error: string | null;
  /** Increments on every refresh so screens can reload their data. */
  version: number;
  refresh: () => Promise<void>;
}

const RepoContext = createContext<RepoContextValue | null>(null);

export function RepoProvider({ children }: { children: ReactNode }) {
  const [repo, setRepo] = useState<RepoPayload | null>(null);
  const [branches, setBranches] = useState<Branches | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const started = useRef(false);

  const load = useCallback(async (refresh: boolean) => {
    try {
      setRepo(await api<RepoPayload>('/api/repo'));
      setError(null);
      setVersion((v) => v + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    // The branch list can take a while on big repositories; it never blocks the first paint.
    api<Branches>('/api/branches', refresh ? { refresh: 1 } : {})
      .then(setBranches)
      .catch((err) => console.error('branch list failed', err));
  }, []);

  useEffect(() => {
    if (started.current) return; // React strict mode double-invokes effects in dev
    started.current = true;
    load(false);
  }, [load]);

  const refresh = useCallback(() => load(true), [load]);

  return <RepoContext.Provider value={{ repo, branches, error, version, refresh }}>{children}</RepoContext.Provider>;
}

export function useRepo(): RepoContextValue {
  const ctx = useContext(RepoContext);
  if (!ctx) throw new Error('useRepo must be used inside RepoProvider');
  return ctx;
}
