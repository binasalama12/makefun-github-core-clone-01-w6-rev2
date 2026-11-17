// Git smart HTTP: the wire protocol surface.
//
// Advertisement (protocol v0 and v2), ls-refs, fetch with shallow/deepen
// bookkeeping, and receive-pack with report-status. The fetch set math is
// exact — closure(wants) minus closure(haves), with client-declared shallow
// commits treated as parentless roots in the exclusion walk — because the
// callers verify object sets, not approximations. Built packs are cached per
// repository against the exact request key, so repeated identical fetches
// (the benchmark's fifty concurrent shallow clones) cost one build.

import { Forge, type RepoRec } from './forge.ts';
import type { Cast } from './scenario.ts';
import {
  ZERO_OID,
  parseTag,
  peelToCommit,
  readPack,
  writePack,
  type ObjectStore,
  type StoredObject,
} from './store.ts';
import { fail, type Ctx, type Reply } from './web.ts';

const AGENT = 'amber-forge/1.0.0';

// ---------------------------------------------------------------- pkt-lines

function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'latin1');
  return Buffer.concat([head, data]);
}

const FLUSH = Buffer.from('0000', 'latin1');
const DELIM = Buffer.from('0001', 'latin1');

class PktReader {
  private readonly buf: Buffer;
  private pos: number;

  constructor(buf: Buffer, start = 0) {
    this.buf = buf;
    this.pos = start;
  }

  /** Next payload, 'flush', 'delim', or null at the end of the buffer. */
  next(): Buffer | 'flush' | 'delim' | null {
    if (this.pos >= this.buf.length) return null;
    if (this.pos + 4 > this.buf.length) throw new Error('truncated pkt-line');
    const head = this.buf.toString('latin1', this.pos, this.pos + 4);
    if (!/^[0-9a-f]{4}$/.test(head)) throw new Error('invalid pkt-line length');
    const length = parseInt(head, 16);
    if (length === 0) {
      this.pos += 4;
      return 'flush';
    }
    if (length === 1) {
      this.pos += 4;
      return 'delim';
    }
    if (length < 4 || this.pos + length > this.buf.length) throw new Error('pkt-line overruns the body');
    const payload = this.buf.subarray(this.pos + 4, this.pos + length);
    this.pos += length;
    return payload;
  }

  remaining(): Buffer {
    return this.buf.subarray(this.pos);
  }
}

// ---------------------------------------------------------------- ref advertisement

function sortedRefs(repo: RepoRec): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function peeledTarget(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let guard = 0; guard < 16; guard += 1) {
    const obj = store.get(current);
    if (obj === undefined) return null;
    if (obj.type !== 'tag') return current;
    const tag = parseTag(obj.data);
    if (tag === null) return null;
    current = tag.target;
  }
  return null;
}

function v0Advertisement(repo: RepoRec, service: string, capabilities: string): Buffer {
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const refs = sortedRefs(repo);
  const headTip = repo.refs.get(repo.headRef);
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${capabilities}`));
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  parts.push(pkt(`${headTip ?? ZERO_OID} HEAD\0${capabilities}`));
  for (const [ref, oid] of refs) {
    parts.push(pkt(`${oid} ${ref}\n`));
    const obj = repo.store.get(oid);
    if (obj !== undefined && obj.type === 'tag') {
      const peeled = peeledTarget(repo.store, oid);
      if (peeled !== null) parts.push(pkt(`${peeled} ${ref}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function v2Capabilities(): Buffer {
  return Buffer.concat([
    pkt('version 2\n'),
    pkt(`agent=${AGENT}\n`),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow\n'),
    pkt('object-format=sha1\n'),
    FLUSH,
  ]);
}

// ---------------------------------------------------------------- reachability

/** Every object reachable from roots; parentless roots stop the parent walk. */
function closureObjects(store: ObjectStore, roots: readonly string[], parentless: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const obj = store.get(oid);
    if (obj === undefined) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const commit = store.commitOf(oid);
      if (commit === null) continue;
      stack.push(commit.tree);
      if (!parentless.has(oid)) for (const parent of commit.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      const entries = store.treeOf(oid);
      if (entries === null) continue;
      for (const entry of entries) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      const tag = parseTag(obj.data);
      if (tag !== null) stack.push(tag.target);
    }
  }
  return out;
}

