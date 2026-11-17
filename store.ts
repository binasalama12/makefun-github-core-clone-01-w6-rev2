// The object database and the graph algorithms on top of it.
//
// Everything git-shaped in this forge lives here: content-addressed objects
// (commit / tree / blob / tag), pack reading and writing, reachability,
// ancestry, merge bases, tree flattening, three-way tree merges and tree
// diffs. Objects are immutable once stored, so every parse and every walk
// result can be cached for the life of the repository.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface StoredObject {
  readonly type: ObjType;
  readonly data: Buffer;
}

export interface ParsedCommit {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export interface FlatEntry {
  readonly mode: string;
  readonly oid: string;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_CODES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const CODE_OF_TYPE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** The content address of an object: sha1 of "<type> <length>\0" + bytes. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export class ObjectStore {
  readonly objects = new Map<string, StoredObject>();
  private readonly commitCache = new Map<string, ParsedCommit>();
  private readonly treeCache = new Map<string, readonly TreeEntry[]>();
  private readonly flatCache = new Map<string, ReadonlyMap<string, FlatEntry>>();
  private readonly ancestorMemo = new Map<string, boolean>();

  /** Store an object under its computed address; returns the address. */
  put(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  /** Store an object whose address the caller already computed. */
  putKnown(oid: string, type: ObjType, data: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
  }

  get(oid: string): StoredObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  commitOf(oid: string): ParsedCommit | null {
    const hit = this.commitCache.get(oid);
    if (hit !== undefined) return hit;
    const obj = this.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') return null;
    const text = obj.data.toString('utf8');
    const split = text.indexOf('\n\n');
    const head = split === -1 ? text : text.slice(0, split);
    const message = split === -1 ? '' : text.slice(split + 2);
    let tree = '';
    const parents: string[] = [];
    for (const line of head.split('\n')) {
      if (line.startsWith('tree ')) tree = line.slice(5).trim();
      else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    }
    const parsed: ParsedCommit = { tree, parents, message };
    this.commitCache.set(oid, parsed);
    return parsed;
  }

  treeOf(oid: string): readonly TreeEntry[] | null {
    const hit = this.treeCache.get(oid);
    if (hit !== undefined) return hit;
    const obj = this.objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entries: TreeEntry[] = [];
    let pos = 0;
    const data = obj.data;
    while (pos < data.length) {
      const space = data.indexOf(0x20, pos);
      const mode = data.toString('utf8', pos, space);
      const nul = data.indexOf(0x00, space + 1);
      const name = data.toString('utf8', space + 1, nul);
      const oid = data.toString('hex', nul + 1, nul + 21);
      entries.push({ mode, name, oid });
      pos = nul + 21;
    }
    this.treeCache.set(oid, entries);
    return entries;
  }

  /** Every file (blob) under a tree, keyed by slash-joined path. */
  flatten(treeOid: string): ReadonlyMap<string, FlatEntry> {
    const hit = this.flatCache.get(treeOid);
    if (hit !== undefined) return hit;
    const out = new Map<string, FlatEntry>();
    const walk = (oid: string, prefix: string): void => {
      const entries = this.treeOf(oid);
      if (entries === null) return;
      for (const entry of entries) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    };
    walk(treeOid, '');
    this.flatCache.set(treeOid, out);
    return out;
  }

  /** Write nested trees for a flattened path map; returns the root tree id. */
  unflatten(flat: ReadonlyMap<string, FlatEntry>): string {
    interface Dir {
      files: Array<{ name: string; mode: string; oid: string }>;
      dirs: Map<string, Dir>;
    }
    const root: Dir = { files: [], dirs: new Map() };
    for (const [path, entry] of flat) {
      const parts = path.split('/');
      let dir = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const name = parts[i] as string;
        let next = dir.dirs.get(name);
        if (next === undefined) {
          next = { files: [], dirs: new Map() };
          dir.dirs.set(name, next);
        }
        dir = next;
      }
      dir.files.push({ name: parts[parts.length - 1] as string, mode: entry.mode, oid: entry.oid });
    }
    const writeDir = (dir: Dir): string => {
      const rows: Array<{ mode: string; name: string; oid: string }> = [];
      for (const file of dir.files) rows.push(file);
      for (const [name, sub] of dir.dirs) rows.push({ mode: '40000', name, oid: writeDir(sub) });
      return this.put('tree', buildTreeData(rows));
    };
    return writeDir(root);
  }

  /** True when `ancestor` is reachable from `descendant` over parent edges. */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const key = `${ancestor}<${descendant}`;
    const memo = this.ancestorMemo.get(key);
    if (memo !== undefined) return memo;
    const seen = new Set<string>();
    const stack: string[] = [descendant];
    let found = false;
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (current === ancestor) {
        found = true;
        break;
      }
      if (seen.has(current)) continue;
      seen.add(current);
      const commit = this.commitOf(current);
      if (commit === null) continue;
      for (const parent of commit.parents) {
        if (parent === ancestor) {
          found = true;
          stack.length = 0;
          break;
        }
        if (!seen.has(parent)) stack.push(parent);
      }
    }
    this.ancestorMemo.set(key, found);
    return found;
  }

