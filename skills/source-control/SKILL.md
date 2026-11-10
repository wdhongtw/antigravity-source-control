---
name: source-control
description: >-
  Manage session Git repositories and worktrees, cite clickable logical diffs in
  chat and Markdown artifacts (`sidecar://source-control/git_ui/?...`), and
  inspect expanded diff context using the Source Control AuxPane UI and `git_*`
  MCP tools.
---

# Source Control & Logical Diff Inspector (`source-control`)

Use the `source-control` plugin's MCP tools (`git_register`, `git_unregister`,
`git_list`, `git_diff_context`) and AuxPane UI
(`sidecar://source-control/git_ui/`) to track session repositories/worktrees,
cite clickable logical diffs in conversations and Markdown artifacts, and
respond to inline diff review comments.

## 1. Session Repository & Worktree Tracking (`git_register`, `git_unregister`, `git_list`)

- **Registering repositories/worktrees (`git_register`)**: When creating a Git
  worktree, cloning or initializing a repository, or working in an additional
  repository outside the default workspace, call `git_register` with `path`
  (plus optional `base_ref` and `label`).
- **Unregistering (`git_unregister`)**: When a temporary worktree or repository
  is cleaned up, call `git_unregister` with `path`.
- **Listing (`git_list`)**: Call `git_list` to inspect all repositories and
  worktrees tracked in the active conversation (including workspace/project
  roots and any inherited across client-side session forks).

## 2. Citing Clickable Logical Diffs (`sidecar://source-control/git_ui/?...`)

When referencing a Git diff in a chat response, code review summary, or Markdown
artifact, format it as a `sidecar://source-control/git_ui/?...` Markdown link.
The host UI renders the link as an interactive inline pill with the Source
Control icon; clicking the pill opens the Source Control AuxPane, selects the
target repository and diff mode/commit, expands the target file (including
automatically expanding collapsed context gaps if the referenced line lies
between hunks), scrolls to the target line, and highlights the target row range.

### Canonical Markdown Syntax

```markdown
[`src/pipeline.js` (unstaged · +L39)](sidecar://source-control/git_ui/?repo=sc-demo-feature&rev=unstaged&file=src/pipeline.js&lines=L39&auto_open=false)
```

Or for a specific commit:

```markdown
[`mcp/git_mcp.mjs` (`e9f2c97` · +L21-L25)](sidecar://source-control/git_ui/?repo=source-control&rev=e9f2c97&file=mcp/git_mcp.mjs&lines=L21-L25&auto_open=false)
```

### Query Parameters

- - Parameter: `repo`
  - Values / Format: `<repo-name>` or `<path>`
  - Description: Matches a tracked session repository/worktree by directory
    basename (`sc-demo-feature`), label, or path.
- - Parameter: `rev`
  - Values / Format: `working`, `staged`, `unstaged`, `all`, `branch`, or
    `<commit-sha>`
  - Description: Selects the diff mode, or switches to **Commits** mode focused
    on `<commit-sha>` (also accepts `commit:<sha>`, `commit-<sha>`, or separate
    `mode` + `commit` parameters).
- - Parameter: `file`
  - Values / Format: `<relative/path/to/file>`
  - Description: Repository-relative file path.
- - Parameter: `lines`
  - Values / Format: `L39`, `L36-L42`, `+L39`, `-L18`, `-L18-L22`
  - Description: Target line or range on the new side (`L39` / `+L39`) or old
    side (`-L18`).
- - Parameter: `auto_open`
  - Values / Format: `false`
  - Description: Keeps the AuxPane from auto-opening while a response streams or
    when opening a report; opens only when clicked.

## 3. Inspecting Diff Context & Handling Inline Diff Review Comments (`git_diff_context`)

Users can select single or multi-line ranges directly inside the Source Control
diff viewer and send either a single comment (`### Diff Review Comment`) or a
batched multi-comment review (`### Diff Review`) to the conversation. Each
review item includes a clickable `sidecar://source-control/git_ui/?...` pill, a
fenced `diff` block with `>` markers on the selected lines, and the user's
comment.

To inspect broader context around any logical diff anchor:

1. **Via the `git_diff_context` MCP tool**:
   - Pass `uri` directly (accepts `sidecar://source-control/git_ui/?...` links,
     Markdown pills `[label](sidecar://...)`, or
     `git-diff://<repo>.local/<rev>/<file>` URIs), or pass explicit
     `{ repo, rev, file, lines, context_lines }` parameters.
   - `git_diff_context` resolves the repository path, runs `git diff` /
     `git show` with `-U<context_lines>` (default `10`), and returns:
     - `formattedDiff` with old/new line numbers and `>` markers on the target
       `lines` range,
     - `surroundingFileWindow` with full file lines around `lines` (even when
       the target lines lie outside a diff hunk),
     - `gitCommand` (the exact `git -C <repo> ...` command),
     - `markdownPill` and `sidecarUri` ready to cite in responses or artifacts.
2. **Via raw `git` commands**:
   - Translate `repo`, `rev`, and `file` directly:
     - `rev=working`: `git -C <repo> diff -U15 HEAD -- <file>`
     - `rev=staged`: `git -C <repo> diff -U15 --cached -- <file>`
     - `rev=unstaged`: `git -C <repo> diff -U15 -- <file>`
     - `rev=all`: `git -C <repo> diff -U15 <base-ref> -- <file>`
     - `rev=branch`: `git -C <repo> diff -U15 <base-ref>...HEAD -- <file>`
     - `rev=<commit-sha>`: `git -C <repo> show -U15 <commit-sha> -- <file>`

## 4. Opening the Source Control Panel

To surface a general one-click button that opens the Source Control AuxPane:

```markdown
[Source Control](sidecar://source-control/git_ui/)
```
