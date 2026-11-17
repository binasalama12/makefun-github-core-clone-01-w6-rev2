// The REST surface: /api/v3, GitHub-shaped.
//
// Repositories, contents backed by the real object store, refs, branches,
// commit lists, labels, issues, comments and pull requests with a working
// merge. Every object here is the forge's own record, so ids and numbers are
// the same ones GraphQL and MCP report.

import { Forge, type IssueRec, type PullRec, type RepoRec } from './forge.ts';
import type { Cast } from './scenario.ts';
import { ZERO_OID, type FlatEntry } from './store.ts';
import { HttpError, fail, json, notFound, type Ctx, type Reply } from './web.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyOf(ctx: Ctx): Record<string, unknown> {
  const parsed = ctx.json();
  if (!isRecord(parsed)) throw new HttpError(400, 'request body must be a JSON object');
  return parsed;
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

function shortHead(repo: RepoRec): string {
  return repo.headRef.replace(/^refs\/heads\//, '');
}

function userJson(cast: Cast): Record<string, unknown> {
  return { login: cast.viewer.login, id: cast.viewer.id, type: 'User' };
}

export function repoJson(cast: Cast, repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${cast.viewer.login}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: shortHead(repo),
    owner: userJson(cast),
    html_url: `https://forge.invalid/${cast.viewer.login}/${repo.name}`,
    clone_url: `https://forge.invalid/${cast.viewer.login}/${repo.name}.git`,
  };
}

export function issueJson(cast: Cast, repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { id: label?.id ?? 0, name, color: label?.color ?? '000000' };
    }),
    user: userJson(cast),
    comments: issue.comments.length,
  };
}

function refJson(forge: Forge, cast: Cast, repo: RepoRec, branch: string): Record<string, unknown> {
  return {
    ref: branch,
    sha: forge.branchTip(repo, branch) ?? ZERO_OID,
    label: `${cast.viewer.login}:${branch}`,
    repo: repoJson(cast, repo),
  };
}

export function pullJson(forge: Forge, cast: Cast, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: refJson(forge, cast, repo, pull.headRef),
    base: refJson(forge, cast, repo, pull.baseRef),
    user: userJson(cast),
    comments: pull.comments.length,
  };
}

export function commentJson(cast: Cast, comment: { id: number; body: string }): Record<string, unknown> {
  return { id: comment.id, body: comment.body, user: userJson(cast) };
}

