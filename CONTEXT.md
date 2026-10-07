# Worktree Diff Viewer

A developer tool that gives an overview of every worktree of one git repository and shows what each worktree's branch changed relative to a base branch of the developer's choosing.

## Language

**Worktree**:
One checkout of the repository, as git lists it. The main checkout counts as a worktree too. The unit the overview lists.
_Avoid_: checkout, session folder, clone

**Base**:
The branch a worktree is compared against. Chosen by the developer, not fixed by the tool.
_Avoid_: target, parent, upstream, main

**Diff**:
The changes a worktree's branch introduced since it diverged from the base. Changes the base gained since the fork are not part of it.
_Avoid_: comparison, delta, changeset

**Overview**:
The screen that lists every worktree of the repository with a summary of each one's diff, and from which a single worktree's diff is opened.
_Avoid_: dashboard, list, home

**Uncommitted changes**:
Edits and new files sitting in a worktree's directory that are not yet part of any commit. Shown separately from the diff, never folded into it.
_Avoid_: dirty state, working-tree changes, local changes, unsaved work
