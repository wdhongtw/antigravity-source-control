# Session Git & Worktree Tracking (`git_*`)

When creating or working inside Git repositories or Git worktrees during a
conversation, keep the current chat session's Source Control root list
synchronized using the `git_*` MCP tools:

- **Registering a repository or worktree**: Call `git_register` when creating a
  Git worktree, cloning or initializing a repository, or starting work in an
  additional repository outside the default workspace.
- **Unregistering a repository or worktree**: Call `git_unregister` when a
  temporary worktree or repository is cleaned up or no longer relevant to the
  conversation.
- **Inspecting tracked repositories**: Call `git_list` to check all repositories
  and worktrees associated with the current session (including workspace/project
  repositories and any inherited from a forked parent conversation).
- **Opening the Source Control panel**: Surface
  `[Source Control](sidecar://source-control/git_ui/)` when the user wants to
  inspect diffs, stage/unstage/discard changes, or commit from the UI.
