// The small shared vocabulary between the HTTP plumbing and the surfaces:
// one request context in, one reply out. Handlers stay synchronous and pure
// over the forge state; the server module owns sockets, auth and framing.

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Ctx {
  readonly method: string;
  /** Decoded path segments, no leading or trailing empties. */
  readonly segments: readonly string[];
  readonly query: URLSearchParams;
  readonly rawBody: Buffer;
  /** The request's Host header, for building absolute pagination links. */
  readonly host: string;
  /** The Git-Protocol header value, when the client sent one. */
  readonly gitProtocol: string | null;
  /** Parse the body as JSON once; a malformed body is an HTTP 400. */
  json(): unknown;
}

export interface Reply {
  readonly status: number;
  readonly body?: unknown;
  readonly raw?: Buffer;
  readonly contentType?: string;
  readonly headers?: Record<string, string>;
}

/** A JSON reply. */
export function json(status: number, body: unknown, headers?: Record<string, string>): Reply {
  return headers === undefined ? { status, body } : { status, body, headers };
}

/** A GitHub-shaped error reply: {"message": ...}. */
export function fail(status: number, message: string): Reply {
  return { status, body: { message } };
}

export function notFound(): Reply {
  return fail(404, 'Not Found');
}
