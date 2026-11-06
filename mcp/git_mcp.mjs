/**
 * @fileoverview Stdio MCP Server for `source-control`.
 *
 * Exposes `git_*` tools (`git_register`, `git_unregister`, `git_list`) so the
 * agent can register, unregister, or list Git repositories and worktrees for
 * the active chat session's Source Control panel.
 *
 * All session state is persisted natively inside the per-conversation
 * Trajectory (`CortexStepMcpTool` / `CORTEX_STEP_TYPE_GENERIC` steps) rather
 * than on the filesystem, so it is automatically inherited when a chat session
 * is forked in the client.
 */

import {
  getSessionRepoState,
  normalizeRepoPath,
} from '../lib/session_repos.mjs';

const SERVER_INFO = {
  name: 'git',
  version: '0.1.9',
};

const TOOLS = [
  {
    name: 'git_register',
    description:
      'Register a Git repository or worktree directory in the current chat session Source Control panel. Tracked purely in per-session trajectory metadata and inherited across client-side session forks.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Path to the Git repository or worktree directory (absolute, ~/..., or file://...).',
        },
        base_ref: {
          type: 'string',
          description:
            'Optional base Git ref/branch to compare against (e.g. "origin/main", "release/0.1"). Auto-detected if omitted.',
        },
        label: {
          type: 'string',
          description:
            'Optional short human-readable label describing what this repository or worktree is used for in this session.',
        },
      },
      required: ['path'],
    },
    _meta: {
      'antigravity/alwaysLoad': true,
    },
  },
  {
    name: 'git_unregister',
    description:
      'Unregister a Git repository or worktree directory from the current chat session Source Control metadata without modifying files on disk.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Path to the Git repository or worktree directory to remove from session tracking.',
        },
      },
      required: ['path'],
    },
    _meta: {
      'antigravity/alwaysLoad': true,
    },
  },
  {
    name: 'git_list',
    description:
      'List all Git repositories and worktrees available in the active chat session Source Control panel, including session workspace repositories, project repositories, MCP-registered repositories/worktrees, and any inherited from a forked parent session.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    _meta: {
      'antigravity/alwaysLoad': true,
    },
  },
];

let useContentLengthFraming = false;
let inputBuffer = Buffer.alloc(0);

process.stdout.on('error', (err) => {
  if (err && err.code === 'EPIPE') {
    process.exit(0);
  }
});

