// The GraphQL surface: POST /api/graphql.
//
// A small hand-written lexer, parser and executor covering exactly the
// schema the forge exposes: viewer, repository, node, issues and pull
// requests with cursor connections, the five mutations, and the slice of
// introspection callers ask for. Global ids are opaque base64 payloads that
// decode back to the same records REST and MCP serve.

import {
  Forge,
  decodeGlobalId,
  encodeGlobalId,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './forge.ts';
import type { Cast, CastMember } from './scenario.ts';
import { HttpError, json, type Ctx, type Reply } from './web.ts';

// ---------------------------------------------------------------- lexer

interface Token {
  kind: 'name' | 'string' | 'number' | 'punct' | 'spread' | 'eof';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:$=!@|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] as string;
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'b') value += '\b';
          else if (esc === 'f') value += '\f';
          else if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else value += esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9.]/.test(source[j] as string)) j += 1;
      if (source[j] === 'e' || source[j] === 'E') {
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: 'number', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<[string, ValueNode]> };

interface DirectiveNode {
  name: string;
  args: Map<string, ValueNode>;
}

interface FieldNode {
  kind: 'field';
  name: string;
  alias?: string;
  args: Map<string, ValueNode>;
  directives: DirectiveNode[];
  selection?: SelectionNode[];
}

type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition?: string; selection: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name?: string;
  varDefaults: Map<string, ValueNode>;
  selection: SelectionNode[];
}

