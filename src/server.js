import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import {
  GitError,
  discoverRepo,
  listWorktrees,
  listBranches,
  guessDefaultBase,
  resolveRef,
  mergeBase,
  mergeTree,
  aheadBehind,
  diffFiles,
  fileDiff,
  fullDiff,
  commitsBetween,
  uncommittedSummary,
  samePath,
} from './git.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const require = createRequire(import.meta.url);

// Third-party browser assets are served from node_modules so the tool works offline.
const VENDOR_FILES = {
  'diff2html-ui.min.js': require.resolve('diff2html/bundles/js/diff2html-ui.min.js'),
  'diff2html.min.css': require.resolve('diff2html/bundles/css/diff2html.min.css'),
  'hljs-light.min.css': require.resolve('highlight.js/styles/github.min.css'),
  'hljs-dark.min.css': require.resolve('highlight.js/styles/github-dark.min.css'),
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Tiny TTL cache that also de-duplicates in-flight computations, so a burst of
 * overview requests shares one `git worktree list` instead of spawning twenty.
 */
function ttlCache(ttl) {
  const map = new Map();
  return {
    get(key, compute, { force = false } = {}) {
      const hit = map.get(key);
      if (!force && hit && Date.now() - hit.at < ttl) return hit.promise;
      const promise = Promise.resolve()
        .then(compute)
        .catch((err) => {
          map.delete(key);
          throw err;
        });
      map.set(key, { at: Date.now(), promise });
      return promise;
    },
    clear() {
      map.clear();
    },
  };
}

const WORKTREE_TTL = 3_000;
const REF_TTL = 3_000;
const BRANCH_TTL = 60_000;

const UNKNOWN_MERGE = { state: 'unknown', via: null, conflicts: null };

/**
 * Is the worktree's work in the base yet?
 *  - same:     the worktree is checked out at the base commit
 *  - merged:   every commit is reachable from the base (via: ancestry), or the
 *              in-memory merge leaves the base tree unchanged (via: squash),
 *              which covers squash and rebase merges
 *  - unmerged: with the list of files that would conflict (empty = merges cleanly,
 *              null = git could not tell)
 */
function describeMerge(ctx, ahead, mt) {
  if (ctx.head === ctx.baseSha) return { state: 'same', via: null, conflicts: null };
  if (ahead === 0) return { state: 'merged', via: 'ancestry', conflicts: null };
  if (!mt) return { state: 'unmerged', via: null, conflicts: null };
  if (mt.tree === ctx.baseTree) return { state: 'merged', via: 'squash', conflicts: [] };
  return { state: 'unmerged', via: null, conflicts: mt.conflicts };
}

// ---------------------------------------------------------------------------
// Repository-facing service
// ---------------------------------------------------------------------------

export class RepoService {
  constructor(repo) {
    this.repo = repo; // { repoRoot, currentWorktree, commonDir }
    this.worktreeCache = ttlCache(WORKTREE_TTL);
    this.refCache = ttlCache(REF_TTL);
    this.branchCache = ttlCache(BRANCH_TTL);
    this.mergeBases = new Map(); // `${head}\0${baseSha}` -> sha (immutable, cache forever)
    this.mergeTrees = new Map(); // `${head}\0${baseSha}` -> { tree, conflicts } | null
  }

  static async open(cwd) {
    return new RepoService(await discoverRepo(cwd));
  }

  worktrees({ force = false } = {}) {
    return this.worktreeCache.get(
      'list',
      async () => {
        const list = await listWorktrees(this.repo.currentWorktree);
        return list.map((w) => ({ ...w, isCurrent: samePath(w.path, this.repo.currentWorktree) }));
      },
      { force },
    );
  }

  branches({ force = false } = {}) {
    return this.branchCache.get('list', () => listBranches(this.repo.currentWorktree), { force });
  }

  /** Fast facts for the first paint. The (slow) branch list is a separate call. */
  async info() {
    const [worktrees, defaultBase] = await Promise.all([
      this.worktrees({ force: true }),
      guessDefaultBase(this.repo.currentWorktree),
    ]);
    return {
      repoRoot: this.repo.repoRoot,
      currentWorktree: this.repo.currentWorktree,
      defaultBase,
      worktrees,
    };
  }

  /** Find a worktree by path (preferred) or by id; refuse anything else. */
  async requireWorktree(key) {
    if (!key) throw new HttpError(400, 'Missing "worktree" parameter');
    const list = await this.worktrees();
    // Expand symlinks and Windows 8.3 short names so the path compares equal
    // to what `git worktree list` prints.
    let realKey = key;
    if (/[\\/]/.test(key)) {
      try {
        realKey = fs.realpathSync.native(key);
      } catch {
        /* keep as given; the lookup below will fail cleanly */
      }
    }
    const wt = list.find((w) => w.id === key || samePath(w.path, realKey) || samePath(w.path, key));
    if (!wt) throw new HttpError(404, `Unknown worktree: ${key}`);
    if (wt.bare) throw new HttpError(400, 'Bare worktree has no checkout to diff');
    if (wt.prunable || !fs.existsSync(wt.path)) {
      throw new HttpError(404, `Worktree directory is missing: ${wt.path}`);
    }
    return wt;
  }

  async requireBase(cwd, base) {
    if (!base) throw new HttpError(400, 'Missing "base" parameter');
    const resolved = await this.refCache.get(base, () => resolveRef(cwd, base));
    if (!resolved) throw new HttpError(404, `Base "${base}" is not a known branch or commit`);
    return resolved; // { sha, tree }
  }

  async mergeBaseCached(cwd, head, baseSha) {
    const key = `${head}\0${baseSha}`;
    if (this.mergeBases.has(key)) return this.mergeBases.get(key);
    const mb = await mergeBase(cwd, baseSha, head);
    if (mb) this.mergeBases.set(key, mb);
    return mb;
  }

  /** In-memory merge of the worktree into the base; result is immutable per sha pair. */
  async mergeTreeCached(ctx) {
    if (ctx.head === ctx.baseSha) return null;
    const key = `${ctx.head}\0${ctx.baseSha}`;
    if (this.mergeTrees.has(key)) return this.mergeTrees.get(key);
    const mt = await mergeTree(ctx.cwd, ctx.baseSha, ctx.head);
    this.mergeTrees.set(key, mt);
    return mt;
  }

  /** Validate worktree + base and find where they forked. */
  async context({ worktree: key, base }) {
    const wt = await this.requireWorktree(key);
    const { sha: baseSha, tree: baseTree } = await this.requireBase(wt.path, base);
    const mb = await this.mergeBaseCached(wt.path, wt.head, baseSha);
    return { wt, cwd: wt.path, head: wt.head, base, baseSha, baseTree, mb };
  }

  /** Numbers for one worktree row of the Overview (no working-tree scan). */
  async summary(params) {
    const ctx = await this.context(params);
    const shape = {
      worktree: ctx.wt,
      base: ctx.base,
      baseSha: ctx.baseSha,
      mergeBase: ctx.mb,
      noCommonHistory: !ctx.mb,
      sameAsBase: ctx.head === ctx.baseSha,
    };
    if (!ctx.mb) return { ...shape, ahead: null, behind: null, totals: null, merge: UNKNOWN_MERGE };
    const [{ ahead, behind }, { totals }, mt] = await Promise.all([
      aheadBehind(ctx.cwd, ctx.baseSha, ctx.head),
      diffFiles(ctx.cwd, ctx.mb, ctx.head),
      this.mergeTreeCached(ctx),
    ]);
    return { ...shape, ahead, behind, totals, merge: describeMerge(ctx, ahead, mt) };
  }

  /** Uncommitted edits in a worktree directory. Reported apart from the diff. */
  async uncommitted({ worktree: key }) {
    const wt = await this.requireWorktree(key);
    const counts = await uncommittedSummary(wt.path);
    return { worktree: wt.path, ...counts };
  }

  /** Everything the Diff screen needs except the per-file patches. */
  async diff(params) {
    const ctx = await this.context(params);
    const shape = {
      worktree: ctx.wt,
      base: ctx.base,
      baseSha: ctx.baseSha,
      mergeBase: ctx.mb,
      noCommonHistory: !ctx.mb,
      sameAsBase: ctx.head === ctx.baseSha,
    };
    if (!ctx.mb) {
      return { ...shape, ahead: null, behind: null, totals: null, merge: UNKNOWN_MERGE, commits: [], files: [] };
    }
    const [{ ahead, behind }, { files, totals }, commits, mt] = await Promise.all([
      aheadBehind(ctx.cwd, ctx.baseSha, ctx.head),
      diffFiles(ctx.cwd, ctx.mb, ctx.head),
      commitsBetween(ctx.cwd, ctx.baseSha, ctx.head),
      this.mergeTreeCached(ctx),
    ]);
    return { ...shape, ahead, behind, totals, merge: describeMerge(ctx, ahead, mt), commits, files };
  }

  async file({ path: filePath, oldPath, context, ...params }) {
    if (!filePath) throw new HttpError(400, 'Missing "path" parameter');
    const ctx = await this.context(params);
    if (!ctx.mb) throw new HttpError(409, 'No common history between worktree and base');
    const lines = Math.min(Math.max(Number(context) || 3, 0), 100000);
    const diff = await fileDiff(ctx.cwd, ctx.mb, ctx.head, { path: filePath, oldPath: oldPath || null }, { context: lines });
    return { path: filePath, oldPath: oldPath || null, mergeBase: ctx.mb, diff };
  }

  async patch(params) {
    const ctx = await this.context(params);
    if (!ctx.mb) throw new HttpError(409, 'No common history between worktree and base');
    const text = await fullDiff(ctx.cwd, ctx.mb, ctx.head);
    const label = (ctx.wt.branch || ctx.head.slice(0, 10)).replace(/[^\w.-]+/g, '_');
    const baseLabel = String(ctx.base).replace(/[^\w.-]+/g, '_');
    return { filename: `${label}-vs-${baseLabel}.patch`, text };
  }
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function sendFile(res, filePath, { cache = 'no-cache' } = {}) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return sendJson(res, 404, { error: 'Not found' });
  }
  if (!stat.isFile()) return sendJson(res, 404, { error: 'Not found' });
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': cache,
  });
  fs.createReadStream(filePath).pipe(res);
}

