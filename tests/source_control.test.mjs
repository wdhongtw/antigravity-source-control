import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  commitRepositoryChanges,
  discardChanges,
  getRepositoryDiff,
  getRepositoryFileLines,
  inspectGitRepository,
  parsePorcelainZStatus,
  resolveScopedGitPath,
  stageChanges,
  unstageChanges,
} from '../lib/git_service.mjs';
import {
  extractGitStepAction,
  findEnclosingGitRoot,
  getSessionRepoState,
  normalizeRepoPath,
} from '../lib/session_repos.mjs';
import { handleToolCall } from '../mcp/git_mcp.mjs';

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function gitInit(dir) {
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: dir,
  });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
}

test('normalizeRepoPath normalizes file://, tilde, and trailing slashes', () => {
  assert.equal(
    normalizeRepoPath('file:///tmp/example/repo///'),
    '/tmp/example/repo'
  );
  assert.equal(normalizeRepoPath('/'), '/');
});

test('getSessionRepoState aggregates workspace, project, and MCP repositories with fork inheritance', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'sc-test-'));
  try {
    const wsRepo = join(tempRoot, 'ws-repo');
    const wsNonGit = join(tempRoot, 'ws-plain');
    const projRepo = join(tempRoot, 'proj-repo');
    const mcpRepo1 = join(tempRoot, 'mcp-one');
    const mcpRepo2 = join(tempRoot, 'mcp-two');
    const projectsDir = join(tempRoot, 'projects');
    const convId = 'conv-sc-12345';

    for (const d of [
      wsRepo,
      wsNonGit,
      projRepo,
      mcpRepo1,
      mcpRepo2,
      projectsDir,
    ]) {
      mkdirSync(d, { recursive: true });
    }
    gitInit(wsRepo);
    gitInit(projRepo);
    gitInit(mcpRepo1);
    gitInit(mcpRepo2);

    // Subdirectory inside mcpRepo2 should automatically normalize to mcpRepo2 root
    const mcpRepo2Sub = join(mcpRepo2, 'packages', 'core');
    mkdirSync(mcpRepo2Sub, { recursive: true });
    assert.equal(findEnclosingGitRoot(mcpRepo2Sub), mcpRepo2);

    writeFileSync(
      join(projectsDir, 'proj-git.json'),
      JSON.stringify({
        id: 'proj-git',
        name: 'Git Demo Project',
        projectResources: {
          resources: [
            { folderUri: `file://${wsRepo}` },
            {
              gitFolder: {
                folderUri: `file://${projRepo}`,
                defaultBranch: 'main',
              },
            },
          ],
        },
      }),
      'utf-8'
    );

    const trajectoryData = {
      ok: true,
      metadata: {
        projectId: 'proj-git',
        workspaceUris: [`file://${wsRepo}`, `file://${wsNonGit}`],
      },
      parentReferences: [
        {
          conversationId: 'parent-conv-777',
          stepIndex: 0,
        },
      ],
      steps: [
        {
          type: 'CORTEX_STEP_TYPE_GENERIC',
          status: 'CORTEX_STEP_STATUS_DONE',
          metadata: {
            toolCall: {
              id: 'call-1',
              name: 'mcp_source-control_git_git_register',
              argumentsJson: JSON.stringify({
                path: mcpRepo1,
                base_ref: 'main',
                label: 'Inherited Worktree',
              }),
            },
          },
        },
        {
          type: 'CORTEX_STEP_TYPE_MCP_TOOL',
          status: 'CORTEX_STEP_STATUS_DONE',
          mcpTool: {
            toolCall: {
              id: 'call-2',
              name: 'git_register',
              argumentsJson: JSON.stringify({
                path: mcpRepo2Sub,
                label: 'Post-Fork Worktree',
              }),
            },
          },
        },
      ],
    };

    const state = await getSessionRepoState(convId, null, {
      trajectoryData,
      projectsDirs: [projectsDir],
    });

    assert.equal(state.isForkedSession, true);
    assert.equal(state.parentConversationId, 'parent-conv-777');
    // wsNonGit is excluded because it is not a Git repository; 4 Git repos remain
    assert.equal(state.repositories.length, 4);

    const wsEntry = state.repositories.find((r) => r.path === wsRepo);
    assert.ok(wsEntry);
    assert.deepEqual(wsEntry.sources, ['workspace', 'project']);

    const mcp1Entry = state.repositories.find((r) => r.path === mcpRepo1);
    assert.ok(mcp1Entry);
    assert.equal(mcp1Entry.inheritedFromFork, true);
    assert.equal(mcp1Entry.label, 'Inherited Worktree');
    assert.equal(mcp1Entry.baseRef, 'main');

    const mcp2Entry = state.repositories.find((r) => r.path === mcpRepo2);
    assert.ok(mcp2Entry);
    assert.equal(mcp2Entry.inheritedFromFork, false);
    assert.equal(mcp2Entry.label, 'Post-Fork Worktree');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('git_unregister removes repository and in-flight RUNNING steps are retained without double application', async () => {
  const convId = 'conv-inflight-git';
  const runningStep1 = {
    type: 'CORTEX_STEP_TYPE_GENERIC',
    status: 'CORTEX_STEP_STATUS_RUNNING',
    metadata: {
      toolCall: {
        id: 'call-run-1',
        name: 'mcp_source-control_git_git_register',
        argumentsJson: JSON.stringify({
          path: '/tmp/repo-alpha',
          label: 'Alpha',
        }),
      },
    },
  };
  const runningStep2 = {
    type: 'CORTEX_STEP_TYPE_GENERIC',
    status: 'CORTEX_STEP_STATUS_RUNNING',
    metadata: {
      toolCall: {
        id: 'call-run-2',
        name: 'mcp_source-control_git_git_register',
        argumentsJson: JSON.stringify({
          path: '/tmp/repo-beta',
          label: 'Beta',
        }),
      },
    },
  };

  // Call 1 while runningStep1 is RUNNING in trajectory
  const res1 = await handleToolCall(
    {
      name: 'git_register',
      arguments: { path: '/tmp/repo-alpha', label: 'Alpha' },
      _meta: { 'antigravity.google/conversation_id': convId },
    },
    {
      trajectoryData: {
        ok: true,
        metadata: {},
        parentReferences: [],
        steps: [runningStep1],
      },
    }
  );
  const payload1 = JSON.parse(res1.content[0].text);
  assert.equal(payload1.trackedCount, 1);

  // Call 2 in the same turn while runningStep1 is still RUNNING and runningStep2 is also RUNNING
  const res2 = await handleToolCall(
    {
      name: 'git_register',
      arguments: { path: '/tmp/repo-beta', label: 'Beta' },
      _meta: { 'antigravity.google/conversation_id': convId },
    },
    {
      trajectoryData: {
        ok: true,
        metadata: {},
        parentReferences: [],
        steps: [runningStep1, runningStep2],
      },
    }
  );
  const payload2 = JSON.parse(res2.content[0].text);
  assert.equal(payload2.trackedCount, 2);

  // Call 3: unregister repo-alpha once steps are DONE
  const res3 = await handleToolCall(
    {
      name: 'git_unregister',
      arguments: { path: '/tmp/repo-alpha' },
      _meta: { 'antigravity.google/conversation_id': convId },
    },
    {
      trajectoryData: {
        ok: true,
        metadata: {},
        parentReferences: [],
        steps: [
          { ...runningStep1, status: 'CORTEX_STEP_STATUS_DONE' },
          { ...runningStep2, status: 'CORTEX_STEP_STATUS_DONE' },
        ],
      },
    }
  );
  const payload3 = JSON.parse(res3.content[0].text);
  assert.equal(payload3.trackedCount, 1);
  assert.equal(payload3.repositories[0].path, '/tmp/repo-beta');
});

test('extractGitStepAction supports CLI fallback and worktree_* compatibility', () => {
  const step = {
    type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      toolCall: {
        id: 'cmd-1',
        name: 'run_command',
        argumentsJson: JSON.stringify({
          CommandLine:
            'node /path/mcp/git_mcp.mjs --cli git_register \'{"path":"/tmp/cli-repo","label":"CLI"}\'',
        }),
      },
    },
  };
  const action = extractGitStepAction(step);
  assert.ok(action);
  assert.equal(action.toolName, 'git_register');
  assert.equal(action.args.path, '/tmp/cli-repo');
});

