import fs from 'node:fs';

import {
  aheadBehind,
  commitsBetween,
  diffFiles,
  discoverRepo,
  fileDiff,
  fullDiff,
  guessDefaultBase,
  listBranches,
  listWorktrees,
  mergeBase,
  mergeTree,
  resolveRef,
  samePath,
  uncommittedSummary,
  type Branches,
  type ChangedFile,
  type Commit,
  type MergeTreeResult,
  type RepoInfo,
  type ResolvedRef,
  type Totals,
  type UncommittedCounts,
  type Worktree,
} from './git';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export type WorktreeRow = Worktree & { isCurrent: boolean };

export interface RepoPayload {
  repoRoot: string;
  currentWorktree: string;
  defaultBase: string | null;
  worktrees: WorktreeRow[];
}

export type MergeState = 'same' | 'merged' | 'unmerged' | 'unknown';

export interface MergeStatus {
  state: MergeState;
  via: 'ancestry' | 'squash' | null;
  conflicts: string[] | null;
}

export interface SummaryPayload {
  worktree: WorktreeRow;
  base: string;
  baseSha: string;
  mergeBase: string | null;
  noCommonHistory: boolean;
  sameAsBase: boolean;
  ahead: number | null;
  behind: number | null;
  totals: Totals | null;
  merge: MergeStatus;
}

export interface DiffPayload extends SummaryPayload {
  commits: Commit[];
  files: ChangedFile[];
}

export interface FilePayload {
  path: string;
  oldPath: string | null;
  mergeBase: string;
  diff: string;
}

export type UncommittedPayload = UncommittedCounts & { worktree: string };

type Params = Record<string, string | undefined>;

/**
 * Tiny TTL cache that also de-duplicates in-flight computations, so a burst of
 * overview requests shares one `git worktree list` instead of spawning twenty.
 */