interface FragmentNode {
  typeCondition: string;
  selection: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.value}`);
    return token.value;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', varDefaults: new Map(), selection: this.parseSelectionSet() });
        continue;
      }
      const word = this.expectName();
      if (word === 'query' || word === 'mutation') {
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        const varDefaults = new Map<string, ValueNode>();
        if (this.peek().kind === 'punct' && this.peek().value === '(') {
          this.next();
          while (!this.skipPunct(')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            this.parseType();
            if (this.skipPunct('=')) varDefaults.set(varName, this.parseValue());
          }
        }
        this.parseDirectives();
        operations.push({ type: word, name, varDefaults, selection: this.parseSelectionSet() });
      } else if (word === 'fragment') {
        const fragName = this.expectName();
        const onWord = this.expectName();
        if (onWord !== 'on') throw new Error('fragment needs a type condition');
        const typeCondition = this.expectName();
        this.parseDirectives();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
      } else if (word === 'subscription') {
        throw new Error('subscriptions are not supported');
      } else {
        throw new Error(`unexpected definition ${word}`);
      }
    }
    return { operations, fragments };
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      const name = this.expectName();
      const args = new Map<string, ValueNode>();
      if (this.peek().kind === 'punct' && this.peek().value === '(') {
        this.next();
        while (!this.skipPunct(')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args.set(argName, this.parseValue());
        }
      }
      directives.push({ name, args });
    }
    return directives;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.parseDirectives();
        return { kind: 'inline', typeCondition, selection: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.parseDirectives();
      return { kind: 'spread', name };
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args = new Map<string, ValueNode>();
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!this.skipPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.set(argName, this.parseValue());
      }
    }
    const directives = this.parseDirectives();
    let selection: SelectionNode[] | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selection = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, directives, selection };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'var', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') return { kind: 'number', value: Number(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!this.skipPunct(']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<[string, ValueNode]> = [];
      while (!this.skipPunct('}')) {
        const key = this.expectName();
        this.expectPunct(':');
        fields.push([key, this.parseValue()]);
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

// ---------------------------------------------------------------- schema tables

const FIELD_TYPES: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __typename: 'String' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
    __typename: 'String',
  },
  User: { id: 'ID', databaseId: 'Int', login: 'String', name: 'String', email: 'String', __typename: 'String' },
  Repository: {
    id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String', description: 'String',
    isPrivate: 'Boolean', owner: 'User', defaultBranchRef: 'Ref', viewerPermission: 'String',
    hasIssuesEnabled: 'Boolean', issue: 'Issue', issues: 'IssueConnection',
    pullRequest: 'PullRequest', pullRequests: 'PullRequestConnection', __typename: 'String',
  },
  Ref: { name: 'String', prefix: 'String', __typename: 'String' },
  Issue: {
    id: 'ID', databaseId: 'Int', number: 'Int', title: 'String', body: 'String', state: 'String',
    repository: 'Repository', __typename: 'String',
  },
  PullRequest: {
    id: 'ID', databaseId: 'Int', number: 'Int', title: 'String', body: 'String', state: 'String',
    merged: 'Boolean', headRefName: 'String', baseRefName: 'String', mergeable: 'String',
    files: 'PullRequestFileConnection', repository: 'Repository', __typename: 'String',
  },
  Comment: { id: 'ID', databaseId: 'Int', body: 'String', __typename: 'String' },
  IssueConnection: { nodes: '[Issue]', edges: '[IssueEdge]', pageInfo: 'PageInfo', __typename: 'String' },
  IssueEdge: { node: 'Issue', cursor: 'String', __typename: 'String' },
  PullRequestConnection: { nodes: '[PullRequest]', edges: '[PullRequestEdge]', pageInfo: 'PageInfo', __typename: 'String' },
  PullRequestEdge: { node: 'PullRequest', cursor: 'String', __typename: 'String' },
  PullRequestFileConnection: { nodes: '[PullRequestFile]', pageInfo: 'PageInfo', __typename: 'String' },
  PullRequestFile: { path: 'String', __typename: 'String' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String', __typename: 'String' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String', __typename: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String', __typename: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String', __typename: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String', __typename: 'String' },
  AddCommentPayload: { commentEdge: 'CommentEdge', subject: 'Node', clientMutationId: 'String', __typename: 'String' },
  CommentEdge: { node: 'Comment', cursor: 'String', __typename: 'String' },
  Node: { id: 'ID', __typename: 'String' },
  __Type: { name: 'String', kind: 'String', fields: '[__Field]', enumValues: '[__EnumValue]', __typename: 'String' },
  __Field: { name: 'String', __typename: 'String' },
  __EnumValue: { name: 'String', __typename: 'String' },
};

const TYPE_KIND: Record<string, 'OBJECT' | 'ENUM'> = {
  SearchType: 'ENUM',
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
};

// ---------------------------------------------------------------- wrappers

type Wrapped =
  | { __type: 'User'; user: CastMember }
  | { __type: 'Repository'; repo: RepoRec }
  | { __type: 'Ref'; name: string }
  | { __type: 'Issue'; repo: RepoRec; issue: IssueRec }
  | { __type: 'PullRequest'; repo: RepoRec; pull: PullRec }
  | { __type: 'Comment'; id: number; body: string }
  | { __type: 'IssueConnection' | 'PullRequestConnection'; nodes: Wrapped[]; pageInfo: PageInfo }
  | { __type: 'PullRequestFileConnection'; nodes: Wrapped[]; pageInfo: PageInfo }
  | { __type: 'IssueEdge' | 'PullRequestEdge'; node: Wrapped; cursor: string }
  | { __type: 'PullRequestFile'; path: string }
  | { __type: 'PageInfo'; info: PageInfo }
  | { __type: 'CreateIssuePayload' | 'CloseIssuePayload'; issue: Wrapped | null; clientMutationId: string | null }
  | { __type: 'CreatePullRequestPayload' | 'MergePullRequestPayload'; pullRequest: Wrapped | null; clientMutationId: string | null }
  | { __type: 'AddCommentPayload'; commentEdge: Wrapped | null; clientMutationId: string | null }
  | { __type: 'CommentEdge'; node: Wrapped; cursor: string }
  | { __type: '__Type'; name: string }
  | { __type: '__Field'; name: string }
  | { __type: '__EnumValue'; name: string };

interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexFromCursor(cursor: unknown): number {
  if (typeof cursor !== 'string') return 0;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? 0 : Number(match[1]);
  } catch {
    return 0;
  }
}

/** Slice a list into a connection page with GitHub-shaped pageInfo. */
function pageOf<T>(items: readonly T[], args: Record<string, unknown>): { page: T[]; pageInfo: PageInfo } {
  const start = args.after !== undefined && args.after !== null ? indexFromCursor(args.after) : 0;
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.floor(args.first) : items.length;
  const page = items.slice(start, start + first);
  const endIndex = start + page.length;
  return {
    page,
    pageInfo: {
      hasNextPage: endIndex < items.length,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? cursorFor(start + 1) : null,
      endCursor: page.length > 0 ? cursorFor(endIndex) : null,
    },
  };
}

// ---------------------------------------------------------------- execution

interface ExecCtx {
  forge: Forge;
  cast: Cast;
  vars: Record<string, unknown>;
  defaults: Map<string, ValueNode>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

function evalValue(node: ValueNode, ctx: ExecCtx): unknown {
  switch (node.kind) {
    case 'var': {
      if (Object.prototype.hasOwnProperty.call(ctx.vars, node.name)) return ctx.vars[node.name];
      const fallback = ctx.defaults.get(node.name);
      return fallback === undefined ? undefined : evalValue(fallback, ctx);
    }
    case 'string':
    case 'number':
    case 'bool':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => evalValue(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of node.fields) out[key] = evalValue(value, ctx);
      return out;
    }
  }
}

function evalArgs(field: FieldNode, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of field.args) out[key] = evalValue(value, ctx);
  return out;
}

function directivesPass(field: FieldNode, ctx: ExecCtx): boolean {
  for (const directive of field.directives) {
    if (directive.name !== 'skip' && directive.name !== 'include') continue;
    const ifNode = directive.args.get('if');
    const flag = ifNode === undefined ? undefined : evalValue(ifNode, ctx);
    if (directive.name === 'skip' && flag === true) return false;
    if (directive.name === 'include' && flag === false) return false;
  }
  return true;
}

function userWrapped(user: CastMember): Wrapped {
  return { __type: 'User', user };
}

function repoWrapped(repo: RepoRec): Wrapped {
  return { __type: 'Repository', repo };
}

function issueWrapped(repo: RepoRec, issue: IssueRec): Wrapped {
  return { __type: 'Issue', repo, issue };
}

function pullWrapped(repo: RepoRec, pull: PullRec): Wrapped {
  return { __type: 'PullRequest', repo, pull };
}

function repoByGlobalId(ctx: ExecCtx, id: unknown): RepoRec | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'repo') return null;
  const dbId = Number(decoded.parts[0]);
  for (const repo of ctx.forge.repos.values()) if (repo.id === dbId) return repo;
  return null;
}

function nodeByGlobalId(ctx: ExecCtx, id: unknown): Wrapped | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'repo') {
    const repo = repoByGlobalId(ctx, id);
    return repo === null ? null : repoWrapped(repo);
  }
  if (decoded.kind === 'user') {
    const user = ctx.cast.users.find((candidate) => candidate.id === Number(decoded.parts[0]));
    return user === undefined ? null : userWrapped(user);
  }
  if (decoded.kind === 'issue' || decoded.kind === 'pr') {
    const repo = [...ctx.forge.repos.values()].find((candidate) => candidate.id === Number(decoded.parts[0]));
    if (repo === undefined) return null;
    const number = Number(decoded.parts[1]);
    if (decoded.kind === 'issue') {
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueWrapped(repo, issue);
    }
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : pullWrapped(repo, pull);
  }
  if (decoded.kind === 'comment') {
    const commentId = Number(decoded.parts[0]);
    for (const repo of ctx.forge.repos.values()) {
      for (const target of [...repo.issues.values(), ...repo.pulls.values()]) {
        const comment = target.comments.find((candidate) => candidate.id === commentId);
        if (comment !== undefined) return { __type: 'Comment', id: comment.id, body: comment.body };
      }
    }
    return null;
  }
  return null;
}

type Resolver = (source: Wrapped | null, args: Record<string, unknown>, ctx: ExecCtx) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (_source, _args, ctx) => userWrapped(ctx.cast.viewer),
    repository: (_source, args, ctx) => {
      if (args.owner !== ctx.cast.viewer.login || typeof args.name !== 'string') return null;
      const repo = ctx.forge.getRepo(args.name);
      return repo === undefined ? null : repoWrapped(repo);
    },
    node: (_source, args, ctx) => nodeByGlobalId(ctx, args.id),
    __type: (_source, args) => {
      if (typeof args.name !== 'string') return null;
      if (FIELD_TYPES[args.name] === undefined && TYPE_KIND[args.name] === undefined) return null;
      return { __type: '__Type', name: args.name } as Wrapped;
    },
  },
  Mutation: {
    createIssue: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByGlobalId(ctx, input.repositoryId);
      if (repo === null) {
        ctx.errors.push({ message: 'the repository does not exist' });
        return { __type: 'CreateIssuePayload', issue: null, clientMutationId: null } as Wrapped;
      }
      const created = ctx.forge.createIssue(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        labels: [],
      });
      if ('unknownLabel' in created) {
        ctx.errors.push({ message: `unknown label ${created.unknownLabel}` });
        return { __type: 'CreateIssuePayload', issue: null, clientMutationId: null } as Wrapped;
      }
      return {
        __type: 'CreateIssuePayload',
        issue: issueWrapped(repo, created),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      } as Wrapped;
    },
    closeIssue: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const node = nodeByGlobalId(ctx, input.issueId);
      if (node === null || node.__type !== 'Issue') {
        ctx.errors.push({ message: 'the issue does not exist' });
        return { __type: 'CloseIssuePayload', issue: null, clientMutationId: null } as Wrapped;
      }
      node.issue.state = 'closed';
      return {
        __type: 'CloseIssuePayload',
        issue: node,
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      } as Wrapped;
    },
    createPullRequest: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByGlobalId(ctx, input.repositoryId);
      if (repo === null) {
        ctx.errors.push({ message: 'the repository does not exist' });
        return { __type: 'CreatePullRequestPayload', pullRequest: null, clientMutationId: null } as Wrapped;
      }
      const pull = ctx.forge.createPull(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        head: typeof input.headRefName === 'string' ? input.headRefName : '',
        base: typeof input.baseRefName === 'string' ? input.baseRefName : '',
      });
      if (pull === null) {
        ctx.errors.push({ message: 'a pull request already exists or a branch is missing' });
        return { __type: 'CreatePullRequestPayload', pullRequest: null, clientMutationId: null } as Wrapped;
      }
      return {
        __type: 'CreatePullRequestPayload',
        pullRequest: pullWrapped(repo, pull),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      } as Wrapped;
    },
    mergePullRequest: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const node = nodeByGlobalId(ctx, input.pullRequestId);
      if (node === null || node.__type !== 'PullRequest') {
        ctx.errors.push({ message: 'the pull request does not exist' });
        return { __type: 'MergePullRequestPayload', pullRequest: null, clientMutationId: null } as Wrapped;
      }
      const method = typeof input.mergeMethod === 'string' && input.mergeMethod.toUpperCase() === 'MERGE' ? 'merge' : 'squash';
      const outcome = ctx.forge.mergePull(node.repo, node.pull, method);
      if ('conflict' in outcome) ctx.errors.push({ message: 'the pull request has conflicts and cannot be merged' });
      else if ('error' in outcome) ctx.errors.push({ message: outcome.error });
      return {
        __type: 'MergePullRequestPayload',
        pullRequest: node,
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      } as Wrapped;
    },
    addComment: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const node = nodeByGlobalId(ctx, input.subjectId);
      if (node === null || (node.__type !== 'Issue' && node.__type !== 'PullRequest')) {
        ctx.errors.push({ message: 'the subject does not exist' });
        return { __type: 'AddCommentPayload', commentEdge: null, clientMutationId: null } as Wrapped;
      }
      const target = node.__type === 'Issue' ? node.issue : node.pull;
      const comment = ctx.forge.addComment(target, typeof input.body === 'string' ? input.body : '');
      const wrapped: Wrapped = { __type: 'Comment', id: comment.id, body: comment.body };
      return {
        __type: 'AddCommentPayload',
        commentEdge: { __type: 'CommentEdge', node: wrapped, cursor: cursorFor(comment.id) } as Wrapped,
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      } as Wrapped;
    },
  },
  User: {
    id: (source) => (source?.__type === 'User' ? encodeGlobalId('user', source.user.id) : null),
    databaseId: (source) => (source?.__type === 'User' ? source.user.id : null),
    login: (source) => (source?.__type === 'User' ? source.user.login : null),
    name: (source) => (source?.__type === 'User' ? source.user.name : null),
    email: (source) => (source?.__type === 'User' ? source.user.email : null),
  },
  Repository: {
    id: (source) => (source?.__type === 'Repository' ? encodeGlobalId('repo', source.repo.id) : null),
    databaseId: (source) => (source?.__type === 'Repository' ? source.repo.id : null),
    name: (source) => (source?.__type === 'Repository' ? source.repo.name : null),
    nameWithOwner: (source, _args, ctx) => (source?.__type === 'Repository' ? `${ctx.cast.viewer.login}/${source.repo.name}` : null),
    description: (source) => (source?.__type === 'Repository' ? source.repo.description : null),
    isPrivate: (source) => (source?.__type === 'Repository' ? source.repo.isPrivate : null),
    owner: (_source, _args, ctx) => userWrapped(ctx.cast.viewer),
    defaultBranchRef: (source) => {
      if (source?.__type !== 'Repository') return null;
      if (source.repo.refs.size === 0) return null;
      return { __type: 'Ref', name: source.repo.headRef.replace(/^refs\/heads\//, '') } as Wrapped;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (source, args) => {
      if (source?.__type !== 'Repository' || typeof args.number !== 'number') return null;
      const issue = source.repo.issues.get(args.number);
      return issue === undefined ? null : issueWrapped(source.repo, issue);
    },
    issues: (source, args) => {
      if (source?.__type !== 'Repository') return null;
      let items = [...source.repo.issues.values()];
      if (Array.isArray(args.states)) {
        const wanted = new Set(args.states.map((state) => String(state).toUpperCase()));
        items = items.filter((issue) => wanted.has(issue.state.toUpperCase()));
      }
      let descending = false;
      if (typeof args.orderBy === 'object' && args.orderBy !== null) {
        const order = args.orderBy as Record<string, unknown>;
        if (String(order.direction ?? '').toUpperCase() === 'DESC') descending = true;
      }
      items.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
      const { page, pageInfo } = pageOf(items, args);
      const nodes = page.map((issue) => issueWrapped(source.repo, issue));
      return {
        __type: 'IssueConnection',
        nodes,
        edges: nodes.map((node, index) => ({ __type: 'IssueEdge', node, cursor: cursorFor(index + 1) }) as Wrapped),
        pageInfo,
      } as unknown as Wrapped;
    },
    pullRequest: (source, args) => {
      if (source?.__type !== 'Repository' || typeof args.number !== 'number') return null;
      const pull = source.repo.pulls.get(args.number);
      return pull === undefined ? null : pullWrapped(source.repo, pull);
    },
    pullRequests: (source, args) => {
      if (source?.__type !== 'Repository') return null;
      let items = [...source.repo.pulls.values()];
      if (Array.isArray(args.states)) {
        const wanted = new Set(args.states.map((state) => String(state).toUpperCase()));
        items = items.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
      } else {
        items = items.filter((pull) => pull.state === 'open');
      }
      items.sort((a, b) => a.number - b.number);
      const { page, pageInfo } = pageOf(items, args);
      const nodes = page.map((pull) => pullWrapped(source.repo, pull));
      return {
        __type: 'PullRequestConnection',
        nodes,
        edges: nodes.map((node, index) => ({ __type: 'PullRequestEdge', node, cursor: cursorFor(index + 1) }) as Wrapped),
        pageInfo,
      } as unknown as Wrapped;
    },
  },
  Ref: {
    name: (source) => (source?.__type === 'Ref' ? source.name : null),
    prefix: () => 'refs/heads/',
  },
  Issue: {
    id: (source) => (source?.__type === 'Issue' ? encodeGlobalId('issue', source.repo.id, source.issue.number) : null),
    databaseId: (source) => (source?.__type === 'Issue' ? source.issue.id : null),
    number: (source) => (source?.__type === 'Issue' ? source.issue.number : null),
    title: (source) => (source?.__type === 'Issue' ? source.issue.title : null),
    body: (source) => (source?.__type === 'Issue' ? source.issue.body : null),
    state: (source) => (source?.__type === 'Issue' ? source.issue.state.toUpperCase() : null),
    repository: (source) => (source?.__type === 'Issue' ? repoWrapped(source.repo) : null),
  },
  PullRequest: {
    id: (source) => (source?.__type === 'PullRequest' ? encodeGlobalId('pr', source.repo.id, source.pull.number) : null),
    databaseId: (source) => (source?.__type === 'PullRequest' ? source.pull.id : null),
    number: (source) => (source?.__type === 'PullRequest' ? source.pull.number : null),
    title: (source) => (source?.__type === 'PullRequest' ? source.pull.title : null),
    body: (source) => (source?.__type === 'PullRequest' ? source.pull.body : null),
    state: (source) => {
      if (source?.__type !== 'PullRequest') return null;
      return source.pull.merged ? 'MERGED' : source.pull.state.toUpperCase();
    },
    merged: (source) => (source?.__type === 'PullRequest' ? source.pull.merged : null),
    headRefName: (source) => (source?.__type === 'PullRequest' ? source.pull.headRef : null),
    baseRefName: (source) => (source?.__type === 'PullRequest' ? source.pull.baseRef : null),
    mergeable: (source, _args, ctx) => (source?.__type === 'PullRequest' ? ctx.forge.mergeable(source.repo, source.pull) : null),
    files: (source, args, ctx) => {
      if (source?.__type !== 'PullRequest') return null;
      const changes = ctx.forge.pullFiles(source.repo, source.pull);
      const nodes: Wrapped[] = changes.map((change) => ({ __type: 'PullRequestFile', path: change.filename }) as Wrapped);
      const { page, pageInfo } = pageOf(nodes, args);
      return { __type: 'PullRequestFileConnection', nodes: page, pageInfo } as Wrapped;
    },
    repository: (source) => (source?.__type === 'PullRequest' ? repoWrapped(source.repo) : null),
  },
  Comment: {
    id: (source) => (source?.__type === 'Comment' ? encodeGlobalId('comment', source.id) : null),
    databaseId: (source) => (source?.__type === 'Comment' ? source.id : null),
    body: (source) => (source?.__type === 'Comment' ? source.body : null),
  },
  PullRequestFile: {
    path: (source) => (source?.__type === 'PullRequestFile' ? source.path : null),
  },
  PageInfo: {
    hasNextPage: (source) => (source?.__type === 'PageInfo' ? source.info.hasNextPage : null),
    hasPreviousPage: (source) => (source?.__type === 'PageInfo' ? source.info.hasPreviousPage : null),
    startCursor: (source) => (source?.__type === 'PageInfo' ? source.info.startCursor : null),
    endCursor: (source) => (source?.__type === 'PageInfo' ? source.info.endCursor : null),
  },
  __Type: {
    name: (source) => (source?.__type === '__Type' ? source.name : null),
    kind: (source) => (source?.__type === '__Type' ? (TYPE_KIND[source.name] ?? 'OBJECT') : null),
    fields: (source) => {
      if (source?.__type !== '__Type') return null;
      const fields = FIELD_TYPES[source.name];
      if (fields === undefined) return null;
      return Object.keys(fields).map((name) => ({ __type: '__Field', name }) as Wrapped);
    },
    enumValues: (source) => {
      if (source?.__type !== '__Type') return null;
      const values = ENUM_VALUES[source.name];
      if (values === undefined) return null;
      return values.map((name) => ({ __type: '__EnumValue', name }) as Wrapped);
    },
  },
  __Field: { name: (source) => (source?.__type === '__Field' ? source.name : null) },
  __EnumValue: { name: (source) => (source?.__type === '__EnumValue' ? source.name : null) },
};

/** Default resolution for connection/payload wrappers: read the property. */
function defaultResolve(source: Wrapped, field: string): unknown {
  const record = source as unknown as Record<string, unknown>;
  const value = record[field];
  if (field === 'pageInfo' && typeof value === 'object' && value !== null) {
    return { __type: 'PageInfo', info: value as PageInfo } as Wrapped;
  }
  return value === undefined ? null : value;
}

function completeValue(declared: string, value: unknown, selection: SelectionNode[] | undefined, ctx: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  if (declared.startsWith('[') && declared.endsWith(']')) {
    if (!Array.isArray(value)) return null;
    const inner = declared.slice(1, -1);
    return value.map((item) => completeValue(inner, item, selection, ctx));
  }
  if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
    const wrapped = value as Wrapped;
    return executeSelection(wrapped.__type, wrapped, selection ?? [], ctx);
  }
  return value;
}

function executeSelection(typeName: string, source: Wrapped | null, selections: SelectionNode[], ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fields = FIELD_TYPES[typeName] ?? {};
  const resolvers = RESOLVERS[typeName] ?? {};
  const visit = (nodes: SelectionNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'inline') {
        if (node.typeCondition === undefined || node.typeCondition === typeName) visit(node.selection);
        continue;
      }
      if (node.kind === 'spread') {
        const fragment = ctx.fragments.get(node.name);
        if (fragment !== undefined && fragment.typeCondition === typeName) visit(fragment.selection);
        continue;
      }
      if (!directivesPass(node, ctx)) continue;
      const key = node.alias ?? node.name;
      if (node.name === '__typename') {
        out[key] = typeName;
        continue;
      }
      const declared = fields[node.name];
      if (declared === undefined) {
        ctx.errors.push({ message: `Field '${node.name}' doesn't exist on type '${typeName}'` });
        out[key] = null;
        continue;
      }
      const resolver = resolvers[node.name];
      const raw = resolver !== undefined
        ? resolver(source, evalArgs(node, ctx), ctx)
        : source !== null
          ? defaultResolve(source, node.name)
          : null;
      out[key] = completeValue(declared, raw, node.selection, ctx);
    }
  };
  visit(selections);
  return out;
}