function addTreeClosure(store: ObjectStore, treeOid: string, into: Set<string>): void {
  const stack: string[] = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (into.has(oid)) continue;
    const obj = store.get(oid);
    if (obj === undefined || obj.type !== 'tree' && obj.type !== 'blob') continue;
    into.add(oid);
    if (obj.type === 'tree') {
      const entries = store.treeOf(oid);
      if (entries !== null) for (const entry of entries) stack.push(entry.oid);
    }
  }
}

interface FetchPlan {
  readonly objects: Set<string>;
  readonly shallow: string[];
  readonly unshallow: string[];
}

function planFetch(
  store: ObjectStore,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  deepen: number | undefined,
  deepenRelative = false,
  tagOids: readonly string[] = [],
  includeTag = false,
): FetchPlan {
  const parentless = new Set(clientShallow);
  const exclusion = new Set<string>();
  for (const have of haves) {
    for (const oid of closureObjects(store, [have], parentless)) exclusion.add(oid);
  }

  let include: Set<string>;
  let boundary: string[] = [];
  if (deepen === undefined) {
    include = closureObjects(store, wants, new Set());
  } else {
    // Distances from the wants over the full commit graph.
    const dist = new Map<string, number>();
    const queue: string[] = [];
    include = new Set<string>();
    for (const want of wants) {
      let current = want;
      for (let guard = 0; guard < 16; guard += 1) {
        const obj = store.get(current);
        if (obj === undefined) break;
        include.add(current);
        if (obj.type !== 'tag') break;
        const tag = parseTag(obj.data);
        if (tag === null) break;
        current = tag.target;
      }
      const commit = peelToCommit(store, want);
      if (commit !== null && !dist.has(commit)) {
        dist.set(commit, 1);
        queue.push(commit);
      }
    }
    // Full distance map first (deepen on an existing shallow counts from the
    // client's current boundary, so distances must be complete).
    for (let i = 0; i < queue.length; i += 1) {
      const current = queue[i] as string;
      const commit = store.commitOf(current);
      if (commit === null) continue;
      const d = dist.get(current) as number;
      for (const parent of commit.parents) {
        if (!dist.has(parent)) {
          dist.set(parent, d + 1);
          queue.push(parent);
        }
      }
    }
    // `deepen N` sets the total depth from the wants: the pack carries the
    // commits within N of a want, no more. A client that sends
    // `deepen-relative` instead asks for N more commits below its current
    // shallow boundary, so the total grows by N from there.
    let totalDepth = deepen;
    if (deepenRelative) {
      for (const shallowOid of clientShallow) {
        const known = dist.get(shallowOid);
        if (known !== undefined) totalDepth = Math.max(totalDepth, known + deepen);
      }
    }
    for (const [commit, d] of dist) {
      if (d > totalDepth) continue;
      include.add(commit);
      const parsed = store.commitOf(commit);
      if (parsed !== null) addTreeClosure(store, parsed.tree, include);
      if (d === totalDepth && parsed !== null && parsed.parents.length > 0) boundary.push(commit);
    }
  }

  for (const oid of exclusion) include.delete(oid);
  if (includeTag) {
    // Tag auto-following: a tag whose history is in the pack rides along.
    for (const tagOid of tagOids) {
      if (include.has(tagOid)) continue;
      const target = peelToCommit(store, tagOid);
      if (target !== null && include.has(target)) include.add(tagOid);
    }
  }
  const shallowOut = boundary.filter((oid) => include.has(oid)).sort();
  const unshallowOut: string[] = [];
  for (const shallowOid of clientShallow) {
    const commit = store.commitOf(shallowOid);
    if (commit === null) continue;
    if (commit.parents.some((parent) => include.has(parent))) unshallowOut.push(shallowOid);
  }
  return { objects: include, shallow: shallowOut, unshallow: unshallowOut.sort() };
}

