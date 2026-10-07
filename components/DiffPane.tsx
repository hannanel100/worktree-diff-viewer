'use client';

import { useEffect, useRef, useState } from 'react';
import { Diff2HtmlUI } from 'diff2html/lib/ui/js/diff2html-ui.js';
import { ColorSchemeType } from 'diff2html/lib/types.js';

export type DiffFormat = 'side-by-side' | 'line-by-line';

const LARGE_DIFF_BYTES = 1_500_000;

interface Props {
  text: string | null;
  format: DiffFormat;
  loading: string | null;
  error: string | null;
}

/** Renders a unified diff with diff2html inside a scroll pane. */
export function DiffPane({ text, format, loading, error }: Props) {
  const [forceLarge, setForceLarge] = useState(false);
  useEffect(() => setForceLarge(false), [text]);

  const isLarge = text !== null && text.length > LARGE_DIFF_BYTES && !forceLarge;
  const isEmpty = text !== null && text.trim() === '';

  return (
    <div className="render">
      {error && <div className="error">{error}</div>}
      {!error && loading && <div className="loading">{loading}</div>}
      {!error && !loading && text === null && <div className="placeholder">Nothing to show.</div>}
      {!error && !loading && isEmpty && (
        <div className="placeholder">No textual changes (binary file or identical content).</div>
      )}
      {!error && !loading && isLarge && (
        <div className="placeholder">
          This diff is large ({(text.length / 1024 / 1024).toFixed(1)} MB) and may take a while to render.
          <br />
          <button type="button" className="btn" onClick={() => setForceLarge(true)}>
            Render anyway
          </button>
        </div>
      )}
      {!error && !loading && text !== null && !isEmpty && !isLarge && <Rendered text={text} format={format} />}
    </div>
  );
}

function Rendered({ text, format }: { text: string; format: DiffFormat }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ui = new Diff2HtmlUI(el, text, {
      drawFileList: false,
      fileListToggle: false,
      fileContentToggle: true,
      matching: 'lines',
      outputFormat: format,
      highlight: true,
      synchronisedScroll: true,
      renderNothingWhenEmpty: false,
      colorScheme: ColorSchemeType.AUTO,
    });
    ui.draw();
    ui.highlightCode();
    return () => {
      el.replaceChildren();
    };
  }, [text, format]);
  return <div ref={ref} />;
}