function runOperation(forge: Forge, cast: Cast, body: Record<string, unknown>): Record<string, unknown> {
  const query = body.query;
  if (typeof query !== 'string') throw new HttpError(400, 'a GraphQL query string is required');
  const variables = (typeof body.variables === 'object' && body.variables !== null ? body.variables : {}) as Record<string, unknown>;
  const { operations, fragments } = new Parser(tokenize(query)).parseDocument();
  if (operations.length === 0) throw new HttpError(400, 'the document has no operation');
  let operation = operations[0] as OperationNode;
  if (typeof body.operationName === 'string') {
    const named = operations.find((candidate) => candidate.name === body.operationName);
    if (named !== undefined) operation = named;
  } else if (operations.length > 1) {
    throw new HttpError(400, 'an operationName is required for a multi-operation document');
  }
  const ctx: ExecCtx = {
    forge,
    cast,
    vars: variables,
    defaults: operation.varDefaults,
    fragments,
    errors: [],
  };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(rootType, null, operation.selection, ctx);
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}

export function handleGraphql(forge: Forge, cast: Cast, ctx: Ctx): Reply {
  const parsed = ctx.json();
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      if (typeof entry !== 'object' || entry === null) return { errors: [{ message: 'each operation must be an object' }] };
      try {
        return runOperation(forge, cast, entry as Record<string, unknown>);
      } catch (error) {
        return { errors: [{ message: error instanceof Error ? error.message : 'execution failed' }] };
      }
    });
    return json(200, results);
  }
  if (typeof parsed !== 'object' || parsed === null) throw new HttpError(400, 'a GraphQL body must be an object or an array');
  try {
    return json(200, runOperation(forge, cast, parsed as Record<string, unknown>));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return json(200, { data: null, errors: [{ message: error instanceof Error ? error.message : 'execution failed' }] });
  }
}
