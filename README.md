# Worktree Diff Viewer

A local developer tool that gives an **overview** of every worktree of one git
repository and shows the **diff** each worktree's branch introduced against a
**base** branch of your choosing. Runs entirely on your machine: a small Node
server bound to `127.0.0.1` serving a static React UI, no account, no network,
no runtime dependencies.

```
$ wtdiff
Repository : C:/work/my-repo
Worktree   : C:/work/my-repo
Worktrees  : 7
Base       : dev

Serving at http://127.0.0.1:4747/?base=dev
```

## What it shows

**Overview** – one row per worktree (the main checkout counts too):

- branch, or `detached @ sha`
- commits ahead of / behind the base
- merge status: **merged** (every commit is in the base, or the branch's
  changes are already there via a squash/rebase merge), **unmerged**, and for
  unmerged branches the files that would **conflict** with the base
- files changed and lines added/removed since the branch forked from the base
- a separate *uncommitted* badge: edits sitting in the worktree directory that
  are not part of any commit. They are never folded into the diff.

The table can be **sorted** by any column (click a header, shift-click for a
second sort key), **filtered** by branch or path text, by merge status and by
uncommitted state, and **rearranged** by dragging column headers or hiding
columns from the *Columns* menu. Sorting, order, visibility and filters are
remembered in the browser.

**Diff** – click a row to open one worktree:

- the list of commits the branch has that the base lacks
- a file list with status (A/M/D/R), filter box, `j`/`k` keyboard navigation,
  in a drawer you can collapse (toolbar button or `f`) to give the diff the
  whole width; `j`/`k` keep working while it is closed
- side-by-side or unified rendering with syntax highlighting (diff2html)
- "All files" mode, and a `.patch` download of the whole diff

The diff is always `merge-base(base, HEAD)..HEAD`, i.e. what the branch
changed since it diverged. Commits the base gained after the fork do not show
up as "changes" in the worktree.

## Install

Requires git on `PATH` and Node 18.17+ to run (20.9+ to develop).

From npm, once published (see below):

```bash
npm i -g @hannanel100/worktree-diff-viewer     # or: npx @hannanel100/worktree-diff-viewer
```

From source:

```bash
git clone <this repo> worktree-diff-viewer
cd worktree-diff-viewer
npm install
npm run build   # static UI export (out/) + bundled server (dist/server.mjs)
npm link        # makes the `wtdiff` command available globally
```

## Usage

Run it from the main checkout or from inside any worktree of the repository
you want to look at. Git's worktree list is shared, so every worktree shows up
either way.

```bash
wtdiff                       # overview of all worktrees vs the default branch
wtdiff develop               # ... vs develop
wtdiff --here                # jump straight to this worktree's diff
wtdiff -b origin/main --here
wtdiff --port 5000 --no-open # pick a port, do not launch the browser
wtdiff --cwd ../other-repo   # inspect a repository you are not inside of
```

The default base is whatever `origin/HEAD` points to, falling back to
`main`, `master`, `develop`, `dev`, `trunk`. You can type any branch, tag or
commit sha into the **Base** box in the UI and press *Compare*.

Press `Ctrl+C` in the terminal to stop the server.

## Security notes

- The server binds to `127.0.0.1` only. Do not expose it; it reads your
  repository on request.
- All git invocations use argument arrays (no shell). Refs are validated
  syntactically and then resolved with git before use; anything that looks
  like an option or a range is rejected.
- Worktree paths in requests must match an entry of `git worktree list`.
- Only `GET` is served. Nothing changes refs, the index or any working tree.
  The one write is `git merge-tree --write-tree` (used for the merge status),
  which stores small loose tree objects in `.git/objects`; git's normal
  garbage collection removes them.
- Static files are served only from the export directory; paths that escape
  it are refused.

## How it is put together

Next.js is the **development and build tool**, not a runtime dependency:

- `next dev` serves the React UI and mounts the API through
  `app/api/*/route.dev.ts` (the `.dev.ts` extension is only recognised in
  development, see `next.config.ts`).
- `next build` produces a **static export** of the UI in `out/`.
- `scripts/build-server.mjs` bundles `server/main.ts` and the `lib/` it
  imports with esbuild into a single dependency-free `dist/server.mjs`.
