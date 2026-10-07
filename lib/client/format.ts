import type { Worktree, FileStatus } from '@/lib/git';

export function fmtNum(n: number | null | undefined): string {
  return n === null || n === undefined ? '–' : Number(n).toLocaleString();
}

export function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const units: [number, string][] = [
    [60, 'second'], [60, 'minute'], [24, 'hour'], [7, 'day'], [4.345, 'week'], [12, 'month'], [Infinity, 'year'],
  ];
  let v = Math.round((Date.now() - t) / 1000);
  for (const [size, name] of units) {
    if (Math.abs(v) < size) {
      const r = Math.round(v);
      return `${r} ${name}${r === 1 ? '' : 's'} ago`;
    }
    v /= size;
  }
  return '';
}

export function worktreeLabel(wt: Worktree): string {
  if (wt.bare) return '(bare)';
  if (wt.branch) return wt.branch;
  return `detached @ ${wt.head.slice(0, 10)}`;
}

/** Path relative to the repository root when inside it, else the full path. */
export function displayPath(wt: Worktree, repoRoot: string): string {
  const root = repoRoot.replace(/\/+$/, '');
  if (wt.path === root) return '.';
  const prefix = `${root}/`;
  return wt.path.toLowerCase().startsWith(prefix.toLowerCase()) ? wt.path.slice(prefix.length) : wt.path;
}

export function splitPath(p: string): [string, string] {
  const i = p.lastIndexOf('/');
  return i === -1 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)];
}

const STATUS_NAMES: Record<string, string> = {
  A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed', U: 'unmerged',
};

export function statusName(s: FileStatus): string {
  return STATUS_NAMES[s] || s;
}
