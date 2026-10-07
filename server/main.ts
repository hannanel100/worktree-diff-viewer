// Entry point of the production server. Bundled by scripts/build-server.mjs
// into dist/server.mjs, which bin/wtdiff.js imports.

import http from 'node:http';

import { getRepoService, resetRepoService } from '../lib/context';
import type { RepoPayload } from '../lib/repo-service';
import { createRequestListener } from './http';

export interface StartOptions {
  /** Directory inside the repository to inspect (any worktree or the main checkout). */
  cwd: string;
  /** The static export of the UI (Next `out/`). */
  staticDir: string;
  host?: string;
  port?: number;
  /** Fail instead of falling back to a random free port when `port` is busy. */
  strictPort?: boolean;
}

export interface Started {
  server: http.Server;
  url: string;
  host: string;
  port: number;
  info: RepoPayload;
}

/** Listen on `port`, falling back to a random free one unless strict. */
export function listen(server: http.Server, host: string, port: number, strict: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const attempt = (p: number) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        if (err.code === 'EADDRINUSE' && !strict && p !== 0) return attempt(0);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : p);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p, host);
    };
    attempt(port);
  });
}

export async function startServer({
  cwd,
  staticDir,
  host = '127.0.0.1',
  port = 4747,
  strictPort = false,
}: StartOptions): Promise<Started> {
  process.env.WTDIFF_CWD = cwd;
  resetRepoService();
  const service = await getRepoService(); // throws GitError outside a repository
  const info = await service.info();

  const server = http.createServer(createRequestListener({ staticDir }));
  const actualPort = await listen(server, host, port, strictPort);
  return { server, url: `http://${host}:${actualPort}/`, host, port: actualPort, info };
}
