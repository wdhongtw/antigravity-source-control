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
inspect expanded diff context.

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

| Parameter   | Values / Format                                                            | Description                                                                                                                                          |
| :---------- | :------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repo`      | `<repo-name>` or `<path>`                                                  | Matches a tracked session repository/worktree by directory basename (`sc-demo-feature`), label, or path.                                             |
| `rev`       | `working` \| `staged` \| `unstaged` \| `all` \| `branch` \| `<commit-sha>` | Selects the diff mode, or switches to **Commits** mode focused on `<commit-sha>` (also accepts `commit-<sha>` or separate `mode` + `commit` params). |
| `file`      | `<relative/path/to/file>`                                                  | Repository-relative file path.                                                                                                                       |
| `lines`     | `L39`, `L36-L42`, `+L39`, `-L18`, `-L18-L22`                               | Target line or range on the new side (`L39` / `+L39`) or old side (`-L18`).                                                                          |
| `auto_open` | `false`                                                                    | Keeps the AuxPane from auto-opening while a response streams or when opening a report; opens only when clicked.                                      |

## 3. Inspecting More Context from a Logical Diff Anchor (`git_diff_context`)

When a conversation message, report, or inline diff review message submitted
from the Source Control panel references a logical diff anchor
(`sidecar://source-control/git_ui/?...` or
`git-diff://<repo>.local/<rev>/<file>`), you can inspect surrounding diff hunks
and file context in two ways:

1. **Via the `git_diff_context` MCP tool**:
   - Pass `uri` directly (accepts `sidecar://source-control/git_ui/?...` links,
     Markdown pills `[label](sidecar://...)`, or
     `git-diff://<repo>.local/<rev>/<file>` review URIs), or pass explicit
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
