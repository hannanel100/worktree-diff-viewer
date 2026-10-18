import fs from 'node:fs';

import {
  aheadBehind,
  commitInfo,
  commitsBetween,
  diffFiles,
  discoverRepo,
  emptyTree,
  fileDiff,
  fullDiff,
  guessDefaultBase,
  listBranches,
  listWorktrees,
  mergeBase,
  mergeTree,
  resolveRef,
  samePath,
  uncommittedFiles,
  uncommittedSummary,
  workingTreeFileDiff,
  workingTreePatch,
  type Branches,
  type ChangedFile,
  type Commit,
  type CommitInfo,
  type DiffOptions,
  type MergeTreeResult,
  type RepoInfo,
  type ResolvedRef,
  type Totals,
  type UncommittedArea,
  type UncommittedCounts,
  type UncommittedFile,
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

/** One commit of a branch, diffed against its first parent. */
export interface CommitPayload {
  worktree: WorktreeRow;
  commit: Commit;
  /** First parent first; empty for a root commit. */
  parents: string[];
  /** What the files are diffed against: the first parent, or null for a root commit (diffed against the empty tree). */
  parent: string | null;
  files: ChangedFile[];
  totals: Totals;
}

export interface CommitFilePayload {
  path: string;
  oldPath: string | null;
  commit: string;
  parent: string | null;
  diff: string;
}

export type UncommittedPayload = UncommittedCounts & { worktree: string };

export interface UncommittedFilesPayload {
  worktree: WorktreeRow;
  head: string;
  files: UncommittedFile[];
  totals: Totals;
  counts: UncommittedCounts;
}

export interface UncommittedFilePayload {
  path: string;
  oldPath: string | null;
  area: UncommittedArea;
  diff: string;
}

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
// Long enough to make per-file requests and prefetching cheap, short enough
// that an edit in the worktree shows up on the next click.
const UNCOMMITTED_TTL = 1_500;

export const UNKNOWN_MERGE: MergeStatus = { state: 'unknown', via: null, conflicts: null };

/** Lines of context asked for when `context=all`: enough for any whole file. */
export const FULL_CONTEXT = 1_000_000;

/**
 * Read the display options shared by every diff and patch route:
 *  - context:    unchanged lines around each change, a number or "all" (default 3)
 *  - whitespace: "ignore" leaves out changes that only touch whitespace
 * Anything unrecognised falls back to git's defaults.
 */
export function diffOptions({ context, whitespace }: Params): DiffOptions {
  const n = context === 'all' ? FULL_CONTEXT : context ? Number(context) : NaN;
  return {
    context: Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 0), FULL_CONTEXT) : 3,
    ignoreWhitespace: whitespace === 'ignore',
  };
}

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
  private uncommittedCache = ttlCache<{ files: UncommittedFile[]; totals: Totals }>(UNCOMMITTED_TTL);
  private mergeBases = new Map<string, string>(); // `${head}\0${baseSha}` -> sha (immutable)
  private mergeTrees = new Map<string, MergeTreeResult | null>();
  private commits = new Map<string, CommitInfo>(); // full sha -> metadata (immutable)
  private emptyTreeSha: Promise<string> | null = null;

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

  // --- uncommitted changes: the working tree + index against HEAD ----------

  private uncommittedListCached(wt: WorktreeRow) {
    return this.uncommittedCache.get(wt.path, () => uncommittedFiles(wt.path));
  }

  /** Every uncommitted change of one worktree, with line counts. */
  async uncommittedFiles({ worktree: key }: Params): Promise<UncommittedFilesPayload> {
    const wt = await this.requireWorktree(key);
    const { files, totals } = await this.uncommittedListCached(wt);
    const counts = {
      changed: files.filter((f) => f.area !== 'untracked').length,
      untracked: files.filter((f) => f.area === 'untracked').length,
    };
    return { worktree: wt, head: wt.head, files, totals, counts };
  }

  /** Only paths git itself reports as changed can be diffed; nothing else on disk is readable. */
  private async requireUncommittedFile(wt: WorktreeRow, filePath: string | undefined, oldPath: string | undefined) {
    if (!filePath) throw new HttpError(400, 'Missing "path" parameter');
    const { files } = await this.uncommittedListCached(wt);
    const file =
      files.find((f) => f.path === filePath && (f.oldPath ?? null) === (oldPath || null)) ??
      files.find((f) => f.path === filePath);
    if (!file) throw new HttpError(404, `"${filePath}" has no uncommitted changes in this worktree`);
    return file;
  }

  async uncommittedFile(params: Params): Promise<UncommittedFilePayload> {
    const wt = await this.requireWorktree(params.worktree);
    const file = await this.requireUncommittedFile(wt, params.path, params.oldPath);
    const diff = await workingTreeFileDiff(wt.path, file, diffOptions(params));
    return { path: file.path, oldPath: file.oldPath, area: file.area, diff };
  }

  async uncommittedPatch(params: Params): Promise<{ filename: string; text: string }> {
    const wt = await this.requireWorktree(params.worktree);
    const { files } = await this.uncommittedListCached(wt);
    const untracked = files.filter((f) => f.area === 'untracked').map((f) => f.path);
    const text = await workingTreePatch(wt.path, untracked, diffOptions(params));
    const label = (wt.branch || wt.head.slice(0, 10)).replace(/[^\w.-]+/g, '_');
    return { filename: `${label}-uncommitted.patch`, text };
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

  async file({ path: filePath, oldPath, ...params }: Params): Promise<FilePayload> {
    if (!filePath) throw new HttpError(400, 'Missing "path" parameter');
    const ctx = await this.context(params);
    if (!ctx.mb) throw new HttpError(409, 'No common history between worktree and base');
    const file = { path: filePath, oldPath: oldPath || null };
    const diff = await fileDiff(ctx.cwd, ctx.mb, ctx.head, file, diffOptions(params));
    return { path: filePath, oldPath: oldPath || null, mergeBase: ctx.mb, diff };
  }

  async patch(params: Params): Promise<{ filename: string; text: string }> {
    const ctx = await this.context(params);
    if (!ctx.mb) throw new HttpError(409, 'No common history between worktree and base');
    const text = await fullDiff(ctx.cwd, ctx.mb, ctx.head, diffOptions(params));
    const label = (ctx.wt.branch || ctx.head.slice(0, 10)).replace(/[^\w.-]+/g, '_');
    const baseLabel = String(ctx.base).replace(/[^\w.-]+/g, '_');
    return { filename: `${label}-vs-${baseLabel}.patch`, text };
  }

  // --- one commit: the commit against its first parent ----------------------

  /** Validate the commit parameter and read its metadata; a full sha is immutable, so it is cached for good. */
  private async requireCommit(cwd: string, ref: string | undefined): Promise<CommitInfo> {
    if (!ref) throw new HttpError(400, 'Missing "commit" parameter');
    const hit = this.commits.get(ref);
    if (hit) return hit;
    const info = await commitInfo(cwd, ref);
    if (!info) throw new HttpError(404, `Commit "${ref}" is not a known commit`);
    if (info.sha === ref) this.commits.set(ref, info); // names move, shas do not
    return info;
  }

  /** The side a commit is diffed against: its first parent, or the empty tree for a root commit. */
  private commitFrom(cwd: string, info: CommitInfo): Promise<string> {
    if (info.parents.length > 0) return Promise.resolve(info.parents[0]);
    this.emptyTreeSha ??= emptyTree(cwd);
    return this.emptyTreeSha;
  }

  private async commitContext({ worktree: key, commit: ref }: Params) {
    const wt = await this.requireWorktree(key);
    const info = await this.requireCommit(wt.path, ref);
    const from = await this.commitFrom(wt.path, info);
    return { wt, cwd: wt.path, info, from };
  }

  /** Everything the per-commit screen needs except the per-file patches. */
  async commit(params: Params): Promise<CommitPayload> {
    const { wt, cwd, info, from } = await this.commitContext(params);
    const { files, totals } = await diffFiles(cwd, from, info.sha);
    const { parents, ...commit } = info;
    return { worktree: wt, commit, parents, parent: parents[0] ?? null, files, totals };
  }

  async commitFile({ path: filePath, oldPath, ...params }: Params): Promise<CommitFilePayload> {
    if (!filePath) throw new HttpError(400, 'Missing "path" parameter');
    const { cwd, info, from } = await this.commitContext(params);
    const file = { path: filePath, oldPath: oldPath || null };
    const diff = await fileDiff(cwd, from, info.sha, file, diffOptions(params));
    return { path: filePath, oldPath: oldPath || null, commit: info.sha, parent: info.parents[0] ?? null, diff };
  }

  async commitPatch(params: Params): Promise<{ filename: string; text: string }> {
    const { wt, cwd, info, from } = await this.commitContext(params);
    const text = await fullDiff(cwd, from, info.sha, diffOptions(params));
    const label = (wt.branch || wt.head.slice(0, 10)).replace(/[^\w.-]+/g, '_');
    return { filename: `${label}-${info.shortSha}.patch`, text };
  }
}
