// How diffs are displayed: lines of context and whether whitespace changes
// count. Read from the URL first (so a shared link shows what its author saw),
// then from the browser's remembered choice, then git's defaults.

import { useCallback, useEffect, useRef, useState } from 'react';

import type { QueryValue } from './api';
import { loadJson, saveJson } from './storage';

export type ContextSetting = number | 'all';

export interface DiffOptions {
  context: ContextSetting;
  ignoreWhitespace: boolean;
}

export const DEFAULT_DIFF_OPTIONS: DiffOptions = { context: 3, ignoreWhitespace: false };

export const CONTEXT_CHOICES: ContextSetting[] = [3, 10, 25, 'all'];

const STORAGE_KEY = 'wtdiff.diffOptions';

export function parseContext(value: string | null | undefined): ContextSetting | null {
  if (value === 'all') return 'all';
  if (!value || !/^\d+$/.test(value)) return null;
  return Math.min(Number(value), 1_000_000);
}

type ParamSource = { get(name: string): string | null };

export function readDiffOptions(params: ParamSource): DiffOptions {
  const stored = loadJson<DiffOptions>(STORAGE_KEY, DEFAULT_DIFF_OPTIONS);
  const ws = params.get('whitespace');
  return {
    context: parseContext(params.get('context')) ?? parseContext(String(stored.context)) ?? DEFAULT_DIFF_OPTIONS.context,
    ignoreWhitespace: ws === 'ignore' ? true : ws === 'show' ? false : stored.ignoreWhitespace === true,
  };
}

/** Query parameters for the API and page URLs; defaults are left out. */
export function diffOptionParams(opts: DiffOptions): Record<string, QueryValue> {
  return {
    context: opts.context === DEFAULT_DIFF_OPTIONS.context ? null : opts.context,
    whitespace: opts.ignoreWhitespace ? 'ignore' : null,
  };
}

/** `href` with the options' query parameters set (or removed where they are the default). */
export function withDiffOptions(href: string, opts: DiffOptions): string {
  const url = new URL(href, 'http://x');
  for (const [k, v] of Object.entries(diffOptionParams(opts))) {
    if (v === null || v === undefined) url.searchParams.delete(k);
    else url.searchParams.set(k, String(v));
  }
  return url.pathname + url.search;
}

export function contextLabel(c: ContextSetting): string {
  return c === 'all' ? 'Whole file' : `${c} ${c === 1 ? 'line' : 'lines'}`;
}

/**
 * The diff options of the current page. A change is remembered for next time
 * and mirrored into the URL; a navigation that sets them in the URL wins.
 */
export function useDiffOptions(params: ParamSource): [DiffOptions, (patch: Partial<DiffOptions>) => void] {
  const [opts, setOpts] = useState<DiffOptions>(() => readDiffOptions(params));
  const urlKey = `${params.get('context')}\0${params.get('whitespace')}`;
  const firstKey = useRef(urlKey);
  useEffect(() => {
    if (urlKey === firstKey.current) return;
    firstKey.current = urlKey;
    setOpts(readDiffOptions(params));
  }, [urlKey, params]);

  const optsRef = useRef(opts);
  optsRef.current = opts;
  const update = useCallback((patch: Partial<DiffOptions>) => {
    const next = { ...optsRef.current, ...patch };
    saveJson(STORAGE_KEY, next);
    window.history.replaceState(null, '', withDiffOptions(window.location.pathname + window.location.search, next));
    setOpts(next);
  }, []);

  return [opts, update];
}
