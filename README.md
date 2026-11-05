# Source Control (`source-control`)

IDE-style Git Source Control & Worktree Inspector UI plugin and MCP toolset
(`git_*`). Combines the unified root registration model of `file-explorer` with
a full IDE Source Control staging/commit workflow and the multi-mode diff &
commit stack inspector from `worktree-inspector`.

## Key Features

- **Unified Repository & Worktree Selector**:
  - Automatically populates top clickable repository/worktree rows from:
    1. **Session Workspaces** (`CortexTrajectoryMetadata.workspace_uris` /
       `workspaces`)
    2. **Project Folders** (`~/.gemini/config/projects/<project_id>.json`
       `projectResources` & `environments`)
    3. **Session MCP Registered Repositories & Worktrees** (`git_register` /
       `git_unregister` steps in the conversation trajectory)
- **Per-Chat Session Trajectory Metadata (`git_*` MCP Tools)**:
  - `git_register`: Register an additional Git repository or worktree for the
    current conversation (`path`, optional `base_ref`, optional `label`).
  - `git_unregister`: Remove a repository or worktree from the session's Source
    Control root list without modifying files on disk.
  - `git_list`: List all Git repositories and worktrees tracked in the current
    session trajectory (including any inherited from a forked parent
    conversation).
- **Client-Side Session Fork Inheritance**:
  - Registered repositories and worktrees are stored as
    `CORTEX_STEP_TYPE_MCP_TOOL` / `CORTEX_STEP_TYPE_GENERIC` steps in
    `CortexTrajectory` with zero filesystem marker files, so forked sessions
    inherit the exact repository state up to the fork point while keeping
    subsequent changes isolated.
- **IDE Source Control Workflow (Stage, Unstage, Discard, Commit)**:
  - Inspect **Staged Changes** (`Index`) and **Changes** (`Working Tree` +
    `Untracked`) in a collapsible Source Control tree.
  - Stage or unstage individual files or all files with one click.
  - Discard uncommitted file changes or untracked files with an inline
    confirmation prompt bar.
  - Author commit messages (`Ctrl+Enter` / `Cmd+Enter`) and create or `--amend`
    commits directly from the panel.
- **Multi-Mode Unified Diff & Stacked Commit Inspector**:
  - **Working Tree**: All uncommitted changes (`HEAD` + untracked files).
  - **Staged**: Index changes (`git diff --cached`).
  - **Unstaged**: Unstaged working tree changes + untracked files.
  - **All vs Base**: Full branch diff against `merge-base(HEAD, base_ref)`
    (committed + uncommitted changes).
  - **Commits**: Stacked commits ahead of `base_ref` (or recent commit log on
    base branches) with clickable per-commit diff filtering.
  - **Interactive Context Expansion**: Adjust surrounding diff context (`-U`) or
    expand hidden lines (`+10 ↑`, `+10 ↓`, `All`) inline between hunks, and open
    any file in the native AuxPane File Preview (`tabType: 'fileView'`).