/** Slice a list by page/per_page and build the rel="next" Link, when any. */
function paginate<T>(ctx: Ctx, items: readonly T[], basePath: string): { page: T[]; headers?: Record<string, string> } {
  const perPageRaw = Number(ctx.query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : 30;
  const pageRaw = Number(ctx.query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (start + perPage >= items.length) return { page: slice };
  const next = `http://${ctx.host}${basePath}?per_page=${perPage}&page=${page + 1}`;
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  const last = `http://${ctx.host}${basePath}?per_page=${perPage}&page=${lastPage}`;
  return { page: slice, headers: { Link: `<${next}>; rel="next", <${last}>; rel="last"` } };
}

/** Resolve a ref-ish (branch name, full ref, or commit id) to a commit id. */
function resolveCommit(repo: RepoRec, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') {
    const tip = repo.refs.get(repo.headRef);
    return tip === undefined ? null : tip;
  }
  const asBranch = repo.refs.get(`refs/heads/${ref}`);
  if (asBranch !== undefined) return asBranch;
  const asRef = repo.refs.get(ref);
  if (asRef !== undefined) return asRef;
  if (repo.store.commitOf(ref) !== null) return ref;
  return null;
}

// ---------------------------------------------------------------- contents

function contentsGet(repo: RepoRec, ctx: Ctx, path: string): Reply {
  const commit = resolveCommit(repo, ctx.query.get('ref') ?? undefined);
  if (commit === null) return notFound();
  const parsed = repo.store.commitOf(commit);
  if (parsed === null) return notFound();
  const parts = path === '' ? [] : path.split('/');
  let treeOid = parsed.tree;
  for (let i = 0; i < parts.length; i += 1) {
    const entries = repo.store.treeOf(treeOid);
    if (entries === null) return notFound();
    const entry = entries.find((candidate) => candidate.name === parts[i]);
    if (entry === undefined) return notFound();
    const isLast = i === parts.length - 1;
    if (!isLast) {
      if (entry.mode !== '40000') return notFound();
      treeOid = entry.oid;
      continue;
    }
    if (entry.mode === '40000') return json(200, listing(repo, entry.oid, path));
    const blob = repo.store.get(entry.oid);
    if (blob === undefined) return notFound();
    return json(200, {
      type: 'file',
      name: entry.name,
      path,
      sha: entry.oid,
      size: blob.data.length,
      encoding: 'base64',
      content: blob.data.toString('base64'),
    });
  }
  return json(200, listing(repo, treeOid, ''));
}

function listing(repo: RepoRec, treeOid: string, prefix: string): Array<Record<string, unknown>> {
  const entries = repo.store.treeOf(treeOid) ?? [];
  return entries.map((entry) => {
    const isDir = entry.mode === '40000';
    const blob = isDir ? undefined : repo.store.get(entry.oid);
    return {
      type: isDir ? 'dir' : 'file',
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      sha: entry.oid,
      ...(blob !== undefined ? { size: blob.data.length } : {}),
    };
  });
}

function contentsPut(forge: Forge, repo: RepoRec, ctx: Ctx, path: string): Reply {
  const body = bodyOf(ctx);
  const content = stringField(body, 'content');
  const message = stringField(body, 'message') ?? 'add file';
  if (content === undefined) throw new HttpError(422, 'content is required');
  const branch = stringField(body, 'branch') ?? shortHead(repo);
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  let parents: string[] = [];
  let baseFlat: ReadonlyMap<string, FlatEntry> = new Map();
  if (tip !== undefined) {
    const commit = repo.store.commitOf(tip);
    if (commit === null) return fail(422, 'branch tip is not a commit');
    parents = [tip];
    baseFlat = repo.store.flatten(commit.tree);
  } else if (branch === shortHead(repo)) {
    // Unborn default branch: this write is the first commit.
    parents = [];
    baseFlat = new Map();
  } else {
    const headTip = repo.refs.get(repo.headRef);
    if (headTip === undefined) return fail(404, 'branch not found');
    const commit = repo.store.commitOf(headTip);
    if (commit === null) return fail(422, 'default branch tip is not a commit');
    parents = [headTip];
    baseFlat = repo.store.flatten(commit.tree);
  }
  const existing = baseFlat.get(path);
  const givenSha = stringField(body, 'sha');
  if (existing !== undefined && givenSha !== undefined && givenSha !== existing.oid) {
    return fail(409, `${path} does not match the given sha`);
  }
  const data = Buffer.from(content, 'base64');
  const blobOid = repo.store.put('blob', data);
  const nextFlat = new Map(baseFlat);
  nextFlat.set(path, { mode: '100644', oid: blobOid });
  const tree = repo.store.unflatten(nextFlat);
  const commitSha = forge.commitTreeOnBranch(repo, branch, tree, message, parents);
  const name = path.split('/').pop() ?? path;
  return json(existing !== undefined ? 200 : 201, {
    content: { name, path, sha: blobOid, size: data.length, encoding: 'base64' },
    commit: { sha: commitSha, message },
  });
}

function contentsDelete(forge: Forge, repo: RepoRec, ctx: Ctx, path: string): Reply {
  const body = bodyOf(ctx);
  const message = stringField(body, 'message') ?? 'delete file';
  const branch = stringField(body, 'branch') ?? shortHead(repo);
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return notFound();
  const commit = repo.store.commitOf(tip);
  if (commit === null) return notFound();
  const flat = repo.store.flatten(commit.tree);
  const existing = flat.get(path);
  if (existing === undefined) return notFound();
  const givenSha = stringField(body, 'sha');
  if (givenSha !== undefined && givenSha !== existing.oid) {
    return fail(409, `${path} does not match the given sha`);
  }
  const nextFlat = new Map(flat);
  nextFlat.delete(path);
  const tree = repo.store.unflatten(nextFlat);
  const commitSha = forge.commitTreeOnBranch(repo, branch, tree, message, [tip]);
  return json(200, { content: null, commit: { sha: commitSha, message } });
}

// ---------------------------------------------------------------- repo sub-resources

function commitsList(repo: RepoRec, ctx: Ctx): Reply {
  const start = resolveCommit(repo, ctx.query.get('sha') ?? undefined);
  if (start === null) return json(200, []);
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const queue: string[] = [start];
  while (queue.length > 0 && out.length < 1000) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const commit = repo.store.commitOf(current);
    if (commit === null) continue;
    out.push({
      sha: current,
      commit: { message: commit.message, tree: { sha: commit.tree } },
      parents: commit.parents.map((parent) => ({ sha: parent })),
    });
    for (const parent of commit.parents) queue.push(parent);
  }
  return json(200, out);
}

