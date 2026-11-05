/**
 * @fileoverview Core Git inspection, unified diff parser, context line reader,
 * and scoped VCS mutation service (`stage`, `unstage`, `discard`, `commit`)
 * for `source-control`.
 */

import { execFile } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  formatRepoDisplayPath,
  normalizeRepoPath,
} from './session_repos.mjs';

const execFileAsync = promisify(execFile);
const HOME = homedir();

/**
 * Executes a `git` command in `cwd`.
 * Read-only queries pass `GIT_OPTIONAL_LOCKS=0` by default to avoid index lock contention.
 */
export async function runGit(
  cwd,
  args,
  { maxBuffer = 16 * 1024 * 1024, writeOperation = false } = {}
) {
  try {
    const env = { ...process.env };
    if (!writeOperation) {
      env.GIT_OPTIONAL_LOCKS = '0';
    }
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      maxBuffer,
      env,
    });
    return { ok: true, stdout, stderr: stderr || '' };
  } catch (err) {
    return {
      ok: false,
      stdout: err?.stdout || '',
      stderr: err?.stderr || err?.message || '',
    };
  }
}

/**
 * Validates that `relOrAbsPath` resolves strictly inside `rootPath` and returns
 * `{ root, target, relPath }`.
 */
export function resolveScopedGitPath(rootPath, relOrAbsPath) {
  const root = normalizeRepoPath(rootPath);
  if (!root) {
    throw new Error('Missing repository root path.');
  }
  const raw = String(relOrAbsPath || '').trim();
  if (!raw) {
    throw new Error('Missing target file path.');
  }
  const target = resolve(root, raw);
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || resolve(root, rel) !== target) {
    throw new Error(
      `Path "${raw}" is outside repository root "${root}".`
    );
  }
  if (rel === '.git' || rel.startsWith('.git/')) {
    throw new Error('Direct mutation of .git metadata is not permitted.');
  }

  let realRoot = root;
  try {
    realRoot = realpathSync(root);
  } catch {
    // Keep lexical root if not yet resolvable
  }

  const parentDir = dirname(target);
  if (existsSync(parentDir)) {
    let realParent = parentDir;
    try {
      realParent = realpathSync(parentDir);
    } catch {
      realParent = parentDir;
    }
    if (
      realParent !== realRoot &&
      !realParent.startsWith(`${realRoot}/`)
    ) {
      throw new Error(
        `Path "${raw}" escapes repository root via symlink.`
      );
    }
  }

  if (existsSync(target)) {
    try {
      const lst = lstatSync(target);
      if (!lst.isSymbolicLink()) {
        const realTarget = realpathSync(target);
        if (
          realTarget !== realRoot &&
          !realTarget.startsWith(`${realRoot}/`)
        ) {
          throw new Error(
            `Path "${raw}" escapes repository root via symlink.`
          );
        }
      }
    } catch (err) {
      if (err?.message?.includes('escapes repository root')) {
        throw err;
      }
    }
  }

  return { root, target, relPath: rel };
}

/**
 * Formats a concise display name for a repository or worktree path.
 */
export function formatWorktreeDisplayName(wtPath, repoRoot, isMainWorktree) {
  if (isMainWorktree && repoRoot) {
    return basename(repoRoot);
  }
  const treesDir = `${join(HOME, '.local', 'trees')}/`;
  if (wtPath.startsWith(treesDir)) {
    return wtPath.slice(treesDir.length);
  }
  return basename(wtPath) || formatRepoDisplayPath(wtPath);
}

/**
 * Resolves the default base branch for a repository/worktree when `baseRef` is
 * not explicitly specified in session metadata.
 */
