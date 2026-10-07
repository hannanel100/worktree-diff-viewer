// The API, as plain (Request) => Response functions.
//
// `next dev` mounts them through app/api/*/route.dev.ts; the published package
// serves them from server/http.ts in front of the static export. Both hosts
// run exactly this code, so there is one API implementation.

import { errorResponse, jsonRoute, type Params } from './api';
import { getRepoService } from './context';

export type ApiHandler = (req: Request) => Promise<Response>;

async function patch(req: Request): Promise<Response> {
  try {
    const params = Object.fromEntries(new URL(req.url).searchParams) as Params;
    const service = await getRepoService();
    const { filename, text } = await service.patch(params);
    return new Response(text, {
      headers: {
        'Content-Type': 'text/x-patch; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export const apiHandlers = {
  repo: jsonRoute((_params, service) => service.info()),
  branches: jsonRoute((params, service) => service.branches({ force: 'refresh' in params })),
  summary: jsonRoute((params, service) => service.summary(params)),
  uncommitted: jsonRoute((params, service) => service.uncommitted(params)),
  diff: jsonRoute((params, service) => service.diff(params)),
  file: jsonRoute((params, service) => service.file(params)),
  patch,
} satisfies Record<string, ApiHandler>;

export type ApiName = keyof typeof apiHandlers;

export function isApiName(name: string): name is ApiName {
  return Object.prototype.hasOwnProperty.call(apiHandlers, name);
}