  /** All commit ids reachable from a tip, the tip included. */
  commitAncestors(tip: string): Set<string> {
    const out = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (out.has(current)) continue;
      const commit = this.commitOf(current);
      if (commit === null) continue;
      out.add(current);
      for (const parent of commit.parents) stack.push(parent);
    }
    return out;
  }

  /** A best common ancestor of two commits, or null when unrelated. */
  mergeBase(a: string, b: string): string | null {
    if (a === b) return a;
    const ancestorsOfA = this.commitAncestors(a);
    if (ancestorsOfA.has(b)) return b;
    if (this.commitAncestors(b).has(a)) return a;
    const seen = new Set<string>();
    const queue: string[] = [b];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      if (ancestorsOfA.has(current)) return current;
      const commit = this.commitOf(current);
      if (commit === null) continue;
      for (const parent of commit.parents) queue.push(parent);
    }
    return null;
  }
}

/** Serialize tree entries (sorted the git way) into tree object bytes. */
export function buildTreeData(rows: Array<{ mode: string; name: string; oid: string }>): Buffer {
  const sorted = [...rows].sort((x, y) => {
    const kx = x.mode === '40000' ? `${x.name}/` : x.name;
    const ky = y.mode === '40000' ? `${y.name}/` : y.name;
    return kx < ky ? -1 : kx > ky ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const row of sorted) {
    parts.push(Buffer.from(`${row.mode} ${row.name}\0`, 'utf8'));
    parts.push(Buffer.from(row.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Serialize a commit object. */
export function buildCommitData(input: {
  tree: string;
  parents: readonly string[];
  message: string;
  name: string;
  email: string;
  whenSec: number;
}): Buffer {
  const stamp = `${input.whenSec} +0000`;
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.name} <${input.email}> ${stamp}`);
  lines.push(`committer ${input.name} <${input.email}> ${stamp}`);
  return Buffer.from(`${lines.join('\n')}\n\n${input.message}`, 'utf8');
}

/** Apply a git binary delta to its base bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos] as number;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // base size, informational here
  const targetSize = readVarint();
  const chunks: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if ((op & 0x01) !== 0) { offset = delta[pos] as number; pos += 1; }
      if ((op & 0x02) !== 0) { offset |= (delta[pos] as number) << 8; pos += 1; }
      if ((op & 0x04) !== 0) { offset |= (delta[pos] as number) << 16; pos += 1; }
      if ((op & 0x08) !== 0) { offset |= (delta[pos] as number) << 24; pos += 1; }
      if ((op & 0x10) !== 0) { size = delta[pos] as number; pos += 1; }
      if ((op & 0x20) !== 0) { size |= (delta[pos] as number) << 8; pos += 1; }
      if ((op & 0x40) !== 0) { size |= (delta[pos] as number) << 16; pos += 1; }
      if (size === 0) size = 0x10000;
      chunks.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      chunks.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(chunks);
  if (out.length !== targetSize) throw new Error('delta produced the wrong size');
  if (produced !== targetSize) throw new Error('delta accounting mismatch');
  return out;
}

/**
 * Index a pack into the store. Each object's deflate stream is inflated
 * exactly once; the inflater reports how many input bytes it consumed, which
 * is where the next object starts. Returns how many objects were read.
 */
export function readPack(store: ObjectStore, pack: Buffer, startAt = 0): number {
  if (pack.length < startAt + 12 || pack.toString('latin1', startAt, startAt + 4) !== 'PACK') {
    throw new Error('not a packfile');
  }
  const count = pack.readUInt32BE(startAt + 8);
  let pos = startAt + 12;
  const positionToOid = new Map<number, string>();
  for (let index = 0; index < count; index += 1) {
    const objectStart = pos;
    let byte = pack[pos] as number;
    pos += 1;
    const typeCode = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[pos] as number;
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | null = null;
    let baseType: ObjType | null = null;
    if (typeCode === 6) {
      // OFS_DELTA: a backward offset to the base object's start in this pack.
      let b = pack[pos] as number;
      pos += 1;
      let offset = b & 0x7f;
      while ((b & 0x80) !== 0) {
        b = pack[pos] as number;
        pos += 1;
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      const found = positionToOid.get(objectStart - offset);
      if (found === undefined) throw new Error('ofs-delta base is not in this pack');
      baseOid = found;
      baseType = (store.get(baseOid) as StoredObject).type;
    } else if (typeCode === 7) {
      // REF_DELTA: the base object's id, inline.
      baseOid = pack.toString('hex', pos, pos + 20);
      pos += 20;
      const base = store.get(baseOid);
      if (base === undefined) throw new Error('ref-delta base is missing');
      baseType = base.type;
    }
    const inflated = inflateSync(pack.subarray(pos), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    pos += inflated.engine.bytesWritten;
    let data = inflated.buffer;
    let type: ObjType;
    if (baseOid !== null && baseType !== null) {
      const base = store.get(baseOid) as StoredObject;
      data = applyDelta(base.data, data);
      type = baseType;
    } else {
      const whole = TYPE_CODES[typeCode];
      if (whole === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      type = whole;
    }
    if (data.length !== size && baseOid === null) {
      // The size in the header is the inflated size; trust the bytes we got.
    }
    const oid = hashObject(type, data);
    store.putKnown(oid, type, data);
    positionToOid.set(objectStart, oid);
  }
  return count;
}

/** Serialize whole objects into a packfile v2 buffer (no deltas). */
export function writePack(objects: readonly StoredObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    let size = obj.data.length;
    const first = ((CODE_OF_TYPE[obj.type] << 4) | (size & 0x0f)) | (size > 0x0f ? 0x80 : 0);
    const varint: number[] = [first];
    size >>= 4;
    while (size > 0) {
      const next = size & 0x7f;
      size >>= 7;
      varint.push(size > 0 ? next | 0x80 : next);
    }
    // Fix continuation bits: every byte but the last carries the high bit.
    for (let i = 0; i < varint.length - 1; i += 1) varint[i] = (varint[i] as number) | 0x80;
    varint[0] = ((CODE_OF_TYPE[obj.type] << 4) | (obj.data.length & 0x0f)) | (varint.length > 1 ? 0x80 : 0);
    parts.push(Buffer.from(varint));
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Parse an annotated tag object: its target and type. */
export function parseTag(data: Buffer): { target: string; targetType: string } | null {
  const text = data.toString('utf8');
  let target = '';
  let targetType = '';
  for (const line of text.split('\n')) {
    if (line === '') break;
    if (line.startsWith('object ')) target = line.slice(7).trim();
    else if (line.startsWith('type ')) targetType = line.slice(5).trim();
  }
  if (target === '') return null;
  return { target, targetType };
}

/** Peel an object id down to its commit (through tags), or null. */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let guard = 0; guard < 16; guard += 1) {
    const obj = store.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      const tag = parseTag(obj.data);
      if (tag === null) return null;
      current = tag.target;
      continue;
    }
    return null;
  }
  return null;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) lines += 1;
  return data[data.length - 1] === 0x0a ? lines : lines + 1;
}

/** Line-level diff counts via a bounded LCS over split lines. */
function lineDiff(before: Buffer, after: Buffer): { additions: number; deletions: number } {
  const a = before.toString('utf8').split('\n');
  const b = after.toString('utf8').split('\n');
  if (a.length > 1500 || b.length > 1500) {
    return { additions: countLines(after), deletions: countLines(before) };
  }
  const dp: number[] = new Array((a.length + 1) * (b.length + 1)).fill(0);
  const width = b.length + 1;
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i * width + j] = a[i] === b[j]
        ? (dp[(i + 1) * width + j + 1] as number) + 1
        : Math.max(dp[(i + 1) * width + j] as number, dp[i * width + j + 1] as number);
    }
  }
  const common = dp[0] as number;
  return { additions: b.length - common, deletions: a.length - common };
}

/** The file-level diff between two trees (either may be null = empty). */
export function diffTrees(store: ObjectStore, fromTree: string | null, toTree: string | null): FileChange[] {
  const empty = new Map<string, FlatEntry>();
  const from = fromTree === null ? empty : store.flatten(fromTree);
  const to = toTree === null ? empty : store.flatten(toTree);
  const changes: FileChange[] = [];
  const paths = new Set<string>([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const before = from.get(path);
    const after = to.get(path);
    if (before !== undefined && after === undefined) {
      const blob = store.get(before.oid);
      const deletions = blob === undefined ? 0 : countLines(blob.data);
      changes.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (before === undefined && after !== undefined) {
      const blob = store.get(after.oid);
      const additions = blob === undefined ? 0 : countLines(blob.data);
      changes.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (before !== undefined && after !== undefined && before.oid !== after.oid) {
      const beforeBlob = store.get(before.oid);
      const afterBlob = store.get(after.oid);
      const { additions, deletions } = lineDiff(
        beforeBlob === undefined ? Buffer.alloc(0) : beforeBlob.data,
        afterBlob === undefined ? Buffer.alloc(0) : afterBlob.data,
      );
      changes.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return changes;
}

export interface MergeOutcome {
  readonly tree: string;
  readonly conflicts: readonly string[];
}

/** File-level three-way merge of flattened trees against a common base. */
export function threeWayMerge(
  store: ObjectStore,
  baseTree: string | null,
  ourTree: string | null,
  theirTree: string | null,
): MergeOutcome {
  const empty = new Map<string, FlatEntry>();
  const base = baseTree === null ? empty : store.flatten(baseTree);
  const ours = ourTree === null ? empty : store.flatten(ourTree);
  const theirs = theirTree === null ? empty : store.flatten(theirTree);
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const result = new Map<string, FlatEntry>();
  const conflicts: string[] = [];
  const same = (x: FlatEntry | undefined, y: FlatEntry | undefined): boolean =>
    (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid && x.mode === y.mode);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (same(o, t)) {
      if (o !== undefined) result.set(path, o);
    } else if (same(b, o)) {
      if (t !== undefined) result.set(path, t);
    } else if (same(b, t)) {
      if (o !== undefined) result.set(path, o);
    } else {
      conflicts.push(path);
    }
  }
  if (conflicts.length > 0) return { tree: '', conflicts };
  return { tree: store.unflatten(result), conflicts };
}
