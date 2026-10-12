import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  countNewFile,
  describeUncommitted,
  isSafeRefSyntax,
  normalizePath,
  parseNumstat,
  parseRawNumstat,
  parseStatusV2,
  parseStatusV2Entries,
  parseWorktreeList,
  shortRefName,
  sumTotals,
  untrackedFileDiff,
} from '@/lib/git';

describe('git output parsers', () => {
  test('parseWorktreeList handles branches, detached heads, bare and flags', () => {
    const porcelain = [
      'worktree C:/repo',
      'HEAD aaaa',
      'branch refs/heads/main',
      '',
      'worktree C:/repo/.claude/worktrees/x',
      'HEAD bbbb',
      'detached',
      'locked',
      '',
      'worktree /srv/bare.git',
      'bare',
      '',
      'worktree C:/gone',
      'HEAD cccc',
      'branch refs/heads/old',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n');
    const list = parseWorktreeList(porcelain);
    expect(list).toHaveLength(4);
    expect(list[0]).toEqual({
      id: '0', isMain: true, path: normalizePath('C:/repo'), head: 'aaaa', branch: 'main',
      detached: false, bare: false, locked: false, prunable: false,
    });
    expect(list[1]).toMatchObject({ detached: true, locked: true, branch: null });
    expect(list[2].bare).toBe(true);
    expect(list[3].prunable).toBe(true);
  });

  test('parseRawNumstat joins raw status entries with numstat counts', () => {
    // Exactly what `git diff --raw --numstat -z -M` prints: raw entries, then numstat.
    const raw = [
      ':100644 100644 2559ac2 3645c83 M', 'assets/logo.bin',
      ':100644 000000 4202011 0000000 D', 'gone.txt',
      ':100644 100644 26b8d7a 572c7d5 M', 'lib/a.js',
      ':000000 100644 0000000 066f32c A', 'lib/b.js',
      ':100644 100644 f985857 f985857 R087', 'old-name.txt', 'new-name.txt',
      ':100644 100644 f985857 f985857 C100', 'src.txt', 'copy.txt',
      '-\t-\tassets/logo.bin',
      '0\t1\tgone.txt',
      '2\t1\tlib/a.js',
      '1\t0\tlib/b.js',
      '0\t0\t', 'old-name.txt', 'new-name.txt',
      '3\t0\t', 'src.txt', 'copy.txt',
      '',
    ].join('\0');
    const files = parseRawNumstat(raw);
    expect(files).toEqual([
      { status: 'M', similarity: null, path: 'assets/logo.bin', oldPath: null, additions: 0, deletions: 0, binary: true },
      { status: 'D', similarity: null, path: 'gone.txt', oldPath: null, additions: 0, deletions: 1, binary: false },
      { status: 'M', similarity: null, path: 'lib/a.js', oldPath: null, additions: 2, deletions: 1, binary: false },
      { status: 'A', similarity: null, path: 'lib/b.js', oldPath: null, additions: 1, deletions: 0, binary: false },
      { status: 'R', similarity: 87, path: 'new-name.txt', oldPath: 'old-name.txt', additions: 0, deletions: 0, binary: false },
      { status: 'C', similarity: 100, path: 'copy.txt', oldPath: 'src.txt', additions: 3, deletions: 0, binary: false },
    ]);
    expect(sumTotals(files)).toEqual({ files: 6, additions: 6, deletions: 2 });
    expect(parseRawNumstat('')).toEqual([]);
  });

  test('parseNumstat reads counts, binaries and rename entries', () => {
    const raw = ['2\t1\ta.js', '-\t-\tlogo.bin', '0\t0\t', 'old.txt', 'new.txt', ''].join('\0');
    const m = parseNumstat(raw);
    expect(m.get('a.js')).toEqual({ additions: 2, deletions: 1, binary: false });
    expect(m.get('logo.bin')).toEqual({ additions: 0, deletions: 0, binary: true });
    expect(m.get('new.txt')).toEqual({ additions: 0, deletions: 0, binary: false });
    expect(m.size).toBe(3);
  });

  test('parseStatusV2 counts tracked changes and untracked files', () => {
    const raw = [
      '1 .M N... 100644 100644 100644 abc def lib/b.js',
      '2 R. N... 100644 100644 100644 abc def R100 new.txt',
      'old.txt',
      'u UU N... 100644 100644 100644 100644 a b c conflict.txt',
      '? scratch.txt',
      '? other.txt',
      '! ignored.log',
      '',
    ].join('\0');
    expect(parseStatusV2(raw)).toEqual({ changed: 3, untracked: 2 });
  });

  test('parseStatusV2Entries keeps paths, renames and the index/worktree letters', () => {
    const raw = [
      '1 .M N... 100644 100644 100644 abc def lib/b.js',
      '1 A. N... 000000 100644 100644 000 def staged.txt',
      '1 MM N... 100644 100644 100644 abc def both.txt',
      '1 .D N... 100644 100644 000000 abc 000 gone with space.txt',
      '2 R. N... 100644 100644 100644 abc def R100 new.txt',
      'old.txt',
      'u UU N... 100644 100644 100644 100644 a b c conflict.txt',
      '? scratch.txt',
      '',
    ].join('\0');
    const entries = parseStatusV2Entries(raw);
    expect(entries.map((e) => [e.kind, e.x, e.y, e.path, e.oldPath])).toEqual([
      ['changed', '.', 'M', 'lib/b.js', null],
      ['changed', 'A', '.', 'staged.txt', null],
      ['changed', 'M', 'M', 'both.txt', null],
      ['changed', '.', 'D', 'gone with space.txt', null],
      ['renamed', 'R', '.', 'new.txt', 'old.txt'],
      ['unmerged', 'U', 'U', 'conflict.txt', null],
      ['untracked', '?', '?', 'scratch.txt', null],
    ]);
    expect(entries.map((e) => `${describeUncommitted(e).status}/${describeUncommitted(e).area}`)).toEqual([
      'M/unstaged', 'A/staged', 'M/both', 'D/unstaged', 'R/staged', 'U/conflict', 'A/untracked',
    ]);
  });

  test('untracked files get a synthetic new-file diff and line counts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtdiff-untracked-'));
    try {
      fs.writeFileSync(path.join(dir, 'two.txt'), 'one\ntwo\n');
      fs.writeFileSync(path.join(dir, 'noeol.txt'), 'only');
      fs.writeFileSync(path.join(dir, 'empty.txt'), '');
      fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([1, 0, 2, 3]));
      expect(untrackedFileDiff(dir, 'two.txt')).toBe(
        'diff --git a/two.txt b/two.txt\nnew file mode 100644\n--- /dev/null\n+++ b/two.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n',
      );
      expect(untrackedFileDiff(dir, 'noeol.txt')).toMatch(/@@ -0,0 \+1,1 @@\n\+only\n\\ No newline at end of file\n$/);
      expect(untrackedFileDiff(dir, 'empty.txt')).toBe('diff --git a/empty.txt b/empty.txt\nnew file mode 100644\n');
      expect(untrackedFileDiff(dir, 'bin.dat')).toMatch(/Binary files \/dev\/null and b\/bin\.dat differ/);
      expect(untrackedFileDiff(dir, 'missing.txt')).toBe('diff --git a/missing.txt b/missing.txt\nnew file mode 100644\n');
      expect(countNewFile(dir, 'two.txt')).toEqual({ additions: 2, deletions: 0, binary: false });
      expect(countNewFile(dir, 'noeol.txt')).toEqual({ additions: 1, deletions: 0, binary: false });
      expect(countNewFile(dir, 'bin.dat')).toEqual({ additions: 0, deletions: 0, binary: true });
      expect(countNewFile(dir, 'missing.txt')).toEqual({ additions: 0, deletions: 0, binary: false });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('shortRefName strips the ref namespace without asking git', () => {
    expect(shortRefName('refs/heads/main')).toBe('main');
    expect(shortRefName('refs/heads/feature/x-1')).toBe('feature/x-1');
    expect(shortRefName('refs/remotes/origin/dev')).toBe('origin/dev');
    expect(shortRefName('refs/tags/v1')).toBe('v1');
    expect(shortRefName('HEAD')).toBe('HEAD');
  });

  test('isSafeRefSyntax rejects option-looking and range-looking input', () => {
    for (const ok of ['main', 'origin/main', 'feature/x-1', 'v1.2.3', 'HEAD', 'abc123', 'a_b.c']) {
      expect(isSafeRefSyntax(ok), ok).toBe(true);
    }
    for (const bad of ['', '-x', '--output=f', 'main..dev', 'a b', 'x~1', 'x^', 'x:y', 'x?', 'x*', 'x[', 'x\\y', 'a.lock', 'a/', 'main@{1}', 'x\u0000y', 42, null]) {
      expect(isSafeRefSyntax(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