export async function resolveDefaultBaseRef(wtPath) {
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    const res = await runGit(wtPath, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${ref}^{commit}`,
    ]);
    if (res.ok && res.stdout.trim()) {
      return ref;
    }
  }
  return 'HEAD';
}

/**
 * Parses `git status --porcelain=v1 -uall -z` output into structured
 * `staged` and `unstaged` file change lists, a lookup `statusMap`, and summary `counts`.
 */
export function parsePorcelainZStatus(rawStdout) {
  const staged = [];
  const unstaged = [];
  const statusMap = new Map();

  if (!rawStdout) {
    return {
      staged,
      unstaged,
      statusMap,
      counts: { staged: 0, unstaged: 0, untracked: 0, totalDirty: 0 },
    };
  }

  const tokens = rawStdout.split('\0');
  let i = 0;
  let stagedCount = 0;
  let unstagedCount = 0;
  let untrackedCount = 0;

  while (i < tokens.length) {
    const entry = tokens[i++];
    if (!entry || entry.length < 4) continue;

    const x = entry[0];
    const y = entry[1];
    const filePath = entry.slice(3);
    let oldPath = '';

    // In porcelain v1 `-z`, renames and copies (`R` or `C` in X or Y) are followed
    // by a second NUL-terminated token containing the original path.
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      oldPath = tokens[i++] || '';
    }

    const isUntracked = x === '?' && y === '?';
    const isStaged = x !== ' ' && x !== '?';
    const isUnstaged = y !== ' ' && y !== '?';

    if (isUntracked) {
      untrackedCount++;
      unstaged.push({
        path: filePath,
        oldPath: '',
        status: 'U',
        statusLabel: 'U',
        section: 'unstaged',
        isUntracked: true,
        rawX: x,
        rawY: y,
      });
    } else {
      if (isStaged) {
        stagedCount++;
        staged.push({
          path: filePath,
          oldPath,
          status: x,
          statusLabel: x,
          section: 'staged',
          isUntracked: false,
          rawX: x,
          rawY: y,
        });
      }
      if (isUnstaged) {
        unstagedCount++;
        unstaged.push({
          path: filePath,
          oldPath,
          status: y,
          statusLabel: y,
          section: 'unstaged',
          isUntracked: false,
          rawX: x,
          rawY: y,
        });
      }
    }

    statusMap.set(filePath, {
      path: filePath,
      oldPath,
      staged: isStaged,
      unstaged: isUnstaged,
      untracked: isUntracked,
      indexStatus: isStaged ? x : '',
      worktreeStatus: isUntracked ? 'U' : isUnstaged ? y : '',
    });
  }

  return {
    staged,
    unstaged,
    statusMap,
    counts: {
      staged: stagedCount,
      unstaged: unstagedCount,
      untracked: untrackedCount,
      totalDirty: stagedCount + unstagedCount + untrackedCount,
    },
  };
}

/**
 * Enriches a session-tracked repository/worktree entry with live Git branch,
 * commit, worktree topology, and working-tree/index status changes.
 */
export async function inspectGitRepository(metaEntry) {
  const wtPath = metaEntry.path;
  const baseFields = {
    path: wtPath,
    uri: metaEntry.uri || `file://${wtPath}`,
    name: metaEntry.name || basename(wtPath) || '/',
    displayPath: metaEntry.displayPath || formatRepoDisplayPath(wtPath),
    sources: metaEntry.sources || ['mcp'],
    primarySource: metaEntry.primarySource || 'mcp',
    isMcpRegistered: Boolean(metaEntry.isMcpRegistered),
    inheritedFromFork: Boolean(metaEntry.inheritedFromFork),
    label: metaEntry.label || '',
    registeredStep: metaEntry.registeredStep ?? -1,
    updatedStep: metaEntry.updatedStep ?? -1,
  };

  if (!existsSync(wtPath)) {
    return {
      ...baseFields,
      displayName: basename(wtPath) || wtPath,
      repoName: basename(wtPath) || wtPath,
      repoRoot: wtPath,
      existsOnDisk: false,
      isGitRepo: false,
      isMainWorktree: false,
      branch: 'missing',
      detached: false,
      headSha: '',
      headSubject: 'Directory not found on disk',
      headAuthor: '',
      headRelTime: '',
      headTimestamp: 0,
      headCommitMessage: '',
      baseRef: metaEntry.baseRef || 'HEAD',
      aheadCount: 0,
      behindCount: 0,
      changes: { staged: [], unstaged: [] },
      counts: {
        staged: 0,
        unstaged: 0,
        untracked: 0,
        totalDirty: 0,
        ahead: 0,
        behind: 0,
      },
    };
  }

  const [commonDirRes, topLevelRes, branchRes, statusRes, logRes] =
    await Promise.all([
      runGit(wtPath, ['rev-parse', '--git-common-dir']),
      runGit(wtPath, ['rev-parse', '--show-toplevel']),
      runGit(wtPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      runGit(wtPath, ['status', '--porcelain=v1', '-uall', '-z']),
      runGit(wtPath, [
        'log',
        '-1',
        '--format=%h%x09%s%x09%an%x09%cr%x09%ct%x09%B',
      ]),
    ]);

  if (!topLevelRes.ok || !topLevelRes.stdout.trim()) {
    return {
      ...baseFields,
      displayName: basename(wtPath) || wtPath,
      repoName: basename(wtPath) || wtPath,
      repoRoot: wtPath,
      existsOnDisk: true,
      isGitRepo: false,
      isMainWorktree: false,
      branch: 'not a git repo',
      detached: false,
      headSha: '',
      headSubject: 'Not a Git repository',
      headAuthor: '',
      headRelTime: '',
      headTimestamp: 0,
      headCommitMessage: '',
      baseRef: metaEntry.baseRef || 'HEAD',
      aheadCount: 0,
      behindCount: 0,
      changes: { staged: [], unstaged: [] },
      counts: {
        staged: 0,
        unstaged: 0,
        untracked: 0,
        totalDirty: 0,
        ahead: 0,
        behind: 0,
      },
    };
  }

  const topLevel = topLevelRes.stdout.trim();
  let repoRoot = topLevel;
  let isMainWorktree = true;

  if (commonDirRes.ok && commonDirRes.stdout.trim()) {
    const commonDir = resolve(wtPath, commonDirRes.stdout.trim());
    if (basename(commonDir) === '.git') {
      const mainRoot = dirname(commonDir);
      try {
        isMainWorktree = realpathSync(mainRoot) === realpathSync(topLevel);
      } catch {
        isMainWorktree = mainRoot === topLevel;
      }
      repoRoot = mainRoot;
    }
  }

  const baseRef = metaEntry.baseRef || (await resolveDefaultBaseRef(wtPath));
  let aheadCount = 0;
  let behindCount = 0;
  if (baseRef && baseRef !== 'HEAD') {
    const revRes = await runGit(wtPath, [
      'rev-list',
      '--left-right',
      '--count',
      `${baseRef}...HEAD`,
    ]);
    if (revRes.ok && revRes.stdout.trim()) {
      const parts = revRes.stdout.trim().split(/\s+/);
      behindCount = Number(parts[0]) || 0;
      aheadCount = Number(parts[1]) || 0;
    }
  }

  const parsedStatus = parsePorcelainZStatus(
    statusRes.ok ? statusRes.stdout : ''
  );

  let headSha = '';
  let headSubject = '';
  let headAuthor = '';
  let headRelTime = '';
  let headTimestamp = 0;
  let headCommitMessage = '';
  if (logRes.ok && logRes.stdout.trim()) {
    const raw = logRes.stdout;
    const parts = raw.split('\t');
    headSha = (parts[0] || '').trim();
    headSubject = (parts[1] || '').trim();
    headAuthor = (parts[2] || '').trim();
    headRelTime = (parts[3] || '').trim();
    headTimestamp = Number(parts[4]) || 0;
    headCommitMessage = parts.slice(5).join('\t').trim();
  }

  const branchName =
    branchRes.ok && branchRes.stdout.trim() ? branchRes.stdout.trim() : '';

  return {
    ...baseFields,
    displayName: formatWorktreeDisplayName(wtPath, repoRoot, isMainWorktree),
    repoName: basename(repoRoot),
    repoRoot,
    existsOnDisk: true,
    isGitRepo: true,
    isMainWorktree,
    branch: branchName || (headSha ? 'detached HEAD' : 'unborn HEAD'),
    detached: !branchName && Boolean(headSha),
    headSha,
    headSubject: headSubject || (headSha ? '' : 'No commits yet'),
    headAuthor,
    headRelTime,
    headTimestamp,
    headCommitMessage,
    baseRef,
    aheadCount,
    behindCount,
    changes: {
      staged: parsedStatus.staged,
      unstaged: parsedStatus.unstaged,
    },
    counts: {
      ...parsedStatus.counts,
      ahead: aheadCount,
      behind: behindCount,
    },
  };
}

/**
 * Parses unified git diff output into structured file and hunk objects.
 */
export function parseUnifiedDiff(rawDiff) {
  const files = [];
  if (!rawDiff || !rawDiff.trim()) return files;

  const lines = rawDiff.split('\n');
  let currentFile = null;
  let currentHunk = null;
  let oldLine = 0;
  let newLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      const oldPath = m ? m[1] : '';
      const newPath = m ? m[2] : '';
      currentFile = {
        path: newPath || oldPath,
        oldPath: oldPath !== newPath ? oldPath : '',
        status: 'M',
        additions: 0,
        deletions: 0,
        isBinary: false,
        hunks: [],
      };
      files.push(currentFile);
      currentHunk = null;
      continue;
    }

    if (!currentFile) continue;

    if (line.startsWith('new file mode ')) {
      currentFile.status = 'A';
      continue;
    }
    if (line.startsWith('deleted file mode ')) {
      currentFile.status = 'D';
      continue;
    }
    if (line.startsWith('rename from ')) {
      currentFile.status = 'R';
      currentFile.oldPath = line.slice('rename from '.length).trim();
      continue;
    }
    if (line.startsWith('rename to ')) {
      currentFile.path = line.slice('rename to '.length).trim();
      continue;
    }
    if (
      line.startsWith('Binary files ') ||
      line.startsWith('GIT binary patch')
    ) {
      currentFile.isBinary = true;
      continue;
    }
    if (
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('similarity index ')
    ) {
      continue;
    }

    if (line.startsWith('@@ ')) {
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      const oldStart = hm ? Number(hm[1]) : 1;
      const oldCount = hm ? (hm[2] !== undefined ? Number(hm[2]) : 1) : 0;
      const newStart = hm ? Number(hm[3]) : 1;
      const newCount = hm ? (hm[4] !== undefined ? Number(hm[4]) : 1) : 0;
      oldLine = oldStart;
      newLine = newStart;
      currentHunk = {
        header: line,
        context: hm && hm[5] ? hm[5].trim() : '',
        oldStart,
        oldCount,
        newStart,
        newCount,
        lines: [],
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    if (currentHunk) {
      if (line.startsWith('+')) {
        currentFile.additions++;
        currentHunk.lines.push({
          type: 'add',
          oldNo: null,
          newNo: newLine++,
          text: line.slice(1),
        });
      } else if (line.startsWith('-')) {
        currentFile.deletions++;
        currentHunk.lines.push({
          type: 'del',
          oldNo: oldLine++,
          newNo: null,
          text: line.slice(1),
        });
      } else if (line.startsWith(' ')) {
        currentHunk.lines.push({
          type: 'ctx',
          oldNo: oldLine++,
          newNo: newLine++,
          text: line.slice(1),
        });
      } else if (line.startsWith('\\ No newline at end of file')) {
        currentHunk.lines.push({
          type: 'meta',
          oldNo: null,
          newNo: null,
          text: line,
        });
      }
    }
  }

  return files;
}

/**
 * Builds synthetic unified diff entries for untracked files in a repository.
 */
export async function buildUntrackedFileDiffs(wtPath, filterFile = '') {
  const args = ['ls-files', '--others', '--exclude-standard', '-z'];
  if (filterFile) {
    args.push('--', filterFile);
  }
  const res = await runGit(wtPath, args);
  if (!res.ok || !res.stdout) return [];

  const relPaths = res.stdout
    .split('\0')
    .map((s) => s.trim())
    .filter(Boolean);

  const out = [];
  for (const relPath of relPaths.slice(0, 60)) {
    const absPath = join(wtPath, relPath);
    try {
      const st = statSync(absPath);
      if (!st.isFile()) continue;
      if (st.size > 256 * 1024) {
        out.push({
          path: relPath,
          oldPath: '',
          status: 'U',
          additions: 0,
          deletions: 0,
          isBinary: true,
          hunks: [],
        });
        continue;
      }
      const raw = readFileSync(absPath);
      if (raw.includes(0)) {
        out.push({
          path: relPath,
          oldPath: '',
          status: 'U',
          additions: 0,
          deletions: 0,
          isBinary: true,
          hunks: [],
        });
        continue;
      }
      const text = raw.toString('utf-8');
      const rawLines = text.split('\n');
      if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
        rawLines.pop();
      }
      const hunkLines = rawLines.map((lineText, idx) => ({
        type: 'add',
        oldNo: null,
        newNo: idx + 1,
        text: lineText,
      }));
      out.push({
        path: relPath,
        oldPath: '',
        status: 'U',
        additions: hunkLines.length,
        deletions: 0,
        isBinary: false,
        hunks: [
          {
            header: `@@ -0,0 +1,${hunkLines.length} @@ (untracked file)`,
            context: 'untracked file',
            oldStart: 0,
            oldCount: 0,
            newStart: 1,
            newCount: hunkLines.length,
            lines: hunkLines,
          },
        ],
      });
    } catch {
      // Skip unreadable file
    }
  }
  return out;
}