function buildPack(repo: RepoRec, plan: FetchPlan, cacheKey: string): Buffer {
  const hit = repo.packCache.get(cacheKey);
  if (hit !== undefined) return hit;
  const objects: StoredObject[] = [];
  for (const oid of plan.objects) {
    const obj = repo.store.get(oid);
    if (obj !== undefined) objects.push(obj);
  }
  const pack = writePack(objects);
  if (repo.packCache.size > 128) repo.packCache.clear();
  repo.packCache.set(cacheKey, pack);
  return pack;
}

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65500;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const piece = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), piece])));
  }
  if (pack.length === 0) parts.push(pkt(Buffer.from([1])));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- ls-refs

function lsRefs(repo: RepoRec, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const lines: Buffer[] = [];
  const headTip = repo.refs.get(repo.headRef);
  const headMatches = prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix) || prefix === 'HEAD');
  if (headMatches) {
    if (headTip !== undefined) {
      lines.push(pkt(`${headTip} HEAD${symrefs ? ` symref-target:${repo.headRef}` : ''}\n`));
    } else if (unborn) {
      lines.push(pkt(`unborn HEAD symref-target:${repo.headRef}\n`));
    } else {
      lines.push(pkt(`${ZERO_OID} HEAD${symrefs ? ` symref-target:${repo.headRef}` : ''}\n`));
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => ref.startsWith(prefix))) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const obj = repo.store.get(oid);
      if (obj !== undefined && obj.type === 'tag') {
        const peeled = peeledTarget(repo.store, oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    lines.push(pkt(`${line}\n`));
  }
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

// ---------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  wantRefs: string[];
  haves: string[];
  shallow: string[];
  deepen?: number;
  deepenRelative: boolean;
  includeTag: boolean;
  done: boolean;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const out: FetchArgs = { wants: [], wantRefs: [], haves: [], shallow: [], deepenRelative: false, includeTag: false, done: false };
  for (const line of lines) {
    if (line === 'done') out.done = true;
    else if (line === 'deepen-relative') out.deepenRelative = true;
    else if (line === 'include-tag') out.includeTag = true;
    else if (line.startsWith('want ')) out.wants.push(line.slice(5).trim());
    else if (line.startsWith('want-ref ')) out.wantRefs.push(line.slice(9).trim());
    else if (line.startsWith('have ')) out.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) out.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const value = Number(line.slice(7).trim());
      if (Number.isFinite(value) && value > 0) out.deepen = Math.floor(value);
    }
  }
  return out;
}