test('git_service inspects repos/worktrees, parses diffs/lines, stages, unstages, discards, commits, and blocks escapes', async () => {
  const outer = mkdtempSync(join(tmpdir(), 'sc-git-'));
  const mainRepo = join(outer, 'main-repo');
  const linkedWt = join(outer, 'wt-feature');
  const outsideDir = join(outer, 'outside');
  mkdirSync(mainRepo, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(outsideDir, 'secret.txt'), 'do-not-delete\n', 'utf-8');

  try {
    gitInit(mainRepo);
    writeFileSync(
      join(mainRepo, 'app.js'),
      ['line 1', 'line 2', 'line 3', 'line 4', 'line 5'].join('\n') + '\n',
      'utf-8'
    );
    writeFileSync(join(mainRepo, 'README.md'), '# Demo\n', 'utf-8');
    execFileSync('git', ['add', '.'], { cwd: mainRepo });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: mainRepo });

    // Create linked worktree on branch feat/ui
    execFileSync('git', ['worktree', 'add', '-b', 'feat/ui', linkedWt, 'main'], {
      cwd: mainRepo,
    });

    // Add a committed change in linkedWt
    writeFileSync(join(linkedWt, 'README.md'), '# Demo\n\nFeature branch.\n', 'utf-8');
    execFileSync('git', ['commit', '-am', 'Add feature docs'], { cwd: linkedWt });

    // Create a staged modification, an unstaged modification, and an untracked file in linkedWt
    writeFileSync(
      join(linkedWt, 'app.js'),
      ['line 1', 'line 2 staged', 'line 3', 'line 4', 'line 5'].join('\n') + '\n',
      'utf-8'
    );
    await stageChanges(linkedWt, { paths: ['app.js'] });

    writeFileSync(
      join(linkedWt, 'app.js'),
      ['line 1', 'line 2 staged', 'line 3', 'line 4 unstaged', 'line 5'].join(
        '\n'
      ) + '\n',
      'utf-8'
    );
    writeFileSync(join(linkedWt, 'untracked.txt'), 'hello world\n', 'utf-8');

    const inspected = await inspectGitRepository({
      path: linkedWt,
      sources: ['mcp'],
      primarySource: 'mcp',
      isMcpRegistered: true,
      baseRef: 'main',
      label: 'Feature UI Worktree',
    });

    assert.equal(inspected.isGitRepo, true);
    assert.equal(inspected.isMainWorktree, false);
    assert.equal(inspected.repoName, 'main-repo');
    assert.equal(inspected.branch, 'feat/ui');
    assert.equal(inspected.aheadCount, 1);
    assert.equal(inspected.counts.staged, 1);
    assert.equal(inspected.counts.unstaged, 1);
    assert.equal(inspected.counts.untracked, 1);
    assert.equal(inspected.counts.totalDirty, 3);

    // Diff in working mode includes README is committed (so not in working), app.js + untracked.txt are in working
    const workingDiff = await getRepositoryDiff(linkedWt, {
      mode: 'working',
      baseRef: 'main',
      context: 1,
    });
    assert.equal(workingDiff.files.length, 2);
    assert.equal(workingDiff.commits.length, 1);
    assert.equal(workingDiff.commits[0].subject, 'Add feature docs');

    // Diff in 'all' mode includes README.md + app.js + untracked.txt
    const allDiff = await getRepositoryDiff(linkedWt, {
      mode: 'all',
      baseRef: 'main',
      context: 1,
    });
    assert.equal(allDiff.files.length, 3);

    // Context file lines reader
    const fileLines = await getRepositoryFileLines(linkedWt, {
      file: 'app.js',
      mode: 'working',
    });
    assert.equal(fileLines.totalLines, 5);
    assert.equal(fileLines.lines[3], 'line 4 unstaged');

    // Discard unstaged modification on app.js (keeps staged change intact!)
    await discardChanges(linkedWt, { paths: ['app.js'] });
    const afterDiscardMod = readFileSync(join(linkedWt, 'app.js'), 'utf-8');
    assert.ok(afterDiscardMod.includes('line 2 staged'));
    assert.ok(!afterDiscardMod.includes('line 4 unstaged'));

    // Discard untracked.txt
    await discardChanges(linkedWt, { paths: ['untracked.txt'] });
    assert.equal(existsSync(join(linkedWt, 'untracked.txt')), false);

    // Unstage app.js, then re-stage and commit
    await unstageChanges(linkedWt, { paths: ['app.js'] });
    const afterUnstage = await inspectGitRepository({ path: linkedWt });
    assert.equal(afterUnstage.counts.staged, 0);
    assert.equal(afterUnstage.counts.unstaged, 1);

    const commitRes = await commitRepositoryChanges(linkedWt, {
      message: 'Update app.js line 2',
      stageAll: true,
    });
    assert.equal(commitRes.ok, true);
    assert.equal(commitRes.subject, 'Update app.js line 2');

    // Amend commit message
    const amendRes = await commitRepositoryChanges(linkedWt, {
      message: 'Update app.js line 2 (amended)',
      amend: true,
    });
    assert.equal(amendRes.ok, true);
    assert.equal(amendRes.amended, true);
    assert.equal(amendRes.subject, 'Update app.js line 2 (amended)');

    // Path traversal & symlink escape guards
    assert.throws(() => {
      resolveScopedGitPath(linkedWt, '../outside/secret.txt');
    }, /outside repository root/);

    assert.throws(() => {
      resolveScopedGitPath(linkedWt, '.git/config');
    }, /not permitted/);

    const symlinkDir = join(linkedWt, 'escape_link');
    symlinkSync(outsideDir, symlinkDir);
    await assert.rejects(async () => {
      await discardChanges(linkedWt, { paths: ['escape_link/secret.txt'] });
    }, /escapes repository root/);
    assert.equal(existsSync(join(outsideDir, 'secret.txt')), true);
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test('parsePorcelainZStatus handles renamed files and spaces in filenames', () => {
  const raw = [
    'R  new name.js',
    'old name.js',
    ' M src/index.js',
    '?? untracked file.txt',
    '',
  ].join('\0');
  const parsed = parsePorcelainZStatus(raw);
  assert.equal(parsed.counts.staged, 1);
  assert.equal(parsed.counts.unstaged, 1);
  assert.equal(parsed.counts.untracked, 1);
  assert.equal(parsed.staged[0].path, 'new name.js');
  assert.equal(parsed.staged[0].oldPath, 'old name.js');
});

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`PASS: ${t.name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL: ${t.name}`);
    console.error(err);
  }
}
if (failed > 0) {
  process.exit(1);
}
console.log(`All ${tests.length} tests passed.`);