/**
 * Computes diffs and commit stack for a repository/worktree.
 *
 * Supported `mode` values:
 * - `'working'` / `'dirty'`: uncommitted working tree + staged + untracked changes
 * - `'staged'`: staged index changes (`git diff --cached`)
 * - `'unstaged'`: unstaged working tree modifications + untracked files
 * - `'all'`: committed + uncommitted changes compared to `merge-base(HEAD, baseRef)`
 * - `'branch'`: committed changes on branch (`mergeBase..HEAD`) or selected commit
 */
export async function getRepositoryDiff(wtPath, options = {}) {
  const normPath = normalizeRepoPath(wtPath);
  const mode = options.mode || 'working';
  if (!normPath || !existsSync(normPath)) {
    return {
      error: 'Repository path does not exist on disk',
      files: [],
      commits: [],
    };
  }

  const baseRef = options.baseRef || (await resolveDefaultBaseRef(normPath));
  const headVerify = await runGit(normPath, [
    'rev-parse',
    '--verify',
    '--quiet',
    'HEAD',
  ]);
  const hasHead = headVerify.ok && Boolean(headVerify.stdout.trim());
  const headFullSha = hasHead ? headVerify.stdout.trim() : '';

  let mergeBase = '';
  if (hasHead && baseRef && baseRef !== 'HEAD') {
    const mbRes = await runGit(normPath, ['merge-base', 'HEAD', baseRef]);
    if (mbRes.ok && mbRes.stdout.trim()) {
      mergeBase = mbRes.stdout.trim();
    }
  }

  const commits = [];
  let commitsScope = 'branch';
  if (hasHead) {
    if (mergeBase && mergeBase !== headFullSha) {
      const logRes = await runGit(normPath, [
        'log',
        '--format=%h%x09%s%x09%an%x09%cr',
        '-n',
        '35',
        `${mergeBase}..HEAD`,
      ]);
      if (logRes.ok && logRes.stdout.trim()) {
        for (const line of logRes.stdout.trim().split('\n')) {
          const [sha, subject, author, relTime] = line.split('\t');
          if (sha) commits.push({ sha, subject, author, relTime });
        }
      }
    }
    // If on main/base branch (0 commits ahead of mergeBase), still populate recent
    // commits so the Commits view works as a normal VCS commit log inspector.
    if (commits.length === 0) {
      commitsScope = 'recent';
      const recentRes = await runGit(normPath, [
        'log',
        '--format=%h%x09%s%x09%an%x09%cr',
        '-n',
        '20',
        'HEAD',
      ]);
      if (recentRes.ok && recentRes.stdout.trim()) {
        for (const line of recentRes.stdout.trim().split('\n')) {
          const [sha, subject, author, relTime] = line.split('\t');
          if (sha) commits.push({ sha, subject, author, relTime });
        }
      }
    }
  }

  const rawCtx = Number.parseInt(String(options.context ?? '3'), 10);
  const contextLines = Number.isFinite(rawCtx)
    ? Math.max(0, Math.min(100000, rawCtx))
    : 3;
  const uFlag = `-U${contextLines}`;

  const selectedCommit =
    typeof options.commit === 'string' &&
    /^[0-9a-f]{6,40}$/i.test(options.commit.trim())
      ? options.commit.trim()
      : '';

  let diffArgs = ['diff', '--no-ext-diff', uFlag];
  let includeUntracked = false;

  if (selectedCommit) {
    diffArgs = ['show', '--format=', '--no-ext-diff', uFlag, selectedCommit];
  } else if (mode === 'staged') {
    diffArgs.push('--cached');
  } else if (mode === 'unstaged') {
    includeUntracked = true;
  } else if (mode === 'dirty' || mode === 'working') {
    if (hasHead) {
      diffArgs.push('HEAD');
    } else {
      diffArgs.push('--cached');
    }
    includeUntracked = true;
  } else if (mode === 'branch') {
    if (mergeBase && mergeBase !== headFullSha) {
      diffArgs.push(`${mergeBase}..HEAD`);
    } else if (commits.length > 0) {
      diffArgs = ['show', '--format=', '--no-ext-diff', uFlag, 'HEAD'];
    } else {
      diffArgs.push('HEAD');
    }
  } else {
    // 'all' vs base
    if (mergeBase) {
      diffArgs.push(mergeBase);
    } else if (hasHead) {
      diffArgs.push('HEAD');
    } else {
      diffArgs.push('--cached');
    }
    includeUntracked = true;
  }

  const [diffRes, statusRes, untrackedFiles] = await Promise.all([
    runGit(normPath, diffArgs),
    runGit(normPath, ['status', '--porcelain=v1', '-uall', '-z']),
    includeUntracked
      ? buildUntrackedFileDiffs(normPath)
      : Promise.resolve([]),
  ]);

  const parsedStatus = parsePorcelainZStatus(
    statusRes.ok ? statusRes.stdout : ''
  );

  const parsedDiffFiles = parseUnifiedDiff(diffRes.stdout);
  const seenPaths = new Set(parsedDiffFiles.map((f) => f.path));
  const mergedFiles = [...parsedDiffFiles];
  for (const uf of untrackedFiles) {
    if (!seenPaths.has(uf.path)) {
      seenPaths.add(uf.path);
      mergedFiles.push(uf);
    }
  }

  const files = mergedFiles.map((f) => ({
    ...f,
    dirtyState: parsedStatus.statusMap.get(f.path) || {
      path: f.path,
      oldPath: f.oldPath || '',
      staged: false,
      unstaged: false,
      untracked: f.status === 'U',
      indexStatus: '',
      worktreeStatus: f.status === 'U' ? 'U' : '',
    },
  }));

  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const f of files) {
    totalAdditions += f.additions;
    totalDeletions += f.deletions;
  }

  return {
    path: normPath,
    mode,
    contextLines,
    baseRef,
    mergeBase: mergeBase ? mergeBase.slice(0, 9) : '',
    commitsScope,
    commits,
    files,
    totalAdditions,
    totalDeletions,
  };
}

