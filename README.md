# herdr-plugin-worktree

A [herdr](https://herdr.dev) plugin covering the full worktree lifecycle
around GitHub work: **create** a worktree from a GitHub issue, a PR, or a
branch name, and **remove** the focused worktree when you're done — both
force-aware, so a dirty checkout never silently fails to delete.

## `create` — start work from an issue, PR, or branch

Starts work **from a GitHub issue, a PR, or a branch name** — all behind one
overlay. It **auto-detects** what you paste and picks the right strategy: an
**issue** gets a brand-new branch + worktree (with names drafted from the
issue content); a **PR** or a raw **branch name** has its existing **remote**
branch imported into a worktree. An agent is launched inside the checkout
either way.

### Why not `github-start`

[`ogulcancelik/herdr-plugin-github-start`](https://github.com/ogulcancelik/herdr-plugin-github-start)
creates a *tab* with a mechanical `gh-issue-614` label, never reads the issue
body, and never touches git worktrees. This plugin reads the issue, drafts
meaningful names from it, and creates an isolated worktree — so each issue
gets its own branch and checkout, ready for parallel agent work. It also
imports existing PR/remote branches, which `github-start` does not do.

### Input detection

The overlay accepts any of these and routes accordingly:

| Input | Detected as | What happens |
| --- | --- | --- |
| issue URL, `issue 614` | issue | new branch, claude-named (flow below) |
| PR URL, `pr 614` / `pull 614` | PR | import the PR's remote head branch |
| `#614` / `614` (bare number) | probed via `gh pr view` | PR if it's a PR, else issue |
| `feature/login`, `origin/feature/login` | branch | import that remote branch |

PR and branch imports use `git fetch` (PRs via `pull/<n>/head`, so fork PRs
work too without adding a remote), keep the **original branch name**, then
`herdr worktree open --branch <name>` checks it out into a worktree. An
existing local branch of the same name is reused, never clobbered.

### Issue flow

1. Paste an issue URL / `#614` / `issue 614` in the overlay, pick an agent.
2. `gh issue view` pulls the title, body, and labels.
3. `claude -p` drafts `{ branch, workspace }` from that content — e.g.
   `614-fix-login-redirect` + a short workspace label. Falls back to a
   deterministic `issue-<n>-<title-slug>` if `claude` is missing or the output
   can't be parsed (naming never blocks the flow).
4. `herdr worktree create --branch <branch> --label <workspace>` makes the
   worktree, **branched off the repo's default branch** (auto-detected — not
   whatever branch you happened to trigger from). This fires `worktree.created`,
   so a plugin like
   [`herdr-plugin-superset-bootstrap`](https://github.com/mkdir700/herdr-plugin-superset-bootstrap)
   can auto-run the repo's setup in the fresh checkout.
5. The chosen agent starts in the worktree's root pane, seeded with a prompt
   pointing at the issue.

### Naming

The "agent drafts the names" step is a single non-interactive `claude -p`
call, not a full interactive agent — names must be decided *before* the
worktree (the agent's working dir) exists. Tune or disable it in
`config.json`:

| Key | Effect |
| --- | ------ |
| `defaultAgent`    | `claude` or `codex` (the interactive agent started in the worktree) |
| `baseRef`         | branch off this ref; empty = auto-detect the repo default (`origin/HEAD`, else `main`/`master`/`develop`) |
| `namingModel`     | model for the naming call (empty = your `claude` default) |
| `promptTemplate`  | issue seed prompt; `{url}` `{title}` `{number}` `{branch}` `{workspace}` |
| `prPromptTemplate` | PR seed prompt (import flow); same placeholders |
| `branchPromptTemplate` | raw-branch seed prompt; `{branch}` `{workspace}` |

Config seeds from `config.example.json` on first run. Find it with:

```bash
herdr plugin config-dir worktree
```

## `remove` — force-aware delete of the focused worktree

herdr's built-in `remove_worktree` calls `herdr worktree remove` **without
`--force`**. A worktree with uncommitted/untracked changes (or git submodules)
is "dirty", so git refuses to delete it and herdr returns
`dirty_worktree_requires_force` — leaving the checkout **directory on disk**.
Because a worktree is the agent's working dir, it's almost always dirty, so
the built-in action looks like it does nothing.

Targets the **focused** workspace (resolved from `herdr workspace list`):

- **clean worktree** → removed immediately, headless, with a notification.
- **dirty worktree** → opens a confirmation overlay listing the
  uncommitted/untracked changes; force-removes (discarding them) only after
  you type `y`.
- **main checkout / non-worktree workspace** → just closes the workspace
  (same as herdr's built-in `close_workspace`), so a single "delete"
  keybinding behaves correctly whether you're in a worktree or a plain
  project.

No config for this action.

## Install

```bash
herdr plugin install mkdir700/herdr-plugin-worktree --yes
```

For local development, link a checkout instead:

```bash
herdr plugin link /path/to/herdr-plugin-worktree
```

## Keybinding

This plugin registers two actions (`create`, `remove`) plus their overlay
panes (`prompt`, `confirm`) — it doesn't ship keybindings. Bind them yourself
in the consumer's `config.toml`, e.g.:

```toml
[[keys.command]]
key = "prefix+shift+i"   # i = issue/import
type = "plugin_action"
command = "worktree.create"
description = "start worktree from github issue/PR"

[[keys.command]]
key = "prefix+shift+d"   # d = delete
type = "plugin_action"
command = "worktree.remove"
description = "remove focused worktree (force-aware) / close workspace"
```

`create` pairs well with the built-in `new_worktree` — same "g/i" worktree
family, but this one seeds the checkout from GitHub. `remove` is meant to
replace the built-in `remove_worktree` (and can subsume `close_workspace`,
since it falls back to closing non-worktree workspaces).

## Requirements

- herdr `>= 0.7.0`
- `gh` (authenticated)
- `git`
- `node` >= 18
- `claude` on `PATH` is optional — only used by `create` to draft names from
  the issue body; falls back to a deterministic title slug without it.
  PR/branch imports and `remove` don't use it at all.
