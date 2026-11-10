---
trigger: always_on
description: Keep session Git repositories synchronized and cite clickable logical diffs via Source Control.
---

# Session Git Tracking & Logical Diff Citations (`git_*`)

When working inside Git repositories or Git worktrees during a conversation,
keep the current chat session's Source Control root list synchronized and use
clickable `sidecar://source-control/git_ui/?...` diff pills when referencing
specific changes (read the `source-control` skill for complete details):

- **Proactive repository & worktree tracking (`git_register`, `git_unregister`,
  `git_list`)**: Call `git_register` when creating a Git worktree, cloning or
  initializing a repository, or starting work in an additional repository
  outside the default workspace; call `git_unregister` when a temporary worktree
  is removed; call `git_list` to inspect all tracked repositories in the
  session.
- **Clickable logical diff citations in chat and Markdown artifacts**: Format
  diff references as
  ``[`<file>` (<rev> · <lines>)](sidecar://source-control/git_ui/?repo=<repo>&rev=<rev>&file=<file>&lines=<lines>&auto_open=false)``
  so clicking the pill opens the Source Control AuxPane directly to the target
  repository, diff mode/commit, file, and highlighted line range, automatically
  expanding collapsed context gaps when needed.
- **Inspecting expanded diff context & inline review comments
  (`git_diff_context`)**: When given a `sidecar://source-control/git_ui/?...`
  diff pill or an inline diff review message from the Source Control panel, call
  `git_diff_context` or run the corresponding `git diff` / `git show` command to
  inspect surrounding hunks and file lines.
- **Interactive AuxPane UI**: Include
  `[Source Control](sidecar://source-control/git_ui/)` in chat when directing
  the user to inspect diffs, review changes, or stage/commit from the UI.