/**
 * Reads full file lines at the appropriate revision for context gap expansion.
 */
export async function getRepositoryFileLines(wtPath, options = {}) {
  const normPath = normalizeRepoPath(wtPath);
  const relPath = String(options.file || '').trim();
  const mode = options.mode || 'working';
  if (!normPath || !relPath || !existsSync(normPath)) {
    return {
      error: 'Invalid repository or file path',
      lines: [],
      totalLines: 0,
    };
  }

  let scoped;
  try {
    scoped = resolveScopedGitPath(normPath, relPath);
  } catch (err) {
    return { error: err.message, lines: [], totalLines: 0 };
  }

  const selectedCommit =
    typeof options.commit === 'string' &&
    /^[0-9a-f]{6,40}$/i.test(options.commit.trim())
      ? options.commit.trim()
      : '';

  let content = null;
  if (selectedCommit) {
    const res = await runGit(normPath, [
      'show',
      `${selectedCommit}:${scoped.relPath}`,
    ]);
    if (res.ok) content = res.stdout;
  } else if (mode === 'branch') {
    const res = await runGit(normPath, ['show', `HEAD:${scoped.relPath}`]);
    if (res.ok) content = res.stdout;
  } else if (mode === 'staged') {
    const res = await runGit(normPath, ['show', `:${scoped.relPath}`]);
    if (res.ok) content = res.stdout;
  }

  if (content === null && existsSync(scoped.target)) {
    try {
      const st = statSync(scoped.target);
      if (st.isFile() && st.size <= 2 * 1024 * 1024) {
        content = readFileSync(scoped.target, 'utf-8');
      }
    } catch {
      content = null;
    }
  }

  if (content === null) {
    return { error: 'Unable to read file lines', lines: [], totalLines: 0 };
  }

  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return {
    file: scoped.relPath,
    totalLines: lines.length,
    lines,
  };
}

