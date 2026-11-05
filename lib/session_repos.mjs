/**
 * @fileoverview Per-chat session Git repository and worktree metadata resolver
 * for `source-control`.
 *
 * Follows the registration model of `file-explorer` while absorbing worktree
 * metadata (`base_ref`, `label`) from `worktree-inspector`:
 * 1. Session workspace URIs (`CortexTrajectoryMetadata.workspace_uris` / `workspaces`)
 * 2. Project folder resources (`~/.gemini/config/projects/<project_id>.json`)
 * 3. Session repositories/worktrees registered via `git_*` (or `worktree_*`)
 *    MCP tool steps in the trajectory (inherited across client-side session
 *    forks with zero filesystem markers)
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const HOME = homedir();
const GIT_TOOL_RE =
  /(?:^|_)((?:git|worktree)_(?:register|unregister|list|add|remove))$/;

const DEFAULT_PROJECTS_DIRS = [
  join(HOME, '.gemini', 'config', 'projects'),
  join(HOME, '.gemini', 'config_dev', 'projects'),
];

let cachedRuntimeEnv = null;

/**
 * Tracks in-flight `git_*` actions that have already been executed in this
 * process while their trajectory step is still in `CORTEX_STEP_STATUS_RUNNING`
 * or `CORTEX_STEP_STATUS_PENDING`.
 *
 * @type {Map<string, Array<{
 *   toolCallId: string,
 *   toolName: string,
 *   path: string,
 *   action: Object,
 *   stepIndex: number,
 * }>>}
 */
const committedInFlightByConv = new Map();

/**
 * Normalizes a directory path (`file://`, `~/`, relative, trailing slashes).
 */
export function normalizeRepoPath(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('file://')) {
    try {
      trimmed = decodeURIComponent(new URL(trimmed).pathname);
    } catch {
      trimmed = trimmed.replace(/^file:\/\//, '');
    }
  } else if (trimmed === '~') {
    trimmed = HOME;
  } else if (trimmed.startsWith('~/')) {
    trimmed = join(HOME, trimmed.slice(2));
  }
  const resolved = resolve(trimmed);
  return resolved.length > 1 ? resolved.replace(/\/+$/, '') : resolved;
}

/**
 * Formats a concise human-readable path string (`~/...`).
 */
export function formatRepoDisplayPath(repoPath) {
  if (!repoPath) return '';
  if (repoPath === HOME) return '~';
  if (repoPath.startsWith(`${HOME}/`)) {
    return `~/${repoPath.slice(HOME.length + 1)}`;
  }
  return repoPath;
}

/**
 * Resolves the enclosing Git worktree root directory by walking upward for `.git`
 * (either a directory for a main checkout or a file for a linked worktree).
 * Returns `''` if `dirPath` is not inside a Git worktree on disk.
 */
export function findEnclosingGitRoot(dirPath) {
  const norm = normalizeRepoPath(dirPath);
  if (!norm || !existsSync(norm)) return '';
  let curr = norm;
  for (let depth = 0; depth < 32; depth++) {
    if (existsSync(join(curr, '.git'))) {
      return curr;
    }
    const parent = dirname(curr);
    if (!parent || parent === curr) break;
    curr = parent;
  }
  return '';
}

/**
 * Discovers the running Language Server address, CSRF token, and appDataDir
 * from process environment, `/proc/<pid>/environ`, or `~/.gemini/*`.
 */
