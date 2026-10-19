'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { parse } from 'diff2html';
import { Diff2HtmlUI } from 'diff2html/lib/ui/js/diff2html-ui.js';
import { ColorSchemeType } from 'diff2html/lib/types.js';

import { firstChangedLine } from '@/lib/client/editor';

export type DiffFormat = 'side-by-side' | 'line-by-line';

const LARGE_DIFF_BYTES = 1_500_000;

/** Viewed marks, shown as the "Viewed" checkbox diff2html draws in each file header. */
export interface PaneReview {
  viewed: Set<string>;
  onToggle(path: string, viewed: boolean): void;
  /** Fold viewed files down to their header (the all-files view). */
  collapse: boolean;
}

interface Props {
  text: string | null;
  format: DiffFormat;
  loading: string | null;
  error: string | null;
  /** Shown in place of the diff, e.g. to explain why there is nothing to see. */
  notice?: ReactNode;
  review?: PaneReview | null;
  /** Link that opens a file of the worktree in an editor, or null when that is off. */
  openUrl?: ((path: string, line: number | null) => string | null) | null;
  /** The file a single-file diff shows, in case its header names it differently (quoted paths). */
  singlePath?: string | null;
}

/** Renders a unified diff with diff2html inside a scroll pane. */
export function DiffPane({ text, format, loading, error, notice = null, review = null, openUrl = null, singlePath = null }: Props) {
  const [forceLarge, setForceLarge] = useState(false);
  useEffect(() => setForceLarge(false), [text]);

  const isLarge = text !== null && text.length > LARGE_DIFF_BYTES && !forceLarge;
  const isEmpty = text !== null && text.trim() === '';

  return (
    <div className="render">
      {error && <div className="error">{error}</div>}
      {!error && loading && <div className="loading">{loading}</div>}
      {!error && !loading && notice && <div className="placeholder">{notice}</div>}
      {!error && !loading && !notice && text === null && <div className="placeholder">Nothing to show.</div>}
      {!error && !loading && !notice && isEmpty && (
        <div className="placeholder">No textual changes (binary file or identical content).</div>
      )}
      {!error && !loading && !notice && isLarge && (
        <div className="placeholder">
          This diff is large ({(text.length / 1024 / 1024).toFixed(1)} MB) and may take a while to render.
          <br />
          <button type="button" className="btn" onClick={() => setForceLarge(true)}>
            Render anyway
          </button>
        </div>
      )}
      {!error && !loading && !notice && text !== null && !isEmpty && !isLarge && (
        <Rendered text={text} format={format} review={review} openUrl={openUrl} singlePath={singlePath} />
      )}
    </div>
  );
}

interface RenderedProps {
  text: string;
  format: DiffFormat;
  review: PaneReview | null;
  openUrl: Props['openUrl'];
  singlePath: string | null;
}

function Rendered({ text, format, review, openUrl, singlePath }: RenderedProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState(0);
  const reviewRef = useRef(review);
  reviewRef.current = review;
  const openRef = useRef(openUrl);
  openRef.current = openUrl;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ui = new Diff2HtmlUI(el, text, {
      drawFileList: false,
      fileListToggle: false,
      // Our own viewed marks drive diff2html's "Viewed" checkbox (see below);
      // its built-in toggle keeps state of its own, so it stays off.
      fileContentToggle: false,
      matching: 'lines',
      outputFormat: format,
      highlight: true,
      synchronisedScroll: true,
      renderNothingWhenEmpty: false,
      colorScheme: ColorSchemeType.AUTO,
    });
    ui.draw();
    ui.highlightCode();

    // Tag each file with its path and first changed line, in render order.
    const parsed = parse(text);
    const wrappers = el.querySelectorAll<HTMLElement>('.d2h-file-wrapper');
    wrappers.forEach((wrapper, i) => {
      const file = parsed[i];
      if (!file) return;
      const deleted = file.isDeleted || file.newName === '/dev/null';
      const path = wrappers.length === 1 && singlePath ? singlePath : deleted ? file.oldName : file.newName;
      wrapper.dataset.file = path;
      if (deleted) wrapper.dataset.deleted = 'true';
      const line = firstChangedLine(file.blocks);
      if (line) wrapper.dataset.line = String(line);

      const toggle = wrapper.querySelector<HTMLLabelElement>('.d2h-file-collapse');
      toggle?.querySelector('input')?.addEventListener('change', (e) => {
        reviewRef.current?.onToggle(path, (e.target as HTMLInputElement).checked);
      });
      if (toggle && !deleted) {
        const link = document.createElement('a');
        link.className = 'd2h-open-editor';
        link.textContent = 'Open';
        toggle.before(link);
      }
    });
    setDrawn((n) => n + 1);

    // A click on a line number of the new side opens the file at that line.
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const wrapper = target.closest<HTMLElement>('.d2h-file-wrapper');
      const path = wrapper?.dataset.file;
      if (!wrapper || !path || wrapper.dataset.deleted || !openRef.current) return;
      let lineText: string | null = null;
      const lineByLine = target.closest('.line-num2');
      const sideCell = target.closest('.d2h-code-side-linenumber');
      if (lineByLine) lineText = lineByLine.textContent;
      else if (sideCell && sideCell.closest('.d2h-file-side-diff') === wrapper.querySelectorAll('.d2h-file-side-diff')[1]) {
        lineText = sideCell.textContent;
      }
      const line = Number(lineText?.trim());
      if (!line) return;
      const url = openRef.current(path, line);
      if (url) window.location.assign(url);
    };
    el.addEventListener('click', onClick);
    return () => {
      el.removeEventListener('click', onClick);
      el.replaceChildren();
    };
  }, [text, format, singlePath]);

  // Viewed marks and editor links change without redrawing the diff.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.classList.toggle('has-editor', Boolean(openUrl));
    for (const wrapper of el.querySelectorAll<HTMLElement>('.d2h-file-wrapper[data-file]')) {
      const path = wrapper.dataset.file as string;
      const viewed = review?.viewed.has(path) ?? false;
      wrapper.classList.toggle('is-viewed', viewed);
      wrapper.classList.toggle('is-collapsed', viewed && Boolean(review?.collapse));
      const toggle = wrapper.querySelector<HTMLElement>('.d2h-file-collapse');
      if (toggle) {
        toggle.style.display = review ? 'flex' : 'none';
        toggle.classList.toggle('d2h-selected', viewed);
        toggle.title = 'Mark this file as viewed (v)';
        const input = toggle.querySelector('input');
        if (input) input.checked = viewed;
      }
      const link = wrapper.querySelector<HTMLAnchorElement>('.d2h-open-editor');
      if (link) {
        const url = openUrl ? openUrl(path, Number(wrapper.dataset.line) || null) : null;
        link.hidden = !url;
        if (url) {
          link.href = url;
          link.title = `Open ${path} in the editor${wrapper.dataset.line ? ` at line ${wrapper.dataset.line}` : ''} (the worktree's copy)`;
        }
      }
    }
  }, [review, openUrl, drawn]);

  return <div ref={ref} />;
}
