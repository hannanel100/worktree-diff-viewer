# Worktree Diff Viewer

A local developer tool that gives an **overview** of every worktree of one git
repository and shows the **diff** each worktree's branch introduced against a
**base** branch of your choosing. Runs entirely on your machine: a tiny Node
server plus a browser UI, no account, no network.

```
$ wtdiff
Repository : C:/work/my-repo
Worktree   : C:/work/my-repo/.claude/worktrees/feature-x
Worktrees  : 7

Serving at http://127.0.0.1:4747/#/overview
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

**Diff** – click a row to open one worktree:

- the list of commits the branch has that the base lacks
- a file list with status (A/M/D/R), filter box, `j`/`k` keyboard navigation
- side-by-side or unified rendering with syntax highlighting (diff2html)
- "All files" mode, and a `.patch` download of the whole diff

The diff is always `merge-base(base, HEAD)..HEAD`, i.e. what the branch
changed since it diverged. Commits the base gained after the fork do not show
up as "changes" in the worktree.

## Install (v1, local)

Requires Node 18.17+ and git on `PATH`.

```bash
git clone <this repo> worktree-diff-viewer
cd worktree-diff-viewer
npm install
npm link        # makes the `wtdiff` command available globally
```

Or without linking:

```bash
node /path/to/worktree-diff-viewer/bin/wtdiff.js
```

## Usage

Run it from inside any worktree (or the main checkout) of the repository you
want to look at:

```bash
wtdiff                       # overview of all worktrees vs the default branch
wtdiff develop               # ... vs develop
wtdiff --here                # jump straight to this worktree's diff
wtdiff -b origin/main --here
wtdiff --port 5000 --no-open # pick a port, do not launch the browser
wtdiff --cwd ../other-repo   # run as if started from another directory
```

The default base is whatever `origin/HEAD` points to, falling back to
`main`, `master`, `develop`, `dev`, `trunk`. You can type any branch, tag or
commit sha into the **Base** box in the UI and press *Compare*.

Press `Ctrl+C` in the terminal to stop the server.

## Security notes

- The server binds to `127.0.0.1` only. Do not expose it; it reads your
  repository on request.
- All git invocations use argument arrays (no shell). Refs are validated
  syntactically and then resolved with `git rev-parse` before use; anything
  that looks like an option or a range is rejected.
- Worktree paths in requests must match an entry of `git worktree list`.
- Only `GET` is served. Nothing changes refs, the index or any working tree.
  The one write is `git merge-tree --write-tree` (used for the merge status),
  which stores small loose tree objects in `.git/objects`; git's normal
  garbage collection removes them.

## Development

```bash
npm test          # node:test suite; builds a throwaway repo with worktrees
npm start -- --no-open --cwd <some-repo>
```

Layout:

```
bin/wtdiff.js     CLI entry (argument parsing, startup banner, browser launch)
src/git.js        git wrappers + parsers (worktree list, name-status, numstat, status v2)
src/server.js     RepoService (summary / diff / file / patch) and the HTTP layer
src/open.js       cross-platform "open URL in default browser"
public/           static UI: index.html, app.js (hash router, views), style.css
test/             fixture builder + API and parser tests
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

The package is already shaped for publishing (`bin`, `files`, `engines`):

1. Pick the final name in `package.json`, e.g. `@webiks/worktree-diff-viewer`
   (scoped packages can be published privately or to a GitHub Packages /
   Verdaccio registry).
2. Bump the version, then `npm publish` (add `--access public` for a public
   scoped package, or configure `publishConfig.registry` for a private one).
3. Teammates install with `npm i -g @webiks/worktree-diff-viewer` or run
   ad hoc with `npx @webiks/worktree-diff-viewer`.

Until then, `npm link` or `npm i -g /path/to/worktree-diff-viewer` works for
anyone with the source.

## License

MIT
