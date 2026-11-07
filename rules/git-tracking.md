# Session Git Tracking & Logical Diff Citations (`git_*`)

When working inside Git repositories or Git worktrees during a conversation,
keep the current chat session's Source Control root list synchronized and use
clickable `sidecar://source-control/git_ui/?...` diff pills when referencing
specific changes (read the `source-control` skill for complete details):

- **Registering and listing repositories (`git_register`, `git_unregister`,
  `git_list`)**: Call `git_register` when creating a Git worktree, cloning or
  initializing a repository, or starting work in an additional repository
  outside the default workspace; call `git_unregister` when a temporary worktree
  is removed; call `git_list` to inspect all tracked repositories in the
  session.
- **Citing clickable logical diffs in chat and Markdown artifacts**: Format diff
  mentions as
  ``[`<file>` (<rev> · <lines>)](sidecar://source-control/git_ui/?repo=<repo>&rev=<rev>&file=<file>&lines=<lines>&auto_open=false)``
  so clicking the pill opens the Source Control AuxPane directly to the target
  repository, diff mode/commit (`working`, `staged`, `unstaged`, `all`,
  `branch`, or `<commit-sha>`), file, and highlighted line range (`L39`,
  `L36-L42`, or `-L18-L22`), automatically expanding collapsed context gaps when
  needed.
- **Inspecting expanded diff context from an anchor (`git_diff_context`)**: When
  given a `sidecar://source-control/git_ui/?...` link or an inline review
  comment on `git-diff://<repo>.local/<rev>/<file>`, call `git_diff_context`
  (passing `uri` or `{ repo, rev, file, lines, context_lines }`) or run the
  corresponding `git diff` / `git show` command to inspect surrounding diff
  hunks and file lines.
- **Opening the Source Control panel**: Surface
  `[Source Control](sidecar://source-control/git_ui/)` when the user wants to
  inspect diffs, stage/unstage/discard changes, or commit from the UI.