export function resolveLanguageServerConnection() {
  const envAddr = (process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const envCsrf = (process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  const envAppData = (process.env.ANTIGRAVITY_APP_DATA_DIR || '').trim();

  if (envAddr && envCsrf && envAppData) {
    return {
      address: envAddr,
      csrfToken: envCsrf,
      appDataDirs: [envAppData],
    };
  }
  if (
    cachedRuntimeEnv?.address &&
    cachedRuntimeEnv?.csrfToken &&
    cachedRuntimeEnv?.appDataDirs?.length
  ) {
    return {
      address: envAddr || cachedRuntimeEnv.address,
      csrfToken: envCsrf || cachedRuntimeEnv.csrfToken,
      appDataDirs: envAppData
        ? [envAppData, ...cachedRuntimeEnv.appDataDirs]
        : cachedRuntimeEnv.appDataDirs,
    };
  }

  let procAddr = '';
  let procCsrf = '';
  let procAppData = '';

  try {
    const pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
    for (const pid of pids) {
      try {
        const raw = readFileSync(`/proc/${pid}/environ`, 'utf-8');
        if (
          !raw.includes('ANTIGRAVITY_LS_ADDRESS=') &&
          !raw.includes('ANTIGRAVITY_APP_DATA_DIR=')
        ) {
          continue;
        }
        for (const entry of raw.split('\0')) {
          if (!procAddr && entry.startsWith('ANTIGRAVITY_LS_ADDRESS=')) {
            procAddr = entry.slice('ANTIGRAVITY_LS_ADDRESS='.length).trim();
          } else if (!procCsrf && entry.startsWith('ANTIGRAVITY_CSRF_TOKEN=')) {
            procCsrf = entry.slice('ANTIGRAVITY_CSRF_TOKEN='.length).trim();
          } else if (
            !procAppData &&
            entry.startsWith('ANTIGRAVITY_APP_DATA_DIR=')
          ) {
            procAppData = entry
              .slice('ANTIGRAVITY_APP_DATA_DIR='.length)
              .trim();
          }
        }
        if (procAddr && procCsrf && procAppData) {
          break;
        }
      } catch {
        // Ignore unreadable /proc entries
      }
    }
  } catch {
    // Ignore /proc scan errors on non-Linux systems
  }

  const candidateDirs = [];
  const addDir = (d) => {
    if (d && !candidateDirs.includes(d)) candidateDirs.push(d);
  };

  addDir(envAppData);
  addDir(procAppData);

  const geminiRoot = join(HOME, '.gemini');
  try {
    const subdirs = readdirSync(geminiRoot, { withFileTypes: true });
    for (const dirent of subdirs) {
      if (!dirent.isDirectory() || dirent.name.startsWith('config')) continue;
      const candidate = join(geminiRoot, dirent.name);
      if (
        existsSync(join(candidate, 'brain')) ||
        existsSync(join(candidate, 'conversations')) ||
        existsSync(join(candidate, 'conversation_summaries.db'))
      ) {
        addDir(candidate);
      }
    }
  } catch {
    // Ignore scan errors
  }

  addDir(join(HOME, '.gemini', 'antigravity'));

  cachedRuntimeEnv = {
    address: envAddr || procAddr,
    csrfToken: envCsrf || procCsrf,
    appDataDirs: candidateDirs,
  };
  return cachedRuntimeEnv;
}

/**
 * Calls a method on `exa.language_server_pb.LanguageServerService`.
 */
export async function callLanguageServerRpc(
  method,
  payload = {},
  timeoutMs = 4000
) {
  const { address, csrfToken } = resolveLanguageServerConnection();
  if (!address) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: 'Language Server address not found',
    };
  }
  let baseUrl = address;
  if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
    baseUrl = `http://${baseUrl}`;
  }
  baseUrl = baseUrl.replace(/\/+$/, '');
  const url = `${baseUrl}/exa.language_server_pb.LanguageServerService/${method}`;

  const headers = { 'Content-Type': 'application/json' };
  if (csrfToken) {
    headers['x-codeium-csrf-token'] = csrfToken;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    let data = null;
    try {
      data = await resp.json();
    } catch {
      data = null;
    }
    return { ok: resp.ok, status: resp.status, data };
  } catch (err) {
    cachedRuntimeEnv = null;
    return {
      ok: false,
      status: 0,
      data: null,
      error: err?.message || String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches all trajectory steps, metadata, and fork lineage for `conversationId`.
 */
export async function fetchConversationTrajectory(conversationId) {
  if (!conversationId) {
    return { ok: false, steps: [], parentReferences: [], metadata: {} };
  }
  const res = await callLanguageServerRpc('GetCascadeTrajectory', {
    cascadeId: conversationId,
  });
  if (!res.ok || !res.data?.trajectory) {
    return { ok: false, steps: [], parentReferences: [], metadata: {} };
  }

  const trajectory = res.data.trajectory;
  const steps = Array.isArray(trajectory.steps) ? [...trajectory.steps] : [];
  const totalSteps = Number(
    res.data.numTotalSteps ??
      res.data.num_total_steps ??
      trajectory.numTotalSteps ??
      steps.length
  );

  while (steps.length < totalSteps) {
    const pageRes = await callLanguageServerRpc('GetCascadeTrajectorySteps', {
      cascadeId: conversationId,
      stepOffset: steps.length,
    });
    const pageSteps = pageRes.data?.steps;
    if (!pageRes.ok || !Array.isArray(pageSteps) || pageSteps.length === 0) {
      break;
    }
    steps.push(...pageSteps);
  }

  return {
    ok: true,
    steps,
    parentReferences: Array.isArray(trajectory.parentReferences)
      ? trajectory.parentReferences
      : Array.isArray(trajectory.parent_references)
      ? trajectory.parent_references
      : [],
    metadata: trajectory.metadata || {},
  };
}

/**
 * Extracts normalized workspace folder paths from `CortexTrajectoryMetadata`.
 */
export function extractWorkspacePathsFromMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return [];
  const paths = [];
  const seen = new Set();

  const addRaw = (raw) => {
    const norm = normalizeRepoPath(raw);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      paths.push(norm);
    }
  };

  const direct = metadata.workspaceUris ?? metadata.workspace_uris ?? [];
  if (Array.isArray(direct)) {
    for (const u of direct) {
      if (typeof u === 'string') addRaw(u);
    }
  }

  const wsList = metadata.workspaces ?? [];
  if (Array.isArray(wsList)) {
    for (const w of wsList) {
      const u =
        w?.gitRootAbsoluteUri ||
        w?.git_root_absolute_uri ||
        w?.workspaceFolderAbsoluteUri ||
        w?.workspace_folder_absolute_uri;
      if (typeof u === 'string') addRaw(u);
    }
  }

  return paths;
}

