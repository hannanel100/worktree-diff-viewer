// Thin, injection-safe wrappers around the git CLI.
// Every call goes through execFile with an argument array (no shell), and every
// user-supplied ref is validated before it reaches git.
//
// Spawning git costs hundreds of milliseconds on some machines (Windows with
// antivirus in particular), so the helpers below try to answer each question
// with a single git process.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_BUFFER = 256 * 1024 * 1024; // diffs of large branches can be big

export interface Worktree {
  id: string;
  path: string;
  head: string;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
  isMain: boolean;
}

export interface BranchRef {
  name: string;
  ref: string;
  sha: string;
  date: string;
}

export interface Branches {
  local: BranchRef[];
  remote: BranchRef[];
}

export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X';

export interface ChangedFile {
  status: FileStatus;
  similarity: number | null;
  path: string;
  oldPath: string | null;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface Totals {
  files: number;
  additions: number;
  deletions: number;
}

export interface Commit {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  date: string;
  subject: string;
}

export interface CommitInfo extends Commit {
  /** Parent shas, first parent first; empty for a root commit. */
  parents: string[];
}

export interface UncommittedCounts {
  changed: number;
  untracked: number;
}

/** Where an uncommitted change sits: the index, the working tree, both, or neither (untracked). */
export type UncommittedArea = 'staged' | 'unstaged' | 'both' | 'untracked' | 'conflict';

export interface UncommittedFile extends ChangedFile {
  area: UncommittedArea;
}

export interface StatusEntry {
  kind: 'changed' | 'renamed' | 'unmerged' | 'untracked';
  /** Index (X) and working-tree (Y) status letters from `git status --porcelain=v2`; '.' = unchanged. */
  x: string;
  y: string;
  path: string;
  oldPath: string | null;
}

export interface ResolvedRef {
  sha: string;
  tree: string;
}

export interface MergeTreeResult {
  tree: string;
  conflicts: string[];
}

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | string | null;
}

export class GitError extends Error {
  code?: number | string | null;
  stderr?: string;
  args?: string[];

  constructor(message: string, extra: { code?: number | string | null; stderr?: string; args?: string[] } = {}) {
    super(message);
    this.name = 'GitError';
    this.code = extra.code;
    this.stderr = extra.stderr;
    this.args = extra.args;
  }
}

export function git(args: string[], opts: { cwd?: string; allowFailure: true }): Promise<GitResult>;
export function git(args: string[], opts?: { cwd?: string; allowFailure?: false }): Promise<string>;
export function git(
  args: string[],
  { cwd, allowFailure = false }: { cwd?: string; allowFailure?: boolean } = {},
): Promise<string | GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code ?? null;
          if (allowFailure) return resolve({ ok: false, stdout, stderr, code });
          return reject(
            new GitError(`git ${args[0]} failed: ${(stderr || err.message).trim()}`, { code, stderr, args }),
          );
        }
        resolve(allowFailure ? { ok: true, stdout, stderr, code: 0 } : stdout);
      },
    );
  });
}

