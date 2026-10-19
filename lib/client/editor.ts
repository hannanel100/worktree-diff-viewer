// "Open in editor" links. Editors register URL schemes (vscode://file/...),
// so a plain link opens a file at a line without the server doing anything:
// the server stays read-only. The editor is picked per browser.

import { useCallback, useEffect, useState } from 'react';

import { loadJson, saveJson } from './storage';

export type EditorId = 'vscode' | 'vscode-insiders' | 'cursor' | 'windsurf' | 'zed' | 'custom' | 'none';

export interface EditorSetting {
  editor: EditorId;
  /** For `custom`: a URL with {path} (absolute, forward slashes) and {line}. */
  template: string;
}

export const DEFAULT_EDITOR: EditorSetting = { editor: 'vscode', template: '' };

export const EDITORS: { id: EditorId; label: string }[] = [
  { id: 'vscode', label: 'VS Code' },
  { id: 'vscode-insiders', label: 'VS Code Insiders' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'windsurf', label: 'Windsurf' },
  { id: 'zed', label: 'Zed' },
  { id: 'custom', label: 'Custom URL…' },
  { id: 'none', label: 'No editor links' },
];

const SCHEMES: Partial<Record<EditorId, string>> = {
  vscode: 'vscode',
  'vscode-insiders': 'vscode-insiders',
  cursor: 'cursor',
  windsurf: 'windsurf',
  zed: 'zed',
};

const STORAGE_KEY = 'wtdiff.editor';

/** `root` + `rel` with forward slashes, the way git and the server print paths. */
export function joinPath(root: string, rel?: string | null): string {
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  return rel ? `${r}/${rel.replace(/^\/+/, '')}` : r;
}

/** Percent-encode each path segment; a Windows drive (`C:`) stays readable. */
function encodePath(p: string): string {
  return p
    .split('/')
    .map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join('/');
}

/**
 * Link that opens `absPath` (a file, or a folder when `line` is omitted) in
 * the chosen editor, or null when editor links are off.
 */
export function editorUrl(setting: EditorSetting, absPath: string, line?: number | null): string | null {
  const p = absPath.replace(/\\/g, '/');
  const at = line && line > 0 ? line : null;
  if (setting.editor === 'none') return null;
  if (setting.editor === 'custom') {
    if (!setting.template.includes('{path}')) return null;
    return setting.template.replaceAll('{path}', encodePath(p)).replaceAll('{line}', String(at ?? 1));
  }
  const scheme = SCHEMES[setting.editor];
  if (!scheme) return null;
  // vscode://file/C:/x/y.ts:12 on Windows, vscode://file/home/x/y.ts:12 elsewhere.
  return `${scheme}://file/${encodePath(p).replace(/^\/+/, '')}${at ? `:${at}` : ''}`;
}

export function editorLabel(setting: EditorSetting): string {
  return EDITORS.find((e) => e.id === setting.editor)?.label.replace('…', '') ?? 'editor';
}

/** The shape of a parsed diff hunk (diff2html's DiffBlock), as far as finding a line needs it. */
export interface HunkLike {
  newStartLine: number;
  lines: { type: string; newNumber?: number }[];
}

/**
 * Line of the new file where the first change is: the first added line, or
 * where the first removed line used to be. Null for a diff without hunks.
 */
export function firstChangedLine(blocks: HunkLike[]): number | null {
  for (const block of blocks) {
    let next = block.newStartLine;
    for (const l of block.lines) {
      if (l.type === 'insert') return l.newNumber ?? next;
      if (l.type === 'delete') return Math.max(1, next);
      if (l.newNumber !== undefined) next = l.newNumber + 1;
    }
  }
  return null;
}

export function loadEditor(): EditorSetting {
  const s = loadJson<EditorSetting>(STORAGE_KEY, DEFAULT_EDITOR);
  return EDITORS.some((e) => e.id === s.editor) ? s : DEFAULT_EDITOR;
}

/** The chosen editor; a change is remembered and reaches other tabs. */
export function useEditor(): [EditorSetting, (next: EditorSetting) => void] {
  const [setting, setSetting] = useState(loadEditor);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY || e.key === null) setSetting(loadEditor());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const update = useCallback((next: EditorSetting) => {
    saveJson(STORAGE_KEY, next);
    setSetting(next);
  }, []);
  return [setting, update];
}
