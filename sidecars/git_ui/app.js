/**
 * @fileoverview Source Control & Worktree Inspector Frontend (`git_ui`).
 *
 * Combines:
 * 1. File Explorer-style clickable repository/worktree root selector
 *    (session workspaces, project folders, and `git_*` MCP trajectory entries).
 * 2. IDE Source Control panel (Staged Changes & Working Tree Changes groups,
 *    one-click stage/unstage/discard with inline confirmation, and commit/amend box).
 * 3. Worktree Inspector multi-mode diff & commit stack viewer (`Working Tree`,
 *    `Staged`, `Unstaged`, `All vs Base`, `Commits`, context stepper, and
 *    interactive `+10 ↑/↓` gap expansion).
 */
(() => {
  const POLL_INTERVAL_MS = 4000;
  const CONTEXT_STEPS = [0, 1, 3, 8, 20, 50, 10000];
  const $ = (id) => document.getElementById(id);

  const state = {
    conversationId: '',
    projectId: '',
    projectName: '',
    isForkedSession: false,
    parentConversationId: '',
    uiAssetVersion: '',
    roots: [],
    selectedRootPath: '',
    selectedChangeFile: '',
    collapsedChangeGroups: new Set(), // 'staged' | 'unstaged'
    amendCommit: false,
    committing: false,
    // Inline discard confirmation: { all: boolean, filePath: string, isUntracked: boolean }
    discardPrompt: null,
    diffMode: 'working', // 'working' | 'staged' | 'unstaged' | 'all' | 'branch'
    selectedCommit: '',
    contextStepIndex: 2, // default: 3 lines of unified diff context
    diffData: null,
    collapsedFiles: new Set(),
    gapExpansions: new Map(), // key: `${filePath}::${gapIdx}` -> { fromStart: number, fromEnd: number }
    fileLinesCache: new Map(), // key: `${wtPath}::${mode}::${commit}::${filePath}::${add}:${del}` -> { totalLines, lines }
    fileFilter: '',
    loadingDiff: false,
    // Inline diff review commenting state:
    // renderedFileRows: Map<filePath, Array<{ rowIdx, type, oldNo, newNo, text, hunkHeader }>>
    renderedFileRows: new Map(),
    // activeCommentDraft: { filePath, anchorRowIdx, startRowIdx, endRowIdx, text, quotedText, editingCommentId } | null
    activeCommentDraft: null,
    // reviewComments: Array<{ id, rootPath, repoName, filePath, customUri, sidecarUri, markdownPill, diffMode, commitSha, startRowIdx, endRowIdx, rangeLabel, urlRangeSpec, modeLabel, hunkHeader, snippet, quotePreview, text }>
    reviewComments: [],
    reviewSummaryNote: '',
    reviewModalOpen: false,
    sendingReview: false,
    // Drag selection state on line numbers
    draggingCommentRange: null, // { filePath, anchorRowIdx } | null
    // Deep-link target from `sidecar://source-control/git_ui/?repo=...&rev=...&file=...&lines=...`
    pendingDeepLink: null, // { repo, rev, mode, commit, file, lineRange } | null
    // Highlighted diff target after jumping via a deep link
    highlightedTarget: null, // { rootPath, diffMode, commitSha, filePath, side, startLine, endLine } | null
  };

  function esc(str) {
    return String(str ?? '').replace(
      /[&<>"']/g,
      (c) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[c]
    );
  }

  function setHtmlIfChanged(el, nextHtml) {
    if (!el) return;
    if (el._lastHtml !== nextHtml) {
      el.innerHTML = nextHtml;
      el._lastHtml = nextHtml;
    }
  }

  let toastTimer = null;
  function showToast(msg) {
    const el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2400);
  }

  const urlParams = new URLSearchParams(window.location.search);
  const sidecarToken = urlParams.get('token') || '';

  function syncThemeScheme() {
    const probe = document.createElement('span');
    probe.style.cssText =
      'position:absolute;visibility:hidden;color:var(--background, #18181b)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    document.documentElement.dataset.theme = lum < 0.5 ? 'dark' : 'light';
  }
  syncThemeScheme();
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'theme-change') {
      const vars = event.data.payload?.cssVariables || {};
      for (const [key, value] of Object.entries(vars)) {
        document.documentElement.style.setProperty(key, value);
      }
      syncThemeScheme();
    }
  });
  new MutationObserver(syncThemeScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  function resolveConversationId() {
    return (
      urlParams.get('conversationId') || window.sidecar?.conversationId || ''
    );
  }

  async function apiGet(path, params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') {
        qs.set(k, String(v));
      }
    }
    const url = qs.toString() ? `${path}?${qs.toString()}` : path;
    const headers = {};
    if (sidecarToken) {
      headers['X-Sidecar-Token'] = sidecarToken;
    }
    const res = await fetch(url, { method: 'GET', headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function apiPost(path, body = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (sidecarToken) {
      headers['X-Sidecar-Token'] = sidecarToken;
    }
    const res = await fetch(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function sourceTagText(src) {
    switch (src) {
      case 'workspace':
        return 'Workspace';
      case 'project':
        return 'Project';
      case 'mcp':
        return 'MCP';
      default:
        return src;
    }
  }

  function getActiveRoot() {
    return state.roots.find((r) => r.path === state.selectedRootPath) || null;
  }

  function getContextLines() {
    return CONTEXT_STEPS[state.contextStepIndex] ?? 3;
  }

  function updateContextStepperUI() {
    const val = getContextLines();
    const labelEl = $('ctx-label');
    if (labelEl) {
      labelEl.textContent = val >= 10000 ? 'Full ctx' : `${val} ctx`;
    }
    const shrinkBtn = $('btn-ctx-shrink');
    if (shrinkBtn) {
      shrinkBtn.disabled = state.contextStepIndex <= 0;
    }
    const expandBtn = $('btn-ctx-expand');
    if (expandBtn) {
      expandBtn.disabled = state.contextStepIndex >= CONTEXT_STEPS.length - 1;
    }
  }

  function fileLinesCacheKey(wtPath, fileObj) {
    return `${wtPath}::${state.diffMode}::${state.selectedCommit}::${fileObj.path}::${fileObj.additions}:${fileObj.deletions}`;
  }

  function getCachedFileLines(wt, fileObj) {
    return state.fileLinesCache.get(fileLinesCacheKey(wt.path, fileObj)) || null;
  }

  async function ensureFileLines(wt, fileObj) {
    const key = fileLinesCacheKey(wt.path, fileObj);
    const cached = state.fileLinesCache.get(key);
    if (cached) return cached;
    const res = await apiGet('/api/file-lines', {
      path: wt.path,
      file: fileObj.path,
      mode: state.diffMode,
      commit: state.selectedCommit,
    });
    const entry = {
      totalLines: Number(res.totalLines ?? 0),
      lines: Array.isArray(res.lines) ? res.lines : [],
    };
    state.fileLinesCache.set(key, entry);
    return entry;
  }

  function getGapExpansion(filePath, gapIdx) {
    const key = `${filePath}::${gapIdx}`;
    let exp = state.gapExpansions.get(key);
    if (!exp) {
      exp = { fromStart: 0, fromEnd: 0 };
      state.gapExpansions.set(key, exp);
    }
    return exp;
  }

  /**
   * Opens a file in the built-in AuxPane File Preview (`fileView`).
   */
  function openInNativeFileViewer(absPath) {
    const fileUri = absPath.startsWith('file://')
      ? absPath
      : `file://${absPath}`;
    const fileName = absPath.split('/').pop() || absPath;

    if (window.sidecar?.ui?.toggleAuxPane) {
      window.sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri: fileUri });
      showToast(`Opened ${fileName}`);
      return;
    }
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(
        {
          type: 'toggle-aux-pane',
          payload: { tabType: 'fileView', uri: fileUri },
        },
        '*'
      );
      showToast(`Opened ${fileName}`);
      return;
    }
    navigator.clipboard?.writeText(absPath);
    showToast(`Copied path: ${absPath}`);
  }

  function formatGpgTooltip({
    gpgStatus = 'N',
    gpgVerified = false,
    gpgKeyId = '',
    gpgSigner = '',
  } = {}) {
    const statusMap = {
      G: 'Good signature',
      U: 'Good signature (unknown trust)',
      X: 'Expired signature',
      Y: 'Signature made by expired key',
      R: 'Signature made by revoked key',
      B: 'Bad signature',
      E: 'Cannot verify signature (missing public key)',
      N: 'Unsigned commit',
    };
    const label = statusMap[gpgStatus] || `GPG status: ${gpgStatus}`;
    const parts = [
      gpgVerified ? `Verified GPG commit — ${label}` : `GPG commit — ${label}`,
    ];
    if (gpgSigner) parts.push(`Signer: ${gpgSigner}`);
    if (gpgKeyId) parts.push(`Key: ${gpgKeyId}`);
    return parts.join(' · ');
  }

  function renderCommitGpgSlotHtml(c) {
    if (c?.gpgVerified) {
      const tip = formatGpgTooltip(c);
      return `<span class="commit-gpg-slot verified" title="${esc(tip)}"><svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 1.5L2.5 3.8v4.2c0 3.6 2.3 6.2 5.5 7 3.2-.8 5.5-3.4 5.5-7V3.8L8 1.5z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/><path d="M5.5 8.1l1.7 1.7 3.5-3.6" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
    }
    const tipAttr = c?.gpgSigned ? ` title="${esc(formatGpgTooltip(c))}"` : '';
    return `<span class="commit-gpg-slot unsigned"${tipAttr}><span class="commit-dot" aria-hidden="true"></span></span>`;
  }

  function renderHeaderAndRoots() {
    if ($('count-roots')) {
      $('count-roots').textContent = `${state.roots.length} tracked`;
    }

    const listEl = $('root-list');
    const activeBarEl = $('active-repo-bar');
    const emptyStateEl = $('empty-root-state');
    const workspaceEl = $('repo-workspace');

    if (state.roots.length === 0) {
      setHtmlIfChanged(
        listEl,
        '<div class="empty-state">No associated Git repositories in this session</div>'
      );
      activeBarEl?.classList.add('hidden');
      emptyStateEl.classList.remove('hidden');
      setHtmlIfChanged(
        emptyStateEl,
        `<div>No Git repositories or worktrees tracked in this session yet.</div>
         <div class="empty-hint">
           Register a repository or worktree using the <code>git_register</code> MCP tool.
         </div>`
      );
      workspaceEl.classList.add('hidden');
      return;
    }

    const rowsHtml = state.roots
      .map((r) => {
        const isSelected = r.path === state.selectedRootPath;
        const sourceBadges = (r.sources || [])
          .map(
            (s) =>
              `<span class="source-pill src-${esc(s)}">${esc(sourceTagText(s))}</span>`
          )
          .join('');
        const worktreeBadge =
          r.isGitRepo && !r.isMainWorktree
            ? `<span class="source-pill src-worktree" title="Linked Git worktree of ${esc(r.repoName)}">Worktree</span>`
            : '';

        const rightBadges = [];
        if (isSelected) {
          rightBadges.push(
            '<span class="source-pill src-active">Active</span>'
          );
        }
        if (r.inheritedFromFork) {
          rightBadges.push(
            '<span class="status-pill inherited" title="Inherited from parent conversation before session fork">Inherited</span>'
          );
        }
        if (!r.existsOnDisk) {
          rightBadges.push(
            '<span class="status-pill missing" title="Directory does not currently exist on disk">Missing</span>'
          );
        } else if (!r.isGitRepo) {
          rightBadges.push(
            '<span class="status-pill missing" title="Directory is not a Git repository">No Git</span>'
          );
        } else {
          if (r.counts.ahead > 0) {
            rightBadges.push(
              `<span class="status-pill ahead" title="${r.counts.ahead} commit(s) ahead of ${esc(r.baseRef)}">+${r.counts.ahead} commit${r.counts.ahead > 1 ? 's' : ''}</span>`
            );
          }
          if (r.counts.totalDirty > 0) {
            const parts = [];
            if (r.counts.staged > 0) parts.push(`${r.counts.staged} staged`);
            if (r.counts.unstaged > 0) parts.push(`${r.counts.unstaged} mod`);
            if (r.counts.untracked > 0) parts.push(`${r.counts.untracked} new`);
            rightBadges.push(
              `<span class="status-pill dirty">${esc(parts.join(', '))}</span>`
            );
          } else {
            rightBadges.push('<span class="status-pill clean">Clean</span>');
          }
        }

        const labelHtml =
          r.label && r.label !== r.displayName
            ? `<span class="root-row-label">· ${esc(r.label)}</span>`
            : '';

        const commitSummary = r.headSha
          ? `${r.headSha} · ${r.headSubject}`
          : r.headSubject || r.displayPath;

        return `
          <div
            class="root-row${isSelected ? ' active' : ''}"
            data-select-root="${esc(r.path)}"
            role="option"
            tabindex="0"
            aria-selected="${isSelected ? 'true' : 'false'}"
            title="${esc(r.path)}"
          >
            <div class="root-row-top">
              <div class="root-row-title-group">
                <span class="root-active-dot" aria-hidden="true"></span>
                ${sourceBadges}
                ${worktreeBadge}
                <span class="root-row-name">${esc(r.displayName || r.name)}</span>
                ${labelHtml}
              </div>
              <div class="root-row-badges">${rightBadges.join('')}</div>
            </div>
            <div class="root-row-bottom">
              <div class="root-git-meta">
                <span class="branch-pill" title="Branch: ${esc(r.branch)} (base: ${esc(r.baseRef)})">${esc(r.branch)}</span>
                <span class="root-commit-subj" title="${esc(commitSummary)}">${esc(commitSummary)}</span>
              </div>
              <div class="root-bottom-right">
                ${r.headRelTime ? `<span class="root-time">${esc(r.headRelTime)}</span>` : ''}
                <button
                  type="button"
                  class="row-btn"
                  data-action="copy-root-path"
                  data-path="${esc(r.path)}"
                  title="Copy repository path (${esc(r.displayPath)})"
                >Copy</button>
              </div>
            </div>
          </div>`;
      })
      .join('');

    setHtmlIfChanged(listEl, rowsHtml);

    const activeRoot = getActiveRoot();
    if (!activeRoot) {
      activeBarEl?.classList.add('hidden');
      emptyStateEl.classList.remove('hidden');
      workspaceEl.classList.add('hidden');
      return;
    }

    if (!activeRoot.existsOnDisk || !activeRoot.isGitRepo) {
      activeBarEl?.classList.add('hidden');
      emptyStateEl.classList.remove('hidden');
      setHtmlIfChanged(
        emptyStateEl,
        `<div>${!activeRoot.existsOnDisk ? 'Repository path does not exist on disk:' : 'Directory is not a Git repository:'}</div>
         <div class="empty-hint"><code>${esc(activeRoot.path)}</code></div>`
      );
      workspaceEl.classList.add('hidden');
      return;
    }

    if (activeBarEl) {
      const kindTag = activeRoot.isMainWorktree ? 'Active Repo' : 'Active Worktree';
      const baseSuffix =
        activeRoot.baseRef &&
        activeRoot.baseRef !== 'HEAD' &&
        activeRoot.baseRef !== activeRoot.branch
          ? ` → ${activeRoot.baseRef}`
          : '';
      activeBarEl.classList.remove('hidden');
      setHtmlIfChanged(
        activeBarEl,
        `<div class="active-repo-left">
          <span class="active-repo-tag">${esc(kindTag)}</span>
          <span class="active-repo-name">${esc(activeRoot.displayName || activeRoot.name)}</span>
          <span class="active-repo-branch">${esc(activeRoot.branch + baseSuffix)}</span>
        </div>
        <code class="active-repo-path" title="${esc(activeRoot.path)}">${esc(activeRoot.displayPath)}</code>`
      );
    }

    emptyStateEl.classList.add('hidden');
    workspaceEl.classList.remove('hidden');
  }

  function renderDiscardMutationBar() {
    const bar = $('mutation-bar');
    const p = state.discardPrompt;
    if (!p) {
      bar.classList.add('hidden');
      bar.innerHTML = '';
      return;
    }

    bar.classList.remove('hidden');
    const titleHtml = p.all
      ? 'Discard <strong>all</strong> unstaged modifications and untracked files in this repository?'
      : p.isUntracked
      ? `Delete untracked file <code>${esc(p.filePath)}</code> permanently?`
      : `Discard unstaged changes in <code>${esc(p.filePath)}</code>?`;

    bar.innerHTML = `
      <div class="mutation-title">${titleHtml}</div>
      <div class="mutation-controls">
        <button type="button" id="btn-discard-confirm" class="ghost-btn danger">Discard</button>
        <button type="button" id="btn-discard-cancel" class="ghost-btn">Cancel</button>
      </div>`;
  }

  function splitFileDir(relPath) {
    const idx = relPath.lastIndexOf('/');
    if (idx === -1) {
      return { name: relPath, dir: '' };
    }
    return {
      name: relPath.slice(idx + 1),
      dir: relPath.slice(0, idx),
    };
  }

  function renderChangeRowHtml(wt, item, section) {
    const { name, dir } = splitFileDir(item.path);
    const absPath = `${wt.path}/${item.path}`;
    const isSelected = state.selectedChangeFile === item.path;
    const statusLabel = item.statusLabel || item.status || 'M';
    const dirLabel = item.oldPath
      ? `${item.oldPath} → ${dir ? `${dir}/` : ''}`
      : dir;

    const actions =
      section === 'staged'
        ? `
          <button type="button" class="row-btn" data-action="open-file" data-path="${esc(absPath)}" title="Open in native File Preview">Open</button>
          <button type="button" class="row-btn" data-action="copy-path" data-path="${esc(item.path)}" title="Copy relative path">Copy</button>
          <button type="button" class="row-btn" data-action="unstage-file" data-file="${esc(item.path)}" title="Unstage file">&#8722; Unstage</button>`
        : `
          <button type="button" class="row-btn" data-action="open-file" data-path="${esc(absPath)}" title="Open in native File Preview">Open</button>
          <button type="button" class="row-btn" data-action="copy-path" data-path="${esc(item.path)}" title="Copy relative path">Copy</button>
          <button type="button" class="row-btn danger" data-action="prompt-discard-file" data-file="${esc(item.path)}" data-untracked="${item.isUntracked ? '1' : '0'}" title="Discard changes">Discard</button>
          <button type="button" class="row-btn" data-action="stage-file" data-file="${esc(item.path)}" title="Stage file">+ Stage</button>`;

    return `
      <div
        class="change-row${isSelected ? ' active' : ''}"
        data-change-file="${esc(item.path)}"
        data-change-section="${esc(section)}"
        title="${esc(item.path)}"
      >
        <div class="change-row-left">
          <span class="file-status st-${esc(item.status)}">${esc(statusLabel)}</span>
          <span class="change-file-name">${esc(name)}</span>
          ${dirLabel ? `<span class="change-file-dir">${esc(dirLabel)}</span>` : ''}
        </div>
        <div class="change-row-right">
          <div class="change-actions">${actions}</div>
        </div>
      </div>`;
  }

  function renderSourceControlPanel(wt) {
    renderDiscardMutationBar();

    const commitInput = $('commit-input');
    if (commitInput) {
      commitInput.placeholder = `Message (Ctrl+Enter to commit on "${wt.branch}")`;
    }

    const commitBtn = $('btn-commit');
    if (commitBtn) {
      const stagedCount = wt.counts?.staged || 0;
      const totalDirty = wt.counts?.totalDirty || 0;
      if (state.committing) {
        commitBtn.textContent = 'Committing…';
        commitBtn.disabled = true;
      } else if (state.amendCommit) {
        commitBtn.textContent =
          stagedCount > 0 ? `Amend (${stagedCount} staged)` : 'Amend Commit';
        commitBtn.disabled = false;
      } else if (stagedCount > 0) {
        commitBtn.textContent = `Commit (${stagedCount} staged)`;
        commitBtn.disabled = false;
      } else if (totalDirty > 0) {
        commitBtn.textContent = `Commit All (${totalDirty})`;
        commitBtn.disabled = false;
      } else {
        commitBtn.textContent = 'Commit';
        commitBtn.disabled = true;
      }
    }

    const listsEl = $('changes-lists');
    const stagedList = wt.changes?.staged || [];
    const unstagedList = wt.changes?.unstaged || [];

    if (stagedList.length === 0 && unstagedList.length === 0) {
      setHtmlIfChanged(
        listsEl,
        `<div class="clean-tree-banner">
          <span>Working tree clean on <code>${esc(wt.branch)}</code></span>
          <span>${wt.counts?.ahead > 0 ? `+${wt.counts.ahead} ahead of <code>${esc(wt.baseRef)}</code>` : `Up to date with <code>${esc(wt.baseRef)}</code>`}</span>
        </div>`
      );
      return;
    }

    const groupsHtml = [];

    if (stagedList.length > 0) {
      const collapsed = state.collapsedChangeGroups.has('staged');
      const rows = collapsed
        ? ''
        : `<div class="changes-group-body">${stagedList
            .map((item) => renderChangeRowHtml(wt, item, 'staged'))
            .join('')}</div>`;
      groupsHtml.push(`
        <div class="changes-group">
          <div class="changes-group-header" data-toggle-group="staged">
            <div class="changes-group-title">
              <span>${collapsed ? '&#9656;' : '&#9662;'}</span>
              <span>Staged Changes</span>
              <span class="badge-count">${stagedList.length}</span>
            </div>
            <div class="changes-group-actions">
              <button type="button" class="row-btn" data-action="unstage-all" title="Unstage all staged changes">&#8722; Unstage All</button>
            </div>
          </div>
          ${rows}
        </div>`);
    }

    if (unstagedList.length > 0) {
      const collapsed = state.collapsedChangeGroups.has('unstaged');
      const rows = collapsed
        ? ''
        : `<div class="changes-group-body">${unstagedList
            .map((item) => renderChangeRowHtml(wt, item, 'unstaged'))
            .join('')}</div>`;
      groupsHtml.push(`
        <div class="changes-group">
          <div class="changes-group-header" data-toggle-group="unstaged">
            <div class="changes-group-title">
              <span>${collapsed ? '&#9656;' : '&#9662;'}</span>
              <span>Changes</span>
              <span class="badge-count">${unstagedList.length}</span>
            </div>
            <div class="changes-group-actions">
              <button type="button" class="row-btn danger" data-action="prompt-discard-all" title="Discard all unstaged changes">Discard All</button>
              <button type="button" class="row-btn" data-action="stage-all" title="Stage all changes">+ Stage All</button>
            </div>
          </div>
          ${rows}
        </div>`);
    }

    setHtmlIfChanged(listsEl, groupsHtml.join(''));
  }

  function syncCommentDraftTextFromDom() {
    if (!state.activeCommentDraft) return;
    const textarea = $('diff-comment-input');
    if (textarea) {
      state.activeCommentDraft.text = textarea.value;
    }
  }

  function focusCommentDraftTextarea() {
    requestAnimationFrame(() => {
      const textarea = $('diff-comment-input');
      if (textarea) {
        textarea.focus({ preventScroll: true });
        const len = textarea.value.length;
        textarea.setSelectionRange(len, len);
      }
    });
  }

  function formatCurrentDiffModeLabel() {
    if (state.selectedCommit) {
      return `Commit ${state.selectedCommit.slice(0, 7)}`;
    }
    switch (state.diffMode) {
      case 'working':
        return 'Working Tree';
      case 'staged':
        return 'Staged';
      case 'unstaged':
        return 'Unstaged';
      case 'all':
        return 'All vs Base';
      case 'branch':
        return 'Branch Commits';
      default:
        return state.diffMode;
    }
  }

  function formatDiffRowPrefix(type) {
    return type === 'add' ? '+' : type === 'del' ? '-' : ' ';
  }

  function sanitizeUriSegment(str) {
    return String(str || 'default').replace(/[^a-zA-Z0-9._-]+/g, '-');
  }

  /**
   * Builds logical Git diff target components (`repoSlug`, `revSlug`, `cleanRelPath`).
   */
  function buildLogicalDiffParts(wt, filePath, diffMode = state.diffMode, commitSha = state.selectedCommit) {
    const repoSlug = sanitizeUriSegment(wt?.displayName || wt?.name || 'repo');
    let revSlug = 'working-tree';
    if (commitSha) {
      revSlug = `commit-${sanitizeUriSegment(commitSha.slice(0, 12))}`;
    } else if (diffMode === 'staged') {
      revSlug = 'staged-index';
    } else if (diffMode === 'unstaged') {
      revSlug = 'unstaged-worktree';
    } else if (diffMode === 'working') {
      revSlug = 'working-tree';
    } else if (diffMode === 'all') {
      revSlug = `all-vs-${sanitizeUriSegment(wt?.baseRef || 'HEAD')}`;
    } else if (diffMode === 'branch') {
      revSlug = `branch-${sanitizeUriSegment(wt?.baseRef || 'main')}..${sanitizeUriSegment(wt?.branch || 'HEAD')}`;
    }
    const cleanRelPath = String(filePath || '').replace(/^\/+/, '');
    return { repoSlug, revSlug, cleanRelPath };
  }

  /**
   * Builds the canonical logical Git diff URI using the custom `git-diff://` scheme:
   * `git-diff://<repo>.local/<rev>/<filePath>`
   */
  function buildCustomDiffUri(wt, filePath, diffMode = state.diffMode, commitSha = state.selectedCommit) {
    const { repoSlug, revSlug, cleanRelPath } = buildLogicalDiffParts(
      wt,
      filePath,
      diffMode,
      commitSha
    );
    return `git-diff://${repoSlug}.local/${revSlug}/${cleanRelPath}`;
  }

  function normalizeDiffRevParam({ rev = '', mode = '', commit = '' } = {}) {
    const rawCommit = String(commit || '')
      .trim()
      .replace(/^commit-/i, '');
    if (/^[0-9a-f]{6,40}$/i.test(rawCommit)) {
      return {
        rev: rawCommit,
        mode: 'branch',
        commit: rawCommit,
        label: rawCommit.slice(0, 7),
      };
    }
    const rawToken = String(rev || mode || 'working')
      .trim()
      .toLowerCase();
    const commitMatch = /^commit-([0-9a-f]{6,40})$/i.exec(rawToken);
    if (commitMatch) {
      const sha = commitMatch[1];
      return { rev: sha, mode: 'branch', commit: sha, label: sha.slice(0, 7) };
    }
    if (/^[0-9a-f]{6,40}$/i.test(rawToken)) {
      return {
        rev: rawToken,
        mode: 'branch',
        commit: rawToken,
        label: rawToken.slice(0, 7),
      };
    }
    switch (rawToken) {
      case 'staged':
      case 'staged-index':
        return { rev: 'staged', mode: 'staged', commit: '', label: 'staged' };
      case 'unstaged':
      case 'unstaged-worktree':
        return {
          rev: 'unstaged',
          mode: 'unstaged',
          commit: '',
          label: 'unstaged',
        };
      case 'all':
      case 'all-vs-base':
        return { rev: 'all', mode: 'all', commit: '', label: 'all' };
      case 'branch':
      case 'branch-commits':
        return { rev: 'branch', mode: 'branch', commit: '', label: 'branch' };
      case 'working':
      case 'working-tree':
      case 'dirty':
      default:
        return {
          rev: 'working',
          mode: 'working',
          commit: '',
          label: 'working',
        };
    }
  }

  function parseDiffLineRangeSpec(rawLines) {
    if (rawLines === null || rawLines === undefined) return null;
    const cleaned = String(rawLines).trim();
    if (!cleaned) return null;
    const m =
      /^([+-])?[Ll]?(\d+)(?:\s*(?:-[+-]?[Ll]?|\.\.|–)(\d+))?$/.exec(cleaned);
    if (!m) return null;
    const side = m[1] === '-' ? 'old' : 'new';
    const a = Number.parseInt(m[2], 10);
    const b = m[3] !== undefined ? Number.parseInt(m[3], 10) : a;
    if (!Number.isFinite(a) || a <= 0) return null;
    const startLine = Math.min(a, b);
    const endLine = Math.max(a, b);
    const sign = side === 'old' ? '-' : '+';
    const urlPrefix = side === 'old' ? '-L' : 'L';
    const urlParam =
      startLine === endLine
        ? `${urlPrefix}${startLine}`
        : `${urlPrefix}${startLine}-L${endLine}`;
    const displayLabel =
      startLine === endLine
        ? `${sign}L${startLine}`
        : `${sign}L${startLine}-L${endLine}`;
    return { side, startLine, endLine, urlParam, displayLabel };
  }

  function buildSidecarDiffLink(
    wt,
    filePath = '',
    linesSpec = '',
    diffMode = state.diffMode,
    commitSha = state.selectedCommit
  ) {
    const repoName = (wt?.name || wt?.displayName || 'repo').replace(
      /\.local$/i,
      ''
    );
    const revSpec = normalizeDiffRevParam({
      mode: diffMode,
      commit: commitSha,
    });
    const cleanFile = String(filePath || '').trim().replace(/^\/+/, '');
    const lineRange = parseDiffLineRangeSpec(linesSpec);

    const params = new URLSearchParams();
    if (repoName) params.set('repo', repoName);
    if (revSpec.rev) params.set('rev', revSpec.rev);
    if (cleanFile) params.set('file', cleanFile);
    if (lineRange) params.set('lines', lineRange.urlParam);
    params.set('auto_open', 'false');

    const sidecarUri = `sidecar://source-control/git_ui/?${params.toString()}`;
    const metaParts = [revSpec.label];
    if (lineRange) metaParts.push(lineRange.displayLabel);
    const suffix = metaParts.length > 0 ? ` (${metaParts.join(' · ')})` : '';
    const pillLabel = cleanFile
      ? `\`${cleanFile}\`${suffix}`
      : `${repoName}${suffix}`;

    return {
      sidecarUri,
      markdownPill: `[${pillLabel}](${sidecarUri})`,
      lineRange,
    };
  }

  function parseDeepLinkFromSearch(searchStr, hashStr = '') {
    const params = new URLSearchParams(searchStr || '');
    const hasTargetParam = [
      'repo',
      'path',
      'root',
      'rev',
      'mode',
      'commit',
      'file',
      'lines',
      'line',
    ].some((k) => params.has(k));
    if (!hasTargetParam) return null;

    const repo = (
      params.get('repo') ||
      params.get('path') ||
      params.get('root') ||
      ''
    )
      .trim()
      .replace(/\.local$/i, '');
    const hasExplicitRev =
      params.has('rev') || params.has('mode') || params.has('commit');
    const revSpec = normalizeDiffRevParam({
      rev: params.get('rev') || '',
      mode: params.get('mode') || '',
      commit: params.get('commit') || '',
    });
    const file = (params.get('file') || '').trim().replace(/^\/+/, '');
    const rawLines =
      params.get('lines') ||
      params.get('line') ||
      String(hashStr || '').replace(/^#/, '') ||
      '';
    const lineRange = parseDiffLineRangeSpec(rawLines);

    return {
      repo,
      hasExplicitRev,
      ...revSpec,
      file,
      rawLines: rawLines.trim(),
      lineRange,
    };
  }

  function formatDiffSnippetRow(r, isSelected = false) {
    const marker = isSelected ? '>' : ' ';
    const oldPad =
      r.oldNo !== null && r.oldNo !== undefined
        ? String(r.oldNo).padStart(4, ' ')
        : '    ';
    const newPad =
      r.newNo !== null && r.newNo !== undefined
        ? String(r.newNo).padStart(4, ' ')
        : '    ';
    const prefix = formatDiffRowPrefix(r.type);
    return `${marker} ${oldPad} ${newPad} | ${prefix}${r.text}`;
  }

  function computeCommentSelectionMeta(
    filePath,
    startRowIdx,
    endRowIdx,
    quotedText = '',
    wt = getActiveRoot()
  ) {
    const rows = state.renderedFileRows.get(filePath) || [];
    if (startRowIdx < 0 || rows.length === 0) {
      const fallbackContent = quotedText.trim() || '';
      const linkInfo = wt
        ? buildSidecarDiffLink(
            wt,
            filePath,
            '',
            state.diffMode,
            state.selectedCommit
          )
        : { sidecarUri: '', markdownPill: `\`${filePath}\`` };
      return {
        rangeLabel: 'File-level diff comment',
        urlRangeSpec: '',
        startLine: 1,
        endLine: 1,
        hunkHeader: '',
        snippet: fallbackContent,
        quotePreview: fallbackContent || `[File diff review on ${filePath}]`,
        sidecarUri: linkInfo.sidecarUri,
        markdownPill: linkInfo.markdownPill,
      };
    }

    const lo = Math.max(0, Math.min(startRowIdx, endRowIdx));
    const hi = Math.min(rows.length - 1, Math.max(startRowIdx, endRowIdx));
    const selectedRows = rows.slice(lo, hi + 1);
    const hunkHeader = selectedRows[0]?.hunkHeader || '';

    const newNos = selectedRows
      .map((r) => r.newNo)
      .filter((n) => Number.isInteger(n) && n >= 1);
    const oldNos = selectedRows
      .map((r) => r.oldNo)
      .filter((n) => Number.isInteger(n) && n >= 1);

    let startLine = 1;
    let endLine = 1;
    let urlRangeSpec = '';
    if (newNos.length > 0) {
      startLine = Math.min(...newNos);
      endLine = Math.max(...newNos);
      urlRangeSpec =
        startLine === endLine
          ? `+L${startLine}`
          : `+L${startLine}-L${endLine}`;
    } else if (oldNos.length > 0) {
      startLine = Math.min(...oldNos);
      endLine = Math.max(...oldNos);
      urlRangeSpec =
        startLine === endLine
          ? `-L${startLine}`
          : `-L${startLine}-L${endLine}`;
    }

    const rangeParts = [];
    if (oldNos.length > 0) {
      const oMin = Math.min(...oldNos);
      const oMax = Math.max(...oldNos);
      rangeParts.push(oMin === oMax ? `-L${oMin}` : `-L${oMin}-L${oMax}`);
    }
    if (newNos.length > 0) {
      const nMin = Math.min(...newNos);
      const nMax = Math.max(...newNos);
      rangeParts.push(nMin === nMax ? `+L${nMin}` : `+L${nMin}-L${nMax}`);
    }
    const rangeLabel = rangeParts.join(' / ') || `L${startLine}`;

    const linkInfo = wt
      ? buildSidecarDiffLink(
          wt,
          filePath,
          urlRangeSpec,
          state.diffMode,
          state.selectedCommit
        )
      : { sidecarUri: '', markdownPill: `\`${filePath}\`` };

    const ctxStart = Math.max(0, lo - 2);
    const ctxEnd = Math.min(rows.length - 1, hi + 2);
    const snippetRows = [];
    for (let idx = ctxStart; idx <= ctxEnd; idx++) {
      const r = rows[idx];
      if (!r) continue;
      if (idx < lo && hunkHeader && r.hunkHeader && r.hunkHeader !== hunkHeader) {
        continue;
      }
      if (idx > hi && hunkHeader && r.hunkHeader && r.hunkHeader !== hunkHeader) {
        continue;
      }
      snippetRows.push(formatDiffSnippetRow(r, idx >= lo && idx <= hi));
    }

    const quotePreview =
      quotedText && quotedText.trim() && selectedRows.length === 1
        ? `${formatDiffRowPrefix(selectedRows[0].type)}${quotedText}`
        : selectedRows
            .map((r) => formatDiffSnippetRow(r, true))
            .join('\n') || `[Lines ${rangeLabel}]`;

    return {
      rangeLabel,
      urlRangeSpec,
      startLine,
      endLine: Math.max(startLine, endLine),
      hunkHeader,
      snippet: snippetRows.join('\n'),
      quotePreview,
      sidecarUri: linkInfo.sidecarUri,
      markdownPill: linkInfo.markdownPill,
    };
  }

  function buildCommentItemFromDraft(wt, draft) {
    syncCommentDraftTextFromDom();
    const commentText = (draft?.text || '').trim();
    if (!commentText) {
      showToast('Please enter a review comment');
      focusCommentDraftTextarea();
      return null;
    }

    const meta = computeCommentSelectionMeta(
      draft.filePath,
      draft.startRowIdx,
      draft.endRowIdx,
      draft.quotedText || '',
      wt
    );
    const modeLabel = formatCurrentDiffModeLabel();
    const customUri = buildCustomDiffUri(
      wt,
      draft.filePath,
      state.diffMode,
      state.selectedCommit
    );
    const repoName = (wt?.name || wt?.displayName || 'repo').replace(
      /\.local$/i,
      ''
    );

    return {
      id:
        draft.editingCommentId ||
        `rc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      rootPath: wt.path,
      repoName,
      filePath: draft.filePath,
      customUri,
      sidecarUri: meta.sidecarUri,
      markdownPill: meta.markdownPill,
      diffMode: state.diffMode,
      commitSha: state.selectedCommit,
      startRowIdx: draft.startRowIdx,
      endRowIdx: draft.endRowIdx,
      rangeLabel: meta.rangeLabel,
      urlRangeSpec: meta.urlRangeSpec,
      modeLabel,
      hunkHeader: meta.hunkHeader,
      snippet: meta.snippet,
      quotePreview: meta.quotePreview,
      text: commentText,
    };
  }

  function queueActiveCommentDraft() {
    const wt = getActiveRoot();
    const draft = state.activeCommentDraft;
    if (!wt || !draft) return;

    const item = buildCommentItemFromDraft(wt, draft);
    if (!item) return;

    const existingIdx = state.reviewComments.findIndex((c) => c.id === item.id);
    if (existingIdx >= 0) {
      state.reviewComments[existingIdx] = item;
    } else {
      state.reviewComments.push(item);
    }

    state.activeCommentDraft = null;
    hideSelectionQuotePill();
    renderDiffFiles(wt);
    renderReviewBatchBar();
    showToast(
      `Queued review comment #${state.reviewComments.length} (${item.filePath} · ${item.rangeLabel})`
    );
  }

  async function dispatchReviewComments(
    commentsToSend,
    { summaryNote = '', clearFromQueueIds = [] } = {}
  ) {
    if (!Array.isArray(commentsToSend) || commentsToSend.length === 0) return;
    if (state.sendingReview) return;
    const wt = getActiveRoot();
    state.sendingReview = true;
    renderReviewBatchBar();
    if (state.reviewModalOpen) renderReviewModal();

    try {
      const res = await apiPost('/api/send-review', {
        conversationId: state.conversationId || resolveConversationId(),
        projectId: state.projectId || '',
        repositoryName: wt?.name || wt?.displayName || '',
        repositoryPath: wt?.path || '',
        summaryNote,
        comments: commentsToSend,
      });

      if (clearFromQueueIds.length > 0) {
        const removeSet = new Set(clearFromQueueIds);
        state.reviewComments = state.reviewComments.filter(
          (c) => !removeSet.has(c.id)
        );
      }
      if (state.reviewComments.length === 0) {
        state.reviewSummaryNote = '';
        state.reviewModalOpen = false;
      }

      const count = res.commentCount || commentsToSend.length;
      showToast(
        count === 1
          ? `Sent diff review comment to conversation`
          : `Sent ${count} diff review comments to conversation`
      );
    } catch (err) {
      showToast(`Failed to send review: ${err.message}`);
    } finally {
      state.sendingReview = false;
      const currentWt = getActiveRoot();
      if (currentWt) renderDiffFiles(currentWt);
      renderReviewBatchBar();
      renderReviewModal();
    }
  }

  async function sendActiveCommentDraftNow() {
    const wt = getActiveRoot();
    const draft = state.activeCommentDraft;
    if (!wt || !draft) return;

    const item = buildCommentItemFromDraft(wt, draft);
    if (!item) return;

    state.activeCommentDraft = null;
    hideSelectionQuotePill();
    renderDiffFiles(wt);

    // If the user was editing an existing queued comment or has queued batch comments,
    // include the active comment with any queued comments if they match or send directly.
    if (draft.editingCommentId) {
      const idx = state.reviewComments.findIndex(
        (c) => c.id === draft.editingCommentId
      );
      if (idx >= 0) state.reviewComments[idx] = item;
    }

    if (state.reviewComments.length > 0 && !draft.editingCommentId) {
      // Send the active comment along with the queued batch
      const allToSend = [...state.reviewComments, item];
      const clearIds = state.reviewComments.map((c) => c.id);
      await dispatchReviewComments(allToSend, {
        summaryNote: state.reviewSummaryNote,
        clearFromQueueIds: clearIds,
      });
    } else if (draft.editingCommentId) {
      await dispatchReviewComments([item], {
        summaryNote: '',
        clearFromQueueIds: [item.id],
      });
    } else {
      await dispatchReviewComments([item], {
        summaryNote: '',
        clearFromQueueIds: [],
      });
    }
  }

  function renderInlineCommentDraftCardHtml(filePath) {
    const draft = state.activeCommentDraft;
    if (!draft || draft.filePath !== filePath) return '';
    const wt = getActiveRoot();
    const meta = computeCommentSelectionMeta(
      filePath,
      draft.startRowIdx,
      draft.endRowIdx,
      draft.quotedText || '',
      wt
    );
    const modeLabel = formatCurrentDiffModeLabel();
    const snippetLines = (meta.quotePreview || '').split('\n');
    const previewSnippet =
      snippetLines.length > 4
        ? `${snippetLines.slice(0, 4).join('\n')}\n… (${snippetLines.length - 4} more line${snippetLines.length - 4 === 1 ? '' : 's'})`
        : meta.quotePreview;
    const queuedCount = state.reviewComments.length;
    const isEditing = Boolean(draft.editingCommentId);
    const sendBtnLabel =
      !isEditing && queuedCount > 0
        ? `Send All (${queuedCount + 1})`
        : 'Send to Chat';
    const queueBtnLabel = isEditing
      ? 'Save in Batch'
      : queuedCount > 0
        ? `+ Add to Batch (${queuedCount})`
        : '+ Add to Batch';

    return `
      <div class="diff-comment-box" data-comment-draft-box="1">
        <div class="diff-comment-header">
          <div class="diff-comment-header-left">
            <span class="diff-comment-badge">${isEditing ? 'Edit Review Comment' : 'Review Comment'}</span>
            <span class="diff-comment-target"><code>${esc(filePath)}</code> · <strong>${esc(meta.rangeLabel)}</strong></span>
            <span class="diff-comment-mode-pill">${esc(modeLabel)}</span>
            <button type="button" class="row-btn" data-action="copy-comment-diff-link" title="Copy clickable Markdown diff pill for this line range">🔗 Copy Pill</button>
          </div>
          <span class="diff-comment-hint">Shift+Click or drag line numbers to select range</span>
        </div>
        <pre class="diff-comment-quote">${esc(previewSnippet)}</pre>
        <textarea
          id="diff-comment-input"
          class="diff-comment-textarea"
          rows="2"
          placeholder="Ask a question or request changes on these diff lines… (Ctrl+Enter to Send to Chat, Alt+Enter to Add to Batch, Esc to cancel)"
        >${esc(draft.text || '')}</textarea>
        <div class="diff-comment-actions">
          <span class="diff-comment-subhint">Posts a structured diff review message with clickable <code>sidecar://</code> anchors to Chat</span>
          <div class="diff-comment-btns">
            <button type="button" class="ghost-btn sm" data-action="cancel-diff-comment">Cancel</button>
            <button type="button" class="ghost-btn sm" data-action="queue-diff-comment" title="Queue this comment in the Review Batch so you can add more comments before sending (Alt+Enter)">${esc(queueBtnLabel)}</button>
            <button type="button" class="ghost-btn sm primary" data-action="send-diff-comment-now" title="Send diff review message directly to the active conversation now (Ctrl+Enter)">${esc(sendBtnLabel)}</button>
          </div>
        </div>
      </div>`;
  }

  function renderQueuedCommentCardHtml(c, queueIndex) {
    return `
      <div class="diff-staged-comment" data-staged-comment-id="${esc(c.id)}">
        <div class="diff-staged-comment-top">
          <div class="diff-staged-comment-meta">
            <span class="diff-staged-pill">Queued #${queueIndex + 1}</span>
            <button type="button" class="diff-staged-uri-chip" data-action="copy-queued-pill" data-comment-id="${esc(c.id)}" title="Click to copy clickable Markdown diff pill"><code>${esc(c.filePath)} (${esc(c.rangeLabel)})</code></button>
            <span class="diff-staged-range">${esc(c.modeLabel)}</span>
          </div>
          <div class="diff-staged-actions">
            <button type="button" class="row-btn" data-action="edit-queued-comment" data-comment-id="${esc(c.id)}" title="Edit this queued review comment">Edit</button>
            <button type="button" class="row-btn" data-action="send-single-queued-comment" data-comment-id="${esc(c.id)}" title="Send just this comment to the conversation now">Send Now</button>
            <button type="button" class="row-btn danger" data-action="remove-queued-comment" data-comment-id="${esc(c.id)}" title="Remove from review batch">Remove</button>
          </div>
        </div>
        <div class="diff-staged-comment-body">${esc(c.text)}</div>
      </div>`;
  }

  function renderReviewBatchBar() {
    const barEl = $('review-batch-bar');
    if (!barEl) return;
    const count = state.reviewComments.length;
    if (count === 0) {
      barEl.classList.add('hidden');
      setHtmlIfChanged(barEl, '');
      return;
    }

    const fileSet = new Set(state.reviewComments.map((c) => c.filePath));
    const filesLabel = `${fileSet.size} file${fileSet.size === 1 ? '' : 's'}`;
    barEl.classList.remove('hidden');
    setHtmlIfChanged(
      barEl,
      `<div class="review-batch-left">
        <span class="review-batch-badge">💬 ${count} Queued</span>
        <span class="review-batch-info">Review comment${count === 1 ? '' : 's'} across ${esc(filesLabel)}</span>
      </div>
      <div class="review-batch-actions">
        <button type="button" class="ghost-btn sm danger" data-action="clear-review-batch" ${state.sendingReview ? 'disabled' : ''}>Clear</button>
        <button type="button" class="ghost-btn sm" data-action="open-review-modal" ${state.sendingReview ? 'disabled' : ''}>Review &amp; Summary…</button>
        <button type="button" class="ghost-btn sm primary" data-action="submit-review-batch" ${state.sendingReview ? 'disabled' : ''}>${state.sendingReview ? 'Sending…' : `Send Review (${count})`}</button>
      </div>`
    );
  }

  function renderReviewModal() {
    const modalEl = $('review-modal');
    if (!modalEl) return;
    if (!state.reviewModalOpen || state.reviewComments.length === 0) {
      modalEl.classList.add('hidden');
      setHtmlIfChanged(modalEl, '');
      return;
    }

    const summaryInputEl = $('review-summary-input');
    if (summaryInputEl) {
      state.reviewSummaryNote = summaryInputEl.value;
    }

    const count = state.reviewComments.length;
    const itemsHtml = state.reviewComments
      .map(
        (c, idx) => `
        <div class="review-modal-item" data-modal-comment-id="${esc(c.id)}">
          <div class="review-modal-item-top">
            <div class="review-modal-item-title">
              <span class="diff-staged-pill">#${idx + 1}</span>
              <button type="button" class="diff-staged-uri-chip" data-action="jump-queued-comment" data-comment-id="${esc(c.id)}" title="Jump to ${esc(c.filePath)} (${esc(c.rangeLabel)}) in diff viewer">
                <code>${esc(c.filePath)}</code> · ${esc(c.rangeLabel)} · ${esc(c.modeLabel)}
              </button>
            </div>
            <div class="diff-staged-actions">
              <button type="button" class="row-btn" data-action="copy-queued-pill" data-comment-id="${esc(c.id)}" title="Copy clickable Markdown diff pill">🔗 Pill</button>
              <button type="button" class="row-btn danger" data-action="remove-queued-comment" data-comment-id="${esc(c.id)}" title="Remove comment">Remove</button>
            </div>
          </div>
          ${c.quotePreview ? `<pre class="diff-comment-quote">${esc(c.quotePreview)}</pre>` : ''}
          <div class="review-modal-item-comment">${esc(c.text)}</div>
        </div>`
      )
      .join('');

    modalEl.classList.remove('hidden');
    setHtmlIfChanged(
      modalEl,
      `<div class="review-modal-card" role="document">
        <div class="review-modal-header">
          <div class="review-modal-title">
            <span>Submit Diff Review (${count} comment${count === 1 ? '' : 's'})</span>
          </div>
          <button type="button" class="row-btn" data-action="close-review-modal" title="Close (Esc)">✕</button>
        </div>
        <div class="review-modal-body">
          <label class="review-summary-label" for="review-summary-input">Overall Review Summary / Instructions (optional)</label>
          <textarea
            id="review-summary-input"
            class="diff-comment-textarea"
            rows="2"
            placeholder="Optional summary note (e.g., Please address these review comments and update the unit tests)…"
          >${esc(state.reviewSummaryNote || '')}</textarea>
          <div class="review-modal-list">${itemsHtml}</div>
        </div>
        <div class="review-modal-footer">
          <button type="button" class="ghost-btn sm" data-action="copy-review-markdown" title="Copy formatted Markdown review to clipboard">📋 Copy Markdown</button>
          <div class="review-modal-footer-right">
            <button type="button" class="ghost-btn sm" data-action="close-review-modal">Cancel</button>
            <button type="button" class="ghost-btn sm primary" data-action="submit-review-batch" ${state.sendingReview ? 'disabled' : ''}>${state.sendingReview ? 'Sending…' : `Send Review to Chat (${count})`}</button>
          </div>
        </div>
      </div>`
    );
  }

  function isRowHighlightedByTarget(wt, filePath, ln) {
    const t = state.highlightedTarget;
    if (!t || !wt) return false;
    if (
      t.rootPath !== wt.path ||
      t.filePath !== filePath ||
      t.diffMode !== state.diffMode ||
      (t.commitSha || '') !== (state.selectedCommit || '')
    ) {
      return false;
    }
    if (!Number.isInteger(t.startLine) || !Number.isInteger(t.endLine)) {
      return false;
    }
    const lineNo = t.side === 'old' ? ln.oldNo : (ln.newNo ?? ln.oldNo);
    if (!Number.isInteger(lineNo)) return false;
    if (t.side === 'old' && ln.oldNo === null) return false;
    if (t.side !== 'old' && ln.newNo === null && ln.type === 'del') return false;
    return lineNo >= t.startLine && lineNo <= t.endLine;
  }

  function renderDiffRow(filePath, ln, rowIdx, extraCls = '') {
    const wt = getActiveRoot();
    const draft = state.activeCommentDraft;
    const isSelectedForComment =
      draft &&
      draft.filePath === filePath &&
      draft.startRowIdx >= 0 &&
      rowIdx >= Math.min(draft.startRowIdx, draft.endRowIdx) &&
      rowIdx <= Math.max(draft.startRowIdx, draft.endRowIdx);
    const isTargetHighlighted = isRowHighlightedByTarget(wt, filePath, ln);

    const cls =
      ln.type === 'add'
        ? 'line-add'
        : ln.type === 'del'
        ? 'line-del'
        : `line-ctx${extraCls ? ` ${extraCls}` : ''}`;
    const selectedCls = isSelectedForComment ? ' selected-for-comment' : '';
    const targetCls = isTargetHighlighted ? ' target-highlighted-line' : '';
    const prefix = formatDiffRowPrefix(ln.type);

    const rowHtml = `<tr class="diff-line ${cls}${selectedCls}${targetCls}" data-diff-file="${esc(filePath)}" data-row-idx="${rowIdx}" data-old-no="${ln.oldNo ?? ''}" data-new-no="${ln.newNo ?? ''}" data-line-type="${esc(ln.type)}"><td class="line-num line-num-old" data-line-gutter="${rowIdx}" title="Click to comment · Shift+Click or drag for multi-line range"><button type="button" class="line-comment-btn" data-comment-gutter="${rowIdx}" tabindex="-1" title="Comment on this diff line (Shift+Click for range)">+</button><span>${ln.oldNo ?? ''}</span></td><td class="line-num line-num-new" data-line-gutter="${rowIdx}" title="Click to comment · Shift+Click or drag for multi-line range">${ln.newNo ?? ''}</td><td class="line-prefix">${prefix}</td><td class="line-code">${esc(ln.text)}</td></tr>`;
    const queuedAtRow = state.reviewComments
      .map((c, idx) => ({ comment: c, idx }))
      .filter(
        ({ comment: c }) =>
          wt &&
          c.rootPath === wt.path &&
          c.filePath === filePath &&
          c.diffMode === state.diffMode &&
          (c.commitSha || '') === (state.selectedCommit || '') &&
          Math.max(c.startRowIdx, c.endRowIdx) === rowIdx &&
          (!draft || draft.editingCommentId !== c.id)
      );
    const queuedRowsHtml = queuedAtRow
      .map(
        ({ comment: c, idx }) =>
          `<tr class="diff-inline-widget-row"><td colspan="4">${renderQueuedCommentCardHtml(c, idx)}</td></tr>`
      )
      .join('');

    const showDraftHere =
      draft &&
      draft.filePath === filePath &&
      draft.startRowIdx >= 0 &&
      Math.max(draft.startRowIdx, draft.endRowIdx) === rowIdx;
    const draftRowHtml = showDraftHere
      ? `<tr class="diff-inline-widget-row"><td colspan="4">${renderInlineCommentDraftCardHtml(filePath)}</td></tr>`
      : '';

    return `${rowHtml}${queuedRowsHtml}${draftRowHtml}`;
  }

  function renderExpandedRange(filePath, fileRows, lines, newStart, oldStart, count) {
    if (!lines || count <= 0) return '';
    const rows = [];
    for (let i = 0; i < count; i++) {
      const newNo = newStart + i;
      const oldNo = oldStart + i;
      if (newNo < 1 || newNo > lines.length) break;
      const rowObj = {
        rowIdx: fileRows.length,
        type: 'ctx',
        oldNo,
        newNo,
        text: lines[newNo - 1] ?? '',
      };
      fileRows.push(rowObj);
      rows.push(
        renderDiffRow(filePath, rowObj, rowObj.rowIdx, 'line-ctx-expanded')
      );
    }
    if (rows.length === 0) return '';
    return `<table class="diff-table"><tbody>${rows.join('')}</tbody></table>`;
  }

  function computeGapBounds(f, gapIdx, fileInfo) {
    const hunks = f.hunks || [];
    if (hunks.length === 0) return null;

    if (gapIdx === 0) {
      const h0 = hunks[0];
      const gapNewStart = 1;
      const gapOldStart = 1;
      const gapSize = Math.max(0, (h0.newStart ?? 1) - 1);
      return { gapNewStart, gapOldStart, gapSize };
    }

    if (gapIdx < hunks.length) {
      const prev = hunks[gapIdx - 1];
      const next = hunks[gapIdx];
      const gapNewStart = (prev.newStart ?? 1) + (prev.newCount ?? 0);
      const gapOldStart = (prev.oldStart ?? 1) + (prev.oldCount ?? 0);
      const gapNewEnd = (next.newStart ?? 1) - 1;
      const gapSize = Math.max(0, gapNewEnd - gapNewStart + 1);
      return { gapNewStart, gapOldStart, gapSize };
    }

    // Trailing gap after last hunk
    if (f.status === 'A') return null;
    const last = hunks[hunks.length - 1];
    const gapNewStart = (last.newStart ?? 1) + (last.newCount ?? 0);
    const gapOldStart = (last.oldStart ?? 1) + (last.oldCount ?? 0);
    if (!fileInfo) {
      if (getContextLines() >= 10000) return null;
      return { gapNewStart, gapOldStart, gapSize: null };
    }
    const gapSize = Math.max(0, fileInfo.totalLines - gapNewStart + 1);
    return { gapNewStart, gapOldStart, gapSize };
  }

  function renderGapSection(wt, f, gapIdx, fileRows) {
    if (
      f.isBinary ||
      f.status === 'D' ||
      f.status === 'U' ||
      !f.hunks?.length
    ) {
      return '';
    }
    const fileInfo = getCachedFileLines(wt, f);
    const bounds = computeGapBounds(f, gapIdx, fileInfo);
    if (!bounds) return '';

    const { gapNewStart, gapOldStart, gapSize } = bounds;
    if (gapSize !== null && gapSize <= 0) return '';

    const isFirst = gapIdx === 0;
    const isLast = gapIdx === f.hunks.length;

    if (gapSize === null) {
      return `
        <div class="ctx-gap-bar" data-gap-file="${esc(f.path)}" data-gap-idx="${gapIdx}">
          <span class="ctx-gap-info">⋯ Below last hunk (line ${gapNewStart}+)</span>
          <div class="ctx-gap-actions">
            <button type="button" class="ctx-gap-btn" data-gap-action="down" title="Expand 10 lines below last hunk">+10 ↓</button>
            <button type="button" class="ctx-gap-btn" data-gap-action="all" title="Expand all remaining lines to end of file">All ↓</button>
          </div>
        </div>`;
    }

    const exp = getGapExpansion(f.path, gapIdx);
    const topCount = Math.min(exp.fromStart, gapSize);
    const botCount = Math.min(exp.fromEnd, Math.max(0, gapSize - topCount));
    const expandedCount = topCount + botCount;
    const hiddenCount = gapSize - expandedCount;

    const topHtml =
      topCount > 0 && fileInfo?.lines
        ? renderExpandedRange(
            f.path,
            fileRows,
            fileInfo.lines,
            gapNewStart,
            gapOldStart,
            topCount
          )
        : '';
    const botHtml =
      botCount > 0 && fileInfo?.lines
        ? renderExpandedRange(
            f.path,
            fileRows,
            fileInfo.lines,
            gapNewStart + gapSize - botCount,
            gapOldStart + gapSize - botCount,
            botCount
          )
        : '';

    const infoText =
      hiddenCount > 0
        ? `⋯ ${hiddenCount} hidden line${hiddenCount === 1 ? '' : 's'}${expandedCount > 0 ? ` (${expandedCount} expanded)` : ''}`
        : `↕ ${expandedCount} context line${expandedCount === 1 ? '' : 's'} expanded`;

    const btns = [];
    if (hiddenCount > 0) {
      if (isFirst) {
        btns.push(
          '<button type="button" class="ctx-gap-btn" data-gap-action="up" title="Expand 10 lines above hunk">+10 ↑</button>'
        );
      } else if (isLast) {
        btns.push(
          '<button type="button" class="ctx-gap-btn" data-gap-action="down" title="Expand 10 lines below hunk">+10 ↓</button>'
        );
      } else {
        btns.push(
          '<button type="button" class="ctx-gap-btn" data-gap-action="down" title="Expand 10 lines downward from previous hunk">+10 ↓</button>'
        );
        btns.push(
          '<button type="button" class="ctx-gap-btn" data-gap-action="up" title="Expand 10 lines upward from next hunk">+10 ↑</button>'
        );
      }
      if (hiddenCount > 10 || (!isFirst && !isLast)) {
        btns.push(
          `<button type="button" class="ctx-gap-btn" data-gap-action="all" title="Expand all ${hiddenCount} hidden lines">All (${hiddenCount})</button>`
        );
      }
    }
    if (expandedCount > 0) {
      btns.push(
        '<button type="button" class="ctx-gap-btn" data-gap-action="shrink" title="Shrink 10 expanded context lines">&#8722;10</button>'
      );
      btns.push(
        '<button type="button" class="ctx-gap-btn" data-gap-action="reset" title="Collapse expanded context lines in this section">Reset</button>'
      );
    }

    const barHtml = `
      <div class="ctx-gap-bar" data-gap-file="${esc(f.path)}" data-gap-idx="${gapIdx}">
        <span class="ctx-gap-info">${infoText}</span>
        <div class="ctx-gap-actions">${btns.join('')}</div>
      </div>`;

    return `${topHtml}${barHtml}${botHtml}`;
  }

  function renderDiffSection(wt) {
    document.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === state.diffMode);
    });

    const commitsBox = $('commits-box');
    const commits = state.diffData?.commits || [];
    const commitsScope = state.diffData?.commitsScope || 'branch';
    const showCommitsBox =
      commits.length > 0 &&
      (state.diffMode === 'branch' ||
        (state.diffMode === 'all' && commitsScope === 'branch'));

    if (showCommitsBox) {
      commitsBox.classList.remove('hidden');
      const titleLabel =
        commitsScope === 'branch'
          ? `Stacked Commits (${commits.length} ahead of <code>${esc(wt.baseRef)}</code>) — click to filter`
          : `Recent Commits on <code>${esc(wt.branch)}</code> (${commits.length}) — click to inspect`;
      const headerRow = `
        <div class="commits-header">
          <span>${titleLabel}</span>
          ${state.selectedCommit ? '<button type="button" class="ghost-btn sm" data-clear-commit="1">Show All</button>' : ''}
        </div>`;
      const rows = commits
        .map(
          (c) => `
          <div class="commit-row${state.selectedCommit === c.sha ? ' active' : ''}" data-commit-sha="${esc(c.sha)}" title="Click to inspect commit ${esc(c.sha)} (${esc(c.author)})">
            ${renderCommitGpgSlotHtml(c)}
            <span class="commit-sha">${esc(c.sha)}</span>
            <span class="commit-msg">${esc(c.subject)}</span>
            <span class="commit-time">${esc(c.relTime)}</span>
          </div>`
        )
        .join('');
      setHtmlIfChanged(commitsBox, headerRow + rows);
    } else {
      commitsBox.classList.add('hidden');
      setHtmlIfChanged(commitsBox, '');
    }

    updateContextStepperUI();
    renderDiffFiles(wt);
  }

  function renderDiffFiles(wt) {
    syncCommentDraftTextFromDom();
    const container = $('diff-container');
    const summaryEl = $('diff-summary-stats');

    if (state.loadingDiff && !state.diffData) {
      setHtmlIfChanged(container, '<div class="empty-state">Loading diff…</div>');
      summaryEl.textContent = '';
      return;
    }

    const allFiles = state.diffData?.files || [];
    const filter = state.fileFilter.trim().toLowerCase();
    const files = filter
      ? allFiles.filter((f) => f.path.toLowerCase().includes(filter))
      : allFiles;

    summaryEl.innerHTML = `${files.length} file${files.length === 1 ? '' : 's'} · <span class="stat-add">+${state.diffData?.totalAdditions || 0}</span> <span class="stat-del">-${state.diffData?.totalDeletions || 0}</span>`;

    if (files.length === 0) {
      setHtmlIfChanged(
        container,
        `<div class="empty-state">No changes in <strong>${esc(state.diffMode)}</strong> view.</div>`
      );
      return;
    }

    state.renderedFileRows.clear();

    const cardsHtml = files
      .map((f) => {
        const collapsed = state.collapsedFiles.has(f.path);
        const isFocusedCard = state.selectedChangeFile === f.path;
        const fullFilePath = `${wt.path}/${f.path}`;
        const statusLabel = f.status === 'U' ? 'U' : f.status;
        const pathLabel = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;

        const fileRows = [];
        state.renderedFileRows.set(f.path, fileRows);

        const stateBadges = [];
        const cardActions = [];
        const ds = f.dirtyState;

        const fileQueuedCommentsCount = state.reviewComments.filter(
          (c) => c.rootPath === wt.path && c.filePath === f.path
        ).length;
        if (fileQueuedCommentsCount > 0) {
          stateBadges.push(
            `<span class="status-pill comment-count-pill" title="${fileQueuedCommentsCount} comment(s) queued in Review Batch">${fileQueuedCommentsCount} 💬</span>`
          );
        }

        if (!state.selectedCommit && state.diffMode !== 'branch' && ds) {
          if (ds.staged) {
            stateBadges.push('<span class="status-pill ahead">staged</span>');
          }
          if (ds.unstaged) {
            stateBadges.push('<span class="status-pill dirty">unstaged</span>');
          }
          if (ds.untracked) {
            stateBadges.push(
              '<span class="status-pill inherited">untracked</span>'
            );
          }

          if (ds.unstaged || ds.untracked) {
            cardActions.push(
              `<button type="button" class="row-btn" data-action="stage-file" data-file="${esc(f.path)}" title="Stage file">+ Stage</button>`
            );
            cardActions.push(
              `<button type="button" class="row-btn danger" data-action="prompt-discard-file" data-file="${esc(f.path)}" data-untracked="${ds.untracked ? '1' : '0'}" title="Discard changes">Discard</button>`
            );
          }
          if (ds.staged) {
            cardActions.push(
              `<button type="button" class="row-btn" data-action="unstage-file" data-file="${esc(f.path)}" title="Unstage file">&#8722; Unstage</button>`
            );
          }
        }

        let bodyHtml = '';
        if (!collapsed) {
          const fileLevelQueuedHtml = state.reviewComments
            .map((c, idx) => ({ comment: c, idx }))
            .filter(
              ({ comment: c }) =>
                c.rootPath === wt.path &&
                c.filePath === f.path &&
                c.diffMode === state.diffMode &&
                (c.commitSha || '') === (state.selectedCommit || '') &&
                c.startRowIdx < 0 &&
                (!state.activeCommentDraft ||
                  state.activeCommentDraft.editingCommentId !== c.id)
            )
            .map(({ comment: c, idx }) => renderQueuedCommentCardHtml(c, idx))
            .join('');
          const fileLevelDraftHtml =
            state.activeCommentDraft &&
            state.activeCommentDraft.filePath === f.path &&
            state.activeCommentDraft.startRowIdx < 0
              ? renderInlineCommentDraftCardHtml(f.path)
              : '';
          const fileTopWidgets =
            fileLevelQueuedHtml || fileLevelDraftHtml
              ? `<div class="file-level-comment-wrap">${fileLevelQueuedHtml}${fileLevelDraftHtml}</div>`
              : '';

          if (f.isBinary) {
            bodyHtml = `<div class="file-hunks">${fileTopWidgets}<div class="empty-state">Binary or large file not shown</div></div>`;
          } else if (f.hunks.length === 0) {
            bodyHtml = `<div class="file-hunks">${fileTopWidgets}<div class="empty-state">Empty file or mode-only change</div></div>`;
          } else {
            const parts = [fileTopWidgets];
            for (let idx = 0; idx < f.hunks.length; idx++) {
              parts.push(renderGapSection(wt, f, idx, fileRows));
              const h = f.hunks[idx];
              const rowsHtml = h.lines
                .map((ln) => {
                  const rowObj = {
                    rowIdx: fileRows.length,
                    type: ln.type,
                    oldNo: ln.oldNo ?? null,
                    newNo: ln.newNo ?? null,
                    text: ln.text ?? '',
                    hunkHeader: h.header,
                  };
                  fileRows.push(rowObj);
                  return renderDiffRow(f.path, rowObj, rowObj.rowIdx);
                })
                .join('');
              parts.push(`
                <div class="hunk-block">
                  <div class="hunk-header">${esc(h.header)}</div>
                  <table class="diff-table"><tbody>${rowsHtml}</tbody></table>
                </div>`);
            }
            parts.push(renderGapSection(wt, f, f.hunks.length, fileRows));
            bodyHtml = `<div class="file-hunks">${parts.join('')}</div>`;
          }
        }

        return `
          <div class="file-card${isFocusedCard ? ' focused-card' : ''}" data-file-card="${esc(f.path)}">
            <div class="file-card-header" data-toggle-file="${esc(f.path)}">
              <div class="file-card-left">
                <span>${collapsed ? '&#9656;' : '&#9662;'}</span>
                <span class="file-status st-${esc(f.status)}">${esc(statusLabel)}</span>
                <span class="file-path" title="${esc(pathLabel)}">${esc(pathLabel)}</span>
              </div>
              <div class="file-card-right">
                ${stateBadges.join('')}
                <span class="stat-add">+${f.additions}</span>
                <span class="stat-del">-${f.deletions}</span>
                ${cardActions.join('')}
                <button type="button" class="row-btn comment-btn" data-action="comment-file" data-file="${esc(f.path)}" title="Add a review comment on this file diff to Chat">💬 Comment</button>
                <button type="button" class="row-btn" data-action="copy-diff-link" data-file="${esc(f.path)}" title="Copy clickable Markdown diff pill for this file">🔗 Link</button>
                <button type="button" class="row-btn" data-action="copy-path" data-path="${esc(f.path)}" title="Copy relative path">Copy</button>
                <button type="button" class="row-btn" data-action="open-file" data-path="${esc(fullFilePath)}" title="Open in native File Preview">Open</button>
              </div>
            </div>
            ${bodyHtml}
          </div>`;
      })
      .join('');

    setHtmlIfChanged(container, cardsHtml);
  }

  function renderActiveWorkspace() {
    renderHeaderAndRoots();
    renderReviewBatchBar();
    renderReviewModal();
    const wt = getActiveRoot();
    if (!wt || !wt.existsOnDisk || !wt.isGitRepo) return;
    renderSourceControlPanel(wt);
    renderDiffSection(wt);
  }

  function seedPreloadedFileLines(wtPath, diffData) {
    if (!wtPath || !diffData?.preloadedFileLines) return;
    const files = diffData.files || [];
    for (const [filePath, entry] of Object.entries(diffData.preloadedFileLines)) {
      const fileObj = files.find((f) => f.path === filePath);
      if (!fileObj || !entry) continue;
      const key = `${wtPath}::${diffData.mode || state.diffMode}::${state.selectedCommit}::${fileObj.path}::${fileObj.additions}:${fileObj.deletions}`;
      state.fileLinesCache.set(key, {
        totalLines: Number(entry.totalLines ?? 0),
        lines: Array.isArray(entry.lines) ? entry.lines : [],
      });
    }
  }

  async function loadDiffForSelected({
    silent = false,
    targetFile = '',
    targetLines = '',
    hasExplicitRev = true,
  } = {}) {
    const wt = getActiveRoot();
    if (!wt || !wt.existsOnDisk || !wt.isGitRepo) {
      state.diffData = null;
      renderActiveWorkspace();
      return;
    }

    if (!silent) {
      state.loadingDiff = true;
      renderActiveWorkspace();
    }
    try {
      const data = await apiGet('/api/diff', {
        path: wt.path,
        mode: state.diffMode,
        baseRef: wt.baseRef,
        commit: state.selectedCommit,
        context: getContextLines(),
        targetFile,
        targetLines,
        hasExplicitRev: hasExplicitRev ? '1' : '0',
      });
      if (state.selectedRootPath === wt.path) {
        if (data.mode && data.mode !== state.diffMode && !state.selectedCommit) {
          state.diffMode = data.mode;
        }
        state.diffData = data;
        seedPreloadedFileLines(wt.path, data);
      }
    } catch (err) {
      if (!silent) {
        showToast(`Diff error: ${err.message}`);
      }
    } finally {
      state.loadingDiff = false;
      renderActiveWorkspace();
    }
  }

  let pendingSelectionQuote = null; // { filePath, startRowIdx, endRowIdx, quotedText }

  function hideSelectionQuotePill() {
    pendingSelectionQuote = null;
    $('selection-quote-pill')?.classList.add('hidden');
  }

  function openDiffCommentDraft(filePath, rowIdx, { extendRange = false, quotedText = '' } = {}) {
    const wt = getActiveRoot();
    if (!wt || !filePath) return;
    syncCommentDraftTextFromDom();

    const prev = state.activeCommentDraft;
    if (extendRange && prev && prev.filePath === filePath && prev.anchorRowIdx >= 0 && rowIdx >= 0) {
      prev.startRowIdx = Math.min(prev.anchorRowIdx, rowIdx);
      prev.endRowIdx = Math.max(prev.anchorRowIdx, rowIdx);
      if (quotedText) prev.quotedText = quotedText;
    } else {
      const preservedText =
        prev && prev.filePath === filePath ? prev.text || '' : '';
      state.activeCommentDraft = {
        filePath,
        anchorRowIdx: rowIdx,
        startRowIdx: rowIdx,
        endRowIdx: rowIdx,
        text: preservedText,
        quotedText: quotedText || '',
      };
    }

    state.collapsedFiles.delete(filePath);
    renderDiffFiles(wt);
    focusCommentDraftTextarea();
  }

  async function selectRootRepository(nextRootPath) {
    if (!nextRootPath) return;
    const changed = state.selectedRootPath !== nextRootPath;
    state.selectedRootPath = nextRootPath;
    if (changed) {
      state.selectedChangeFile = '';
      state.selectedCommit = '';
      state.discardPrompt = null;
      state.activeCommentDraft = null;
      state.highlightedTarget = null;
      hideSelectionQuotePill();
      state.collapsedFiles.clear();
      state.gapExpansions.clear();
      state.diffData = null;
    }
    renderActiveWorkspace();
    await loadDiffForSelected({ silent: false });
  }

  function resolveDeepLinkRoot(repoQuery) {
    const raw = String(repoQuery || '')
      .trim()
      .replace(/\.local$/i, '')
      .replace(/\/+$/, '');
    if (!raw) return null;
    const lower = raw.toLowerCase();

    for (const r of state.roots) {
      if (r.path === raw) return r;
      const base = (r.path.split('/').pop() || '').toLowerCase();
      const name = String(r.name || '').toLowerCase();
      const display = String(r.displayName || '').toLowerCase();
      const label = String(r.label || '').toLowerCase();
      if (
        base === lower ||
        name === lower ||
        display === lower ||
        (label && label === lower)
      ) {
        return r;
      }
    }
    for (const r of state.roots) {
      if (r.path.toLowerCase().endsWith(`/${lower}`)) {
        return r;
      }
    }
    return null;
  }

  function findFileInDiffData(targetFile) {
    if (!targetFile) return null;
    const files = state.diffData?.files || [];
    const exact = files.find(
      (f) => f.path === targetFile || f.oldPath === targetFile
    );
    if (exact) return exact;
    return (
      files.find((f) => f.path.endsWith(`/${targetFile}`)) || null
    );
  }

  function isLinePresentInHunks(fileObj, lineRange) {
    if (!fileObj || !lineRange) return true;
    for (const h of fileObj.hunks || []) {
      for (const l of h.lines || []) {
        const lineNo =
          lineRange.side === 'old' ? l.oldNo : (l.newNo ?? l.oldNo);
        if (
          Number.isInteger(lineNo) &&
          lineNo >= lineRange.startLine &&
          lineNo <= lineRange.endLine &&
          (lineRange.side === 'old' ? l.oldNo !== null : l.newNo !== null)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  async function ensureTargetLineGapExpanded(wt, fileObj, lineRange) {
    if (!wt || !fileObj || !lineRange || isLinePresentInHunks(fileObj, lineRange)) {
      return false;
    }
    try {
      const fileInfo = await ensureFileLines(wt, fileObj);
      if (!fileInfo || !fileInfo.totalLines) return false;
      const hunks = fileObj.hunks || [];
      let expandedAny = false;
      for (let gapIdx = 0; gapIdx <= hunks.length; gapIdx++) {
        const bounds = computeGapBounds(fileObj, gapIdx, fileInfo);
        if (!bounds || !bounds.gapSize || bounds.gapSize <= 0) continue;
        const { gapNewStart, gapOldStart, gapSize } = bounds;
        const gapStart = lineRange.side === 'old' ? gapOldStart : gapNewStart;
        const gapEnd = gapStart + gapSize - 1;
        if (lineRange.endLine >= gapStart && lineRange.startLine <= gapEnd) {
          const exp = getGapExpansion(fileObj.path, gapIdx);
          if (gapIdx === 0) {
            const neededFromEnd = Math.min(
              gapSize,
              gapEnd - Math.max(gapStart, lineRange.startLine - 4) + 1
            );
            exp.fromEnd = Math.max(exp.fromEnd, neededFromEnd);
          } else {
            const neededFromStart = Math.min(
              gapSize,
              Math.min(gapEnd, lineRange.endLine + 4) - gapStart + 1
            );
            exp.fromStart = Math.max(exp.fromStart, neededFromStart);
          }
          expandedAny = true;
        }
      }
      return expandedAny;
    } catch {
      return false;
    }
  }

  async function applyPendingDeepLink({ skipDiffFetch = false } = {}) {
    const dl = state.pendingDeepLink;
    if (!dl || state.roots.length === 0) return false;
    state.pendingDeepLink = null;

    const matchedRoot = dl.repo ? resolveDeepLinkRoot(dl.repo) : getActiveRoot();
    if (matchedRoot) {
      state.selectedRootPath = matchedRoot.path;
    } else if (!state.selectedRootPath) {
      state.selectedRootPath = state.roots[0].path;
    }

    if (!skipDiffFetch) {
      state.diffMode = dl.mode || 'working';
      state.selectedCommit = dl.commit || '';
    }
    state.activeCommentDraft = null;
    hideSelectionQuotePill();
    state.gapExpansions.clear();

    if (dl.file && state.fileFilter) {
      const filterLower = state.fileFilter.trim().toLowerCase();
      if (!dl.file.toLowerCase().includes(filterLower)) {
        state.fileFilter = '';
        if ($('file-filter')) $('file-filter').value = '';
      }
    }

    if (!skipDiffFetch) {
      await loadDiffForSelected({
        silent: false,
        targetFile: dl.file || '',
        targetLines: dl.rawLines || '',
        hasExplicitRev: Boolean(dl.hasExplicitRev),
      });
    }

    const wt = getActiveRoot();
    if (!wt) return true;

    // Snap commit prefix to exact short SHA in commits list so the active commit row highlights
    if (state.selectedCommit && Array.isArray(state.diffData?.commits)) {
      const commitLower = state.selectedCommit.toLowerCase();
      const matchedCommit = state.diffData.commits.find(
        (c) =>
          c.sha.toLowerCase().startsWith(commitLower) ||
          commitLower.startsWith(c.sha.toLowerCase())
      );
      if (matchedCommit && matchedCommit.sha !== state.selectedCommit) {
        state.selectedCommit = matchedCommit.sha;
      }
    }

    let fileObj = findFileInDiffData(dl.file);
    // If no explicit `rev`/`mode` was provided in the link and the file is not in `working`,
    // fallback to `all` (`All vs Base`) so committed branch changes are still found.
    if (!fileObj && dl.file && !dl.hasExplicitRev && state.diffMode === 'working') {
      state.diffMode = 'all';
      await loadDiffForSelected({
        silent: false,
        targetFile: dl.file || '',
        targetLines: dl.rawLines || '',
        hasExplicitRev: true,
      });
      fileObj = findFileInDiffData(dl.file);
    }

    if (fileObj) {
      state.collapsedFiles.delete(fileObj.path);
      state.selectedChangeFile = fileObj.path;
      if (dl.lineRange) {
        seedPreloadedFileLines(wt.path, state.diffData);
        await ensureTargetLineGapExpanded(wt, fileObj, dl.lineRange);
        state.highlightedTarget = {
          rootPath: wt.path,
          diffMode: state.diffMode,
          commitSha: state.selectedCommit,
          filePath: fileObj.path,
          side: dl.lineRange.side,
          startLine: dl.lineRange.startLine,
          endLine: dl.lineRange.endLine,
        };
      } else {
        state.highlightedTarget = null;
      }
      renderActiveWorkspace();

      requestAnimationFrame(() => {
        const cardEl = document.querySelector(
          `[data-file-card="${CSS.escape(fileObj.path)}"]`
        );
        const lineEl =
          cardEl?.querySelector('tr.target-highlighted-line') || cardEl;
        lineEl?.scrollIntoView({ behavior: 'auto', block: 'center' });
      });

      const toastSuffix = dl.lineRange ? ` (${dl.lineRange.displayLabel})` : '';
      showToast(`Jumped to ${fileObj.path}${toastSuffix}`);
    } else {
      renderActiveWorkspace();
      if (dl.file) {
        showToast(`Opened ${wt.displayName || wt.name} (${dl.file} not in ${state.diffMode} diff)`);
      }
    }

    return true;
  }

  async function refreshAll({ silent = false } = {}) {
    try {
      const data = await apiGet('/api/roots', {
        conversationId: state.conversationId,
      });

      if (data.uiAssetVersion) {
        if (
          state.uiAssetVersion &&
          state.uiAssetVersion !== data.uiAssetVersion
        ) {
          window.location.reload();
          return;
        }
        state.uiAssetVersion = data.uiAssetVersion;
      }

      state.roots = data.repositories || [];
      state.projectId = data.projectId || '';
      state.projectName = data.projectName || '';
      state.isForkedSession = Boolean(data.isForkedSession);
      state.parentConversationId = data.parentConversationId || '';

      if (state.roots.length === 0) {
        state.selectedRootPath = '';
        state.diffData = null;
        renderHeaderAndRoots();
        return;
      }

      if (state.pendingDeepLink) {
        await applyPendingDeepLink();
        return;
      }

      if (!state.roots.some((r) => r.path === state.selectedRootPath)) {
        state.selectedRootPath = state.roots[0].path;
        state.selectedChangeFile = '';
        state.selectedCommit = '';
        state.discardPrompt = null;
        state.activeCommentDraft = null;
        state.highlightedTarget = null;
        hideSelectionQuotePill();
        state.collapsedFiles.clear();
        state.gapExpansions.clear();
      }

      renderActiveWorkspace();
      await loadDiffForSelected({ silent });
    } catch (err) {
      if (!silent) {
        setHtmlIfChanged(
          $('empty-root-state'),
          `<div class="empty-state">Error loading session repositories: ${esc(err.message)}</div>`
        );
      }
    }
  }

  async function performStage(paths, all = false) {
    const wt = getActiveRoot();
    if (!wt) return;
    try {
      await apiPost('/api/stage', { path: wt.path, paths, all });
      showToast(all ? 'Staged all changes' : `Staged ${paths[0]}`);
      await refreshAll({ silent: true });
    } catch (err) {
      showToast(err.message);
    }
  }

  async function performUnstage(paths, all = false) {
    const wt = getActiveRoot();
    if (!wt) return;
    try {
      await apiPost('/api/unstage', { path: wt.path, paths, all });
      showToast(all ? 'Unstaged all changes' : `Unstaged ${paths[0]}`);
      await refreshAll({ silent: true });
    } catch (err) {
      showToast(err.message);
    }
  }

  async function executeDiscardPrompt() {
    const wt = getActiveRoot();
    const p = state.discardPrompt;
    if (!wt || !p) return;
    try {
      await apiPost('/api/discard', {
        path: wt.path,
        paths: p.all ? [] : [p.filePath],
        all: Boolean(p.all),
      });
      state.discardPrompt = null;
      showToast(p.all ? 'Discarded all changes' : `Discarded ${p.filePath}`);
      await refreshAll({ silent: true });
    } catch (err) {
      showToast(err.message);
    }
  }

  async function performCommit() {
    const wt = getActiveRoot();
    if (!wt || state.committing) return;
    const inputEl = $('commit-input');
    const message = (inputEl?.value || '').trim();
    if (!message) {
      showToast('Please enter a commit message');
      inputEl?.focus();
      return;
    }

    const stagedCount = wt.counts?.staged || 0;
    const totalDirty = wt.counts?.totalDirty || 0;
    const stageAll = !state.amendCommit && stagedCount === 0 && totalDirty > 0;

    state.committing = true;
    renderSourceControlPanel(wt);

    try {
      const res = await apiPost('/api/commit', {
        path: wt.path,
        message,
        amend: state.amendCommit,
        stageAll,
      });
      if (inputEl) inputEl.value = '';
      state.amendCommit = false;
      if ($('chk-amend')) $('chk-amend').checked = false;
      showToast(
        `${res.amended ? 'Amended' : 'Committed'} ${res.sha}: ${res.subject}`
      );
      await refreshAll({ silent: true });
    } catch (err) {
      showToast(err.message);
    } finally {
      state.committing = false;
      const currentWt = getActiveRoot();
      if (currentWt) renderSourceControlPanel(currentWt);
    }
  }

  // Line Gutter Drag Selection for Multi-Line Comment Ranges
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const gutterEl = e.target.closest('[data-line-gutter], [data-comment-gutter]');
    if (!gutterEl) return;
    const rowTr = gutterEl.closest('tr.diff-line');
    if (!rowTr) return;
    const filePath = rowTr.dataset.diffFile;
    const rowIdx = Number(rowTr.dataset.rowIdx);
    if (!filePath || !Number.isInteger(rowIdx)) return;

    e.preventDefault();
    hideSelectionQuotePill();

    if (
      e.shiftKey &&
      state.activeCommentDraft &&
      state.activeCommentDraft.filePath === filePath &&
      state.activeCommentDraft.anchorRowIdx >= 0
    ) {
      openDiffCommentDraft(filePath, rowIdx, { extendRange: true });
      state.draggingCommentRange = {
        filePath,
        anchorRowIdx: state.activeCommentDraft.anchorRowIdx,
      };
      return;
    }

    state.draggingCommentRange = { filePath, anchorRowIdx: rowIdx };
    openDiffCommentDraft(filePath, rowIdx, { extendRange: false });
  });

  document.addEventListener('mouseover', (e) => {
    const drag = state.draggingCommentRange;
    if (!drag) return;
    const rowTr = e.target.closest('tr.diff-line');
    if (!rowTr || rowTr.dataset.diffFile !== drag.filePath) return;
    const rowIdx = Number(rowTr.dataset.rowIdx);
    if (!Number.isInteger(rowIdx)) return;
    if (
      state.activeCommentDraft &&
      state.activeCommentDraft.filePath === drag.filePath
    ) {
      const nextStart = Math.min(drag.anchorRowIdx, rowIdx);
      const nextEnd = Math.max(drag.anchorRowIdx, rowIdx);
      if (
        state.activeCommentDraft.startRowIdx !== nextStart ||
        state.activeCommentDraft.endRowIdx !== nextEnd
      ) {
        syncCommentDraftTextFromDom();
        state.activeCommentDraft.startRowIdx = nextStart;
        state.activeCommentDraft.endRowIdx = nextEnd;
        const wt = getActiveRoot();
        if (wt) renderDiffFiles(wt);
      }
    }
  });

  document.addEventListener('mouseup', () => {
    if (state.draggingCommentRange) {
      state.draggingCommentRange = null;
      focusCommentDraftTextarea();
      return;
    }

    // Detect text selection inside `.diff-table` to offer floating "Comment on Selection" pill
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        hideSelectionQuotePill();
        return;
      }
      const selectedText = sel.toString();
      if (!selectedText.trim()) {
        hideSelectionQuotePill();
        return;
      }
      const range = sel.getRangeAt(0);
      const startNode =
        range.startContainer.nodeType === 1
          ? range.startContainer
          : range.startContainer.parentElement;
      const endNode =
        range.endContainer.nodeType === 1
          ? range.endContainer
          : range.endContainer.parentElement;
      const startTr = startNode?.closest?.('tr.diff-line');
      const endTr = endNode?.closest?.('tr.diff-line');
      if (!startTr || !endTr) {
        hideSelectionQuotePill();
        return;
      }
      const filePath = startTr.dataset.diffFile;
      if (!filePath || endTr.dataset.diffFile !== filePath) {
        hideSelectionQuotePill();
        return;
      }
      const r1 = Number(startTr.dataset.rowIdx);
      const r2 = Number(endTr.dataset.rowIdx);
      if (!Number.isInteger(r1) || !Number.isInteger(r2)) {
        hideSelectionQuotePill();
        return;
      }

      const rect = range.getBoundingClientRect();
      const pill = $('selection-quote-pill');
      if (!pill || (rect.width === 0 && rect.height === 0)) return;

      pendingSelectionQuote = {
        filePath,
        startRowIdx: Math.min(r1, r2),
        endRowIdx: Math.max(r1, r2),
        quotedText: selectedText.trim(),
      };

      const top = Math.max(8, rect.top - 32);
      const left = Math.min(
        window.innerWidth - 175,
        Math.max(8, rect.left + rect.width / 2 - 75)
      );
      pill.style.top = `${top}px`;
      pill.style.left = `${left}px`;
      pill.classList.remove('hidden');
    }, 10);
  });

  $('selection-quote-pill')?.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!pendingSelectionQuote) return;
    const { filePath, startRowIdx, endRowIdx, quotedText } =
      pendingSelectionQuote;
    const wt = getActiveRoot();
    if (!wt) return;
    syncCommentDraftTextFromDom();
    const preservedText =
      state.activeCommentDraft && state.activeCommentDraft.filePath === filePath
        ? state.activeCommentDraft.text || ''
        : '';
    state.activeCommentDraft = {
      filePath,
      anchorRowIdx: startRowIdx,
      startRowIdx,
      endRowIdx,
      text: preservedText,
      quotedText,
    };
    window.getSelection()?.removeAllRanges();
    hideSelectionQuotePill();
    renderDiffFiles(wt);
    focusCommentDraftTextarea();
  });

  // Event Delegation
  document.addEventListener('click', async (e) => {
    if (e.target === $('review-modal')) {
      const summaryEl = $('review-summary-input');
      if (summaryEl) state.reviewSummaryNote = summaryEl.value;
      state.reviewModalOpen = false;
      renderReviewModal();
      return;
    }
    if (e.target.closest('[data-line-gutter], [data-comment-gutter]')) {
      e.stopPropagation();
      return;
    }
    if (e.target.closest('#btn-discard-confirm')) {
      await executeDiscardPrompt();
      return;
    }
    if (e.target.closest('#btn-discard-cancel')) {
      state.discardPrompt = null;
      renderDiscardMutationBar();
      return;
    }

    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn) {
      e.stopPropagation();
      const action = actionBtn.dataset.action;

      if (action === 'comment-file') {
        const filePath = actionBtn.dataset.file || '';
        if (!filePath) return;
        const rows = state.renderedFileRows.get(filePath) || [];
        const targetRowIdx = rows.length > 0 ? 0 : -1;
        openDiffCommentDraft(filePath, targetRowIdx, { extendRange: false });
        return;
      }
      if (action === 'queue-diff-comment') {
        queueActiveCommentDraft();
        return;
      }
      if (action === 'send-diff-comment-now') {
        await sendActiveCommentDraftNow();
        return;
      }
      if (action === 'cancel-diff-comment') {
        state.activeCommentDraft = null;
        const wt = getActiveRoot();
        if (wt) renderDiffFiles(wt);
        return;
      }
      if (action === 'remove-queued-comment') {
        const id = actionBtn.dataset.commentId || '';
        state.reviewComments = state.reviewComments.filter((c) => c.id !== id);
        if (state.reviewComments.length === 0) {
          state.reviewModalOpen = false;
        }
        const wt = getActiveRoot();
        if (wt) renderDiffFiles(wt);
        renderReviewBatchBar();
        renderReviewModal();
        return;
      }
      if (action === 'edit-queued-comment') {
        const id = actionBtn.dataset.commentId || '';
        const found = state.reviewComments.find((c) => c.id === id);
        const wt = getActiveRoot();
        if (found && wt) {
          state.activeCommentDraft = {
            filePath: found.filePath,
            anchorRowIdx: found.startRowIdx,
            startRowIdx: found.startRowIdx,
            endRowIdx: found.endRowIdx,
            text: found.text || '',
            quotedText: '',
            editingCommentId: found.id,
          };
          state.collapsedFiles.delete(found.filePath);
          renderDiffFiles(wt);
          focusCommentDraftTextarea();
        }
        return;
      }
      if (action === 'send-single-queued-comment') {
        const id = actionBtn.dataset.commentId || '';
        const found = state.reviewComments.find((c) => c.id === id);
        if (found) {
          await dispatchReviewComments([found], {
            summaryNote: '',
            clearFromQueueIds: [found.id],
          });
        }
        return;
      }
      if (action === 'copy-queued-pill') {
        const id = actionBtn.dataset.commentId || '';
        const found = state.reviewComments.find((c) => c.id === id);
        if (found && found.markdownPill) {
          await navigator.clipboard?.writeText(found.markdownPill);
          showToast(`Copied diff pill for ${found.filePath} (${found.rangeLabel})`);
        }
        return;
      }
      if (action === 'clear-review-batch') {
        state.reviewComments = [];
        state.reviewSummaryNote = '';
        state.reviewModalOpen = false;
        const wt = getActiveRoot();
        if (wt) renderDiffFiles(wt);
        renderReviewBatchBar();
        renderReviewModal();
        showToast('Cleared review batch');
        return;
      }
      if (action === 'open-review-modal') {
        state.reviewModalOpen = true;
        renderReviewModal();
        setTimeout(() => {
          $('review-summary-input')?.focus();
        }, 15);
        return;
      }
      if (action === 'close-review-modal') {
        const summaryEl = $('review-summary-input');
        if (summaryEl) state.reviewSummaryNote = summaryEl.value;
        state.reviewModalOpen = false;
        renderReviewModal();
        return;
      }
      if (action === 'submit-review-batch') {
        const summaryEl = $('review-summary-input');
        if (summaryEl) state.reviewSummaryNote = summaryEl.value;
        const ids = state.reviewComments.map((c) => c.id);
        await dispatchReviewComments(state.reviewComments, {
          summaryNote: state.reviewSummaryNote,
          clearFromQueueIds: ids,
        });
        return;
      }
      if (action === 'copy-review-markdown') {
        const summaryEl = $('review-summary-input');
        if (summaryEl) state.reviewSummaryNote = summaryEl.value;
        const wt = getActiveRoot();
        try {
          const res = await apiPost('/api/send-review', {
            conversationId: state.conversationId || resolveConversationId(),
            repositoryName: wt?.name || wt?.displayName || '',
            repositoryPath: wt?.path || '',
            summaryNote: state.reviewSummaryNote,
            comments: state.reviewComments,
            dryRun: true,
          });
          if (res.markdown) {
            await navigator.clipboard?.writeText(res.markdown);
            showToast('Copied formatted Markdown review to clipboard');
          }
        } catch (err) {
          showToast(`Copy failed: ${err.message}`);
        }
        return;
      }
      if (action === 'jump-queued-comment') {
        const id = actionBtn.dataset.commentId || '';
        const found = state.reviewComments.find((c) => c.id === id);
        if (found) {
          state.reviewModalOpen = false;
          renderReviewModal();
          const lineRange = parseDiffLineRangeSpec(found.urlRangeSpec || '');
          state.pendingDeepLink = {
            repo: found.repoName || found.rootPath,
            hasExplicitRev: true,
            rev: found.commitSha || found.diffMode || 'working',
            mode: found.diffMode || 'working',
            commit: found.commitSha || '',
            file: found.filePath,
            lineRange,
          };
          await applyPendingDeepLink();
        }
        return;
      }
      if (action === 'copy-diff-link') {
        const filePath = actionBtn.dataset.file || '';
        const wt = getActiveRoot();
        if (wt && filePath) {
          const { markdownPill } = buildSidecarDiffLink(wt, filePath, '');
          await navigator.clipboard?.writeText(markdownPill);
          showToast(`Copied diff pill for ${filePath}`);
        }
        return;
      }
      if (action === 'copy-comment-diff-link') {
        const draft = state.activeCommentDraft;
        const wt = getActiveRoot();
        if (wt && draft) {
          const meta = computeCommentSelectionMeta(
            draft.filePath,
            draft.startRowIdx,
            draft.endRowIdx,
            draft.quotedText || '',
            wt
          );
          const { markdownPill } = buildSidecarDiffLink(
            wt,
            draft.filePath,
            meta.urlRangeSpec || ''
          );
          await navigator.clipboard?.writeText(markdownPill);
          showToast(
            `Copied diff pill for ${draft.filePath} (${meta.rangeLabel})`
          );
        }
        return;
      }
      if (action === 'copy-root-path' || action === 'copy-path') {
        const p = actionBtn.dataset.path || '';
        if (p) {
          await navigator.clipboard?.writeText(p);
          showToast(`Copied: ${p}`);
        }
        return;
      }
      if (action === 'open-file') {
        openInNativeFileViewer(actionBtn.dataset.path || '');
        return;
      }
      if (action === 'stage-file') {
        const file = actionBtn.dataset.file || '';
        if (file) await performStage([file], false);
        return;
      }
      if (action === 'stage-all') {
        await performStage([], true);
        return;
      }
      if (action === 'unstage-file') {
        const file = actionBtn.dataset.file || '';
        if (file) await performUnstage([file], false);
        return;
      }
      if (action === 'unstage-all') {
        await performUnstage([], true);
        return;
      }
      if (action === 'prompt-discard-file') {
        state.discardPrompt = {
          all: false,
          filePath: actionBtn.dataset.file || '',
          isUntracked: actionBtn.dataset.untracked === '1',
        };
        renderDiscardMutationBar();
        return;
      }
      if (action === 'prompt-discard-all') {
        state.discardPrompt = {
          all: true,
          filePath: '',
          isUntracked: false,
        };
        renderDiscardMutationBar();
        return;
      }
    }

    const gapBtn = e.target.closest('[data-gap-action]');
    if (gapBtn) {
      e.stopPropagation();
      const barEl = gapBtn.closest('[data-gap-file]');
      if (!barEl) return;
      const filePath = barEl.dataset.gapFile;
      const gapIdx = Number(barEl.dataset.gapIdx);
      const action = gapBtn.dataset.gapAction;
      const wt = getActiveRoot();
      const fileObj = (state.diffData?.files || []).find(
        (f) => f.path === filePath
      );
      if (!wt || !fileObj) return;

      try {
        const fileInfo = await ensureFileLines(wt, fileObj);
        const bounds = computeGapBounds(fileObj, gapIdx, fileInfo);
        if (!bounds || !bounds.gapSize || bounds.gapSize <= 0) {
          renderDiffFiles(wt);
          return;
        }
        const { gapSize } = bounds;
        const exp = getGapExpansion(filePath, gapIdx);
        const step = 10;

        if (action === 'down') {
          exp.fromStart = Math.min(gapSize - exp.fromEnd, exp.fromStart + step);
        } else if (action === 'up') {
          exp.fromEnd = Math.min(gapSize - exp.fromStart, exp.fromEnd + step);
        } else if (action === 'all') {
          if (gapIdx === 0) {
            exp.fromStart = 0;
            exp.fromEnd = gapSize;
          } else {
            exp.fromStart = gapSize;
            exp.fromEnd = 0;
          }
        } else if (action === 'shrink') {
          let rem = step;
          if (exp.fromEnd > 0) {
            const take = Math.min(exp.fromEnd, rem);
            exp.fromEnd -= take;
            rem -= take;
          }
          if (rem > 0 && exp.fromStart > 0) {
            exp.fromStart = Math.max(0, exp.fromStart - rem);
          }
        } else if (action === 'reset') {
          exp.fromStart = 0;
          exp.fromEnd = 0;
        }
        renderDiffFiles(wt);
      } catch (err) {
        showToast(`Context load error: ${err.message}`);
      }
      return;
    }

    const rootRow = e.target.closest('[data-select-root]');
    if (rootRow) {
      await selectRootRepository(rootRow.dataset.selectRoot);
      return;
    }

    const toggleGroupHdr = e.target.closest('[data-toggle-group]');
    if (toggleGroupHdr) {
      const grp = toggleGroupHdr.dataset.toggleGroup;
      if (state.collapsedChangeGroups.has(grp)) {
        state.collapsedChangeGroups.delete(grp);
      } else {
        state.collapsedChangeGroups.add(grp);
      }
      const wt = getActiveRoot();
      if (wt) renderSourceControlPanel(wt);
      return;
    }

    const changeRow = e.target.closest('[data-change-file]');
    if (changeRow) {
      const fp = changeRow.dataset.changeFile;
      const section = changeRow.dataset.changeSection;
      state.selectedChangeFile = fp;
      state.collapsedFiles.delete(fp);

      const targetMode = section === 'staged' ? 'staged' : 'unstaged';
      if (
        state.diffMode !== 'working' &&
        state.diffMode !== targetMode &&
        state.diffMode !== 'all'
      ) {
        state.diffMode = targetMode;
        state.selectedCommit = '';
        await loadDiffForSelected({ silent: false });
      } else {
        renderActiveWorkspace();
      }

      const cardEl = document.querySelector(
        `[data-file-card="${CSS.escape(fp)}"]`
      );
      cardEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }

    const modeBtn = e.target.closest('[data-mode]');
    if (modeBtn) {
      state.diffMode = modeBtn.dataset.mode;
      state.selectedCommit = '';
      state.activeCommentDraft = null;
      state.highlightedTarget = null;
      hideSelectionQuotePill();
      state.gapExpansions.clear();
      await loadDiffForSelected({ silent: false });
      return;
    }

    const clearCommitBtn = e.target.closest('[data-clear-commit]');
    if (clearCommitBtn) {
      state.selectedCommit = '';
      state.activeCommentDraft = null;
      state.highlightedTarget = null;
      hideSelectionQuotePill();
      state.gapExpansions.clear();
      await loadDiffForSelected({ silent: false });
      return;
    }

    const commitRow = e.target.closest('[data-commit-sha]');
    if (commitRow) {
      const sha = commitRow.dataset.commitSha;
      state.selectedCommit = state.selectedCommit === sha ? '' : sha;
      state.activeCommentDraft = null;
      state.highlightedTarget = null;
      hideSelectionQuotePill();
      state.gapExpansions.clear();
      await loadDiffForSelected({ silent: false });
      return;
    }

    const toggleFileHdr = e.target.closest('[data-toggle-file]');
    if (toggleFileHdr) {
      const fp = toggleFileHdr.dataset.toggleFile;
      if (state.collapsedFiles.has(fp)) state.collapsedFiles.delete(fp);
      else state.collapsedFiles.add(fp);
      const wt = getActiveRoot();
      if (wt) renderDiffFiles(wt);
      return;
    }
  });

  document.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'diff-comment-input' && state.activeCommentDraft) {
      state.activeCommentDraft.text = e.target.value;
    }
    if (e.target && e.target.id === 'review-summary-input') {
      state.reviewSummaryNote = e.target.value;
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.target && e.target.id === 'diff-comment-input') {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        sendActiveCommentDraftNow();
        return;
      }
      if (e.altKey && e.key === 'Enter') {
        e.preventDefault();
        queueActiveCommentDraft();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        state.activeCommentDraft = null;
        const wt = getActiveRoot();
        if (wt) renderDiffFiles(wt);
        return;
      }
    }
    if (state.reviewModalOpen && e.key === 'Escape') {
      e.preventDefault();
      const summaryEl = $('review-summary-input');
      if (summaryEl) state.reviewSummaryNote = summaryEl.value;
      state.reviewModalOpen = false;
      renderReviewModal();
      return;
    }
    if (
      state.reviewModalOpen &&
      e.target &&
      e.target.id === 'review-summary-input' &&
      (e.ctrlKey || e.metaKey) &&
      e.key === 'Enter'
    ) {
      e.preventDefault();
      state.reviewSummaryNote = e.target.value;
      const ids = state.reviewComments.map((c) => c.id);
      dispatchReviewComments(state.reviewComments, {
        summaryNote: state.reviewSummaryNote,
        clearFromQueueIds: ids,
      });
    }
  });

  $('btn-commit')?.addEventListener('click', () => {
    performCommit();
  });

  $('commit-input')?.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      performCommit();
    }
  });

  $('chk-amend')?.addEventListener('change', (e) => {
    state.amendCommit = e.target.checked;
    const wt = getActiveRoot();
    if (!wt) return;
    const inputEl = $('commit-input');
    if (
      state.amendCommit &&
      inputEl &&
      !inputEl.value.trim() &&
      wt.headCommitMessage
    ) {
      inputEl.value = wt.headCommitMessage;
    }
    renderSourceControlPanel(wt);
  });

  $('btn-ctx-shrink')?.addEventListener('click', async () => {
    if (state.contextStepIndex <= 0) return;
    state.contextStepIndex -= 1;
    state.gapExpansions.clear();
    updateContextStepperUI();
    await loadDiffForSelected({ silent: false });
  });

  $('btn-ctx-expand')?.addEventListener('click', async () => {
    if (state.contextStepIndex >= CONTEXT_STEPS.length - 1) return;
    state.contextStepIndex += 1;
    state.gapExpansions.clear();
    updateContextStepperUI();
    await loadDiffForSelected({ silent: false });
  });

  $('file-filter')?.addEventListener('input', (e) => {
    state.fileFilter = e.target.value || '';
    const wt = getActiveRoot();
    if (wt) renderDiffFiles(wt);
  });

  $('btn-expand-all')?.addEventListener('click', () => {
    state.collapsedFiles.clear();
    const wt = getActiveRoot();
    if (wt) renderDiffFiles(wt);
  });

  $('btn-collapse-all')?.addEventListener('click', () => {
    for (const f of state.diffData?.files || []) {
      state.collapsedFiles.add(f.path);
    }
    const wt = getActiveRoot();
    if (wt) renderDiffFiles(wt);
  });

  let lastRefreshAt = 0;
  async function refreshIfActive({ silent = true, minIntervalMs = 0 } = {}) {
    if (
      state.committing ||
      state.sendingReview ||
      state.reviewModalOpen ||
      state.discardPrompt ||
      state.activeCommentDraft ||
      state.draggingCommentRange ||
      pendingSelectionQuote
    ) {
      return;
    }
    const now = Date.now();
    if (minIntervalMs > 0 && now - lastRefreshAt < minIntervalMs) return;
    lastRefreshAt = now;
    const nextConv = resolveConversationId();
    if (nextConv && nextConv !== state.conversationId) {
      state.conversationId = nextConv;
    }
    await refreshAll({ silent });
  }

  function consumeUrlDeepLinkParams() {
    const parsed = parseDeepLinkFromSearch(
      window.location.search,
      window.location.hash
    );
    if (!parsed) return;
    state.pendingDeepLink = parsed;

    try {
      const nextUrl = new URL(window.location.href);
      for (const k of [
        'repo',
        'path',
        'root',
        'rev',
        'mode',
        'commit',
        'file',
        'lines',
        'line',
        'auto_open',
      ]) {
        nextUrl.searchParams.delete(k);
      }
      nextUrl.hash = '';
      window.history.replaceState(null, '', nextUrl.toString());
    } catch {
      // Ignore history replace errors
    }
  }

  async function init() {
    state.conversationId = resolveConversationId();
    consumeUrlDeepLinkParams();
    lastRefreshAt = Date.now();

    const boot = window.__INITIAL_SC_BOOT__;
    if (boot?.rootsData && Array.isArray(boot.rootsData.repositories)) {
      window.__INITIAL_SC_BOOT__ = null;
      const rData = boot.rootsData;
      if (!state.conversationId && rData.conversationId) {
        state.conversationId = rData.conversationId;
      }
      state.uiAssetVersion = rData.uiAssetVersion || '';
      state.roots = rData.repositories || [];
      state.projectId = rData.projectId || '';
      state.projectName = rData.projectName || '';
      state.isForkedSession = Boolean(rData.isForkedSession);
      state.parentConversationId = rData.parentConversationId || '';
      state.selectedRootPath =
        boot.selectedRootPath || state.roots[0]?.path || '';
      state.diffMode = boot.diffMode || 'working';
      state.selectedCommit = boot.selectedCommit || '';
      state.diffData = boot.diffData || null;
      if (state.selectedRootPath && state.diffData) {
        seedPreloadedFileLines(state.selectedRootPath, state.diffData);
      }

      if (state.roots.length === 0) {
        renderHeaderAndRoots();
      } else if (state.pendingDeepLink) {
        await applyPendingDeepLink({ skipDiffFetch: Boolean(state.diffData) });
      } else {
        renderActiveWorkspace();
        if (!state.diffData) {
          await loadDiffForSelected({ silent: false });
        }
      }
    } else if (state.pendingDeepLink) {
      // Parallel fetch of `/api/roots` and `/api/diff` when server-injected boot state was not available
      const dl = state.pendingDeepLink;
      try {
        const [rootsData, diffData] = await Promise.all([
          apiGet('/api/roots', { conversationId: state.conversationId }),
          apiGet('/api/diff', {
            repo: dl.repo || '',
            conversationId: state.conversationId,
            mode: dl.mode || 'working',
            commit: dl.commit || '',
            context: getContextLines(),
            targetFile: dl.file || '',
            targetLines: dl.rawLines || '',
            hasExplicitRev: dl.hasExplicitRev ? '1' : '0',
          }).catch(() => null),
        ]);
        state.uiAssetVersion = rootsData.uiAssetVersion || '';
        state.roots = rootsData.repositories || [];
        state.projectId = rootsData.projectId || '';
        state.projectName = rootsData.projectName || '';
        state.isForkedSession = Boolean(rootsData.isForkedSession);
        state.parentConversationId = rootsData.parentConversationId || '';
        if (diffData && !diffData.error && diffData.path) {
          state.selectedRootPath = diffData.path;
          state.diffMode = diffData.mode || dl.mode || 'working';
          state.selectedCommit = dl.commit || '';
          state.diffData = diffData;
          seedPreloadedFileLines(diffData.path, diffData);
          await applyPendingDeepLink({ skipDiffFetch: true });
        } else {
          await applyPendingDeepLink({ skipDiffFetch: false });
        }
      } catch {
        await refreshAll({ silent: false });
      }
    } else {
      await refreshAll({ silent: false });
    }

    // Refresh automatically when the pane becomes visible, focused, or interacted with
    window.addEventListener('focus', () => {
      refreshIfActive({ silent: true, minIntervalMs: 1000 });
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        refreshIfActive({ silent: true, minIntervalMs: 1000 });
      }
    });
    document.addEventListener('mouseenter', () => {
      refreshIfActive({ silent: true, minIntervalMs: 2000 });
    });

    setInterval(() => {
      if (
        !document.hidden &&
        !state.committing &&
        !state.sendingReview &&
        !state.reviewModalOpen &&
        !state.discardPrompt &&
        !state.activeCommentDraft &&
        !state.draggingCommentRange &&
        !pendingSelectionQuote
      ) {
        refreshIfActive({ silent: true });
      }
    }, POLL_INTERVAL_MS);
  }

  init();
})();
