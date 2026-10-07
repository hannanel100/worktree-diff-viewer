// Builds a throwaway repository with a main worktree and several branches in
// their own worktrees:
//
//   main:            c1 -> c2 (README) -> c3 (merge of merged-feature) -> c4 (squash of squashed)
//   feature:         forks at c1: f1 (modify, add, rename) -> f2 (binary + delete), plus uncommitted noise
//   merged-feature:  m1, merged into main with a merge commit
//   squashed:        s1, whose change main received as the fresh commit c4
//   conflict:        x1, edits the README line main changed in c2
//   orphan:          no shared history at all

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test Author',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();
}

export interface Fixture {
  root: string;
  mainDir: string;
  featureDir: string;
  mergedDir: string;
  squashedDir: string;
  conflictDir: string;
  orphanDir: string;
  shas: { c1: string; c2: string; f1: string; f2: string };
  cleanup(): void;
}

export function createFixture(): Fixture {
  // realpath expands Windows 8.3 short names (HANNAN~1) to what git prints.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wtdiff-fixture-')));
  const mainDir = path.join(root, 'repo');
  const featureDir = path.join(root, 'wt-feature');
  fs.mkdirSync(mainDir);

  const write = (dir: string, rel: string, content: string | Buffer) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  git(mainDir, 'init', '-q', '-b', 'main');
  git(mainDir, 'config', 'user.name', 'Test Author');
  git(mainDir, 'config', 'user.email', 'test@example.com');
  git(mainDir, 'config', 'core.autocrlf', 'false');

  // c1
  write(mainDir, 'README.md', '# Fixture\n\nHello.\n');
  write(mainDir, 'lib/a.js', 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
  write(mainDir, 'old-name.txt', 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\n');
  write(mainDir, 'assets/logo.bin', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 4, 5]));
  write(mainDir, 'gone.txt', 'to be deleted\n');
  git(mainDir, 'add', '-A');
  git(mainDir, 'commit', '-q', '-m', 'c1: initial');
  const c1 = git(mainDir, 'rev-parse', 'HEAD');

  // feature worktree forks here
  git(mainDir, 'worktree', 'add', '-q', '-b', 'feature', featureDir, 'main');

  // c2 on main (must NOT appear in the feature diff)
  write(mainDir, 'README.md', '# Fixture\n\nHello from main after the fork.\n');
  git(mainDir, 'add', '-A');
  git(mainDir, 'commit', '-q', '-m', 'c2: main moves on');
  const c2 = git(mainDir, 'rev-parse', 'HEAD');

  // f1 on feature: modify, add, rename
  write(featureDir, 'lib/a.js', 'export const a = 10;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\n');
  write(featureDir, 'lib/b.js', 'export const hello = () => "world";\n');
  fs.renameSync(path.join(featureDir, 'old-name.txt'), path.join(featureDir, 'new-name.txt'));
  git(featureDir, 'add', '-A');
  git(featureDir, 'commit', '-q', '-m', 'f1: modify, add, rename');
  const f1 = git(featureDir, 'rev-parse', 'HEAD');

  // f2 on feature: binary change + delete
  write(featureDir, 'assets/logo.bin', Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9]));
  fs.unlinkSync(path.join(featureDir, 'gone.txt'));
  git(featureDir, 'add', '-A');
  git(featureDir, 'commit', '-q', '-m', 'f2: binary and delete');
  const f2 = git(featureDir, 'rev-parse', 'HEAD');

  // uncommitted noise in the feature worktree
  write(featureDir, 'lib/b.js', 'export const hello = () => "world";\n// uncommitted edit\n');
  write(featureDir, 'scratch.txt', 'untracked\n');

  // merged by ancestry: main merged this branch with a merge commit
  const mergedDir = path.join(root, 'wt-merged');
  git(mainDir, 'worktree', 'add', '-q', '-b', 'merged-feature', mergedDir, c1);
  write(mergedDir, 'merged.txt', 'already merged\n');
  git(mergedDir, 'add', '-A');
  git(mergedDir, 'commit', '-q', '-m', 'm1: merged feature');
  git(mainDir, 'merge', '-q', '--no-ff', '-m', 'c3: merge merged-feature', 'merged-feature');

  // squash-merged: main got the same change as one fresh commit
  const squashedDir = path.join(root, 'wt-squashed');
  git(mainDir, 'worktree', 'add', '-q', '-b', 'squashed', squashedDir, c1);
  write(squashedDir, 'squash.txt', 'squashed content\n');
  git(squashedDir, 'add', '-A');
  git(squashedDir, 'commit', '-q', '-m', 's1: add squash.txt');
  write(mainDir, 'squash.txt', 'squashed content\n');
  git(mainDir, 'add', '-A');
  git(mainDir, 'commit', '-q', '-m', 'c4: squash merge of squashed');

  // conflicting: edits the README line that main changed in c2
  const conflictDir = path.join(root, 'wt-conflict');
  git(mainDir, 'worktree', 'add', '-q', '-b', 'conflict', conflictDir, c1);
  write(conflictDir, 'README.md', '# Fixture\n\nHello from conflict.\n');
  git(conflictDir, 'add', '-A');
  git(conflictDir, 'commit', '-q', '-m', 'x1: conflicting README');

  // an unrelated branch with no shared history
  const orphanDir = path.join(root, 'wt-orphan');
  git(mainDir, 'worktree', 'add', '-q', '--detach', orphanDir);
  git(orphanDir, 'checkout', '-q', '--orphan', 'orphan');
  git(orphanDir, 'rm', '-rfq', '.');
  write(orphanDir, 'alone.txt', 'no shared history\n');
  git(orphanDir, 'add', '-A');
  git(orphanDir, 'commit', '-q', '-m', 'o1: orphan');

  return {
    root,
    mainDir,
    featureDir,
    mergedDir,
    squashedDir,
    conflictDir,
    orphanDir,
    shas: { c1, c2, f1, f2 },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