/**
 * Stages specific paths (or all changes when `all: true`) in `wtPath`.
 */
export async function stageChanges(wtPath, { paths = [], all = false } = {}) {
  const normPath = normalizeRepoPath(wtPath);
  if (!normPath || !existsSync(normPath)) {
    throw new Error('Repository path does not exist on disk.');
  }

  if (all) {
    const res = await runGit(normPath, ['add', '-A', '--', '.'], {
      writeOperation: true,
    });
    if (!res.ok) {
      throw new Error(res.stderr.trim() || 'Failed to stage all changes.');
    }
    return { ok: true, stagedAll: true };
  }

  const relPaths = (Array.isArray(paths) ? paths : [paths])
    .map((p) => String(p || '').trim())
    .filter(Boolean)
    .map((p) => resolveScopedGitPath(normPath, p).relPath);

  if (relPaths.length === 0) {
    throw new Error('No file paths specified to stage.');
  }

  const res = await runGit(normPath, ['add', '-A', '--', ...relPaths], {
    writeOperation: true,
  });
  if (!res.ok) {
    throw new Error(res.stderr.trim() || 'Failed to stage file changes.');
  }
  return { ok: true, paths: relPaths };
}

/**
 * Unstages specific paths (or all staged changes when `all: true`) in `wtPath`.
 */
