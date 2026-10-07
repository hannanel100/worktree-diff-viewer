/* Worktree Diff - browser client. Vanilla JS, no build step. */
(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  const $ = (sel, root = document) => root.querySelector(sel);
  const role = (name, root = document) => root.querySelector(`[data-role="${name}"]`);

  /** Hyperscript-style element builder; children are nodes or strings (escaped). */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function fmtNum(n) {
    return n === null || n === undefined ? '–' : Number(n).toLocaleString();
  }

  function relTime(iso) {
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return '';
    const s = Math.round((Date.now() - t) / 1000);
    const units = [
      [60, 'second'], [60, 'minute'], [24, 'hour'], [7, 'day'], [4.345, 'week'], [12, 'month'], [Infinity, 'year'],
    ];
    let v = s;
    for (const [size, name] of units) {
      if (Math.abs(v) < size) {
        const r = Math.round(v);
        return `${r} ${name}${r === 1 ? '' : 's'} ago`;
      }
      v /= size;
    }
    return '';
  }

  async function api(route, params = {}) {
    const url = new URL(route, location.origin);
    for (const [k, v] of Object.entries(params)) {
      if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, v);
    }
    const res = await fetch(url);
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
    }
    if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
    return body;
  }

  /** Run async tasks with a concurrency cap; resolves when all settle. */
  async function pool(items, limit, worker) {
    const queue = items.slice();
    const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        try {
          await worker(item);
        } catch (err) {
          console.error(err);
        }
      }
    });
    await Promise.all(runners);
  }

  // ---------------------------------------------------------------------------
  // Routing (hash based):  #/overview?base=X   #/diff?worktree=P&base=X&file=F
  // ---------------------------------------------------------------------------

  function parseRoute() {
    const hash = location.hash.replace(/^#/, '') || '/overview';
    const [pathPart, queryPart = ''] = hash.split('?');
    const params = Object.fromEntries(new URLSearchParams(queryPart));
    const view = pathPart.replace(/^\/+/, '').split('/')[0] || 'overview';
    return { view, params };
  }

  function buildHash(view, params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    const q = qs.toString();
    return `#/${view}${q ? `?${q}` : ''}`;
  }

  function navigate(view, params, { replace = false } = {}) {
    const next = buildHash(view, params);
    if (replace) history.replaceState(null, '', next);
    else location.hash = next;
    if (replace) render();
  }

  // ---------------------------------------------------------------------------
  // Application state
  // ---------------------------------------------------------------------------

  const state = {
    repo: null, // /api/repo payload
    renderToken: 0, // invalidates in-flight renders when the route changes
    format: localStorage.getItem('wtdiff.format') || 'side-by-side',
    fileCache: new Map(), // `${worktree}\0${base}\0${path}` -> diff text
  };

  const main = $('#main');
  const baseInput = $('#base-input');
  const baseList = $('#base-list');

  function currentBase() {
    const { params } = parseRoute();
    return params.base || state.repo?.defaultBase || '';
  }

  function showError(err, where = main) {
    where.replaceChildren(h('div', { class: 'error' }, err?.message || String(err)));
  }

  // ---------------------------------------------------------------------------
  // Boot: load repository info and fill the base picker
  // ---------------------------------------------------------------------------

  async function loadRepo() {
    state.repo = await api('/api/repo');
    $('#repo-root').textContent = state.repo.repoRoot;
    $('#repo-root').title = `Repository root: ${state.repo.repoRoot}`;
  }

  /** The branch list can take a while on big repositories, so it fills in after first paint. */
  async function loadBranches({ refresh = false } = {}) {
    try {
      const branches = await api('/api/branches', refresh ? { refresh: 1 } : {});
      baseList.replaceChildren(
        ...branches.local.map((b) => h('option', { value: b.name }, `local · ${b.sha}`)),
        ...branches.remote.map((b) => h('option', { value: b.name }, `remote · ${b.sha}`)),
      );
    } catch (err) {
      console.error('branch list failed', err);
    }
  }

  $('#base-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const value = baseInput.value.trim();
    if (!value) return;
    const { view, params } = parseRoute();
    delete params.file;
    navigate(view, { ...params, base: value });
    baseInput.blur();
  });

  $('#refresh-btn').addEventListener('click', async () => {
    try {
      await loadRepo();
      state.fileCache.clear();
      render();
      loadBranches({ refresh: true });
    } catch (err) {
      showError(err);
    }
  });

  // ---------------------------------------------------------------------------
  // Overview
  // ---------------------------------------------------------------------------

  function worktreeLabel(wt) {
    if (wt.bare) return '(bare)';
    if (wt.branch) return wt.branch;
    return `detached @ ${wt.head.slice(0, 10)}`;
  }

  function displayPath(wt) {
    const root = state.repo.repoRoot.replace(/\/+$/, '');
    const p = wt.path;
    if (p === root) return '.';
    const prefix = `${root}/`;
    return p.toLowerCase().startsWith(prefix.toLowerCase()) ? p.slice(prefix.length) : p;
  }

  /** Tags describing whether the worktree's work is in the base. */
  function mergeTags(m) {
    // Drop skipped optional parts: replaceChildren(false) would print "false".
    return mergeTagParts(m).filter(Boolean);
  }

  function mergeTagParts(m) {
    if (!m) return [h('span', { class: 'muted' }, '–')];
    switch (m.state) {
      case 'same':
        return [h('span', { class: 'tag tag-main', title: 'The worktree is checked out at the base commit' }, 'same as base')];
      case 'merged':
        return [
          h('span', {
            class: 'tag tag-ok',
            title: m.via === 'squash'
              ? 'The branch’s changes are already in the base (squash or rebase merge)'
              : 'Every commit of this branch is reachable from the base',
          }, 'merged'),
          m.via === 'squash' && h('span', { class: 'muted small' }, ' squash'),
        ];
      case 'unmerged': {
        const tags = [h('span', { class: 'tag tag-main', title: m.conflicts?.length === 0 ? 'Merges cleanly into the base' : '' }, 'unmerged')];
        if (m.conflicts?.length) {
          tags.push(' ', h('span', { class: 'tag tag-warn', title: `Would conflict in:\n${m.conflicts.join('\n')}` }, `conflicts (${m.conflicts.length})`));
        }
        return tags;
      }
      default:
        return [h('span', { class: 'muted' }, '–')];
    }
  }

  function uncommittedTag(u) {
    if (!u) return h('span', { class: 'muted' }, '–');
    const total = u.changed + u.untracked;
    if (total === 0) return h('span', { class: 'tag tag-ok' }, 'clean');
    const parts = [];
    if (u.changed) parts.push(`${u.changed} changed`);
    if (u.untracked) parts.push(`${u.untracked} untracked`);
    return h('span', { class: 'tag tag-warn', title: 'Not part of the diff' }, parts.join(', '));
  }

  function renderOverview(base) {
    const tpl = $('#tpl-overview').content.cloneNode(true);
    const rowsEl = role('rows', tpl);
    role('subtitle', tpl).textContent = base
      ? `Each worktree's committed changes since it forked from ${base}.`
      : 'No base branch chosen.';
    document.title = `Worktrees · ${base || ''}`;

    const rows = new Map();
    for (const wt of state.repo.worktrees) {
      const tags = [
        wt.isCurrent && h('span', { class: 'tag tag-current', title: 'Where wtdiff was started' }, 'current'),
        wt.isMain && h('span', { class: 'tag tag-main' }, 'main worktree'),
        wt.detached && h('span', { class: 'tag tag-detached' }, 'detached'),
        wt.locked && h('span', { class: 'tag tag-locked' }, 'locked'),
        wt.prunable && h('span', { class: 'tag tag-warn' }, 'missing'),
      ];
      const disabled = wt.bare || wt.prunable || !base;
      const open = () => !disabled && navigate('diff', { worktree: wt.path, base });
      const tr = h(
        'tr',
        {
          class: [wt.isCurrent && 'is-current', disabled && 'is-disabled'].filter(Boolean).join(' '),
          onclick: open,
        },
        h('td', null, h('div', { class: 'branch' }, worktreeLabel(wt), ' ', ...tags)),
        h('td', { class: 'path', title: wt.path }, displayPath(wt)),
        h('td', { class: 'num', dataset: { col: 'ab' } }, h('span', { class: 'skeleton' })),
        h('td', { dataset: { col: 'merge' } }, h('span', { class: 'skeleton' })),
        h('td', { class: 'num', dataset: { col: 'files' } }, h('span', { class: 'skeleton' })),
        h('td', { class: 'num', dataset: { col: 'lines' } }, h('span', { class: 'skeleton' })),
        h('td', { dataset: { col: 'unc' } }, h('span', { class: 'skeleton' })),
        h('td', null, !disabled && h('a', { href: buildHash('diff', { worktree: wt.path, base }), onclick: (e) => e.stopPropagation() }, 'View diff')),
      );
      rowsEl.append(tr);
      rows.set(wt.path, tr);
    }
    main.replaceChildren(tpl);

    if (!base) return;
    const token = ++state.renderToken;
    const live = state.repo.worktrees.filter((w) => !w.bare && !w.prunable);

    // Uncommitted counts need a working-tree scan, which is the slowest git
    // call, so they load in their own lane and never hold up the diff numbers.
    pool(live, 2, async (wt) => {
      const cell = rows.get(wt.path).querySelector('[data-col="unc"]');
      try {
        const u = await api('/api/uncommitted', { worktree: wt.path });
        if (token !== state.renderToken) return;
        cell.replaceChildren(uncommittedTag(u));
      } catch (err) {
        if (token !== state.renderToken) return;
        cell.replaceChildren(h('span', { class: 'muted', title: err.message }, '–'));
      }
    });

    pool(live, 4, async (wt) => {
      const tr = rows.get(wt.path);
      const cell = (name) => tr.querySelector(`[data-col="${name}"]`);
      try {
        const s = await api('/api/summary', { worktree: wt.path, base });
        if (token !== state.renderToken) return;
        if (s.noCommonHistory) {
          cell('ab').replaceChildren(h('span', { class: 'tag tag-warn' }, 'no common history'));
          cell('merge').textContent = '–';
          cell('files').textContent = '–';
          cell('lines').textContent = '–';
        } else {
          cell('ab').replaceChildren(
            h('span', { class: 'ahead', title: 'commits ahead of base' }, fmtNum(s.ahead)),
            h('span', { class: 'muted' }, ' / '),
            h('span', { class: 'behind', title: 'commits behind base' }, fmtNum(s.behind)),
          );
          cell('merge').replaceChildren(...mergeTags(s.merge));
          cell('files').textContent = fmtNum(s.totals.files);
          cell('lines').replaceChildren(
            h('span', { class: 'plus' }, `+${fmtNum(s.totals.additions)}`),
            ' ',
            h('span', { class: 'minus' }, `−${fmtNum(s.totals.deletions)}`),
          );
        }
      } catch (err) {
        if (token !== state.renderToken) return;
        cell('ab').replaceChildren(h('span', { class: 'tag tag-warn', title: err.message }, 'error'));
        cell('merge').textContent = '';
        cell('files').textContent = '';
        cell('lines').replaceChildren(h('span', { class: 'muted', title: err.message }, err.message.slice(0, 60)));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Diff view
  // ---------------------------------------------------------------------------

  const LARGE_DIFF_BYTES = 1_500_000;

  function hasDiff2Html() {
    return typeof window.Diff2HtmlUI === 'function';
  }

  function renderPatch(target, diffText, { format }) {
    target.replaceChildren();
    if (!diffText.trim()) {
      target.append(h('div', { class: 'placeholder' }, 'No textual changes (binary file or identical content).'));
      return;
    }
    if (!hasDiff2Html()) {
      target.append(h('pre', { class: 'mono' }, diffText));
      return;
    }
    const ui = new window.Diff2HtmlUI(target, diffText, {
      drawFileList: false,
      fileListToggle: false,
      fileContentToggle: true,
      matching: 'lines',
      outputFormat: format,
      highlight: true,
      synchronisedScroll: true,
      renderNothingWhenEmpty: false,
      colorScheme: 'auto',
    });
    ui.draw();
    ui.highlightCode();
  }

  function guardedRender(target, diffText, opts) {
    if (diffText.length > LARGE_DIFF_BYTES) {
      const btn = h('button', { class: 'btn', onclick: () => renderPatch(target, diffText, opts) }, 'Render anyway');
      target.replaceChildren(
        h('div', { class: 'placeholder' },
          `This diff is large (${(diffText.length / 1024 / 1024).toFixed(1)} MB) and may take a while to render.`,
          h('br'),
          btn),
      );
      return;
    }
    renderPatch(target, diffText, opts);
  }

  function fileKey(wtPath, base, filePath) {
    return `${wtPath}\0${base}\0${filePath}`;
  }

  async function fetchFileDiff(wtPath, base, file) {
    const key = fileKey(wtPath, base, file.path);
    if (state.fileCache.has(key)) return state.fileCache.get(key);
    const res = await api('/api/file', { worktree: wtPath, base, path: file.path, oldPath: file.oldPath });
    state.fileCache.set(key, res.diff);
    return res.diff;
  }

  function splitPath(p) {
    const i = p.lastIndexOf('/');
    return i === -1 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)];
  }

  async function renderDiff(params) {
    const base = params.base || state.repo.defaultBase;
    const wtPath = params.worktree;
    if (!wtPath) return navigate('overview', { base }, { replace: true });

    const token = ++state.renderToken;
    main.replaceChildren(h('div', { class: 'loading' }, 'Loading diff…'));

    let data;
    try {
      data = await api('/api/diff', { worktree: wtPath, base });
    } catch (err) {
      if (token === state.renderToken) showError(err);
      return;
    }
    if (token !== state.renderToken) return;

    const tpl = $('#tpl-diff').content.cloneNode(true);
    const wt = data.worktree;
    const title = worktreeLabel(wt);
    document.title = `${title} vs ${base}`;
    role('title', tpl).textContent = title;
    role('path', tpl).textContent = wt.path;
    role('path', tpl).title = wt.path;

    // --- header meta ------------------------------------------------------
    const meta = role('meta', tpl);
    meta.append(h('span', null, 'base ', h('code', null, base), ' ', h('span', { class: 'muted mono' }, data.baseSha.slice(0, 10))));
    if (data.noCommonHistory) {
      meta.append(h('span', { class: 'tag tag-warn' }, 'no common history with base'));
    } else {
      meta.append(
        h('span', { title: 'Merge base: where the branch forked from the base' }, 'forked at ', h('code', null, data.mergeBase.slice(0, 10))),
        h('span', null, h('b', null, fmtNum(data.ahead)), ' commits ahead, ', h('b', null, fmtNum(data.behind)), ' behind'),
        h('span', null, h('b', null, fmtNum(data.totals.files)), ' files, ',
          h('span', { class: 'plus' }, `+${fmtNum(data.totals.additions)}`), ' ',
          h('span', { class: 'minus' }, `−${fmtNum(data.totals.deletions)}`)),
        h('span', null, ...mergeTags(data.merge)),
      );
    }
    const uncommittedSlot = h('span', { class: 'muted' }, 'checking working tree…');
    meta.append(uncommittedSlot);
    api('/api/uncommitted', { worktree: wtPath })
      .then((u) => {
        if (token !== state.renderToken) return;
        const total = u.changed + u.untracked;
        uncommittedSlot.replaceWith(
          total === 0
            ? h('span', { class: 'tag tag-ok', title: 'Nothing uncommitted in this worktree' }, 'working tree clean')
            : h('span', { class: 'tag tag-warn', title: 'Uncommitted changes are not part of this diff' },
                `${total} uncommitted ${total === 1 ? 'change' : 'changes'} not shown`),
        );
      })
      .catch(() => uncommittedSlot.remove());

    // --- commits ----------------------------------------------------------
    role('commit-count', tpl).textContent = `(${data.commits.length})`;
    const commitList = role('commit-list', tpl);
    role('commits', tpl).open = data.commits.length > 0 && data.commits.length <= 8;
    for (const c of data.commits) {
      commitList.append(
        h('li', { title: `${c.sha}\n${c.author} <${c.email}>\n${c.date}` },
          h('span', { class: 'sha' }, c.shortSha),
          h('span', { class: 'subject' }, c.subject),
          h('span', { class: 'who' }, `${c.author} · ${relTime(c.date)}`)),
      );
    }
    if (!data.commits.length) commitList.append(h('li', { class: 'muted' }, 'No commits beyond the base.'));

    // --- file list --------------------------------------------------------
    const fileList = role('file-list', tpl);
    const renderEl = role('render', tpl);
    const allFilesBox = role('all-files', tpl);
    const patchLink = role('patch-link', tpl);
    const patchUrl = new URL('/api/patch', location.origin);
    patchUrl.searchParams.set('worktree', wtPath);
    patchUrl.searchParams.set('base', base);
    patchLink.href = patchUrl.toString();

    const items = new Map();
    let activePath = params.file || null;
    if (activePath && !data.files.some((f) => f.path === activePath)) activePath = null;

    const selectFile = async (file, { updateHash = true } = {}) => {
      activePath = file.path;
      for (const [p, li] of items) li.classList.toggle('is-active', p === file.path);
      if (updateHash) history.replaceState(null, '', buildHash('diff', { worktree: wtPath, base, file: file.path }));
      if (allFilesBox.checked) {
        const header = [...renderEl.querySelectorAll('.d2h-file-name')].find((el) => el.textContent.trim().endsWith(file.path));
        header?.closest('.d2h-file-wrapper')?.scrollIntoView({ block: 'start' });
        return;
      }
      renderEl.replaceChildren(h('div', { class: 'loading' }, `Loading ${file.path}…`));
      const myToken = state.renderToken;
      try {
        const diff = await fetchFileDiff(wtPath, base, file);
        if (myToken !== state.renderToken || activePath !== file.path) return;
        guardedRender(renderEl, diff, { format: state.format });
      } catch (err) {
        if (myToken === state.renderToken) showError(err, renderEl);
      }
      prefetchAround(file);
    };

    // Warm the cache for the next few files so j/k navigation feels instant.
    const prefetchAround = (file) => {
      const idx = data.files.indexOf(file);
      const next = data.files.slice(idx + 1, idx + 4);
      pool(next, 1, (f) => (state.renderToken === token ? fetchFileDiff(wtPath, base, f) : null));
    };

    for (const f of data.files) {
      const [dir, name] = splitPath(f.path);
      const li = h(
        'li',
        { title: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path, dataset: { path: f.path }, onclick: () => selectFile(f) },
        h('span', { class: `status status-${f.status}`, title: statusName(f.status) }, f.status),
        h('span', { class: 'name' }, h('span', null, h('span', { class: 'dir' }, dir), name)),
        h('span', { class: 'counts' },
          f.binary
            ? h('span', { class: 'muted' }, 'bin')
            : [h('span', { class: 'plus' }, `+${f.additions}`), ' ', h('span', { class: 'minus' }, `−${f.deletions}`)]),
      );
      fileList.append(li);
      items.set(f.path, li);
    }
    if (!data.files.length) {
      fileList.append(h('li', { class: 'empty' }, data.noCommonHistory ? 'Nothing to compare.' : 'No committed changes relative to the base.'));
    }

    // --- file filter ------------------------------------------------------
    role('file-filter', tpl).addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      for (const [p, li] of items) li.classList.toggle('is-hidden', q !== '' && !p.toLowerCase().includes(q));
    });

    // --- layout toggle ----------------------------------------------------
    const formatButtons = [...tpl.querySelectorAll('[data-format]')];
    const syncFormat = () => formatButtons.forEach((b) => b.classList.toggle('is-active', b.dataset.format === state.format));
    syncFormat();
    for (const b of formatButtons) {
      b.addEventListener('click', () => {
        state.format = b.dataset.format;
        localStorage.setItem('wtdiff.format', state.format);
        syncFormat();
        rerenderCurrent();
      });
    }

    // --- all-files mode ---------------------------------------------------
    const renderAll = async () => {
      renderEl.replaceChildren(h('div', { class: 'loading' }, 'Loading full patch…'));
      const myToken = state.renderToken;
      try {
        const res = await fetch(patchUrl);
        if (!res.ok) throw new Error((await res.json()).error || res.statusText);
        const text = await res.text();
        if (myToken !== state.renderToken) return;
        guardedRender(renderEl, text, { format: state.format });
        if (activePath) {
          const file = data.files.find((f) => f.path === activePath);
          if (file) selectFile(file, { updateHash: false });
        }
      } catch (err) {
        if (myToken === state.renderToken) showError(err, renderEl);
      }
    };
    const rerenderCurrent = () => {
      if (allFilesBox.checked) return renderAll();
      const file = data.files.find((f) => f.path === activePath);
      if (file) selectFile(file, { updateHash: false });
    };
    allFilesBox.addEventListener('change', rerenderCurrent);

    // --- keyboard navigation (j/k or arrows) ------------------------------
    const onKey = (e) => {
      if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
      const down = e.key === 'j' || e.key === 'ArrowDown';
      const up = e.key === 'k' || e.key === 'ArrowUp';
      if (!down && !up) return;
      const visible = data.files.filter((f) => !items.get(f.path).classList.contains('is-hidden'));
      if (!visible.length) return;
      const idx = visible.findIndex((f) => f.path === activePath);
      const next = visible[Math.min(visible.length - 1, Math.max(0, idx + (down ? 1 : -1)))];
      if (next && next.path !== activePath) {
        e.preventDefault();
        selectFile(next);
        items.get(next.path).scrollIntoView({ block: 'nearest' });
      }
    };
    document.addEventListener('keydown', onKey);
    state.cleanup = () => document.removeEventListener('keydown', onKey);

    main.replaceChildren(tpl);

    const first = data.files.find((f) => f.path === activePath) || data.files[0];
    if (first) selectFile(first, { updateHash: Boolean(params.file) });
    else renderEl.replaceChildren(h('div', { class: 'placeholder' }, 'Nothing to show.'));
  }

  function statusName(s) {
    return { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed', U: 'unmerged' }[s] || s;
  }

  // ---------------------------------------------------------------------------
  // Render dispatcher
  // ---------------------------------------------------------------------------

  function render() {
    if (!state.repo) return;
    state.cleanup?.();
    state.cleanup = null;
    const { view, params } = parseRoute();
    const base = params.base || state.repo.defaultBase || '';
    baseInput.value = base;
    if (view === 'diff') renderDiff({ ...params, base });
    else renderOverview(base);
  }

  window.addEventListener('hashchange', render);

  loadRepo()
    .then(() => {
      render();
      loadBranches();
    })
    .catch((err) => showError(err));
})();
