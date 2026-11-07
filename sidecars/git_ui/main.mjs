/**
 * @fileoverview Source Control & Worktree Inspector Sidecar Backend (`git_ui`).
 *
 * Serves the Source Control web UI and JSON APIs for listing session/project/MCP
 * Git repositories & worktrees, inspecting live status/diffs/commit stacks,
 * reading file context lines, and performing scoped Git mutations (`stage`,
 * `unstage`, `discard`, `commit`).
 */

import { readFileSync, statSync, watchFile } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  commitRepositoryChanges,
  discardChanges,
  formatDiffReviewMessage,
  getRepositoryDiff,
  getRepositoryFileLines,
  inspectGitRepository,
  normalizeDiffRevSpec,
  resolveRepositoryFromQuery,
  stageChanges,
  unstageChanges,
} from '../../lib/git_service.mjs';
import {
  discoverRecentConversationId,
  getSessionRepoState,
} from '../../lib/session_repos.mjs';
import { HttpResponse, RawSidecarServer } from '../../lib/sidecar_http.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const STATIC_ASSETS = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

const staticFileCache = new Map();

function readCachedAsset(fileName) {
  const fullPath = join(__dirname, fileName);
  try {
    const mtimeMs = Math.floor(statSync(fullPath).mtimeMs);
    const cached = staticFileCache.get(fileName);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.content;
    }
    const content = readFileSync(fullPath, 'utf-8');
    staticFileCache.set(fileName, { mtimeMs, content });
    return content;
  } catch {
    return readFileSync(fullPath, 'utf-8');
  }
}

function computeUiAssetVersion() {
  try {
    const files = ['index.html', 'styles.css', 'app.js'];
    return files
      .map((f) => Math.floor(statSync(join(__dirname, f)).mtimeMs))
      .join('-');
  } catch {
    return '0';
  }
}

const app = new RawSidecarServer();

async function buildRootsPayload(conversationId) {
  const sessionState = await getSessionRepoState(conversationId);
  const repositories = await Promise.all(
    sessionState.repositories.map((entry) => inspectGitRepository(entry))
  );

  return {
    conversationId,
    projectId: sessionState.projectId,
    projectName: sessionState.projectName,
    isForkedSession: sessionState.isForkedSession,
    parentConversationId: sessionState.parentConversationId,
    repositories,
    uiAssetVersion: computeUiAssetVersion(),
    timestamp: Date.now(),
  };
}

async function buildInitialBootState(url) {
  const params = url?.searchParams;
  const conversationId =
    params?.get('conversationId') ||
    app.config.conversationId ||
    discoverRecentConversationId() ||
    '';
  const sessionState = await getSessionRepoState(conversationId);
  const rawRepos = sessionState.repositories || [];
  if (rawRepos.length === 0) {
    return {
      rootsData: {
        conversationId,
        projectId: sessionState.projectId,
        projectName: sessionState.projectName,
        isForkedSession: sessionState.isForkedSession,
        parentConversationId: sessionState.parentConversationId,
        repositories: [],
        uiAssetVersion: computeUiAssetVersion(),
        timestamp: Date.now(),
      },
      selectedRootPath: '',
      diffData: null,
    };
  }

  const repoQuery =
    params?.get('repo') || params?.get('path') || params?.get('root') || '';
  const selectedRootPath =
    resolveRepositoryFromQuery(repoQuery, rawRepos) || rawRepos[0].path;
  const matchedEntry =
    rawRepos.find((r) => r.path === selectedRootPath) || rawRepos[0];

  const hasExplicitRev = Boolean(
    params?.has('rev') || params?.has('mode') || params?.has('commit')
  );
  const revSpec = normalizeDiffRevSpec({
    rev: params?.get('rev') || '',
    mode: params?.get('mode') || '',
    commit: params?.get('commit') || '',
  });
  const targetFile = (params?.get('file') || '').trim().replace(/^\/+/, '');
  const targetLines = params?.get('lines') || params?.get('line') || '';

  // Run repository inspections and the target repository diff concurrently in one wave
  const [repositories, diffData] = await Promise.all([
    Promise.all(rawRepos.map((entry) => inspectGitRepository(entry))),
    matchedEntry?.existsOnDisk && matchedEntry?.isGitRepo
      ? getRepositoryDiff(matchedEntry.path, {
          mode: revSpec.mode || 'working',
          baseRef: matchedEntry.baseRef || '',
          commit: revSpec.commit || '',
          context: 3,
          targetFile,
          targetLines,
          hasExplicitRev,
        })
      : Promise.resolve(null),
  ]);

  const rootsData = {
    conversationId,
    projectId: sessionState.projectId,
    projectName: sessionState.projectName,
    isForkedSession: sessionState.isForkedSession,
    parentConversationId: sessionState.parentConversationId,
    repositories,
    uiAssetVersion: computeUiAssetVersion(),
    timestamp: Date.now(),
  };

  return {
    rootsData,
    selectedRootPath: matchedEntry.path,
    diffMode: diffData?.mode || revSpec.mode || 'working',
    selectedCommit: revSpec.commit || '',
    diffData,
  };
}

