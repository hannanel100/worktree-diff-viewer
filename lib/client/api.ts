// Browser-side helpers shared by the Overview and Diff screens.

export type QueryValue = string | number | null | undefined;

export function buildUrl(route: string, params: Record<string, QueryValue> = {}): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== '') qs.set(k, String(v));
  }
  const q = qs.toString();
  return q ? `${route}?${q}` : route;
}

export async function api<T>(route: string, params: Record<string, QueryValue> = {}): Promise<T> {
  const res = await fetch(buildUrl(route, params));
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const message = (body as { error?: string })?.error || `${res.status} ${res.statusText}`;
    throw new Error(message);
  }
  return body as T;
}

/** Run async tasks with a concurrency cap; resolves when all settle. */
export async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<unknown>): Promise<void> {
  const queue = items.slice();
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift() as T;
      try {
        await worker(item);
      } catch (err) {
        console.error(err);
      }
    }
  });
  await Promise.all(runners);
}

export const hrefOverview = (base: string | null | undefined) => buildUrl('/', { base });

export const hrefDiff = (worktree: string, base: string | null | undefined, file?: string | null) =>
  buildUrl('/diff', { worktree, base, file });

export const hrefPatch = (worktree: string, base: string) => buildUrl('/api/patch', { worktree, base });