export async function unstageChanges(
  wtPath,
  { paths = [], all = false } = {}
) {
  const normPath = normalizeRepoPath(wtPath);
  if (!normPath || !existsSync(normPath)) {
    throw new Error('Repository path does not exist on disk.');
  }

  const headRes = await runGit(normPath, [
    'rev-parse',
    '--verify',
    '--quiet',
    'HEAD',
  ]);
  const hasHead = headRes.ok && Boolean(headRes.stdout.trim());

  if (all) {
    const args = hasHead
      ? ['reset', '-q', 'HEAD', '--', '.']
      : ['rm', '--cached', '-r', '-f', '--', '.'];
    const res = await runGit(normPath, args, { writeOperation: true });
    if (!res.ok) {
      throw new Error(res.stderr.trim() || 'Failed to unstage all changes.');
    }
    return { ok: true, unstagedAll: true };
  }

  const relPaths = (Array.isArray(paths) ? paths : [paths])
    .map((p) => String(p || '').trim())
    .filter(Boolean)
    .map((p) => resolveScopedGitPath(normPath, p).relPath);

  if (relPaths.length === 0) {
    throw new Error('No file paths specified to unstage.');
  }

  const args = hasHead
    ? ['reset', '-q', 'HEAD', '--', ...relPaths]
    : ['rm', '--cached', '-r', '-f', '--', ...relPaths];
  const res = await runGit(normPath, args, { writeOperation: true });
  if (!res.ok) {
    throw new Error(res.stderr.trim() || 'Failed to unstage file changes.');
  }
  return { ok: true, paths: relPaths };
}

