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
  getRepositoryDiff,
  getRepositoryFileLines,
  inspectGitRepository,
  stageChanges,
  unstageChanges,
} from '../../lib/git_service.mjs';
import { getSessionRepoState } from '../../lib/session_repos.mjs';
import { HttpResponse, RawSidecarServer } from '../../lib/sidecar_http.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const STATIC_ASSETS = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

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

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));
app.page('/fullscreen', () =>
  readFileSync(join(__dirname, 'index.html'), 'utf-8')
);

for (const [route, [file, contentType]] of Object.entries(STATIC_ASSETS)) {
  app.api(
    route,
    () =>
      new HttpResponse(readFileSync(join(__dirname, file), 'utf-8'), {
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
  },
  'GET'
);

app.api(
  '/api/diff',
  async (data) => {
    return await getRepositoryDiff(data.path || '', {
      mode: data.mode || 'working',
      baseRef: data.baseRef || '',
      commit: data.commit || '',
      context: data.context ?? 3,
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

app.run();