- `bin/wtdiff.js` starts that server, which answers `/api/*` through the very
  same handler functions `next dev` uses (`lib/handlers.ts`) and serves
  `out/` for everything else.

```bash
npm run dev          # Next.js dev server; inspects the current directory
WTDIFF_CWD=/path/to/repo npm run dev
node bin/wtdiff.js --dev --cwd <some-repo>   # same, through the CLI
npm test             # vitest: parsers, RepoService, handlers, production server
npm run typecheck
npm run build        # out/ + dist/server.mjs
```

Layout:

```
bin/wtdiff.js         CLI: arguments, starts dist/server.mjs (or `next dev`), opens the browser
bin/open.js           cross-platform "open URL in default browser"
server/main.ts        startServer(): repository check, listen with port fallback
server/http.ts        request listener: /api/* via shared handlers, static export otherwise
lib/handlers.ts       the API as (Request) => Response functions, one per route
lib/api.ts            jsonRoute() helper and error-to-status mapping
lib/git.ts            git wrappers + parsers (worktree list, raw/numstat, status v2, merge-tree)
lib/repo-service.ts   RepoService: summary / diff / file / patch / merge status, caching
lib/context.ts        one RepoService per process, bound to WTDIFF_CWD
lib/client/           browser helpers: fetch, URL builders, formatting, localStorage
app/                  Next.js app: layout, pages, dev-only API routes, styles
components/           Overview, OverviewTable (TanStack), DiffView, DiffPane, TopBar, ...
scripts/build-server.mjs   esbuild bundle of the server
tests/                fixture builder + parser, service, handler and server tests
```

API (all `GET`, JSON unless noted):

| Route              | Params                                 | Returns                                      |
| ------------------ | -------------------------------------- | -------------------------------------------- |
| `/api/repo`        | –                                      | worktrees, default base, repo root           |
| `/api/branches`    | `refresh?`                             | local and remote branches (cached 60 s)      |
| `/api/summary`     | `worktree`, `base`                     | ahead/behind, merge status, file/line totals |
| `/api/uncommitted` | `worktree`                             | counts of changed and untracked files        |
| `/api/diff`        | `worktree`, `base`                     | summary + commits + file list                |
| `/api/file`        | `worktree`, `base`, `path`, `oldPath?` | unified diff of one file                     |
| `/api/patch`       | `worktree`, `base`                     | whole diff as `text/x-patch` download        |

`worktree` is a path exactly as `git worktree list` prints it (or the row id
from `/api/repo`). Spawning git is the dominant cost (hundreds of ms per
process on Windows), so the server caches the worktree list and resolved refs
for a few seconds and merge-bases for the life of the process, and avoids
`%(refname:short)`, which takes seconds on repositories with thousands of
refs.

## Roadmap

Ideas for later versions, roughly in order of usefulness:

- **Uncommitted changes view** – show the content of a worktree's uncommitted
  edits on their own tab (still separate from the committed diff).
- **Per-commit view** – click a commit in the list to see only that commit.
- **Whitespace and context controls** – ignore whitespace, widen context,
  expand collapsed lines.
- **Review aids** – mark files as viewed, collapse viewed files, remember
  position per worktree/base.
- **Compare two worktrees directly**, not only worktree vs base branch.
- **Multiple repositories** in one overview (pass several `--cwd` roots).
- **Live refresh** – watch `.git` for new commits and update the overview.
- **Open in editor** links (`vscode://file/...`).

## Publishing to npm

The package ships only `bin/`, `dist/server.mjs` and the static `out/`; it has
no runtime dependencies, so `npx` starts it in seconds.

1. Pick the final name in `package.json`, e.g. `@hannanel100/worktree-diff-viewer`
   (scoped packages can be published privately, or to GitHub Packages /
   Verdaccio).
2. Bump the version and run `npm publish` (add `--access public` for a public
   scoped package, or set `publishConfig.registry` for a private one).
   `prepublishOnly` builds and tests first.
3. Teammates install with `npm i -g @hannanel100/worktree-diff-viewer` or run
   ad hoc with `npx @hannanel100/worktree-diff-viewer`.

Without a registry, `npm i -g git+ssh://git@github.com/<org>/worktree-diff-viewer.git`
also works if a `"prepare": "npm run build"` script is added, at the cost of
building on each teammate's machine.

## License

MIT