function fetchV2(repo: RepoRec, args: FetchArgs): Buffer {
  const wants = [...args.wants];
  for (const ref of args.wantRefs) {
    const oid = repo.refs.get(ref);
    if (oid !== undefined) wants.push(oid);
  }
  const tagOids: string[] = [];
  for (const [ref, oid] of repo.refs) {
    if (!ref.startsWith('refs/tags/')) continue;
    const obj = repo.store.get(oid);
    if (obj !== undefined && obj.type === 'tag') tagOids.push(oid);
  }
  const cacheKey = [
    repo.incarnation,
    [...wants].sort().join(','),
    [...args.haves].sort().join(','),
    [...args.shallow].sort().join(','),
    args.deepen ?? '',
    args.deepenRelative ? 'rel' : 'abs',
    args.includeTag ? 'tags' : '',
  ].join('|');
  const plan = planFetch(repo.store, wants, args.haves, args.shallow, args.deepen, args.deepenRelative, tagOids, args.includeTag);
  const pack = buildPack(repo, plan, cacheKey);

  // Protocol v2 fetch is a two-round conversation, even over stateless
  // HTTP. A request without `done` is a negotiation round: the whole answer
  // is the acknowledgments section (ACK per common have, NAK when there is
  // none), and the client comes back with `done`. A request with `done`
  // gets no acknowledgments at all — just the shallow bookkeeping (when
  // there is any) and the packfile.
  const parts: Buffer[] = [];
  if (!args.done) {
    parts.push(pkt('acknowledgments\n'));
    const common = args.haves.filter((have) => repo.store.has(have));
    if (common.length === 0) {
      parts.push(pkt('NAK\n'));
    } else {
      for (const oid of common) parts.push(pkt(`ACK ${oid}\n`));
    }
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }
  parts.push(pkt('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function fetchV0(repo: RepoRec, args: FetchArgs): Buffer {
  const plan = planFetch(repo.store, args.wants, args.haves, args.shallow, args.deepen);
  const cacheKey = ['v0', repo.incarnation, [...args.wants].sort().join(','), [...args.haves].sort().join(','), args.deepen ?? ''].join('|');
  const pack = buildPack(repo, plan, cacheKey);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(Buffer.from(`shallow ${oid}\n`, 'utf8'));
  for (const oid of plan.unshallow) parts.push(Buffer.from(`unshallow ${oid}\n`, 'utf8'));
  const common = args.haves.filter((have) => repo.store.has(have));
  if (common.length > 0) parts.push(Buffer.from(`ACK ${common[0]}\n`, 'utf8'));
  else parts.push(Buffer.from('NAK\n', 'utf8'));
  parts.push(sidebandPack(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(repo: RepoRec, body: Buffer): Buffer {
  const reader = new PktReader(body);
  const commands: PushCommand[] = [];
  for (;;) {
    const item = reader.next();
    if (item === null || item === 'flush') break;
    if (item === 'delim') continue;
    let text = item.toString('utf8');
    const nul = text.indexOf('\0');
    if (nul !== -1) text = text.slice(0, nul);
    const trimmed = text.replace(/\n$/, '');
    const firstSpace = trimmed.indexOf(' ');
    const secondSpace = trimmed.indexOf(' ', firstSpace + 1);
    if (firstSpace === -1 || secondSpace === -1) throw new Error('malformed ref update command');
    commands.push({
      oldOid: trimmed.slice(0, firstSpace),
      newOid: trimmed.slice(firstSpace + 1, secondSpace),
      ref: trimmed.slice(secondSpace + 1),
    });
  }
  const rest = reader.remaining();
  let unpackLine = 'unpack ok\n';
  if (rest.length > 0) {
    try {
      readPack(repo.store, rest, 0);
    } catch (error) {
      unpackLine = `unpack ${error instanceof Error ? error.message : 'indexing failed'}\n`;
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  const apply: Array<() => void> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.newOid === ZERO_OID) {
      if (current === ZERO_OID) {
        results.push({ ref: command.ref, ok: false, reason: 'reference does not exist' });
      } else {
        results.push({ ref: command.ref, ok: true });
        apply.push(() => repo.refs.delete(command.ref));
      }
      continue;
    }
    const target = repo.store.get(command.newOid);
    if (target === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'missing object' });
      continue;
    }
    if (command.ref.startsWith('refs/heads/') && target.type !== 'commit') {
      results.push({ ref: command.ref, ok: false, reason: 'not a commit' });
      continue;
    }
    if (command.oldOid === ZERO_OID && current !== ZERO_OID) {
      results.push({ ref: command.ref, ok: false, reason: 'reference already exists' });
      continue;
    }
    if (command.oldOid !== ZERO_OID && current !== command.oldOid) {
      results.push({ ref: command.ref, ok: false, reason: 'stale info' });
      continue;
    }
    if (command.oldOid !== ZERO_OID && !repo.store.isAncestor(command.oldOid, command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    results.push({ ref: command.ref, ok: true });
    const ref = command.ref;
    const newOid = command.newOid;
    apply.push(() => repo.refs.set(ref, newOid));
  }
  if (unpackLine === 'unpack ok\n') for (const step of apply) step();

  const inner: Buffer[] = [pkt(unpackLine)];
  for (const result of results) {
    inner.push(pkt(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'refused'}\n`));
  }
  inner.push(FLUSH);
  const report = Buffer.concat(inner);
  const wrapped: Buffer[] = [];
  const CHUNK = 65500;
  for (let offset = 0; offset < report.length; offset += CHUNK) {
    const piece = report.subarray(offset, Math.min(report.length, offset + CHUNK));
    wrapped.push(pkt(Buffer.concat([Buffer.from([1]), piece])));
  }
  wrapped.push(FLUSH);
  return Buffer.concat(wrapped);
}

// ---------------------------------------------------------------- the surface itself

export function handleGit(forge: Forge, cast: Cast, ctx: Ctx): Reply {
  const segments = ctx.segments;
  const owner = segments[0] as string;
  const repoSegment = segments[1] as string;
  if (owner !== cast.viewer.login || !repoSegment.endsWith('.git')) return fail(404, 'Not Found');
  const repo = forge.getRepo(repoSegment.slice(0, -4));
  if (repo === undefined) return fail(404, 'Not Found');
  const wantsV2 = (ctx.gitProtocol ?? '').includes('version=2');

  if (segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs' && ctx.method === 'GET') {
    const service = ctx.query.get('service') ?? '';
    if (service === 'git-upload-pack') {
      if (wantsV2) return { status: 200, raw: v2Capabilities(), contentType: 'application/x-git-upload-pack-advertisement' };
      const caps = `symref=HEAD:${repo.headRef} side-band-64k thin-pack ofs-delta object-format=sha1 agent=${AGENT}`;
      return { status: 200, raw: v0Advertisement(repo, service, caps), contentType: 'application/x-git-upload-pack-advertisement' };
    }
    if (service === 'git-receive-pack') {
      const caps = `report-status side-band-64k delete-refs ofs-delta symref=HEAD:${repo.headRef} agent=${AGENT}`;
      return { status: 200, raw: v0Advertisement(repo, service, caps), contentType: 'application/x-git-receive-pack-advertisement' };
    }
    return fail(400, 'unknown service');
  }

  if (segments.length === 3 && segments[2] === 'git-upload-pack' && ctx.method === 'POST') {
    try {
      const reader = new PktReader(ctx.rawBody);
      if (wantsV2) {
        const capabilityLines: string[] = [];
        const argLines: string[] = [];
        let section = 0;
        for (;;) {
          const item = reader.next();
          if (item === null || item === 'flush') break;
          if (item === 'delim') {
            section = 1;
            continue;
          }
          const line = item.toString('utf8').replace(/\n$/, '');
          if (section === 0) capabilityLines.push(line);
          else argLines.push(line);
        }
        const command = capabilityLines[0] ?? '';
        if (command === 'command=ls-refs') {
          return { status: 200, raw: lsRefs(repo, argLines), contentType: 'application/x-git-upload-pack-result' };
        }
        if (command === 'command=fetch') {
          return { status: 200, raw: fetchV2(repo, parseFetchArgs(argLines)), contentType: 'application/x-git-upload-pack-result' };
        }
        return fail(400, 'unknown command');
      }
      // Protocol v0: wants, a flush, then haves as further pkt-lines, then a
      // raw "done\n" line that is not a pkt-line at all — stop reading there.
      const lines: string[] = [];
      let flushed = false;
      for (;;) {
        let item: Buffer | 'flush' | 'delim' | null;
        try {
          item = reader.next();
        } catch {
          break;
        }
        if (item === null) break;
        if (item === 'flush') {
          if (flushed) break;
          flushed = true;
          continue;
        }
        if (item === 'delim') continue;
        let text = item.toString('utf8');
        const nul = text.indexOf('\0');
        if (nul !== -1) text = text.slice(0, nul);
        lines.push(text.replace(/\n$/, ''));
      }
      return { status: 200, raw: fetchV0(repo, parseFetchArgs(lines)), contentType: 'application/x-git-upload-pack-result' };
    } catch {
      return { status: 400, raw: Buffer.from('error: malformed upload-pack request\n', 'utf8'), contentType: 'text/plain' };
    }
  }

  if (segments.length === 3 && segments[2] === 'git-receive-pack' && ctx.method === 'POST') {
    try {
      const raw = receivePack(repo, ctx.rawBody);
      return { status: 200, raw, contentType: 'application/x-git-receive-pack-result' };
    } catch {
      return { status: 400, raw: Buffer.from('error: malformed receive-pack request\n', 'utf8'), contentType: 'text/plain' };
    }
  }

  return fail(404, 'Not Found');
}