async function renderIndexHtmlWithBoot(url) {
  const rawHtml = readCachedAsset('index.html');
  let bootState = null;
  try {
    bootState = await Promise.race([
      buildInitialBootState(url),
      new Promise((resolve) => setTimeout(() => resolve(null), 250)),
    ]);
  } catch {
    bootState = null;
  }

  if (!bootState) {
    return rawHtml;
  }

  const safeJson = JSON.stringify(bootState).replace(/</g, '\\u003c');
  const bootScript = `<script>window.__INITIAL_SC_BOOT__=${safeJson};</script>\n  <script src="/app.js"></script>`;
  return rawHtml.replace('<script src="/app.js"></script>', bootScript);
}

app.page('/', (url) => renderIndexHtmlWithBoot(url));
app.page('/fullscreen', (url) => renderIndexHtmlWithBoot(url));

for (const [route, [file, contentType]] of Object.entries(STATIC_ASSETS)) {
  app.api(
    route,
    () =>
      new HttpResponse(readCachedAsset(file), {
        contentType,
      }),
    'GET'
  );
}

app.api(
  '/api/roots',
  async (data) => {
    const conversationId =
      data.conversationId || app.config.conversationId || '';
    return await buildRootsPayload(conversationId);
  },
  'GET'
);

app.api(
  '/api/diff',
  async (data) => {
    let targetPath = String(data.path || '').trim();
    if (!targetPath && data.repo) {
      const conversationId =
        data.conversationId || app.config.conversationId || '';
      const sessionState = await getSessionRepoState(conversationId);
      targetPath = resolveRepositoryFromQuery(
        data.repo,
        sessionState.repositories
      );
    }
    const hasExplicitRev =
      data.hasExplicitRev === undefined
        ? true
        : data.hasExplicitRev !== '0' && data.hasExplicitRev !== false;

    return await getRepositoryDiff(targetPath, {
      mode: data.mode || 'working',
      baseRef: data.baseRef || '',
      commit: data.commit || '',
      context: data.context ?? 3,
      targetFile: data.targetFile || '',
      targetLines: data.targetLines || '',
      hasExplicitRev,
    });
  },
  'GET'
);

app.api(
  '/api/file-lines',
  async (data) => {
    return await getRepositoryFileLines(data.path || '', {
      file: data.file || '',
      mode: data.mode || 'working',
      commit: data.commit || '',
    });
  },
  'GET'
);

app.api(
  '/api/stage',
  async (data) => {
    return await stageChanges(data.path || '', {
      paths: data.paths || (data.file ? [data.file] : []),
      all: Boolean(data.all),
    });
  },
  'POST'
);

app.api(
  '/api/unstage',
  async (data) => {
    return await unstageChanges(data.path || '', {
      paths: data.paths || (data.file ? [data.file] : []),
      all: Boolean(data.all),
    });
  },
  'POST'
);

app.api(
  '/api/discard',
  async (data) => {
    return await discardChanges(data.path || '', {
      paths: data.paths || (data.file ? [data.file] : []),
      all: Boolean(data.all),
    });
  },
  'POST'
);

app.api(
  '/api/commit',
  async (data) => {
    return await commitRepositoryChanges(data.path || '', {
      message: data.message || '',
      amend: Boolean(data.amend),
      stageAll: Boolean(data.stageAll),
    });
  },
  'POST'
);

app.api(
  '/api/send-review',
  async (data) => {
    const conversationId =
      data.conversationId || app.config.conversationId || '';
    const formatted = formatDiffReviewMessage({
      comments: Array.isArray(data.comments) ? data.comments : [],
      summaryNote: data.summaryNote || '',
      repositoryName: data.repositoryName || '',
      repositoryPath: data.repositoryPath || '',
    });
    if (!Boolean(data.dryRun)) {
      await app.sendMessage(conversationId, formatted.markdown, {
        title: formatted.title,
        projectId: data.projectId || app.config.projectId || '',
      });
    }
    return {
      ok: true,
      conversationId,
      title: formatted.title,
      markdown: formatted.markdown,
      commentCount: formatted.commentCount,
      fileCount: formatted.fileCount,
      anchors: formatted.anchors,
    };
  },
  'POST'
);

for (const watched of [
  join(__dirname, 'main.mjs'),
  join(__dirname, '../../lib/session_repos.mjs'),
  join(__dirname, '../../lib/git_service.mjs'),
]) {
  watchFile(watched, { interval: 2000 }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) {
      process.exit(0);
    }
  }).unref();
}

app.run().then(() => {
  // Pre-warm trajectory, repository topology, and commit GPG caches across all tracked repos
  setTimeout(async () => {
    try {
      const warmConvId =
        app.config.conversationId || discoverRecentConversationId() || '';
      if (!warmConvId) return;
      const roots = await buildRootsPayload(warmConvId);
      await Promise.all(
        (roots.repositories || []).map((repo) =>
          repo?.existsOnDisk && repo?.isGitRepo
            ? getRepositoryDiff(repo.path, {
                mode: 'working',
                baseRef: repo.baseRef || '',
                context: 3,
              })
            : null
        )
      );
    } catch {
      // Ignore pre-warm errors
    }
  }, 50).unref?.();
});