/** Normalise a path the way `git worktree list` prints it (forward slashes). */
export function normalizePath(p: string): string {
  let out = path.resolve(p).replace(/\\/g, '/');
  if (/^[a-z]:\//.test(out)) out = out[0].toUpperCase() + out.slice(1);
  return out;
}

export function samePath(a: string, b: string): boolean {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

// ---------------------------------------------------------------------------
// Repository discovery
// ---------------------------------------------------------------------------

export interface RepoInfo {
  currentWorktree: string;
  commonDir: string;
  repoRoot: string;
}

export async function discoverRepo(cwd: string): Promise<RepoInfo> {
  const res = await git(['rev-parse', '--show-toplevel', '--git-common-dir'], { cwd, allowFailure: true });
  if (!res.ok) {
    throw new GitError(`Not inside a git repository: ${cwd}`, { stderr: res.stderr });
  }
  const [toplevel, commonDirRaw] = res.stdout.split(/\r?\n/);
  const commonDir = path.isAbsolute(commonDirRaw) ? commonDirRaw : path.join(toplevel, commonDirRaw);
  return {
    currentWorktree: normalizePath(toplevel),
    commonDir: normalizePath(commonDir),
    // The main worktree is the parent of the common .git directory (unless bare).
    repoRoot: normalizePath(path.dirname(commonDir)),
  };
}

// ---------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------

export function parseWorktreeList(porcelain: string): Worktree[] {
  type Partial = Omit<Worktree, 'id' | 'isMain' | 'path' | 'head'> & { path: string | null; head: string | null };
  const worktrees: Partial[] = [];
  let current: Partial | null = null;
  for (const rawLine of porcelain.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line === '') {
      if (current) worktrees.push(current);
      current = null;
      continue;
    }
    if (!current) {
      current = { path: null, head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
    }
    if (line.startsWith('worktree ')) current.path = normalizePath(line.slice('worktree '.length));
    else if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length);
    else if (line.startsWith('branch ')) current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    else if (line === 'detached') current.detached = true;
    else if (line === 'bare') current.bare = true;
    else if (line.startsWith('locked')) current.locked = true;
    else if (line.startsWith('prunable')) current.prunable = true;
  }
  if (current) worktrees.push(current);
  return worktrees.map((w, i) => ({ ...w, path: w.path ?? '', head: w.head ?? '', id: String(i), isMain: i === 0 }));
}

export async function listWorktrees(cwd: string): Promise<Worktree[]> {
  const out = await git(['worktree', 'list', '--porcelain'], { cwd });
  return parseWorktreeList(out);
}

// ---------------------------------------------------------------------------
// Branches / refs
// ---------------------------------------------------------------------------

/** `refs/heads/x` -> `x`, `refs/remotes/origin/x` -> `origin/x`. */
export function shortRefName(refname: string): string {
  if (refname.startsWith('refs/heads/')) return refname.slice('refs/heads/'.length);
  if (refname.startsWith('refs/remotes/')) return refname.slice('refs/remotes/'.length);
  if (refname.startsWith('refs/tags/')) return refname.slice('refs/tags/'.length);
  return refname;
}

export async function listBranches(cwd: string): Promise<Branches> {
  // %(refname:short) is avoided on purpose: git checks every name for
  // ambiguity, which takes seconds on repositories with thousands of refs.
  const format = ['%(refname)', '%(objectname:short)', '%(committerdate:iso-strict)', '%(symref)'].join('%09');
  const out = await git(
    ['for-each-ref', `--format=${format}`, '--sort=-committerdate', 'refs/heads', 'refs/remotes'],
    { cwd },
  );
  const local: BranchRef[] = [];
  const remote: BranchRef[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue;
    const [refname, sha, date, symref] = line.split('\t');
    if (symref) continue; // e.g. refs/remotes/origin/HEAD is only an alias
    const entry = { name: shortRefName(refname), ref: refname, sha, date };
    if (refname.startsWith('refs/heads/')) local.push(entry);
    else remote.push(entry);
  }
  return { local, remote };
}

// Anything that could be read as a git option, a revision range or a path
// escape is rejected up front. Real validation happens in resolveRef().
const REF_RE = /^[^\s~^:?*[\\\x00-\x1f\x7f-][^\s~^:?*[\\\x00-\x1f\x7f]*$/;

export function isSafeRefSyntax(ref: unknown): ref is string {
  return (
    typeof ref === 'string' &&
    ref.length > 0 &&
    ref.length < 512 &&
    REF_RE.test(ref) &&
    !ref.includes('..') &&
    !ref.includes('@{') &&
    !ref.endsWith('.lock') &&
    !ref.endsWith('/')
  );
}

/** Resolve a ref to its commit sha and tree sha in one call, or null if unknown. */
export async function resolveRef(cwd: string, ref: string): Promise<ResolvedRef | null> {
  if (!isSafeRefSyntax(ref)) return null;
  const res = await git(['log', '-1', '--format=%H%x09%T', '--end-of-options', ref, '--'], { cwd, allowFailure: true });
  if (!res.ok) return null;
  const [sha, tree] = res.stdout.trim().split('\t');
  return sha && tree ? { sha, tree } : null;
}

/**
 * Merge `head` into `base` in memory (git >= 2.38) and report the resulting
 * tree plus the files that would conflict. Writes only loose tree objects, no
 * refs and no working-tree changes. Returns null when git cannot do it.
 */
export async function mergeTree(cwd: string, baseSha: string, head: string): Promise<MergeTreeResult | null> {
  const res = await git(
    ['merge-tree', '--write-tree', '--no-messages', '--name-only', '-z', baseSha, head],
    { cwd, allowFailure: true },
  );
  if (!res.ok && res.code !== 1) return null; // exit 1 = conflicts, anything else = unsupported/failed
  const parts = res.stdout
    .split('\0')
    .map((p) => p.replace(/\r?\n$/, ''))
    .filter((p) => p !== '');
  const tree = parts[0];
  if (!/^[0-9a-f]{40,64}$/.test(tree || '')) return null;
  return { tree, conflicts: res.code === 1 ? parts.slice(1) : [] };
}

const DEFAULT_BASE_CANDIDATES = ['main', 'master', 'develop', 'dev', 'trunk'];

/**
 * Pick a sensible default base with a single git call: what origin/HEAD points
 * to if that branch exists locally (else its remote-tracking ref), otherwise
 * the first conventional name that exists.
 */
export async function guessDefaultBase(cwd: string): Promise<string | null> {
  const patterns = [
    'refs/remotes/origin/HEAD',
    ...DEFAULT_BASE_CANDIDATES.map((c) => `refs/heads/${c}`),
    ...DEFAULT_BASE_CANDIDATES.map((c) => `refs/remotes/origin/${c}`),
  ];
  const res = await git(['for-each-ref', '--format=%(refname)%09%(symref)', ...patterns], { cwd, allowFailure: true });
  if (!res.ok) return null;
  const existing = new Set<string>();
  let originHead: string | null = null;
  for (const line of res.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const [refname, symref] = line.split('\t');
    if (refname === 'refs/remotes/origin/HEAD') originHead = symref || null;
    else existing.add(refname);
  }
  if (originHead) {
    const name = shortRefName(originHead).replace(/^origin\//, '');
    if (existing.has(`refs/heads/${name}`)) return name;
    return shortRefName(originHead);
  }
  for (const cand of DEFAULT_BASE_CANDIDATES) {
    if (existing.has(`refs/heads/${cand}`)) return cand;
  }
  for (const cand of DEFAULT_BASE_CANDIDATES) {
    if (existing.has(`refs/remotes/origin/${cand}`)) return `origin/${cand}`;
  }
  // Nothing conventional: fall back to the most recently committed local branch.
  const any = await git(
    ['for-each-ref', '--format=%(refname)', '--sort=-committerdate', '--count=1', 'refs/heads'],
    { cwd, allowFailure: true },
  );
  const first = any.ok ? any.stdout.trim() : '';
  return first ? shortRefName(first) : null;
}

// ---------------------------------------------------------------------------
// Diff of a worktree's branch against a base
// ---------------------------------------------------------------------------

export async function mergeBase(cwd: string, base: string, head = 'HEAD'): Promise<string | null> {
  const res = await git(['merge-base', base, head], { cwd, allowFailure: true });
  return res.ok ? res.stdout.trim() : null;
}

/** Commits only on each side: { behind: on base only, ahead: on head only }. */
export async function aheadBehind(
  cwd: string,
  base: string,
  head = 'HEAD',
): Promise<{ ahead: number | null; behind: number | null }> {
  // The trailing `--` stops git from also trying the range as a path name.
  const res = await git(['rev-list', '--left-right', '--count', `${base}...${head}`, '--'], { cwd, allowFailure: true });
  if (!res.ok) return { ahead: null, behind: null };
  const [behind, ahead] = res.stdout.trim().split(/\s+/).map(Number);
  return { ahead, behind };
}

interface NumstatEntry {
  additions: number;
  deletions: number;
  binary: boolean;
}

/** Parse `git diff --numstat -z -M` output into a map keyed by new path. */
export function parseNumstat(raw: string): Map<string, NumstatEntry> {
  return parseNumstatTokens(raw.split('\0'), 0).byPath;
}

function parseNumstatTokens(tokens: string[], start: number): { byPath: Map<string, NumstatEntry>; next: number } {
  const byPath = new Map<string, NumstatEntry>();
  let i = start;
  while (i < tokens.length) {
    const tok = tokens[i++];
    if (!tok) continue;
    const [a, d, inlinePath] = tok.split('\t');
    const binary = a === '-' && d === '-';
    const additions = binary ? 0 : Number(a);
    const deletions = binary ? 0 : Number(d);
    if (inlinePath !== undefined && inlinePath !== '') {
      byPath.set(inlinePath, { additions, deletions, binary });
    } else {
      // rename/copy: the two paths follow as separate NUL-terminated tokens
      i++; // old path
      const newPath = tokens[i++];
      byPath.set(newPath, { additions, deletions, binary });
    }
  }
  return { byPath, next: i };
}

/**
 * Parse the output of `git diff --raw --numstat -z -M`: raw entries
 * (`:mode mode sha sha STATUS\0path\0`, renames carry two paths) followed by
 * numstat entries. One git process gives us status, paths and line counts.
 */
export function parseRawNumstat(raw: string): ChangedFile[] {
  const tokens = raw.split('\0');
  const files: Omit<ChangedFile, 'additions' | 'deletions' | 'binary'>[] = [];
  let i = 0;
  while (i < tokens.length && tokens[i].startsWith(':')) {
    const header = tokens[i++];
    const status = header.slice(header.lastIndexOf(' ') + 1);
    const kind = status[0] as FileStatus;
    if (kind === 'R' || kind === 'C') {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      files.push({ status: kind, similarity: Number(status.slice(1)) || null, path: newPath, oldPath });
    } else {
      files.push({ status: kind, similarity: null, path: tokens[i++], oldPath: null });
    }
  }
  const { byPath } = parseNumstatTokens(tokens, i);
  return files.map((f) => ({ ...f, ...(byPath.get(f.path) ?? { additions: 0, deletions: 0, binary: false }) }));
}

export function sumTotals(files: ChangedFile[]): Totals {
  return files.reduce(
    (acc, f) => ({
      files: acc.files + 1,
      additions: acc.additions + f.additions,
      deletions: acc.deletions + f.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 },
  );
}

export async function diffFiles(cwd: string, from: string, to = 'HEAD'): Promise<{ files: ChangedFile[]; totals: Totals }> {
  const out = await git(['diff', '--raw', '--numstat', '-z', '-M', from, to], { cwd });
  const files = parseRawNumstat(out);
  return { files, totals: sumTotals(files) };
}

/** How a diff is printed: lines of context around each change, and whether whitespace changes count. */
export interface DiffOptions {
  context?: number;
  ignoreWhitespace?: boolean;
}

function diffOptionArgs({ context = 3, ignoreWhitespace = false }: DiffOptions = {}): string[] {
  return [`--unified=${context}`, ...(ignoreWhitespace ? ['--ignore-all-space'] : [])];
}

export async function fileDiff(
  cwd: string,
  from: string,
  to: string,
  file: { path: string; oldPath: string | null },
  options: DiffOptions = {},
): Promise<string> {
  // :(literal) stops git from treating '*', '?' or '[' in file names as globs.
  const pathspec = [`:(literal)${file.path}`];
  if (file.oldPath) pathspec.push(`:(literal)${file.oldPath}`);
  return git(
    ['diff', '-M', ...diffOptionArgs(options), '--no-color', '--no-ext-diff', from, to, '--', ...pathspec],
    { cwd },
  );
}

export async function fullDiff(cwd: string, from: string, to: string, options: DiffOptions = {}): Promise<string> {
  return git(['diff', '-M', ...diffOptionArgs(options), '--no-color', '--no-ext-diff', from, to], { cwd });
}

// Commit records: fields separated by ASCII "unit separator", records by
// "record separator", so subjects can contain anything printable.
const FIELD = '\x1f';
const RECORD = '\x1e';
const COMMIT_FORMAT = ['%H', '%h', '%an', '%ae', '%aI', '%s'].join(FIELD);

function parseCommit(record: string): Commit {
  const [sha, shortSha, author, email, date, subject] = record.split(FIELD);
  return { sha, shortSha, author, email, date, subject };
}

export async function commitsBetween(cwd: string, base: string, head = 'HEAD'): Promise<Commit[]> {
  const out = await git(['log', `--format=${COMMIT_FORMAT}${RECORD}`, '--no-decorate', `${base}..${head}`], { cwd });
  return out
    .split(RECORD)
    .map((r) => r.replace(/^\r?\n/, ''))
    .filter((r) => r.trim() !== '')
    .map(parseCommit);
}

/**
 * Metadata and parents of one commit in a single call, or null when the ref
 * is unknown or does not name a commit. Validated like resolveRef().
 */
export async function commitInfo(cwd: string, ref: string): Promise<CommitInfo | null> {
  if (!isSafeRefSyntax(ref)) return null;
  const res = await git(
    ['log', '-1', `--format=${COMMIT_FORMAT}${FIELD}%P`, '--no-decorate', '--end-of-options', ref, '--'],
    { cwd, allowFailure: true },
  );
  if (!res.ok) return null;
  const record = res.stdout.replace(/\r?\n$/, '');
  const fields = record.split(FIELD);
  if (fields.length < 7 || !fields[0]) return null;
  const parents = fields[6].split(' ').filter((p) => p !== '');
  return { ...parseCommit(record), parents };
}

/** git's empty tree in a SHA-1 repository: what a root commit is diffed against. */
export const EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** The empty tree's id in this repository (SHA-256 repositories hash it differently). */
export async function emptyTree(cwd: string): Promise<string> {
  const res = await git(['hash-object', '-t', 'tree', '/dev/null'], { cwd, allowFailure: true });
  const sha = res.ok ? res.stdout.trim() : '';
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : EMPTY_TREE_SHA1;
}

// ---------------------------------------------------------------------------
// Uncommitted changes (summary only - never folded into the diff)
// ---------------------------------------------------------------------------

/** Parse `git status --porcelain=v2 -z` into one entry per changed path. */
export function parseStatusV2Entries(raw: string): StatusEntry[] {
  const tokens = raw.split('\0');
  const out: StatusEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry) continue;
    const kind = entry[0];
    const parts = entry.split(' ');
    if (kind === '1') {
      // 1 XY sub mH mI mW hH hI path
      out.push({ kind: 'changed', x: parts[1][0], y: parts[1][1], path: parts.slice(8).join(' '), oldPath: null });
    } else if (kind === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path NUL origPath
      const oldPath = tokens[++i] ?? null;
      out.push({ kind: 'renamed', x: parts[1][0], y: parts[1][1], path: parts.slice(9).join(' '), oldPath });
    } else if (kind === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      out.push({ kind: 'unmerged', x: parts[1][0], y: parts[1][1], path: parts.slice(10).join(' '), oldPath: null });
    } else if (kind === '?') {
      out.push({ kind: 'untracked', x: '?', y: '?', path: entry.slice(2), oldPath: null });
    }
    // '!' (ignored) entries never appear: --ignored is not passed.
  }
  return out;
}

export function parseStatusV2(raw: string): UncommittedCounts {
  let changed = 0;
  let untracked = 0;
  for (const e of parseStatusV2Entries(raw)) {
    if (e.kind === 'untracked') untracked++;
    else changed++;
  }
  return { changed, untracked };
}

export async function uncommittedSummary(cwd: string): Promise<UncommittedCounts> {
  // --untracked-files=normal reports an untracked directory as one entry,
  // which is what `git status` shows and is much faster on big trees.
  const out = await git(
    ['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--untracked-files=normal'],
    { cwd },
  );
  return parseStatusV2(out);
}

/** Map a status entry to the badge letter and the area it lives in. */
export function describeUncommitted(e: StatusEntry): { status: FileStatus; area: UncommittedArea } {
  if (e.kind === 'untracked') return { status: 'A', area: 'untracked' };
  if (e.kind === 'unmerged') return { status: 'U', area: 'conflict' };
  const area: UncommittedArea = e.x !== '.' && e.y !== '.' ? 'both' : e.x !== '.' ? 'staged' : 'unstaged';
  const letters = e.x + e.y;
  const status: FileStatus =
    e.kind === 'renamed' ? 'R' : letters.includes('A') ? 'A' : letters.includes('D') ? 'D' : letters.includes('T') ? 'T' : 'M';
  return { status, area };
}

const BINARY_PROBE_BYTES = 8000;

function readNewFile(cwd: string, relPath: string): { mode: string; buf: Buffer } | null {
  const full = path.join(cwd, relPath);
  try {
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) return { mode: '120000', buf: Buffer.from(fs.readlinkSync(full), 'utf8') };
    if (!stat.isFile()) return null;
    return { mode: '100644', buf: fs.readFileSync(full) };
  } catch {
    return null;
  }
}

function splitLines(text: string): { lines: string[]; trailingNewline: boolean } {
  if (text === '') return { lines: [], trailingNewline: true };
  const trailingNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

/** Line counts for an untracked file, read straight from disk (HEAD has nothing to diff against). */
export function countNewFile(cwd: string, relPath: string): { additions: number; deletions: number; binary: boolean } {
  const file = readNewFile(cwd, relPath);
  if (!file) return { additions: 0, deletions: 0, binary: false };
  if (file.buf.subarray(0, BINARY_PROBE_BYTES).includes(0)) return { additions: 0, deletions: 0, binary: true };
  return { additions: splitLines(file.buf.toString('utf8')).lines.length, deletions: 0, binary: false };
}

/** Unified diff of an untracked file, in the shape `git diff` would print for a new file. */
export function untrackedFileDiff(cwd: string, relPath: string): string {
  const file = readNewFile(cwd, relPath);
  const head = `diff --git a/${relPath} b/${relPath}\nnew file mode ${file?.mode ?? '100644'}\n`;
  if (!file) return head;
  if (file.buf.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
    return `${head}Binary files /dev/null and b/${relPath} differ\n`;
  }
  const { lines, trailingNewline } = splitLines(file.buf.toString('utf8'));
  if (lines.length === 0) return head;
  let body = lines.map((l) => `+${l}`).join('\n') + '\n';
  if (!trailingNewline) body += '\\ No newline at end of file\n';
  return `${head}--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1,${lines.length} @@\n${body}`;
}

/** Every uncommitted change of a worktree (index + working tree vs HEAD, plus untracked files). */
export async function uncommittedFiles(cwd: string): Promise<{ files: UncommittedFile[]; totals: Totals }> {
  const [statusRaw, numstat] = await Promise.all([
    git(['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--untracked-files=all'], { cwd }),
    // HEAD may not exist yet in a brand-new repository; then there are no line counts.
    git(['diff', '--numstat', '-z', '-M', 'HEAD'], { cwd, allowFailure: true }),
  ]);
  const stats = numstat.ok ? parseNumstat(numstat.stdout) : new Map<string, NumstatEntry>();
  const files: UncommittedFile[] = parseStatusV2Entries(statusRaw).map((e) => {
    const { status, area } = describeUncommitted(e);
    const counts =
      area === 'untracked' ? countNewFile(cwd, e.path) : (stats.get(e.path) ?? { additions: 0, deletions: 0, binary: false });
    return { status, similarity: null, path: e.path, oldPath: e.oldPath, area, ...counts };
  });
  return { files, totals: sumTotals(files) };
}

export async function workingTreeFileDiff(
  cwd: string,
  file: { path: string; oldPath: string | null; area: UncommittedArea },
  options: DiffOptions = {},
): Promise<string> {
  // An untracked file is all new lines: neither context nor whitespace changes anything.
  if (file.area === 'untracked') return untrackedFileDiff(cwd, file.path);
  const pathspec = [`:(literal)${file.path}`];
  if (file.oldPath) pathspec.push(`:(literal)${file.oldPath}`);
  return git(
    ['diff', '-M', ...diffOptionArgs(options), '--no-color', '--no-ext-diff', 'HEAD', '--', ...pathspec],
    { cwd },
  );
}

export async function workingTreePatch(cwd: string, untrackedPaths: string[], options: DiffOptions = {}): Promise<string> {
  const tracked = await git(['diff', '-M', ...diffOptionArgs(options), '--no-color', '--no-ext-diff', 'HEAD'], {
    cwd,
    allowFailure: true,
  });
  return (tracked.ok ? tracked.stdout : '') + untrackedPaths.map((p) => untrackedFileDiff(cwd, p)).join('');
}
