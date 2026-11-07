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
 * Normalizes Git `%G?`, `%GK`, and `%GS` signature verification fields.
 *
 * Git `%G?` codes:
 * - `G`: valid (good) signature
 * - `U`: good signature with unknown trust validity
 * - `X`: good signature that has expired
 * - `Y`: good signature made by an expired key
 * - `R`: good signature made by a revoked key
 * - `B`: bad signature
 * - `E`: signature cannot be checked (e.g., missing public key)
 * - `N`: no signature
 */
export function parseCommitGpgStatus(rawStatus = '', keyId = '', signer = '') {
  const status = String(rawStatus || '').trim().toUpperCase() || 'N';
  const verified = status === 'G' || status === 'U';
  const signed = status !== 'N';
  return {
    gpgStatus: status,
    gpgVerified: verified,
    gpgSigned: signed,
    gpgKeyId: String(keyId || '').trim(),
    gpgSigner: String(signer || '').trim(),
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
  const commitLogFormat = '%h%x09%s%x09%an%x09%cr%x09%G?%x09%GK%x09%GS';
  const parseCommitLine = (line) => {
    const [sha, subject, author, relTime, gpgCode, gpgKeyId, gpgSigner] =
      line.split('\t');
    if (!sha) return null;
    const gpg = parseCommitGpgStatus(gpgCode, gpgKeyId, gpgSigner);
    return {
      sha,
      subject,
      author,
      relTime,
      ...gpg,
    };
  };

  if (hasHead) {
    if (mergeBase && mergeBase !== headFullSha) {
      const logRes = await runGit(normPath, [
        'log',
        `--format=${commitLogFormat}`,
        '-n',
        '35',
        `${mergeBase}..HEAD`,
      ]);
      if (logRes.ok && logRes.stdout.trim()) {
        for (const line of logRes.stdout.trim().split('\n')) {
          const item = parseCommitLine(line);
          if (item) commits.push(item);
        }
      }
    }
    // If on main/base branch (0 commits ahead of mergeBase), still populate recent
    // commits so the Commits view works as a normal VCS commit log inspector.
    if (commits.length === 0) {
      commitsScope = 'recent';
      const recentRes = await runGit(normPath, [
        'log',
        `--format=${commitLogFormat}`,
        '-n',
        '20',
        'HEAD',
      ]);
      if (recentRes.ok && recentRes.stdout.trim()) {
        for (const line of recentRes.stdout.trim().split('\n')) {
          const item = parseCommitLine(line);
          if (item) commits.push(item);
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

/**
 * Normalizes a diff revision / mode token into `{ rev, mode, commit, label }`.
 *
 * Accepted tokens:
 * - `'working'` | `'working-tree'` | `'dirty'` -> `{ rev: 'working', mode: 'working', commit: '', label: 'working' }`
 * - `'staged'` | `'staged-index'` -> `{ rev: 'staged', mode: 'staged', commit: '', label: 'staged' }`
 * - `'unstaged'` | `'unstaged-worktree'` -> `{ rev: 'unstaged', mode: 'unstaged', commit: '', label: 'unstaged' }`
 * - `'all'` | `'all-vs-base'` -> `{ rev: 'all', mode: 'all', commit: '', label: 'all' }`
 * - `'branch'` | `'branch-commits'` -> `{ rev: 'branch', mode: 'branch', commit: '', label: 'branch' }`
 * - `'commit-<sha>'` or `<sha>` (hex `^[0-9a-f]{6,40}$`) -> `{ rev: sha, mode: 'branch', commit: sha, label: sha.slice(0, 7) }`
 */
export function normalizeDiffRevSpec({
  rev = '',
  mode = '',
  commit = '',
} = {}) {
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
  const commitPrefixMatch = /^commit-([0-9a-f]{6,40})$/i.exec(rawToken);
  if (commitPrefixMatch) {
    const sha = commitPrefixMatch[1];
    return {
      rev: sha,
      mode: 'branch',
      commit: sha,
      label: sha.slice(0, 7),
    };
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
      return { rev: 'working', mode: 'working', commit: '', label: 'working' };
  }
}

/**
 * Parses a diff line / range specification into `{ side, startLine, endLine, urlParam, displayLabel }`.
 *
 * Supported formats:
 * - `'L39'`, `'+L39'`, `' L39'` (unencoded `+` in query string), `'+39'`, `'39'` -> `{ side: 'new', startLine: 39, endLine: 39, urlParam: 'L39', displayLabel: '+L39' }`
 * - `'L36-L42'`, `'+L36-L42'`, `'+36-42'`, `'36-42'` -> `{ side: 'new', startLine: 36, endLine: 42, urlParam: 'L36-L42', displayLabel: '+L36-L42' }`
 * - `'-L18'`, `'-18'` -> `{ side: 'old', startLine: 18, endLine: 18, urlParam: '-L18', displayLabel: '-L18' }`
 * - `'-L18-L22'`, `'-18-22'` -> `{ side: 'old', startLine: 18, endLine: 22, urlParam: '-L18-L22', displayLabel: '-L18-L22' }`
 */
export function parseDiffLineRange(rawLines) {
  if (rawLines === null || rawLines === undefined) return null;
  const cleaned = String(rawLines).trim();
  if (!cleaned) return null;

  const m =
    /^([+-])?[Ll]?(\d+)(?:\s*(?:-[+-]?[Ll]?|\.\.)(\d+))?$/.exec(cleaned);
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

  return {
    side,
    startLine,
    endLine,
    urlParam,
    displayLabel,
  };
}

/**
 * Parses a logical diff anchor URI or markdown link into normalized fields:
 * `{ repo, rev, mode, commit, file, lines, lineRange }`.
 *
 * Accepts:
 * 1. `sidecar://source-control/git_ui/?repo=...&rev=...&file=...&lines=...`
 * 2. Markdown links wrapping a `sidecar://` or `git-diff://` URI: `[label](sidecar://...)`
 * 3. `git-diff://<repo>.local/<rev>/<file>` or `file:///git-diff/<repo>.local/<rev>/<file>`
 */
export function parseDiffAnchorUri(rawInput) {
  const input = String(rawInput || '').trim();
  if (!input) return null;

  // Unwrap markdown link `[label](href)` if passed directly
  const mdMatch = /^\[[^\]]*\]\(([^)]+)\)$/.exec(input);
  const uriStr = mdMatch ? mdMatch[1].trim() : input;

  // Case 1: sidecar://source-control/git_ui/?... or source-control/git_ui/?...
  if (
    /^sidecar:\/\//i.test(uriStr) ||
    /^\/?source-control\/git_ui\b/i.test(uriStr) ||
    /^\/?git_ui\b/i.test(uriStr)
  ) {
    const qIdx = uriStr.indexOf('?');
    if (qIdx === -1) {
      return {
        repo: '',
        ...normalizeDiffRevSpec({}),
        file: '',
        lines: '',
        lineRange: null,
      };
    }
    const hashIdx = uriStr.indexOf('#', qIdx);
    const queryPart =
      hashIdx >= 0 ? uriStr.slice(qIdx + 1, hashIdx) : uriStr.slice(qIdx + 1);
    const hashPart = hashIdx >= 0 ? uriStr.slice(hashIdx + 1) : '';
    const params = new URLSearchParams(queryPart);

    const repo = (
      params.get('repo') ||
      params.get('path') ||
      params.get('root') ||
      ''
    )
      .trim()
      .replace(/\.local$/i, '');
    const revSpec = normalizeDiffRevSpec({
      rev: params.get('rev') || '',
      mode: params.get('mode') || '',
      commit: params.get('commit') || '',
    });
    const file = (params.get('file') || '').trim().replace(/^\/+/, '');
    const rawLines =
      params.get('lines') || params.get('line') || hashPart || '';
    const lineRange = parseDiffLineRange(rawLines);

    return {
      repo,
      ...revSpec,
      file,
      lines: lineRange ? lineRange.displayLabel : rawLines.trim(),
      lineRange,
    };
  }

  // Case 2: git-diff://<repo>.local/<rev>/<file>[?lines=...][#L...] or file:///git-diff/<repo>.local/<rev>/<file>
  const gitDiffMatch =
    /^(?:git-diff:\/\/|file:\/\/\/git-diff\/)([^/?#]+)\/([^/?#]+)\/([^?#]+)(?:\?([^#]*))?(?:#(.*))?$/i.exec(
      uriStr
    );
  if (gitDiffMatch) {
    const repo = decodeURIComponent(gitDiffMatch[1]).replace(/\.local$/i, '');
    const rawRev = decodeURIComponent(gitDiffMatch[2]);
    const file = decodeURIComponent(gitDiffMatch[3]).replace(/^\/+/, '');
    const queryStr = gitDiffMatch[4] || '';
    const hashStr = gitDiffMatch[5] || '';
    const params = new URLSearchParams(queryStr);
    const rawLines =
      params.get('lines') || params.get('line') || hashStr || '';
    const revSpec = normalizeDiffRevSpec({ rev: rawRev });
    const lineRange = parseDiffLineRange(rawLines);
    return {
      repo,
      ...revSpec,
      file,
      lines: lineRange ? lineRange.displayLabel : rawLines.trim(),
      lineRange,
    };
  }

  return null;
}

/**
 * Formats a canonical `sidecar://source-control/git_ui/?...` deep-link URI
 * and a Markdown pill for citing a logical diff in chat or artifacts.
 */
export function formatDiffAnchorLink({
  repo = '',
  rev = '',
  mode = '',
  commit = '',
  file = '',
  lines = '',
  label = '',
  autoOpen = false,
} = {}) {
  const cleanRepo = (
    basename(String(repo || '').trim().replace(/\/+$/, '')) ||
    String(repo || '').trim()
  ).replace(/\.local$/i, '');
  const revSpec = normalizeDiffRevSpec({ rev, mode, commit });
  const cleanFile = String(file || '').trim().replace(/^\/+/, '');
  const lineRange = parseDiffLineRange(lines);

  const params = new URLSearchParams();
  if (cleanRepo) params.set('repo', cleanRepo);
  if (revSpec.rev) params.set('rev', revSpec.rev);
  if (cleanFile) params.set('file', cleanFile);
  if (lineRange) {
    params.set('lines', lineRange.urlParam);
  }
  if (!autoOpen) {
    params.set('auto_open', 'false');
  }

  const query = params.toString();
  const sidecarUri = `sidecar://source-control/git_ui/${query ? `?${query}` : ''}`;

  const logicalRevSlug = revSpec.commit
    ? `commit-${revSpec.commit.slice(0, 7)}`
    : revSpec.mode === 'staged'
      ? 'staged-index'
      : revSpec.mode === 'unstaged'
        ? 'unstaged-worktree'
        : revSpec.mode === 'all'
          ? 'all-vs-base'
          : revSpec.mode === 'branch'
            ? 'branch-commits'
            : 'working-tree';
  const repoSlug =
    cleanRepo.replace(/[^a-zA-Z0-9._-]+/g, '-') || 'repo';
  const logicalUri = cleanFile
    ? `git-diff://${repoSlug}.local/${logicalRevSlug}/${cleanFile}`
    : `git-diff://${repoSlug}.local/${logicalRevSlug}`;

  let pillLabel = String(label || '').trim();
  if (!pillLabel) {
    const metaParts = [];
    if (revSpec.label) metaParts.push(revSpec.label);
    if (lineRange) metaParts.push(lineRange.displayLabel);
    const suffix = metaParts.length > 0 ? ` (${metaParts.join(' · ')})` : '';
    pillLabel = cleanFile
      ? `\`${cleanFile}\`${suffix}`
      : `${cleanRepo || 'Source Control'}${suffix}`;
  }

  return {
    sidecarUri,
    logicalUri,
    markdownPill: `[${pillLabel}](${sidecarUri})`,
    repo: cleanRepo,
    rev: revSpec.rev,
    mode: revSpec.mode,
    commit: revSpec.commit,
    file: cleanFile,
    lineRange,
  };
}

/**
 * Resolves a repository query (repo basename, label, or path) against the session's
 * tracked repositories or local filesystem.
 */
export function resolveRepositoryFromQuery(repoQuery, trackedRepos = []) {
  const raw = String(repoQuery || '')
    .trim()
    .replace(/\.local$/i, '');
  const list = Array.isArray(trackedRepos) ? trackedRepos : [];

  if (!raw) {
    return list[0]?.path || '';
  }

  const normCandidate = normalizeRepoPath(raw);
  if (normCandidate) {
    const exactMatch = list.find((r) => r.path === normCandidate);
    if (exactMatch) return exactMatch.path;
  }

  const lower = raw.toLowerCase();
  for (const r of list) {
    const base = basename(r.path || '').toLowerCase();
    const name = String(r.name || '').toLowerCase();
    const label = String(r.label || '').toLowerCase();
    if (base === lower || name === lower || (label && label === lower)) {
      return r.path;
    }
  }

  for (const r of list) {
    if (
      String(r.path || '')
        .toLowerCase()
        .endsWith(`/${lower}`)
    ) {
      return r.path;
    }
  }

  if (normCandidate && existsSync(normCandidate)) {
    return normCandidate;
  }

  return '';
}

/**
 * Resolves a logical diff anchor or explicit parameters (`repo`, `rev`/`mode`/`commit`,
 * `file`, `lines`, `contextLines`) into structured diff hunks, surrounding file lines,
 * exact raw `git` command, and clickable `sidecar://source-control/git_ui/?...` pill.
 */
export async function getLogicalDiffContext(options = {}) {
  const parsedUri = options.uri ? parseDiffAnchorUri(options.uri) : null;
  const repoQuery = options.repo || parsedUri?.repo || '';
  const revSpec = normalizeDiffRevSpec({
    rev: options.rev || parsedUri?.rev || '',
    mode: options.mode || parsedUri?.mode || '',
    commit: options.commit || parsedUri?.commit || '',
  });
  const targetFile = String(options.file || parsedUri?.file || '')
    .trim()
    .replace(/^\/+/, '');
  const rawLines =
    options.lines !== undefined ? options.lines : parsedUri?.lines || '';
  const lineRange = parseDiffLineRange(rawLines) || parsedUri?.lineRange || null;

  const rawCtx = Number.parseInt(
    String(options.contextLines ?? options.context_lines ?? '10'),
    10
  );
  const contextLines = Number.isFinite(rawCtx)
    ? Math.max(0, Math.min(200, rawCtx))
    : 10;

  const wtPath = resolveRepositoryFromQuery(
    repoQuery,
    options.trackedRepos || []
  );
  if (!wtPath || !existsSync(wtPath)) {
    return {
      ok: false,
      error: repoQuery
        ? `Could not resolve repository "${repoQuery}" in session or on disk.`
        : 'No repository specified and no tracked repositories in the active session.',
    };
  }

  const diffData = await getRepositoryDiff(wtPath, {
    mode: revSpec.mode,
    commit: revSpec.commit,
    context: contextLines,
    baseRef: options.baseRef || '',
  });
  if (diffData.error) {
    return {
      ok: false,
      error: diffData.error,
      repositoryPath: wtPath,
    };
  }

  const repoName = basename(wtPath);
  const linkInfo = formatDiffAnchorLink({
    repo: repoName,
    rev: revSpec.rev,
    mode: revSpec.mode,
    commit: revSpec.commit,
    file: targetFile,
    lines: lineRange ? lineRange.displayLabel : '',
  });

  const fileSuffix = targetFile ? ` -- ${targetFile}` : '';
  const uFlag = `-U${contextLines}`;
  const gitCommand = revSpec.commit
    ? `git -C ${wtPath} show ${uFlag} ${revSpec.commit}${fileSuffix}`
    : revSpec.mode === 'staged'
      ? `git -C ${wtPath} diff ${uFlag} --cached${fileSuffix}`
      : revSpec.mode === 'unstaged'
        ? `git -C ${wtPath} diff ${uFlag}${fileSuffix}`
        : revSpec.mode === 'all'
          ? `git -C ${wtPath} diff ${uFlag} ${diffData.mergeBase || diffData.baseRef || 'HEAD'}${fileSuffix}`
          : revSpec.mode === 'branch'
            ? `git -C ${wtPath} diff ${uFlag} ${diffData.mergeBase || diffData.baseRef || 'HEAD'}..HEAD${fileSuffix}`
            : `git -C ${wtPath} diff ${uFlag} HEAD${fileSuffix}`;

  let matchedFiles = diffData.files || [];
  if (targetFile) {
    matchedFiles = matchedFiles.filter(
      (f) =>
        f.path === targetFile ||
        f.oldPath === targetFile ||
        f.path.endsWith(`/${targetFile}`)
    );
  }

  const formattedFiles = [];
  for (const f of matchedFiles) {
    const hunkTexts = [];
    for (const h of f.hunks || []) {
      if ( lineRange ) {
        // Check if hunk overlaps or is within contextLines*2 of lineRange;
        // if multiple hunks exist and lineRange is specified, we still include all
        // hunks for the file unless the file has many hunks, in which case we prioritize overlapping ones.
      }
      const renderedLines = [h.header];
      for (const l of h.lines || []) {
        if (l.type === 'meta') {
          renderedLines.push(`  ${l.text}`);
          continue;
        }
        const prefix = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
        const lineNo =
          lineRange?.side === 'old'
            ? l.oldNo
            : (l.newNo ?? l.oldNo);
        const isTarget =
          lineRange &&
          lineNo !== null &&
          lineNo !== undefined &&
          lineNo >= lineRange.startLine &&
          lineNo <= lineRange.endLine &&
          (lineRange.side === 'old' ? l.oldNo !== null : l.newNo !== null);
        const marker = isTarget ? '>' : ' ';
        const oldPad =
          l.oldNo !== null && l.oldNo !== undefined
            ? String(l.oldNo).padStart(4, ' ')
            : '    ';
        const newPad =
          l.newNo !== null && l.newNo !== undefined
            ? String(l.newNo).padStart(4, ' ')
            : '    ';
        renderedLines.push(`${marker} ${oldPad} ${newPad} | ${prefix}${l.text}`);
      }
      hunkTexts.push(renderedLines.join('\n'));
    }

    formattedFiles.push({
      path: f.path,
      oldPath: f.oldPath || '',
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      hunkCount: (f.hunks || []).length,
      formattedDiff: hunkTexts.join('\n\n'),
    });
  }

  // If a specific file & lineRange were requested, also fetch surrounding lines from the file
  // so the agent gets full surrounding context even when the target line lies outside a diff hunk.
  let surroundingFileWindow = null;
  if (targetFile && lineRange && lineRange.side !== 'old') {
    const fileLinesRes = await getRepositoryFileLines(wtPath, {
      file: targetFile,
      mode: revSpec.mode,
      commit: revSpec.commit,
    });
    if (!fileLinesRes.error && Array.isArray(fileLinesRes.lines)) {
      const winStart = Math.max(1, lineRange.startLine - contextLines);
      const winEnd = Math.min(
        fileLinesRes.totalLines,
        lineRange.endLine + contextLines
      );
      const windowLines = [];
      for (let ln = winStart; ln <= winEnd; ln++) {
        const isTarget =
          ln >= lineRange.startLine && ln <= lineRange.endLine;
        const marker = isTarget ? '>' : ' ';
        const lnPad = String(ln).padStart(4, ' ');
        windowLines.push(
          `${marker} ${lnPad} | ${fileLinesRes.lines[ln - 1] ?? ''}`
        );
      }
      surroundingFileWindow = {
        startLine: winStart,
        endLine: winEnd,
        totalLines: fileLinesRes.totalLines,
        snippet: windowLines.join('\n'),
      };
    }
  }

  return {
    ok: true,
    repositoryPath: wtPath,
    repositoryName: repoName,
    rev: revSpec.rev,
    mode: revSpec.mode,
    commit: revSpec.commit,
    file: targetFile,
    lines: lineRange ? lineRange.displayLabel : '',
    lineRange,
    contextLines,
    gitCommand,
    sidecarUri: linkInfo.sidecarUri,
    logicalUri: linkInfo.logicalUri,
    markdownPill: linkInfo.markdownPill,
    fileCount: formattedFiles.length,
    files: formattedFiles,
    surroundingFileWindow,
  };
}
