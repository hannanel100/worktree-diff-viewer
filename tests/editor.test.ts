import { parse } from 'diff2html';
import { describe, expect, test } from 'vitest';

import { editorUrl, firstChangedLine, joinPath, type EditorSetting } from '@/lib/client/editor';

const vscode: EditorSetting = { editor: 'vscode', template: '' };

describe('open in editor', () => {
  test('joinPath gives forward-slash absolute paths', () => {
    expect(joinPath('C:/repo/wt/', 'src/a.ts')).toBe('C:/repo/wt/src/a.ts');
    expect(joinPath('C:\\repo\\wt', 'src/a.ts')).toBe('C:/repo/wt/src/a.ts');
    expect(joinPath('/home/me/wt', null)).toBe('/home/me/wt');
  });

  test('editor URLs carry the path and line, with unsafe characters encoded', () => {
    expect(editorUrl(vscode, 'C:/repo/wt/src/a.ts', 12)).toBe('vscode://file/C:/repo/wt/src/a.ts:12');
    expect(editorUrl(vscode, '/home/me/wt/a.ts', 3)).toBe('vscode://file/home/me/wt/a.ts:3');
    expect(editorUrl(vscode, 'C:/repo/wt')).toBe('vscode://file/C:/repo/wt');
    expect(editorUrl(vscode, 'C:/my repo/#1?.ts', 1)).toBe('vscode://file/C:/my%20repo/%231%3F.ts:1');
    expect(editorUrl({ editor: 'cursor', template: '' }, 'C:/r/a.ts', 2)).toBe('cursor://file/C:/r/a.ts:2');
    expect(editorUrl({ editor: 'none', template: '' }, 'C:/r/a.ts', 2)).toBeNull();
  });

  test('a custom template fills {path} and {line}, and needs {path}', () => {
    const idea: EditorSetting = { editor: 'custom', template: 'idea://open?file={path}&line={line}' };
    expect(editorUrl(idea, 'C:/r/a b.ts', 7)).toBe('idea://open?file=C:/r/a%20b.ts&line=7');
    expect(editorUrl(idea, 'C:/r/a.ts')).toBe('idea://open?file=C:/r/a.ts&line=1');
    expect(editorUrl({ editor: 'custom', template: 'x://open' }, 'C:/r/a.ts', 1)).toBeNull();
  });

  test('firstChangedLine finds the first added line, or where the first removal was', () => {
    const lineOf = (diff: string) => firstChangedLine(parse(diff)[0].blocks);
    const head = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n';
    expect(lineOf(`${head}@@ -10,4 +10,4 @@\n ctx\n ctx\n-old\n+new\n`)).toBe(12);
    expect(lineOf(`${head}@@ -10,4 +10,3 @@\n ctx\n ctx\n-gone\n ctx\n`)).toBe(12);
    expect(lineOf(`${head}@@ -0,0 +1,2 @@\n+a\n+b\n`)).toBe(1);
    expect(lineOf(`${head}@@ -1,2 +0,0 @@\n-a\n-b\n`)).toBe(1);
    expect(firstChangedLine([])).toBeNull();
  });
});