function ttlCache<T>(ttl: number) {
  const map = new Map<string, { at: number; promise: Promise<T> }>();
  return {
    get(key: string, compute: () => Promise<T>, { force = false } = {}): Promise<T> {
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

export const UNKNOWN_MERGE: MergeStatus = { state: 'unknown', via: null, conflicts: null };

interface Context {
  wt: WorktreeRow;
  cwd: string;
  head: string;
  base: string;
  baseSha: string;
  baseTree: string;
  mb: string | null;
}

/**
 * Is the worktree's work in the base yet?
 *  - same:     the worktree is checked out at the base commit
 *  - merged:   every commit is reachable from the base (via: ancestry), or the
 *              in-memory merge leaves the base tree unchanged (via: squash),
 *              which covers squash and rebase merges
 *  - unmerged: with the list of files that would conflict (empty = merges cleanly,
 *              null = git could not tell)
 */
export function describeMerge(ctx: Context, ahead: number | null, mt: MergeTreeResult | null): MergeStatus {
  if (ctx.head === ctx.baseSha) return { state: 'same', via: null, conflicts: null };
  if (ahead === 0) return { state: 'merged', via: 'ancestry', conflicts: null };
  if (!mt) return { state: 'unmerged', via: null, conflicts: null };
  if (mt.tree === ctx.baseTree) return { state: 'merged', via: 'squash', conflicts: [] };
  return { state: 'unmerged', via: null, conflicts: mt.conflicts };
}

export class RepoService {
  repo: RepoInfo;
  private worktreeCache = ttlCache<WorktreeRow[]>(WORKTREE_TTL);
  private refCache = ttlCache<ResolvedRef | null>(REF_TTL);
  private branchCache = ttlCache<Branches>(BRANCH_TTL);
  private mergeBases = new Map<string, string>(); // `${head}\0${baseSha}` -> sha (immutable)
  private mergeTrees = new Map<string, MergeTreeResult | null>();

  constructor(repo: RepoInfo) {
    this.repo = repo;
  }

  static async open(cwd: string): Promise<RepoService> {
    return new RepoService(await discoverRepo(cwd));
  }

  worktrees({ force = false } = {}): Promise<WorktreeRow[]> {
    return this.worktreeCache.get(
      'list',
      async () => {
        const list = await listWorktrees(this.repo.currentWorktree);
        return list.map((w) => ({ ...w, isCurrent: samePath(w.path, this.repo.currentWorktree) }));
      },
      { force },
    );
  }

  branches({ force = false } = {}): Promise<Branches> {
    return this.branchCache.get('list', () => listBranches(this.repo.currentWorktree), { force });
  }

  /** Fast facts for the first paint. The (slow) branch list is a separate call. */
  async info(): Promise<RepoPayload> {
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
  async requireWorktree(key: string | undefined): Promise<WorktreeRow> {
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

  async requireBase(cwd: string, base: string | undefined): Promise<ResolvedRef> {
    if (!base) throw new HttpError(400, 'Missing "base" parameter');
    const resolved = await this.refCache.get(base, () => resolveRef(cwd, base));
    if (!resolved) throw new HttpError(404, `Base "${base}" is not a known branch or commit`);
    return resolved;
  }

  private async mergeBaseCached(cwd: string, head: string, baseSha: string): Promise<string | null> {
    const key = `${head}\0${baseSha}`;
    const hit = this.mergeBases.get(key);
    if (hit) return hit;
    const mb = await mergeBase(cwd, baseSha, head);
    if (mb) this.mergeBases.set(key, mb);
    return mb;
  }

  /** In-memory merge of the worktree into the base; result is immutable per sha pair. */
  private async mergeTreeCached(ctx: Context): Promise<MergeTreeResult | null> {
    if (ctx.head === ctx.baseSha) return null;
    const key = `${ctx.head}\0${ctx.baseSha}`;
    if (this.mergeTrees.has(key)) return this.mergeTrees.get(key) ?? null;
    const mt = await mergeTree(ctx.cwd, ctx.baseSha, ctx.head);
    this.mergeTrees.set(key, mt);
    return mt;
  }

  /** Validate worktree + base and find where they forked. */
  private async context({ worktree: key, base }: Params): Promise<Context> {
    const wt = await this.requireWorktree(key);
    const { sha: baseSha, tree: baseTree } = await this.requireBase(wt.path, base);
    const mb = await this.mergeBaseCached(wt.path, wt.head, baseSha);
    return { wt, cwd: wt.path, head: wt.head, base: base as string, baseSha, baseTree, mb };
  }

  private shape(ctx: Context) {
    return {
      worktree: ctx.wt,
      base: ctx.base,
      baseSha: ctx.baseSha,
      mergeBase: ctx.mb,
      noCommonHistory: !ctx.mb,
      sameAsBase: ctx.head === ctx.baseSha,
    };
  }

  /** Numbers for one worktree row of the Overview (no working-tree scan). */
  async summary(params: Params): Promise<SummaryPayload> {
    const ctx = await this.context(params);
    const shape = this.shape(ctx);
    if (!ctx.mb) return { ...shape, ahead: null, behind: null, totals: null, merge: UNKNOWN_MERGE };
    const [{ ahead, behind }, { totals }, mt] = await Promise.all([
      aheadBehind(ctx.cwd, ctx.baseSha, ctx.head),
      diffFiles(ctx.cwd, ctx.mb, ctx.head),
      this.mergeTreeCached(ctx),
    ]);
    return { ...shape, ahead, behind, totals, merge: describeMerge(ctx, ahead, mt) };
  }

  /** Uncommitted edits in a worktree directory. Reported apart from the diff. */
  async uncommitted({ worktree: key }: Params): Promise<UncommittedPayload> {
    const wt = await this.requireWorktree(key);
    const counts = await uncommittedSummary(wt.path);
    return { worktree: wt.path, ...counts };
  }

  /** Everything the Diff screen needs except the per-file patches. */
  async diff(params: Params): Promise<DiffPayload> {
    const ctx = await this.context(params);
    const shape = this.shape(ctx);
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

  async file({ path: filePath, oldPath, context, ...params }: Params): Promise<FilePayload> {
    if (!filePath) throw new HttpError(400, 'Missing "path" parameter');
    const ctx = await this.context(params);
    if (!ctx.mb) throw new HttpError(409, 'No common history between worktree and base');
    const lines = Math.min(Math.max(Number(context) || 3, 0), 100000);
    const diff = await fileDiff(ctx.cwd, ctx.mb, ctx.head, { path: filePath, oldPath: oldPath || null }, { context: lines });
    return { path: filePath, oldPath: oldPath || null, mergeBase: ctx.mb, diff };
  }

  async patch(params: Params): Promise<{ filename: string; text: string }> {
    const ctx = await this.context(params);
    if (!ctx.mb) throw new HttpError(409, 'No common history between worktree and base');
    const text = await fullDiff(ctx.cwd, ctx.mb, ctx.head);
    const label = (ctx.wt.branch || ctx.head.slice(0, 10)).replace(/[^\w.-]+/g, '_');
    const baseLabel = String(ctx.base).replace(/[^\w.-]+/g, '_');
    return { filename: `${label}-vs-${baseLabel}.patch`, text };
  }
}
