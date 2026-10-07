# Worktree Diff Viewer

A local developer tool that gives an **overview** of every worktree of one git
repository and shows the **diff** each worktree's branch introduced against a
**base** branch of your choosing. Runs entirely on your machine: a Next.js app
served from a tiny CLI, bound to `127.0.0.1`, no account, no network.

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
- a file list with status (A/M/D/R), filter box, `j`/`k` keyboard navigation
- side-by-side or unified rendering with syntax highlighting (diff2html)
- "All files" mode, and a `.patch` download of the whole diff

The diff is always `merge-base(base, HEAD)..HEAD`, i.e. what the branch
changed since it diverged. Commits the base gained after the fork do not show
up as "changes" in the worktree.

## Install (local, from source)

Requires Node 20.9+ and git on `PATH`.

```bash
git clone <this repo> worktree-diff-viewer
cd worktree-diff-viewer
npm install
npm run build   # compiles the Next.js app into .next/
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

## Development

```bash
npm run dev          # Next.js dev server; inspects the current directory
WTDIFF_CWD=/path/to/repo npm run dev
npm test             # vitest: builds a throwaway repo with worktrees
npm run typecheck
npm run build
node bin/wtdiff.js --dev --cwd <some-repo>   # dev server through the CLI
```

Layout:

```
bin/wtdiff.js         CLI: argument parsing, boots Next in-process, opens the browser
bin/open.js           cross-platform "open URL in default browser"
lib/git.ts            git wrappers + parsers (worktree list, raw/numstat, status v2, merge-tree)
lib/repo-service.ts   RepoService: summary / diff / file / patch / merge status, caching
lib/context.ts        one RepoService per process, bound to WTDIFF_CWD
lib/api.ts            route-handler helper (JSON + error mapping)
lib/client/           browser helpers: fetch, URL builders, formatting, localStorage
app/api/*/route.ts    GET routes (thin wrappers over RepoService)
app/page.tsx          Overview screen       components/Overview.tsx, OverviewTable.tsx
app/diff/page.tsx     Diff screen           components/DiffView.tsx, DiffPane.tsx
components/           TopBar, RepoProvider (repo + branches context), Tags, ClientOnly
tests/                fixture builder + parser, service and route tests
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

## Sharing with the team via npm

The package ships the production build, so teammates need neither Next.js
knowledge nor a build step:

1. Pick the final name in `package.json`, e.g. `@webiks/worktree-diff-viewer`
   (scoped packages can be published privately or to a GitHub Packages /
   Verdaccio registry).
2. Bump the version and run `npm publish` (add `--access public` for a public
   scoped package, or configure `publishConfig.registry` for a private one).
   `prepublishOnly` builds and tests first, and `files` includes `.next/`
   while excluding its cache.
3. Teammates install with `npm i -g @webiks/worktree-diff-viewer` or run
   ad hoc with `npx @webiks/worktree-diff-viewer`.

Until then, `npm link` or `npm i -g /path/to/worktree-diff-viewer` works for
anyone with the source (after `npm run build`).

## License

MIT
