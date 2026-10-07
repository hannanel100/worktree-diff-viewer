// Production request listener: the API (shared handlers) plus the static
// export of the UI. Dependency-free; everything here is Node built-ins.

import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { apiHandlers, isApiName } from '../lib/handlers';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

function sendText(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  sendText(res, status, 'application/json; charset=utf-8', JSON.stringify(body));
}

function sendFile(res: ServerResponse, file: string, status: number, cache: string, headOnly: boolean): void {
  const stat = fs.statSync(file);
  res.writeHead(status, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': cache,
  });
  if (headOnly) return void res.end();
  fs.createReadStream(file).pipe(res);
}

/** True when `target` is `root` itself or lives underneath it. */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ---------------------------------------------------------------------------
// API: adapt Node's request/response to the shared Web-standard handlers
// ---------------------------------------------------------------------------

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }
  const name = url.pathname.slice('/api/'.length).replace(/\/+$/, '');
  if (!isApiName(name)) return sendJson(res, 404, { error: 'Unknown API route' });

  // The handlers only read the URL; no request headers are forwarded.
  const response = await apiHandlers[name](new Request(url.toString(), { method: 'GET' }));
  const body = Buffer.from(await response.arrayBuffer());
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  headers['content-length'] = String(body.length);
  res.writeHead(response.status, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

// ---------------------------------------------------------------------------
// Static export (Next `output: 'export'` layout: /diff -> diff.html, etc.)
// ---------------------------------------------------------------------------

function serveStatic(res: ServerResponse, root: string, pathname: string, headOnly: boolean): void {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    return sendText(res, 400, 'text/plain; charset=utf-8', 'Bad request');
  }

  const candidates =
    rel === '' ? ['index.html'] : path.extname(rel) ? [rel] : [`${rel}.html`, path.join(rel, 'index.html')];
  // Next's static export writes nested segment prefetch payloads as
  // `__next.<segment>/__PAGE__.txt` while the client asks for
  // `__next.<segment>.__PAGE__.txt`; accept both spellings.
  if (rel.endsWith('.__PAGE__.txt') && path.basename(rel).startsWith('__next.')) {
    candidates.push(rel.replace(/\.__PAGE__\.txt$/, '/__PAGE__.txt'));
  }

  for (const candidate of candidates) {
    const full = path.resolve(root, candidate);
    if (!isInside(root, full)) return sendText(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    // Next's hashed assets can be cached forever; HTML must always revalidate.
    const cache = candidate.startsWith('_next/static/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    return sendFile(res, full, 200, cache, headOnly);
  }

  const notFound = path.join(root, '404.html');
  if (fs.existsSync(notFound)) return sendFile(res, notFound, 404, 'no-cache', headOnly);
  sendText(res, 404, 'text/plain; charset=utf-8', 'Not found');
}

// ---------------------------------------------------------------------------

export function createRequestListener({ staticDir }: { staticDir: string }) {
  const root = path.resolve(staticDir);
  return async function listener(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendText(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');
      }
      serveStatic(res, root, url.pathname, req.method === 'HEAD');
    } catch (err) {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: err instanceof Error ? err.message : 'Internal error' });
      else res.end();
    }
  };
}