function params(url) {
  const out = {};
  for (const [k, v] of url.searchParams) out[k] = v;
  return out;
}

export function createApp(service) {
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        throw new HttpError(405, 'Method not allowed');
      }

      // --- API -----------------------------------------------------------
      if (p === '/api/repo') return sendJson(res, 200, await service.info());
      if (p === '/api/branches') {
        return sendJson(res, 200, await service.branches({ force: url.searchParams.has('refresh') }));
      }
      if (p === '/api/summary') return sendJson(res, 200, await service.summary(params(url)));
      if (p === '/api/uncommitted') return sendJson(res, 200, await service.uncommitted(params(url)));
      if (p === '/api/diff') return sendJson(res, 200, await service.diff(params(url)));
      if (p === '/api/file') return sendJson(res, 200, await service.file(params(url)));
      if (p === '/api/patch') {
        const { filename, text } = await service.patch(params(url));
        res.writeHead(200, {
          'Content-Type': 'text/x-patch; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-store',
        });
        return res.end(text);
      }
      if (p.startsWith('/api/')) throw new HttpError(404, 'Unknown API route');

      // --- Static --------------------------------------------------------
      if (p.startsWith('/vendor/')) {
        const name = p.slice('/vendor/'.length);
        const file = VENDOR_FILES[name];
        if (!file) throw new HttpError(404, 'Not found');
        return sendFile(res, file, { cache: 'public, max-age=86400' });
      }
      const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
      const target = path.normalize(path.join(PUBLIC_DIR, rel));
      if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== PUBLIC_DIR) {
        throw new HttpError(403, 'Forbidden');
      }
      if (!fs.existsSync(target)) {
        // Unknown paths fall back to the SPA shell (hash routing does the rest).
        return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
      }
      return sendFile(res, target);
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      if (err instanceof GitError) return sendJson(res, 500, { error: err.message, git: true });
      console.error(err);
      return sendJson(res, 500, { error: err?.message || 'Internal error' });
    }
  };
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * Start the viewer for the repository containing `cwd`.
 * If `port` is busy and `strictPort` is false, falls back to a random free port.
 */
export async function startServer({ cwd, host = '127.0.0.1', port = 4747, strictPort = false } = {}) {
  const service = await RepoService.open(cwd);
  const server = http.createServer(createApp(service));
  let actualPort;
  try {
    actualPort = await listen(server, host, port);
  } catch (err) {
    if (err.code === 'EADDRINUSE' && !strictPort) {
      actualPort = await listen(server, host, 0);
    } else {
      throw err;
    }
  }
  const url = `http://${host}:${actualPort}/`;
  return { server, service, url, port: actualPort, repo: service.repo };
}