function repoRoutes(forge: Forge, cast: Cast, ctx: Ctx, rest: string[]): Reply {
  const repo = forge.getRepo(rest[0] as string);
  if (repo === undefined) return notFound();
  const tail = rest.slice(1);
  const method = ctx.method;

  if (tail.length === 0) {
    if (method === 'GET') return json(200, repoJson(cast, repo));
    if (method === 'PATCH') {
      const body = bodyOf(ctx);
      const description = stringField(body, 'description');
      if (description !== undefined) repo.description = description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      const name = stringField(body, 'name');
      if (name !== undefined && name !== repo.name && !forge.repos.has(name)) {
        forge.repos.delete(repo.name);
        repo.name = name;
        forge.repos.set(name, repo);
      }
      return json(200, repoJson(cast, repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo.name);
      return { status: 204 };
    }
    return notFound();
  }

  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const body = bodyOf(ctx);
      const ref = stringField(body, 'ref');
      const sha = stringField(body, 'sha');
      if (ref === undefined || sha === undefined) throw new HttpError(422, 'ref and sha are required');
      if (!ref.startsWith('refs/')) throw new HttpError(422, 'ref must start with refs/');
      if (repo.refs.has(ref)) return fail(422, 'Reference already exists');
      if (!repo.store.has(sha)) return fail(422, 'the given sha does not exist');
      repo.refs.set(ref, sha);
      return json(201, { ref, object: { sha, type: repo.store.get(sha)?.type ?? 'commit' } });
    }
    if (method === 'GET' && tail.length >= 3) {
      const ref = `refs/${tail.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return notFound();
      return json(200, { ref, object: { sha, type: repo.store.get(sha)?.type ?? 'commit' } });
    }
    return notFound();
  }

  if (tail[0] === 'branches') {
    if (method === 'GET' && tail.length === 1) {
      const branches: Array<Record<string, unknown>> = [];
      for (const [ref, sha] of repo.refs) {
        if (ref.startsWith('refs/heads/')) branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
      }
      branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return json(200, branches);
    }
    if (method === 'GET' && tail.length >= 2) {
      const branch = tail.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return notFound();
      return json(200, { name: branch, commit: { sha } });
    }
    return notFound();
  }

  if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') return commitsList(repo, ctx);

  if (tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    if (method === 'GET') return contentsGet(repo, ctx, path);
    if (method === 'PUT') return contentsPut(forge, repo, ctx, path);
    if (method === 'DELETE') return contentsDelete(forge, repo, ctx, path);
    return notFound();
  }

  if (tail[0] === 'labels') {
    if (method === 'GET' && tail.length === 1) {
      return json(200, [...repo.labels.values()].map((label) => ({ id: label.id, name: label.name, color: label.color })));
    }
    if (method === 'POST' && tail.length === 1) {
      const body = bodyOf(ctx);
      const name = stringField(body, 'name');
      const color = stringField(body, 'color') ?? '000000';
      if (name === undefined) throw new HttpError(422, 'name is required');
      const label = forge.createLabel(repo, name, color);
      if (label === null) return fail(422, 'Validation Failed: name has already been taken');
      return json(201, { id: label.id, name: label.name, color: label.color });
    }
    return notFound();
  }

  if (tail[0] === 'issues') return issueRoutes(forge, cast, repo, ctx, tail.slice(1));
  if (tail[0] === 'pulls') return pullRoutes(forge, cast, repo, ctx, tail.slice(1));
  return notFound();
}

function issueRoutes(forge: Forge, cast: Cast, repo: RepoRec, ctx: Ctx, tail: string[]): Reply {
  const method = ctx.method;
  if (tail.length === 0) {
    if (method === 'POST') {
      const body = bodyOf(ctx);
      const title = stringField(body, 'title');
      if (title === undefined) throw new HttpError(422, 'title is required');
      const rawLabels = body.labels;
      const labels: string[] = [];
      if (Array.isArray(rawLabels)) {
        for (const entry of rawLabels) {
          if (typeof entry === 'string') labels.push(entry);
          else if (isRecord(entry) && typeof entry.name === 'string') labels.push(entry.name);
        }
      }
      const created = forge.createIssue(repo, { title, body: stringField(body, 'body') ?? '', labels });
      if ('unknownLabel' in created) return fail(422, `unknown label: ${created.unknownLabel}`);
      return json(201, issueJson(cast, repo, created));
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let items = [...repo.issues.values()];
      if (state === 'open') items = items.filter((issue) => issue.state === 'open');
      else if (state === 'closed') items = items.filter((issue) => issue.state === 'closed');
      const direction = ctx.query.get('direction') ?? 'asc';
      items.sort((a, b) => (direction === 'desc' ? b.number - a.number : a.number - b.number));
      const { page, headers } = paginate(ctx, items, `/api/v3/repos/${cast.viewer.login}/${repo.name}/issues`);
      return json(200, page.map((issue) => issueJson(cast, repo, issue)), headers);
    }
    return notFound();
  }
  const number = Number(tail[0]);
  if (!Number.isSafeInteger(number)) return notFound();
  if (tail.length === 2 && tail[1] === 'comments') {
    const target = forge.numbered(repo, number);
    if (target === undefined) return notFound();
    if (method === 'GET') return json(200, target.comments.map((comment) => commentJson(cast, comment)));
    if (method === 'POST') {
      const body = bodyOf(ctx);
      const text = stringField(body, 'body');
      if (text === undefined) throw new HttpError(422, 'body is required');
      const comment = forge.addComment(target, text);
      return json(201, commentJson(cast, comment));
    }
    return notFound();
  }
  if (tail.length !== 1) return notFound();
  const issue = repo.issues.get(number);
  if (issue === undefined) return notFound();
  if (method === 'GET') return json(200, issueJson(cast, repo, issue));
  if (method === 'PATCH') {
    const body = bodyOf(ctx);
    const state = stringField(body, 'state');
    if (state === 'open' || state === 'closed') issue.state = state;
    const title = stringField(body, 'title');
    if (title !== undefined) issue.title = title;
    const text = stringField(body, 'body');
    if (text !== undefined) issue.body = text;
    return json(200, issueJson(cast, repo, issue));
  }
  return notFound();
}

function pullRoutes(forge: Forge, cast: Cast, repo: RepoRec, ctx: Ctx, tail: string[]): Reply {
  const method = ctx.method;
  if (tail.length === 0) {
    if (method === 'POST') {
      const body = bodyOf(ctx);
      const title = stringField(body, 'title');
      const headRaw = stringField(body, 'head');
      const baseRaw = stringField(body, 'base');
      if (title === undefined || headRaw === undefined || baseRaw === undefined) {
        throw new HttpError(422, 'title, head and base are required');
      }
      const head = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
      const base = baseRaw.includes(':') ? (baseRaw.split(':').pop() as string) : baseRaw;
      const pull = forge.createPull(repo, { title, body: stringField(body, 'body') ?? '', head, base });
      if (pull === null) return fail(422, 'Validation Failed: a pull request already exists or a branch is missing');
      return json(201, pullJson(forge, cast, repo, pull));
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let items = [...repo.pulls.values()];
      if (state === 'open') items = items.filter((pull) => pull.state === 'open');
      else if (state === 'closed') items = items.filter((pull) => pull.state === 'closed');
      items.sort((a, b) => a.number - b.number);
      const { page, headers } = paginate(ctx, items, `/api/v3/repos/${cast.viewer.login}/${repo.name}/pulls`);
      return json(200, page.map((pull) => pullJson(forge, cast, repo, pull)), headers);
    }
    return notFound();
  }
  const number = Number(tail[0]);
  if (!Number.isSafeInteger(number)) return notFound();
  const pull = repo.pulls.get(number);
  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    if (pull === undefined) return notFound();
    return json(200, forge.pullFiles(repo, pull).map((change) => ({
      filename: change.filename,
      status: change.status === 'removed' ? 'removed' : change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.changes,
    })));
  }
  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (pull === undefined) return notFound();
    const body = bodyOf(ctx);
    const mergeMethod = stringField(body, 'merge_method') ?? 'merge';
    if (mergeMethod !== 'squash' && mergeMethod !== 'merge') {
      return fail(405, 'This pull request cannot be merged with the requested method');
    }
    if (pull.state !== 'open' || pull.merged) return fail(405, 'Pull Request is not mergeable');
    const outcome = forge.mergePull(repo, pull, mergeMethod);
    if ('conflict' in outcome) return fail(405, 'Pull Request is not mergeable');
    if ('error' in outcome) return fail(405, 'Pull Request is not mergeable');
    return json(200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
  }
  if (tail.length !== 1) return notFound();
  if (pull === undefined) return notFound();
  if (method === 'GET') return json(200, pullJson(forge, cast, repo, pull));
  return notFound();
}

// ---------------------------------------------------------------- the surface itself

export function handleRest(forge: Forge, cast: Cast, ctx: Ctx): Reply {
  const segments = ctx.segments.slice(2); // strip api / v3
  const method = ctx.method;

  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return json(200, {
      current_user_url: 'https://forge.invalid/api/v3/user',
      repository_url: 'https://forge.invalid/api/v3/repos/{owner}/{repo}',
      issue_search_url: 'https://forge.invalid/api/v3/search/issues',
      emojis_url: 'https://forge.invalid/api/v3/emojis',
    });
  }

  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return json(200, { installed_version: 'amber-forge 1.0.0', github_build_version: 'amber-forge 1.0.0' });
  }

  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return json(200, { login: cast.viewer.login, id: cast.viewer.id, name: cast.viewer.name, email: cast.viewer.email, type: 'User' });
  }

  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'POST') {
      const body = bodyOf(ctx);
      const name = stringField(body, 'name');
      if (name === undefined || name === '') throw new HttpError(422, 'name is required');
      const repo = forge.createRepo(name, body.private === true, stringField(body, 'description') ?? '');
      if (repo === null) return fail(422, 'name already exists on this account');
      return json(201, repoJson(cast, repo));
    }
    if (method === 'GET') {
      const items = [...forge.repos.values()];
      const { page, headers } = paginate(ctx, items, '/api/v3/user/repos');
      return json(200, page.map((repo) => repoJson(cast, repo)), headers);
    }
    return notFound();
  }

  if (segments[0] === 'repos' && segments.length >= 3) {
    if (segments[1] !== cast.viewer.login) return notFound();
    return repoRoutes(forge, cast, ctx, segments.slice(2));
  }

  return notFound();
}