/**
 * Extracts folder resources from a `Resources` protojson object.
 */
function extractResourcesArray(resourcesWrapper) {
  const list = resourcesWrapper?.resources;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const r of list) {
    const folderUri =
      r?.folderUri ||
      r?.folder_uri ||
      r?.gitFolder?.folderUri ||
      r?.git_folder?.folder_uri ||
      '';
    const norm = normalizeRepoPath(folderUri);
    if (!norm) continue;
    out.push({
      path: norm,
      isGit: Boolean(r?.gitFolder || r?.git_folder),
      defaultBranch:
        r?.gitFolder?.defaultBranch || r?.git_folder?.default_branch || '',
    });
  }
  return out;
}

/**
 * Reads associated folders for a project (`~/.gemini/config/projects/<projectId>.json`).
 */
export function loadProjectFolders(projectId, environmentId = '', options = {}) {
  const cleanId = String(projectId || '').trim();
  if (
    !cleanId ||
    cleanId === 'outside-of-project' ||
    cleanId === 'default-cli-project' ||
    cleanId.includes('/') ||
    cleanId.includes('..')
  ) {
    return { projectId: cleanId, projectName: '', folders: [] };
  }

  const projectsDirs = options.projectsDirs || DEFAULT_PROJECTS_DIRS;
  let projJson = null;
  for (const dir of projectsDirs) {
    const candidate = join(dir, `${cleanId}.json`);
    if (existsSync(candidate)) {
      try {
        projJson = JSON.parse(readFileSync(candidate, 'utf-8'));
        break;
      } catch {
        // Ignore malformed project JSON
      }
    }
  }

  if (!projJson || typeof projJson !== 'object') {
    return { projectId: cleanId, projectName: '', folders: [] };
  }

  const projectName = String(projJson.name || '').trim();
  const seen = new Set();
  const folders = [];

  const addFolder = (entry, envName = '') => {
    if (!entry?.path || seen.has(entry.path)) return;
    seen.add(entry.path);
    folders.push({
      path: entry.path,
      isGit: Boolean(entry.isGit),
      defaultBranch: entry.defaultBranch || '',
      envName,
    });
  };

  if (environmentId) {
    const envs = projJson.environments?.environments;
    if (Array.isArray(envs)) {
      const matchedEnv = envs.find((e) => e?.id === environmentId);
      if (matchedEnv) {
        for (const item of extractResourcesArray(matchedEnv.resources)) {
          addFolder(item, matchedEnv.name || '');
        }
      }
    }
  }

  for (const item of extractResourcesArray(
    projJson.projectResources ?? projJson.project_resources
  )) {
    addFolder(item, '');
  }

  return {
    projectId: cleanId,
    projectName,
    folders,
  };
}

