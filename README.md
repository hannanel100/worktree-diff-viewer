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
  are not part of any commit. They are never folded into the diff; the badge
  opens them on their own screen.

The table can be **sorted** by any column (click a header, shift-click for a
second sort key), **filtered** by branch or path text, by merge status and by
uncommitted state, and **rearranged** by dragging column headers or hiding
columns from the *Columns* menu. Sorting, order, visibility and filters are
remembered in the browser.

**Diff** – click a row to open one worktree:

- the list of commits the branch has that the base lacks
- a file list with status (A/M/D/R), filter box, `j`/`k` keyboard navigation,
  in a drawer you can collapse (toolbar button or `f`) to give the diff the
  whole width, and resize by dragging its edge (double-click the edge to fit
  the longest file name); `j`/`k` keep working while it is closed
- side-by-side or unified rendering with syntax highlighting (diff2html)
- **Ignore whitespace** (toolbar or `w`) hides changes that only add, remove
  or re-indent whitespace; a file whose only change is whitespace says so
  instead of showing an empty diff
- **Context**: 3, 10 or 25 unchanged lines around each change, or the whole
  file
- "All files" mode, and a `.patch` download of the whole diff

Whitespace and context apply to every screen (branch diff, single commit,
uncommitted changes) and to "All files". They are kept in the URL
(`&whitespace=ignore&context=all`), so a shared link shows the same view, and
the last choice is remembered in the browser for pages opened without them.
The `.patch` download is always the plain diff, so it applies cleanly.

The diff is always `merge-base(base, HEAD)..HEAD`, i.e. what the branch
changed since it diverged. Commits the base gained after the fork do not show
up as "changes" in the worktree.

**Per-commit view** – click a commit in the *Commits* panel to see only what
that commit changed (against its first parent; a merge commit is shown against
the branch it was merged into, a root commit as all-new files). The file list,
the diff pane, "All files" and the `.patch` download then cover just that
commit, and the header shows its sha, subject, author and age next to the
branch facts. The *Whole branch* entry at the top of the panel (or the link in
the header) returns to the full diff; `]` and `[` step down and up the list.
The URL carries the selection (`&commit=<sha>`), so it can be shared.

**Uncommitted changes** – the same screen for what sits in a worktree's
directory but not in any commit: index and working tree against `HEAD`, with
untracked files shown as new files. Each file is labelled staged, staged +
unstaged, untracked or conflict. Reachable from the Overview badge and from
the Diff header; a Refresh button re-reads the working tree.

**Mark files as viewed** – on every diff screen (branch diff, single commit,
uncommitted changes) each file has a *Viewed* checkbox, in the file list and
in the diff header. `v` marks the open file and moves on to the next file not
yet viewed (pressing it on a viewed file unmarks it). The toolbar shows
*N / M viewed*, viewed files are struck through in the list, and *Hide viewed*
leaves them out of it. In "All files" mode a viewed file folds down to its
header. Without a `file` in the URL, a screen reopens the file you had open
last.

A mark belongs to one worktree and to what it is compared with (the base, the
commit, or the uncommitted changes), and to the content the file had when you
marked it: once the file changes, it shows as not viewed again. For committed
diffs that content is the pair of blob ids `git diff --raw` reports; for
uncommitted files it is the `HEAD` blob plus the working-tree file's size and
modification time, which change whenever the file is saved. Marks are kept in
the browser (`localStorage`), pruned to the files still listed, and capped,
so old reviews drop out by themselves. The Overview's **Viewed** column shows
the progress of each branch diff against the current base, as long as the
diff has not changed since.

**Open in editor** – the header of each file in the diff has an *Open* link
that opens the worktree's copy of the file in your editor, at the first
changed line; clicking a line number on the new side opens it at that line,
and `o` opens the current file. *Open in …* next to the worktree path (and
*Open* on each Overview row) opens the whole worktree. Pick the editor in the
toolbar: VS Code, VS Code Insiders, Cursor, Windsurf, Zed, a custom URL such
as `idea://open?file={path}&line={line}`, or none. These are plain
`vscode://`-style links that your browser hands to the editor; the server
does not launch anything.

Keys on the diff screens: `j`/`k` (or arrows) next/previous file, `v` viewed,
`o` open in editor, `f` file list, `w` whitespace, `]`/`[` next/previous
commit.

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
lib/client/           browser helpers: fetch, URL builders, formatting, localStorage,
                      diff options, viewed marks (viewed.ts), editor links (editor.ts)
