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
    live: true,
    loadingDiff: false,
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

  function renderHeaderAndRoots() {
    $('count-roots').textContent = String(state.roots.length);

    const forkBadge = $('fork-badge');
    if (forkBadge) {
      if (state.isForkedSession) {
        const parentShort = state.parentConversationId
          ? state.parentConversationId.slice(0, 8)
          : 'parent';
        forkBadge.textContent = `fork:${parentShort}`;
        forkBadge.title = state.parentConversationId
          ? `Forked from conversation ${state.parentConversationId}`
          : 'Forked session';
        forkBadge.classList.remove('hidden');
      } else {
        forkBadge.classList.add('hidden');
      }
    }

    const listEl = $('root-list');
    const emptyStateEl = $('empty-root-state');
    const workspaceEl = $('repo-workspace');

    if (state.roots.length === 0) {
      setHtmlIfChanged(
        listEl,
        '<div class="empty-state">No associated Git repositories in this session</div>'
      );
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
      emptyStateEl.classList.remove('hidden');
      workspaceEl.classList.add('hidden');
      return;
    }

    if (!activeRoot.existsOnDisk || !activeRoot.isGitRepo) {
      emptyStateEl.classList.remove('hidden');
      setHtmlIfChanged(
        emptyStateEl,
        `<div>${!activeRoot.existsOnDisk ? 'Repository path does not exist on disk:' : 'Directory is not a Git repository:'}</div>
         <div class="empty-hint"><code>${esc(activeRoot.path)}</code></div>`
      );
      workspaceEl.classList.add('hidden');
      return;
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

  function renderDiffRow(ln, extraCls = '') {
    const cls =
      ln.type === 'add'
        ? 'line-add'
        : ln.type === 'del'
        ? 'line-del'
        : `line-ctx${extraCls ? ` ${extraCls}` : ''}`;
    const prefix = ln.type === 'add' ? '+' : ln.type === 'del' ? '-' : ' ';
    return `<tr class="diff-line ${cls}">
      <td class="line-num">${ln.oldNo ?? ''}</td>
      <td class="line-num">${ln.newNo ?? ''}</td>
      <td class="line-prefix">${prefix}</td>
      <td class="line-code">${esc(ln.text)}</td>
    </tr>`;
  }

  function renderExpandedRange(lines, newStart, oldStart, count) {
    if (!lines || count <= 0) return '';
    const rows = [];
    for (let i = 0; i < count; i++) {
      const newNo = newStart + i;
      const oldNo = oldStart + i;
      if (newNo < 1 || newNo > lines.length) break;
      rows.push(
        renderDiffRow(
          {
            type: 'ctx',
            oldNo,
            newNo,
            text: lines[newNo - 1] ?? '',
          },
          'line-ctx-expanded'
        )
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

  function renderGapSection(wt, f, gapIdx) {
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
        ? renderExpandedRange(fileInfo.lines, gapNewStart, gapOldStart, topCount)
        : '';
    const botHtml =
      botCount > 0 && fileInfo?.lines
        ? renderExpandedRange(
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

    const cardsHtml = files
      .map((f) => {
        const collapsed = state.collapsedFiles.has(f.path);
        const isFocusedCard = state.selectedChangeFile === f.path;
        const fullFilePath = `${wt.path}/${f.path}`;
        const statusLabel = f.status === 'U' ? 'U' : f.status;
        const pathLabel = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;

        const stateBadges = [];
        const cardActions = [];
        const ds = f.dirtyState;

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
          if (f.isBinary) {
            bodyHtml =
              '<div class="file-hunks"><div class="empty-state">Binary or large file not shown</div></div>';
          } else if (f.hunks.length === 0) {
            bodyHtml =
              '<div class="file-hunks"><div class="empty-state">Empty file or mode-only change</div></div>';
          } else {
            const parts = [];
            for (let idx = 0; idx < f.hunks.length; idx++) {
              parts.push(renderGapSection(wt, f, idx));
              const h = f.hunks[idx];
              const rowsHtml = h.lines.map((ln) => renderDiffRow(ln)).join('');
              parts.push(`
                <div class="hunk-block">
                  <div class="hunk-header">${esc(h.header)}</div>
                  <table class="diff-table"><tbody>${rowsHtml}</tbody></table>
                </div>`);
            }
            parts.push(renderGapSection(wt, f, f.hunks.length));
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
    const wt = getActiveRoot();
    if (!wt || !wt.existsOnDisk || !wt.isGitRepo) return;
    renderSourceControlPanel(wt);
    renderDiffSection(wt);
  }

  async function loadDiffForSelected({ silent = false } = {}) {
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
      });
      if (state.selectedRootPath === wt.path) {
        state.diffData = data;
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

  async function selectRootRepository(nextRootPath) {
    if (!nextRootPath) return;
    const changed = state.selectedRootPath !== nextRootPath;
    state.selectedRootPath = nextRootPath;
    if (changed) {
      state.selectedChangeFile = '';
      state.selectedCommit = '';
      state.discardPrompt = null;
      state.collapsedFiles.clear();
      state.gapExpansions.clear();
      state.diffData = null;
    }
    renderActiveWorkspace();
    await loadDiffForSelected({ silent: false });
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

      if (!state.roots.some((r) => r.path === state.selectedRootPath)) {
        state.selectedRootPath = state.roots[0].path;
        state.selectedChangeFile = '';
        state.selectedCommit = '';
        state.discardPrompt = null;
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

  // Event Delegation
  document.addEventListener('click', async (e) => {
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
      state.gapExpansions.clear();
      await loadDiffForSelected({ silent: false });
      return;
    }

    const clearCommitBtn = e.target.closest('[data-clear-commit]');
    if (clearCommitBtn) {
      state.selectedCommit = '';
      state.gapExpansions.clear();
      await loadDiffForSelected({ silent: false });
      return;
    }

    const commitRow = e.target.closest('[data-commit-sha]');
    if (commitRow) {
      const sha = commitRow.dataset.commitSha;
      state.selectedCommit = state.selectedCommit === sha ? '' : sha;
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

  $('btn-refresh')?.addEventListener('click', () => {
    showToast('Refreshing Source Control…');
    refreshAll({ silent: false });
  });

  $('chk-live')?.addEventListener('change', (e) => {
    state.live = e.target.checked;
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

  // Initialize
  state.conversationId = resolveConversationId();
  if (state.conversationId) {
    const badge = $('conv-badge');
    if (badge) {
      badge.textContent = state.conversationId.slice(0, 8);
      badge.title = `Session ID: ${state.conversationId}`;
      badge.classList.remove('hidden');
    }
  }

  refreshAll({ silent: false });

  setInterval(() => {
    if (!state.live || document.hidden || state.committing) return;
    const nextConv = resolveConversationId();
    if (nextConv && nextConv !== state.conversationId) {
      state.conversationId = nextConv;
    }
    refreshAll({ silent: true });
  }, POLL_INTERVAL_MS);
})();