/**
 * Discards unstaged working-tree modifications and/or untracked files in `wtPath`.
 */
export async function discardChanges(
  wtPath,
  { paths = [], all = false } = {}
) {
  const normPath = normalizeRepoPath(wtPath);
  if (!normPath || !existsSync(normPath)) {
    throw new Error('Repository path does not exist on disk.');
  }

  if (all) {
    const checkoutRes = await runGit(normPath, ['checkout', '--', '.'], {
      writeOperation: true,
    });
    const cleanRes = await runGit(normPath, ['clean', '-fd'], {
      writeOperation: true,
    });
    if (!checkoutRes.ok && !cleanRes.ok) {
      throw new Error(
        checkoutRes.stderr.trim() ||
          cleanRes.stderr.trim() ||
          'Failed to discard working tree changes.'
      );
    }
    return { ok: true, discardedAll: true };
  }

  const scopedItems = (Array.isArray(paths) ? paths : [paths])
    .map((p) => String(p || '').trim())
    .filter(Boolean)
    .map((p) => resolveScopedGitPath(normPath, p));

  if (scopedItems.length === 0) {
    throw new Error('No file paths specified to discard.');
  }

  const statusRes = await runGit(normPath, [
    'status',
    '--porcelain=v1',
    '-uall',
    '-z',
  ]);
  const parsedStatus = parsePorcelainZStatus(
    statusRes.ok ? statusRes.stdout : ''
  );

  const trackedRelPaths = [];
  const untrackedTargets = [];

  for (const item of scopedItems) {
    const st = parsedStatus.statusMap.get(item.relPath);
    if (st?.untracked) {
      untrackedTargets.push(item);
    } else {
      trackedRelPaths.push(item.relPath);
    }
  }

  if (trackedRelPaths.length > 0) {
    const res = await runGit(
      normPath,
      ['checkout', '--', ...trackedRelPaths],
      { writeOperation: true }
    );
    if (!res.ok) {
      throw new Error(
        res.stderr.trim() || 'Failed to discard tracked file modifications.'
      );
    }
  }

  for (const item of untrackedTargets) {
    if (existsSync(item.target)) {
      rmSync(item.target, { recursive: true, force: true });
    }
  }

  return {
    ok: true,
    paths: scopedItems.map((i) => i.relPath),
  };
}

