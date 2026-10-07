// Thin, injection-safe wrappers around the git CLI.
// Every call goes through execFile with an argument array (no shell), and every
// user-supplied ref is validated before it reaches git.
//
// Spawning git costs hundreds of milliseconds on some machines (Windows with
// antivirus in particular), so the helpers below try to answer each question
// with a single git process.

import { execFile } from 'node:child_process';
import path from 'node:path';

const MAX_BUFFER = 256 * 1024 * 1024; // diffs of large branches can be big

export class GitError extends Error {
  constructor(message, { code, stderr, args } = {}) {
    super(message);
    this.name = 'GitError';
    this.code = code;
    this.stderr = stderr;
    this.args = args;
  }
}

export function git(args, { cwd, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          if (allowFailure) return resolve({ ok: false, stdout, stderr, code: err.code });
          return reject(
            new GitError(`git ${args[0]} failed: ${(stderr || err.message).trim()}`, {
              code: err.code,
              stderr,
              args,
            }),
          );
        }
        resolve(allowFailure ? { ok: true, stdout, stderr, code: 0 } : stdout);
      },
    );
  });
}

/** Normalise a path the way `git worktree list` prints it (forward slashes). */
export function normalizePath(p) {
  let out = path.resolve(p).replace(/\\/g, '/');
  if (/^[a-z]:\//.test(out)) out = out[0].toUpperCase() + out.slice(1);
  return out;
}

export function samePath(a, b) {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

// ---------------------------------------------------------------------------
// Repository discovery
// ---------------------------------------------------------------------------

export async function discoverRepo(cwd) {
  const res = await git(['rev-parse', '--show-toplevel', '--git-common-dir'], {
    cwd,
    allowFailure: true,
  });
  if (!res.ok) {
    throw new GitError(`Not inside a git repository: ${cwd}`, { stderr: res.stderr });
  }
  const [toplevel, commonDirRaw] = res.stdout.split(/\r?\n/);
  const commonDir = path.isAbsolute(commonDirRaw)
    ? commonDirRaw
    : path.join(toplevel, commonDirRaw);
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

export function parseWorktreeList(porcelain) {
  const worktrees = [];
  let current = null;
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
  return worktrees.map((w, i) => ({ ...w, id: String(i), isMain: i === 0 }));
}

export async function listWorktrees(cwd) {
  const out = await git(['worktree', 'list', '--porcelain'], { cwd });
  return parseWorktreeList(out);
}

// ---------------------------------------------------------------------------
// Branches / refs
// ---------------------------------------------------------------------------

/** `refs/heads/x` -> `x`, `refs/remotes/origin/x` -> `origin/x`. */
export function shortRefName(refname) {
  if (refname.startsWith('refs/heads/')) return refname.slice('refs/heads/'.length);
  if (refname.startsWith('refs/remotes/')) return refname.slice('refs/remotes/'.length);
  if (refname.startsWith('refs/tags/')) return refname.slice('refs/tags/'.length);
  return refname;
}

export async function listBranches(cwd) {
  // %(refname:short) is avoided on purpose: git checks every name for
  // ambiguity, which takes seconds on repositories with thousands of refs.
  const format = ['%(refname)', '%(objectname:short)', '%(committerdate:iso-strict)', '%(symref)'].join('%09');
  const out = await git(
    ['for-each-ref', `--format=${format}`, '--sort=-committerdate', 'refs/heads', 'refs/remotes'],
    { cwd },
  );
  const local = [];
  const remote = [];
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
// escape is rejected up front. Real validation happens in resolveCommit().
const REF_RE = /^[^\s~^:?*[\\\x00-\x1f\x7f-][^\s~^:?*[\\\x00-\x1f\x7f]*$/;

export function isSafeRefSyntax(ref) {
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
export async function resolveRef(cwd, ref) {
  if (!isSafeRefSyntax(ref)) return null;
  const res = await git(['log', '-1', '--format=%H%x09%T', '--end-of-options', ref, '--'], {
    cwd,
    allowFailure: true,
  });
  if (!res.ok) return null;
  const [sha, tree] = res.stdout.trim().split('\t');
  return sha && tree ? { sha, tree } : null;
}

/**
 * Merge `head` into `base` in memory (git >= 2.38) and report the resulting
 * tree plus the files that would conflict. Writes only loose tree objects, no
 * refs and no working-tree changes. Returns null when git cannot do it.
 */
export async function mergeTree(cwd, baseSha, head) {
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
export async function guessDefaultBase(cwd) {
  const patterns = [
    'refs/remotes/origin/HEAD',
    ...DEFAULT_BASE_CANDIDATES.map((c) => `refs/heads/${c}`),
    ...DEFAULT_BASE_CANDIDATES.map((c) => `refs/remotes/origin/${c}`),
  ];
  const res = await git(['for-each-ref', '--format=%(refname)%09%(symref)', ...patterns], {
    cwd,
    allowFailure: true,
  });
  if (!res.ok) return null;
  const existing = new Set();
  let originHead = null;
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

export async function mergeBase(cwd, base, head = 'HEAD') {
  const res = await git(['merge-base', base, head], { cwd, allowFailure: true });
  return res.ok ? res.stdout.trim() : null;
}

/** Commits only on each side: { behind: on base only, ahead: on head only }. */
export async function aheadBehind(cwd, base, head = 'HEAD') {
  const res = await git(['rev-list', '--left-right', '--count', `${base}...${head}`], { cwd, allowFailure: true });
  if (!res.ok) return { ahead: null, behind: null };
  const [behind, ahead] = res.stdout.trim().split(/\s+/).map(Number);
  return { ahead, behind };
}

/** Parse `git diff --numstat -z -M` output into a map keyed by new path. */
export function parseNumstat(raw) {
  return parseNumstatTokens(raw.split('\0'), 0).byPath;
}

function parseNumstatTokens(tokens, start) {
  const byPath = new Map();
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
export function parseRawNumstat(raw) {
  const tokens = raw.split('\0');
  const files = [];
  let i = 0;
  while (i < tokens.length && tokens[i].startsWith(':')) {
    const header = tokens[i++];
    const status = header.slice(header.lastIndexOf(' ') + 1);
    const kind = status[0];
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

export function sumTotals(files) {
  return files.reduce(
    (acc, f) => ({
      files: acc.files + 1,
      additions: acc.additions + f.additions,
      deletions: acc.deletions + f.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 },
  );
}

export async function diffFiles(cwd, from, to = 'HEAD') {
  const out = await git(['diff', '--raw', '--numstat', '-z', '-M', from, to], { cwd });
  const files = parseRawNumstat(out);
  return { files, totals: sumTotals(files) };
}

export async function fileDiff(cwd, from, to, file, { context = 3 } = {}) {
  // :(literal) stops git from treating '*', '?' or '[' in file names as globs.
  const pathspec = [`:(literal)${file.path}`];
  if (file.oldPath) pathspec.push(`:(literal)${file.oldPath}`);
  return git(
    ['diff', '-M', `--unified=${context}`, '--no-color', '--no-ext-diff', from, to, '--', ...pathspec],
    { cwd },
  );
}

export async function fullDiff(cwd, from, to) {
  return git(['diff', '-M', '--no-color', '--no-ext-diff', from, to], { cwd });
}

export async function commitsBetween(cwd, base, head = 'HEAD') {
  const FIELD = '\x1f';
  const RECORD = '\x1e';
  const format = ['%H', '%h', '%an', '%ae', '%aI', '%s'].join(FIELD) + RECORD;
  const out = await git(['log', `--format=${format}`, '--no-decorate', `${base}..${head}`], { cwd });
  return out
    .split(RECORD)
    .map((r) => r.replace(/^\r?\n/, ''))
    .filter((r) => r.trim() !== '')
    .map((r) => {
      const [sha, shortSha, author, email, date, subject] = r.split(FIELD);
      return { sha, shortSha, author, email, date, subject };
    });
}

// ---------------------------------------------------------------------------
// Uncommitted changes (summary only - never folded into the diff)
// ---------------------------------------------------------------------------

export function parseStatusV2(raw) {
  const tokens = raw.split('\0');
  let changed = 0;
  let untracked = 0;
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry) continue;
    const kind = entry[0];
    if (kind === '1' || kind === 'u') changed++;
    else if (kind === '2') {
      changed++;
      i++; // rename entries carry the original path as the next token
    } else if (kind === '?') untracked++;
  }
  return { changed, untracked };
}

export async function uncommittedSummary(cwd) {
  // --untracked-files=normal reports an untracked directory as one entry,
  // which is what `git status` shows and is much faster on big trees.
  const out = await git(
    ['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--untracked-files=normal'],
    { cwd },
  );
  return parseStatusV2(out);
}
