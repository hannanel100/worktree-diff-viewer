import { GitError } from './git';
import { HttpError, type RepoService } from './repo-service';
import { getRepoService } from './context';

export type Params = Record<string, string | undefined>;

const NO_STORE = { 'Cache-Control': 'no-store' };

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return Response.json({ error: err.message }, { status: err.status, headers: NO_STORE });
  if (err instanceof GitError) return Response.json({ error: err.message, git: true }, { status: 500, headers: NO_STORE });
  console.error(err);
  const message = err instanceof Error ? err.message : 'Internal error';
  return Response.json({ error: message }, { status: 500, headers: NO_STORE });
}

/** Build a GET route handler that answers with JSON and maps errors to statuses. */
export function jsonRoute<T>(fn: (params: Params, service: RepoService) => Promise<T>) {
  return async function GET(req: Request): Promise<Response> {
    try {
      const params = Object.fromEntries(new URL(req.url).searchParams) as Params;
      const service = await getRepoService();
      return Response.json(await fn(params, service), { headers: NO_STORE });
    } catch (err) {
      return errorResponse(err);
    }
  };
}