function sendMessage(msg) {
  const json = JSON.stringify(msg);
  if (useContentLengthFraming) {
    const byteLen = Buffer.byteLength(json, 'utf-8');
    process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

function sendResult(id, result) {
  sendMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  sendMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

export async function handleToolCall(params, options = {}) {
  const rawToolName = params?.name || '';
  const args = params?.arguments || {};
  const meta = params?._meta || {};
  const conversationId =
    meta['antigravity.google/conversation_id'] ||
    args.conversation_id ||
    process.env.ANTIGRAVITY_CONVERSATION_ID ||
    '';

  const match = /(?:^|_)(git_(?:register|unregister|list))$/.exec(rawToolName);
  const toolName = match ? match[1] : rawToolName;

  if (toolName === 'git_register' || toolName === 'git_unregister') {
    const repoPath = normalizeRepoPath(args.path || '');
    if (!repoPath) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Missing required argument: `path`.' }],
      };
    }

    const pendingAction = {
      toolName,
      args: { ...args, path: repoPath },
      createdAt: new Date().toISOString(),
    };
    const state = await getSessionRepoState(
      conversationId,
      pendingAction,
      options
    );

    const actionVerb =
      toolName === 'git_unregister' ? 'Unregistered' : 'Registered';

    const payload = {
      ok: true,
      action: toolName,
      message: `${actionVerb} repository ${repoPath} in session ${conversationId || '(active)'}`,
      conversationId,
      trackedCount: state.repositories.length,
      repositories: state.repositories,
    };

    return {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
  }

  if (toolName === 'git_list') {
    const state = await getSessionRepoState(conversationId, null, options);
    const payload = {
      ok: true,
      conversationId,
      projectId: state.projectId,
      projectName: state.projectName,
      isForkedSession: state.isForkedSession,
      parentConversationId: state.parentConversationId,
      trackedCount: state.repositories.length,
      repositories: state.repositories,
    };
    return {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
  }

  return {
    isError: true,
    content: [{ type: 'text', text: `Unknown tool: ${rawToolName}` }],
  };
}

async function processRpcMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.id === undefined || msg.id === null) {
    return;
  }

  try {
    switch (msg.method) {
      case 'initialize': {
        const clientProtocol = msg.params?.protocolVersion || '2024-11-05';
        sendResult(msg.id, {
          protocolVersion: clientProtocol,
          capabilities: {
            tools: {},
          },
          serverInfo: SERVER_INFO,
        });
        break;
      }
      case 'ping': {
        sendResult(msg.id, {});
        break;
      }
      case 'tools/list': {
        sendResult(msg.id, { tools: TOOLS });
        break;
      }
      case 'tools/call': {
        const result = await handleToolCall(msg.params || {});
        sendResult(msg.id, result);
        break;
      }
      default: {
        sendError(msg.id, -32601, `Method not found: ${msg.method}`);
        break;
      }
    }
  } catch (err) {
    sendError(msg.id, -32603, err?.message || String(err));
  }
}

let rpcQueue = Promise.resolve();

function enqueueRpcMessage(msg) {
  rpcQueue = rpcQueue
    .then(() => processRpcMessage(msg))
    .catch((err) => {
      sendError(msg?.id ?? null, -32603, err?.message || String(err));
    });
}

function drainInputBuffer() {
  while (inputBuffer.length > 0) {
    const headerStart = inputBuffer.subarray(0, 32).toString('utf-8');
    if (headerStart.startsWith('Content-Length:')) {
      useContentLengthFraming = true;
      const sepIdx = inputBuffer.indexOf('\r\n\r\n');
      if (sepIdx === -1) return;
      const headerText = inputBuffer.subarray(0, sepIdx).toString('utf-8');
      const match = headerText.match(/Content-Length:\s*(\d+)/i);
      const bodyLen = match ? Number(match[1]) : 0;
      const totalLen = sepIdx + 4 + bodyLen;
      if (inputBuffer.length < totalLen) return;
      const bodyText = inputBuffer
        .subarray(sepIdx + 4, totalLen)
        .toString('utf-8');
      inputBuffer = inputBuffer.subarray(totalLen);
      try {
        enqueueRpcMessage(JSON.parse(bodyText));
      } catch (err) {
        sendError(null, -32700, `Parse error: ${err.message}`);
      }
    } else {
      const nlIdx = inputBuffer.indexOf('\n');
      if (nlIdx === -1) return;
      const line = inputBuffer.subarray(0, nlIdx).toString('utf-8').trim();
      inputBuffer = inputBuffer.subarray(nlIdx + 1);
      if (!line) continue;
      try {
        enqueueRpcMessage(JSON.parse(line));
      } catch (err) {
        sendError(null, -32700, `Parse error: ${err.message}`);
      }
    }
  }
}

const isMainModule =
  process.argv[1] && process.argv[1].endsWith('git_mcp.mjs');

if (isMainModule) {
  if (process.argv[2] === '--cli') {
    const cliToolName = process.argv[3] || '';
    const cliArgsRaw = process.argv[4] || '{}';
    let cliArgs = {};
    try {
      cliArgs = JSON.parse(cliArgsRaw);
    } catch (err) {
      console.error(`Invalid JSON arguments: ${err.message}`);
      process.exit(1);
    }
    handleToolCall({
      name: cliToolName,
      arguments: cliArgs,
    }).then((res) => {
      const text = res.content?.[0]?.text || '';
      if (res.isError) {
        console.error(text);
        process.exit(1);
      }
      console.log(text);
      process.exit(0);
    });
  } else {
    process.stdin.on('data', (chunk) => {
      inputBuffer = Buffer.concat([inputBuffer, chunk]);
      drainInputBuffer();
    });
    process.stdin.on('end', () => {
      process.exit(0);
    });
  }
}