app/                  Next.js app: layout, pages, dev-only API routes, styles
components/           Overview, OverviewTable (TanStack), ChangeSetView (file drawer + diff pane) used by
                      DiffView (committed) and UncommittedView, DiffPane (diff2html), TopBar, ...
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
| `/api/diff`        | `worktree`, `base`                     | summary + commits + file list (with blob ids) |
| `/api/file`        | `worktree`, `base`, `path`, `oldPath?` | unified diff of one file                     |
| `/api/patch`       | `worktree`, `base`                     | whole diff as `text/x-patch` download        |
| `/api/commit`      | `worktree`, `commit`                   | one commit vs its first parent: metadata, parents, file list |
| `/api/commit-file` | `worktree`, `commit`, `path`, `oldPath?` | unified diff of one file in that commit    |
| `/api/commit-patch` | `worktree`, `commit`                  | that commit's diff as a `.patch`             |
| `/api/uncommitted-files` | `worktree`                       | uncommitted files with area and line counts  |
| `/api/uncommitted-file`  | `worktree`, `path`, `oldPath?`   | working-tree diff of one file vs `HEAD`      |
| `/api/uncommitted-patch` | `worktree`                       | all uncommitted changes as a `.patch`        |

Only paths that `git status` itself reports can be diffed on the uncommitted
screen; untracked files are read from disk to build a new-file diff, so no
other file in the worktree is ever readable through the API.

Every route that returns a diff or a patch (`file`, `patch`, `commit-file`,
`commit-patch`, `uncommitted-file`, `uncommitted-patch`) also takes
`context` (lines of context, a number or `all`; default 3) and
`whitespace=ignore` (`git diff --ignore-all-space`).

`worktree` is a path exactly as `git worktree list` prints it (or the row id
from `/api/repo`); `commit` is a full sha (any ref git resolves to a commit is
accepted). Spawning git is the dominant cost (hundreds of ms per process on
Windows), so the server caches the worktree list and resolved refs for a few
seconds and merge-bases and commit metadata for the life of the process, and
avoids `%(refname:short)`, which takes seconds on repositories with thousands
of refs.

## Roadmap

Ideas for later versions, roughly in order of usefulness:

- **Expand collapsed lines** between hunks on demand (the whole-file context
  covers most of it today).
- **Compare two worktrees directly**, not only worktree vs base branch.
- **Multiple repositories** in one overview (pass several `--cwd` roots).
- **Live refresh** – watch `.git` for new commits and update the overview.

## CI

`.github/workflows/ci.yml` runs on every push to `main` and every pull request:

- typecheck, tests and build on Ubuntu with Node 20, 22 and 24, and on Windows
  with Node 22 (where git is slowest);
- a smoke job that installs the `npm pack` tarball globally on Node 18.17 (the
  oldest version `engines` allows), starts `wtdiff` on this repository and
  checks that `/api/repo` and the UI answer. It catches a missing file in
  `files` or a server bundle that needs a newer Node.

## Publishing to npm

The package ships only `bin/`, `dist/server.mjs` and the static `out/`; it has
no runtime dependencies, so `npx` starts it in seconds.

Releases are published by `.github/workflows/release.yml` when a `v*` tag is
pushed:

1. Bump `version` in `package.json`, commit (`Release vX.Y.Z`) and tag it
   `vX.Y.Z`.
2. `git push origin main vX.Y.Z`. The workflow checks that the tag matches
   `package.json`, runs `npm publish` (`prepublishOnly` builds and tests
   first) and creates a GitHub release with generated notes.

Publishing uses npm [trusted publishing](https://docs.npmjs.com/trusted-publishers),
so there is no npm token in the repository. The package's settings on
npmjs.com need a GitHub Actions trusted publisher once: owner `hannanel100`,
repository `worktree-diff-viewer`, workflow `release.yml`. The published
version then carries a provenance attestation. Don't also run `npm publish`
locally for a tagged version, because npm refuses to publish the same version
twice.

Teammates install with `npm i -g @hannanel100/worktree-diff-viewer` or run
ad hoc with `npx @hannanel100/worktree-diff-viewer`.

Without a registry, `npm i -g git+ssh://git@github.com/<org>/worktree-diff-viewer.git`
also works if a `"prepare": "npm run build"` script is added, at the cost of
building on each teammate's machine.

## License

MIT