/**
 * Canonicalizes a `git_*` or `worktree_*` tool name to `git_register`,
 * `git_unregister`, or `git_list`.
 */
function canonicalizeGitToolName(rawTool) {
  if (
    rawTool === 'git_register' ||
    rawTool === 'git_add' ||
    rawTool === 'worktree_register' ||
    rawTool === 'worktree_add'
  ) {
    return 'git_register';
  }
  if (
    rawTool === 'git_unregister' ||
    rawTool === 'git_remove' ||
    rawTool === 'worktree_unregister' ||
    rawTool === 'worktree_remove'
  ) {
    return 'git_unregister';
  }
  if (rawTool === 'git_list' || rawTool === 'worktree_list') {
    return 'git_list';
  }
  return rawTool;
}

/**
 * Extracts a normalized `git_*` action from a trajectory step, or null.
 * By default (`options.allowInFlight !== true`), only completed steps
 * (`CORTEX_STEP_STATUS_DONE`, or unit-test steps without an explicit status)
 * are returned so that an unexecuted `CORTEX_STEP_STATUS_RUNNING` /
 * `CORTEX_STEP_STATUS_PENDING` step is not applied prematurely.
 */
export function extractGitStepAction(step, options = {}) {
  if (!step) return null;
  const status = step.status || '';
  const allowInFlight = options.allowInFlight === true;
  if (status && status !== 'CORTEX_STEP_STATUS_DONE') {
    if (
      !allowInFlight ||
      (status !== 'CORTEX_STEP_STATUS_RUNNING' &&
        status !== 'CORTEX_STEP_STATUS_PENDING')
    ) {
      return null;
    }
  }

  if (
    step.type === 'CORTEX_STEP_TYPE_MCP_TOOL' ||
    step.type === 'CORTEX_STEP_TYPE_GENERIC'
  ) {
    const mcpTool = step.mcpTool || step.mcp_tool;
    if (mcpTool?.isError || mcpTool?.is_error) {
      return null;
    }
    const toolCall =
      mcpTool?.toolCall ||
      mcpTool?.tool_call ||
      step.metadata?.toolCall ||
      step.metadata?.tool_call;
    const rawName = toolCall?.name || '';
    const match = GIT_TOOL_RE.exec(rawName);
    if (match) {
      const canonicalTool = canonicalizeGitToolName(match[1]);
      let args = {};
      const argsJson =
        toolCall?.argumentsJson ?? toolCall?.arguments_json ?? '';
      if (typeof argsJson === 'string' && argsJson.trim()) {
        try {
          args = JSON.parse(argsJson);
        } catch {
          return null;
        }
      } else if (argsJson && typeof argsJson === 'object') {
        args = argsJson;
      }

      return {
        toolCallId: toolCall?.id || '',
        toolName: canonicalTool,
        args,
        createdAt: step.metadata?.createdAt || step.metadata?.created_at || '',
      };
    }
  }

  // Fallback for CLI invocation (`git_mcp.mjs --cli git_register '<json>'`)
  if (
    step.type === 'CORTEX_STEP_TYPE_RUN_COMMAND' ||
    step.type === 'CORTEX_STEP_TYPE_GENERIC'
  ) {
    const metaToolCall = step.metadata?.toolCall || step.metadata?.tool_call;
    const argsJson =
      metaToolCall?.argumentsJson ?? metaToolCall?.arguments_json ?? '';
    let cmdLine = '';
    if (
      typeof argsJson === 'string' &&
      (argsJson.includes('git_') || argsJson.includes('worktree_'))
    ) {
      try {
        const parsed = JSON.parse(argsJson);
        cmdLine = parsed.CommandLine || '';
      } catch {
        return null;
      }
    }
    if (!cmdLine) return null;
    const cliMatch =
      /--cli\s+(?:[a-z0-9_]*_)?((?:git|worktree)_(?:register|unregister|list))\s+'([^']+)'/.exec(
        cmdLine
      );
    if (!cliMatch) return null;
    try {
      const args = JSON.parse(cliMatch[2]);
      return {
        toolCallId: metaToolCall?.id || '',
        toolName: canonicalizeGitToolName(cliMatch[1]),
        args,
        createdAt: step.metadata?.createdAt || step.metadata?.created_at || '',
      };
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Applies a single `git_*` action onto the session repository fold state.
 */
export function applyGitAction(
  state,
  action,
  stepIndex,
  isInheritedFromFork = false
) {
  const { toolName, args, createdAt } = action;
  const rawPath =
    args.path ||
    args.repo_path ||
    args.repoPath ||
    args.worktree_path ||
    args.worktreePath ||
    '';
  const rawNormalized = normalizeRepoPath(rawPath);
  if (!rawNormalized) return;

  // If the registered path is inside an existing Git worktree on disk,
  // normalize to the enclosing Git worktree root.
  const enclosingRoot = findEnclosingGitRoot(rawNormalized);
  const repoPath = enclosingRoot || rawNormalized;

  if (toolName === 'git_register') {
    state.unregisteredPaths.delete(repoPath);
    state.unregisteredPaths.delete(rawNormalized);
    const prev = state.mcpEntries.get(repoPath);
    const baseRef = String(
      args.base_ref ?? args.baseRef ?? prev?.baseRef ?? ''
    ).trim();
    const label = String(
      args.label ?? args.description ?? prev?.label ?? ''
    ).trim();

    state.mcpEntries.set(repoPath, {
      path: repoPath,
      baseRef,
      label,
      registeredStep: prev ? prev.registeredStep : stepIndex,
      updatedStep: stepIndex,
      updatedAt: createdAt || prev?.updatedAt || '',
      inheritedFromFork: prev ? prev.inheritedFromFork : isInheritedFromFork,
    });
    return;
  }

  if (toolName === 'git_unregister') {
    state.mcpEntries.delete(repoPath);
    state.mcpEntries.delete(rawNormalized);
    state.unregisteredPaths.add(repoPath);
    state.unregisteredPaths.add(rawNormalized);
  }
}

/**
 * Resolves all Git repositories and worktrees associated with a conversation:
 * - Session workspace folders (if inside a Git worktree)
 * - Project resource folders (if flagged `isGit` or inside a Git worktree)
 * - MCP-registered repositories/worktrees (`git_register` / `git_unregister`)
 *
 * @param {string} conversationId
 * @param {?Object=} pendingAction Optional in-flight MCP action
 * @param {Object=} options Optional overrides for testing (`trajectoryData`, `projectsDirs`)
 */
export async function getSessionRepoState(
  conversationId,
  pendingAction = null,
  options = {}
) {
  const traj =
    options.trajectoryData ||
    (await fetchConversationTrajectory(conversationId));
  const steps = traj.steps || [];
  const metadata = traj.metadata || {};

  // Detect fork boundary step index if this conversation was forked in the client
  let forkBoundaryStep = -1;
  let parentConversationId = '';
  const parentRefs = traj.parentReferences || [];
  if (parentRefs.length > 0) {
    const lastRef = parentRefs[parentRefs.length - 1];
    parentConversationId =
      lastRef.conversationId ||
      lastRef.conversation_id ||
      lastRef.cascadeId ||
      lastRef.cascade_id ||
      '';
    const refIdx = Number(lastRef.stepIndex ?? lastRef.step_index ?? -1);
    if (Number.isFinite(refIdx) && refIdx >= 0) {
      forkBoundaryStep = refIdx;
    }
  }
  for (let i = 0; i < steps.length; i++) {
    const sysMsg = steps[i]?.systemMessage || steps[i]?.system_message;
    if (
      sysMsg?.eventType === 'FORK_NOTICE' ||
      sysMsg?.event_type === 'FORK_NOTICE'
    ) {
      forkBoundaryStep = i;
    }
  }

  const foldState = {
    mcpEntries: new Map(),
    unregisteredPaths: new Set(),
    seenToolCallIds: new Set(),
  };

  const inFlightSteps = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const doneAction = extractGitStepAction(step);
    if (doneAction) {
      if (doneAction.toolCallId) {
        foldState.seenToolCallIds.add(doneAction.toolCallId);
      }
      const isInherited = forkBoundaryStep >= 0 && i <= forkBoundaryStep;
      applyGitAction(foldState, doneAction, i, isInherited);
      continue;
    }

    const inFlightAction = extractGitStepAction(step, { allowInFlight: true });
    if (inFlightAction) {
      const rawPath =
        inFlightAction.args?.path ||
        inFlightAction.args?.repo_path ||
        inFlightAction.args?.repoPath ||
        '';
      inFlightSteps.push({
        stepIndex: i,
        toolCallId: inFlightAction.toolCallId || '',
        toolName: inFlightAction.toolName,
        path: normalizeRepoPath(rawPath),
        action: inFlightAction,
      });
    }
  }

  const claimedInFlightIndices = new Set();
  const convKey = String(conversationId || '').trim();
  if (convKey && committedInFlightByConv.has(convKey)) {
    const prevCommitted = committedInFlightByConv.get(convKey) || [];
    const stillActive = [];

    for (const entry of prevCommitted) {
      if (entry.toolCallId && foldState.seenToolCallIds.has(entry.toolCallId)) {
        continue;
      }
      const matchIdx = inFlightSteps.findIndex((s, idx) => {
        if (claimedInFlightIndices.has(idx)) return false;
        if (entry.toolCallId && s.toolCallId) {
          return s.toolCallId === entry.toolCallId;
        }
        return s.toolName === entry.toolName && s.path === entry.path;
      });
      if (matchIdx === -1) {
        continue;
      }
      claimedInFlightIndices.add(matchIdx);
      const matchedStep = inFlightSteps[matchIdx];
      if (matchedStep.toolCallId) {
        foldState.seenToolCallIds.add(matchedStep.toolCallId);
      }
      applyGitAction(
        foldState,
        entry.action,
        matchedStep.stepIndex,
        false
      );
      stillActive.push({
        ...entry,
        toolCallId: entry.toolCallId || matchedStep.toolCallId || '',
        stepIndex: matchedStep.stepIndex,
      });
    }

    if (stillActive.length > 0) {
      committedInFlightByConv.set(convKey, stillActive);
    } else {
      committedInFlightByConv.delete(convKey);
    }
  }

  if (
    pendingAction &&
    (!pendingAction.toolCallId ||
      !foldState.seenToolCallIds.has(pendingAction.toolCallId))
  ) {
    const pendingPath = normalizeRepoPath(pendingAction.args?.path || '');
    let pendingStepIdx = steps.length;
    const matchIdx = inFlightSteps.findIndex((s, idx) => {
      if (claimedInFlightIndices.has(idx)) return false;
      if (pendingAction.toolCallId && s.toolCallId) {
        return s.toolCallId === pendingAction.toolCallId;
      }
      return s.toolName === pendingAction.toolName && s.path === pendingPath;
    });
    let matchedToolCallId = pendingAction.toolCallId || '';
    if (matchIdx !== -1) {
      claimedInFlightIndices.add(matchIdx);
      pendingStepIdx = inFlightSteps[matchIdx].stepIndex;
      matchedToolCallId =
        matchedToolCallId || inFlightSteps[matchIdx].toolCallId || '';
    }

    applyGitAction(foldState, pendingAction, pendingStepIdx, false);

    if (convKey) {
      const list = committedInFlightByConv.get(convKey) || [];
      list.push({
        toolCallId: matchedToolCallId,
        toolName: pendingAction.toolName,
        path: pendingPath,
        action: pendingAction,
        stepIndex: pendingStepIdx,
      });
      committedInFlightByConv.set(convKey, list);
    }
  }

  // 1. Session workspace folders
  const workspacePaths = extractWorkspacePathsFromMetadata(metadata);

  // 2. Project resource folders
  const projectId = String(
    metadata.projectId ||
      metadata.project_id ||
      process.env.ANTIGRAVITY_PROJECT_ID ||
      ''
  ).trim();
  const environmentId = String(
    metadata.environmentId || metadata.environment_id || ''
  ).trim();
  const projectInfo = loadProjectFolders(projectId, environmentId, options);

  const byPath = new Map();

  const ensureEntry = (repoPath, source, extra = {}) => {
    if (!repoPath || foldState.unregisteredPaths.has(repoPath)) return null;
    let item = byPath.get(repoPath);
    if (!item) {
      const exists = existsSync(repoPath);
      const gitRoot = exists ? findEnclosingGitRoot(repoPath) : '';
      item = {
        path: repoPath,
        uri: `file://${repoPath}`,
        name: basename(repoPath) || '/',
        displayPath: formatRepoDisplayPath(repoPath),
        label: '',
        baseRef: '',
        sources: [],
        primarySource: source,
        inheritedFromFork: false,
        registeredStep: -1,
        updatedStep: -1,
        updatedAt: '',
        existsOnDisk: exists,
        isGitRepo: Boolean(gitRoot),
      };
      byPath.set(repoPath, item);
    }
    if (!item.sources.includes(source)) {
      item.sources.push(source);
    }
    if (extra.label && !item.label) {
      item.label = extra.label;
    }
    if (extra.overrideLabel) {
      item.label = extra.overrideLabel;
    }
    if (extra.baseRef && !item.baseRef) {
      item.baseRef = extra.baseRef;
    }
    if (extra.overrideBaseRef) {
      item.baseRef = extra.overrideBaseRef;
    }
    if (extra.inheritedFromFork) {
      item.inheritedFromFork = true;
    }
    if (
      typeof extra.registeredStep === 'number' &&
      extra.registeredStep >= 0
    ) {
      item.registeredStep = extra.registeredStep;
    }
    if (typeof extra.updatedStep === 'number' && extra.updatedStep >= 0) {
      item.updatedStep = extra.updatedStep;
    }
    if (extra.updatedAt) {
      item.updatedAt = extra.updatedAt;
    }
    return item;
  };

  for (const wsPath of workspacePaths) {
    const gitRoot = findEnclosingGitRoot(wsPath);
    if (gitRoot) {
      ensureEntry(gitRoot, 'workspace');
    } else if (options.includeNonGitWorkspaces === true) {
      ensureEntry(wsPath, 'workspace');
    }
  }

  for (const pf of projectInfo.folders) {
    const gitRoot = findEnclosingGitRoot(pf.path);
    if (gitRoot || pf.isGit) {
      ensureEntry(gitRoot || pf.path, 'project', {
        label: projectInfo.projectName || pf.envName || '',
        baseRef: pf.defaultBranch || '',
      });
    }
  }

  for (const mcpItem of foldState.mcpEntries.values()) {
    ensureEntry(mcpItem.path, 'mcp', {
      overrideLabel: mcpItem.label || undefined,
      overrideBaseRef: mcpItem.baseRef || undefined,
      inheritedFromFork: mcpItem.inheritedFromFork,
      registeredStep: mcpItem.registeredStep,
      updatedStep: mcpItem.updatedStep,
      updatedAt: mcpItem.updatedAt,
    });
  }

  const allRepos = [...byPath.values()];
  const sourceOrder = { workspace: 1, project: 2, mcp: 3 };

  const repositories = allRepos.map((item) => {
    const isMcp = item.sources.includes('mcp');
    const primarySource = item.sources.includes('workspace')
      ? 'workspace'
      : item.sources.includes('project')
      ? 'project'
      : 'mcp';
    return {
      ...item,
      primarySource,
      isMcpRegistered: isMcp,
    };
  });

  repositories.sort((a, b) => {
    const orderA = sourceOrder[a.primarySource] || 99;
    const orderB = sourceOrder[b.primarySource] || 99;
    if (orderA !== orderB) return orderA - orderB;
    if (b.updatedStep !== a.updatedStep) return b.updatedStep - a.updatedStep;
    return a.path.localeCompare(b.path);
  });

  return {
    conversationId,
    projectId: projectInfo.projectId,
    projectName: projectInfo.projectName,
    isForkedSession: forkBoundaryStep >= 0 || Boolean(parentConversationId),
    parentConversationId,
    forkBoundaryStep,
    repositories,
  };
}