/**
 * Creates or amends a Git commit in `wtPath`.
 */
export async function commitRepositoryChanges(
  wtPath,
  { message = '', amend = false, stageAll = false } = {}
) {
  const normPath = normalizeRepoPath(wtPath);
  if (!normPath || !existsSync(normPath)) {
    throw new Error('Repository path does not exist on disk.');
  }

  const cleanMsg = String(message || '').trim();
  if (!cleanMsg) {
    throw new Error('Commit message cannot be empty.');
  }

  if (stageAll) {
    await stageChanges(normPath, { all: true });
  }

  if (!amend) {
    const statusRes = await runGit(normPath, [
      'status',
      '--porcelain=v1',
      '-uall',
      '-z',
    ]);
    const parsed = parsePorcelainZStatus(
      statusRes.ok ? statusRes.stdout : ''
    );
    if (parsed.counts.staged === 0) {
      throw new Error(
        'No staged changes to commit. Stage files first or enable Stage All.'
      );
    }
  }

  const args = ['commit'];
  if (amend) {
    args.push('--amend');
  }
  args.push('-m', cleanMsg);

  const commitRes = await runGit(normPath, args, { writeOperation: true });
  if (!commitRes.ok) {
    throw new Error(
      commitRes.stderr.trim() ||
        commitRes.stdout.trim() ||
        'Git commit failed.'
    );
  }

  const headRes = await runGit(normPath, [
    'log',
    '-1',
    '--format=%h%x09%s',
  ]);
  const [sha = '', subject = ''] = (headRes.stdout || '').trim().split('\t');

  return {
    ok: true,
    sha,
    subject,
    amended: Boolean(amend),
  };
}
