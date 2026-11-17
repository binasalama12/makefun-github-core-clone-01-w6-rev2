// The MCP surface: POST /mcp, streamable HTTP, JSON-RPC.
//
// This forge speaks the handshake era: `server/discover` is answered with
// JSON-RPC method-not-found, the client falls back to `initialize`, and from
// there everything is stateless per request — no session to keep, ids echoed
// exactly, including string ids under concurrency. The six tools are thin
// projections of the same forge records REST serves, so an object made here
// is the same object there. The tools/list payload is one frozen array, so
// it is byte-identical across calls.

import { Forge, type RepoRec } from './forge.ts';
import type { Cast } from './scenario.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { type Ctx, type Reply } from './web.ts';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'the repository name' },
        description: { type: 'string', description: 'a short description' },
        private: { type: 'boolean', description: 'whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'the repository owner login' },
        repo: { type: 'string', description: 'the repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Open an issue on a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'the repository owner login' },
        repo: { type: 'string', description: 'the repository name' },
        title: { type: 'string', description: 'the issue title' },
        body: { type: 'string', description: 'the issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List a repository\u2019s issues, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'the repository owner login' },
        repo: { type: 'string', description: 'the repository name' },
        state: { type: 'string', description: 'open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'the repository owner login' },
        repo: { type: 'string', description: 'the repository name' },
        title: { type: 'string', description: 'the pull request title' },
        head: { type: 'string', description: 'the head branch name' },
        base: { type: 'string', description: 'the base branch name' },
        body: { type: 'string', description: 'the pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'the repository owner login' },
        repo: { type: 'string', description: 'the repository name' },
        pull_number: { type: 'number', description: 'the pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

const LEGACY_REVISIONS: readonly string[] = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function rpcResult(id: unknown, result: unknown): Reply {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): Reply {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolOk(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload as Record<string, unknown>,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findRepo(forge: Forge, cast: Cast, args: Record<string, unknown>): RepoRec | null {
  if (args.owner !== cast.viewer.login || typeof args.repo !== 'string') return null;
  return forge.getRepo(args.repo) ?? null;
}

function callTool(forge: Forge, cast: Cast, name: string, args: Record<string, unknown>): Record<string, unknown> | { rpcCode: number; message: string } {
  const def = TOOLS.find((tool) => tool.name === name);
  if (def === undefined) return { rpcCode: -32602, message: `unknown tool: ${name}` };
  for (const required of def.inputSchema.required) {
    const value = args[required];
    if (value === undefined || value === null || value === '') {
      return { rpcCode: -32602, message: `missing required argument: ${required}` };
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const existing = forge.getRepo(repoName);
      if (existing !== undefined) return toolOk(repoJson(cast, existing));
      const repo = forge.createRepo(
        repoName,
        args.private === true,
        typeof args.description === 'string' ? args.description : '',
      );
      if (repo === null) return toolError('the repository could not be created');
      return toolOk(repoJson(cast, repo));
    }
    case 'get_repo': {
      const repo = findRepo(forge, cast, args);
      if (repo === null) return toolError('repository not found');
      return toolOk(repoJson(cast, repo));
    }
    case 'create_issue': {
      const repo = findRepo(forge, cast, args);
      if (repo === null) return toolError('repository not found');
      const created = forge.createIssue(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        labels: [],
      });
      if ('unknownLabel' in created) return toolError(`unknown label: ${created.unknownLabel}`);
      return toolOk(issueJson(cast, repo, created));
    }
    case 'list_issues': {
      const repo = findRepo(forge, cast, args);
      if (repo === null) return toolError('repository not found');
      let items = [...repo.issues.values()];
      if (args.state === 'open') items = items.filter((issue) => issue.state === 'open');
      else if (args.state === 'closed') items = items.filter((issue) => issue.state === 'closed');
      items.sort((a, b) => a.number - b.number);
      return toolOk(items.map((issue) => issueJson(cast, repo, issue)));
    }
    case 'create_pull_request': {
      const repo = findRepo(forge, cast, args);
      if (repo === null) return toolError('repository not found');
      const pull = forge.createPull(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        head: String(args.head),
        base: String(args.base),
      });
      if (pull === null) return toolError('a pull request already exists or a branch is missing');
      return toolOk(pullJson(forge, cast, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = findRepo(forge, cast, args);
      if (repo === null) return toolError('repository not found');
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return toolError('pull request not found');
      const outcome = forge.mergePull(repo, pull, 'squash');
      if ('conflict' in outcome) return toolError('the pull request has conflicts and cannot be merged');
      if ('error' in outcome) return toolError(outcome.error);
      return toolOk(pullJson(forge, cast, repo, pull));
    }
    default:
      return { rpcCode: -32602, message: `unknown tool: ${name}` };
  }
}

export function handleMcp(forge: Forge, cast: Cast, ctx: Ctx): Reply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.rawBody.toString('utf8'));
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  const id = parsed.id;
  const method = parsed.method;
  const params = isRecord(parsed.params) ? parsed.params : {};

  // A notification has no id and is never answered with a body.
  if (id === undefined) return { status: 202 };

  switch (method) {
    case 'server/discover':
      // Pre-discover era: method-not-found sends the client to initialize.
      return rpcError(id, -32601, 'Method not found');
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const revision = LEGACY_REVISIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: revision,
        capabilities: { tools: {} },
        serverInfo: { name: 'amber-forge', version: '1.0.0' },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      const outcome = callTool(forge, cast, toolName, args);
      if ('rpcCode' in outcome) return rpcError(id, outcome.rpcCode, outcome.message);
      return rpcResult(id, outcome);
    }
    default:
      return rpcError(id, -32601, 'Method not found');
  }
}
