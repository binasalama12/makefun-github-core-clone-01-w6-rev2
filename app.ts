// The HTTP plumbing: one server, four surfaces, one auth gate.
//
// Every request — REST, git smart HTTP, GraphQL, MCP — presents the shop
// token as a Bearer credential; anything else is a 401 before routing. Every
// reply carries an X-GitHub-Request-Id, and /api/v3 replies carry the OAuth
// scopes header. Handlers are synchronous over the in-memory forge, so this
// module only moves bytes: read the body, build the context, dispatch, frame
// the reply.

import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './forge.ts';
import { handleGit } from './githttp.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { scenarioCast } from './scenario.ts';
import { HttpError, type Ctx, type Reply } from './web.ts';

const OAUTH_SCOPES = 'repo, read:org';

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

class RequestContext implements Ctx {
  readonly method: string;
  readonly segments: readonly string[];
  readonly query: URLSearchParams;
  readonly rawBody: Buffer;
  readonly host: string;
  readonly gitProtocol: string | null;
  private parsedBody: unknown;
  private bodyParsed = false;

  constructor(req: IncomingMessage, url: URL, rawBody: Buffer) {
    this.method = (req.method ?? 'GET').toUpperCase();
    this.segments = url.pathname.split('/').filter((part) => part !== '').map(decodeSegment);
    this.query = url.searchParams;
    this.rawBody = rawBody;
    this.host = req.headers.host ?? '127.0.0.1';
    const protocol = req.headers['git-protocol'];
    this.gitProtocol = typeof protocol === 'string' ? protocol : null;
  }

  json(): unknown {
    if (this.bodyParsed) return this.parsedBody;
    this.bodyParsed = true;
    const text = this.rawBody.toString('utf8').trim();
    if (text === '') {
      this.parsedBody = {};
      return this.parsedBody;
    }
    try {
      this.parsedBody = JSON.parse(text);
    } catch {
      throw new HttpError(400, 'Problems parsing JSON');
    }
    return this.parsedBody;
  }
}

function send(res: ServerResponse, reply: Reply, isApiV3: boolean): void {
  const headers: Record<string, string> = {
    'X-GitHub-Request-Id': randomBytes(8).toString('hex').toUpperCase(),
    ...(reply.headers ?? {}),
  };
  if (isApiV3) headers['X-Oauth-Scopes'] = OAUTH_SCOPES;
  if (reply.raw !== undefined) {
    headers['Content-Type'] = reply.contentType ?? 'application/octet-stream';
    headers['Content-Length'] = String(reply.raw.length);
    res.writeHead(reply.status, headers);
    res.end(reply.raw);
    return;
  }
  if (reply.body === undefined) {
    res.writeHead(reply.status, headers);
    res.end();
    return;
  }
  const text = JSON.stringify(reply.body);
  headers['Content-Type'] = 'application/json; charset=utf-8';
  headers['Content-Length'] = String(Buffer.byteLength(text));
  res.writeHead(reply.status, headers);
  res.end(text);
}

export function createApp(): Server {
  const forge = new Forge();
  const cast = scenarioCast();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const authorized = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization ?? '';
    if (token !== '') return header === `Bearer ${token}`;
    // No token configured (local development): still demand a Bearer shape,
    // so the unauthenticated paths behave the same as in production.
    return /^Bearer .+/.test(header);
  };

  const route = (ctx: RequestContext): Reply => {
    const segments = ctx.segments;
    if (segments[0] === 'api' && segments[1] === 'v3') return handleRest(forge, cast, ctx);
    if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
      if (ctx.method !== 'POST') return { status: 404, body: { message: 'Not Found' } };
      return handleGraphql(forge, cast, ctx);
    }
    if (segments[0] === 'mcp' && segments.length === 1) {
      if (ctx.method !== 'POST') return { status: 405, body: { message: 'Method Not Allowed' } };
      return handleMcp(forge, cast, ctx);
    }
    if (segments.length >= 3 && (segments[1] ?? '').endsWith('.git')) return handleGit(forge, cast, ctx);
    return { status: 404, body: { message: 'Not Found' } };
  };

  const server = createServer((req, res) => {
    void (async () => {
      let isApiV3 = false;
      try {
        const rawBody = await readBody(req);
        const url = new URL(req.url ?? '/', 'http://forge.invalid');
        const ctx = new RequestContext(req, url, rawBody);
        isApiV3 = ctx.segments[0] === 'api' && ctx.segments[1] === 'v3';
        if (ctx.method === 'GET' && ctx.segments.length === 1 && ctx.segments[0] === 'healthz') {
          send(res, { status: 200, body: { status: 'ok' } }, false);
          return;
        }
        if (!authorized(req)) {
          send(res, { status: 401, body: { message: 'Bad credentials' } }, isApiV3);
          return;
        }
        send(res, route(ctx), isApiV3);
      } catch (error) {
        if (error instanceof HttpError) {
          send(res, { status: error.status, body: { message: error.message } }, isApiV3);
        } else {
          console.error('unhandled error', error);
          send(res, { status: 500, body: { message: 'Internal Server Error' } }, isApiV3);
        }
      }
    })();
  });
  return server;
}
