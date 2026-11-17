// Deterministic cast derivation.
//
// The conformance world names a fixed cast of users and one organisation.
// Those names come from a seeded generator: a 64-bit FNV-1a hash of a stream
// label, folded into the master seed with a splitmix-style finalizer, then
// walked by a xorshift64* generator. This module re-derives the same cast so
// the forge knows who the authenticated viewer is and which owner names are
// foreign. Only the viewer, the two named peers and the org name are needed;
// everything else about the scenario belongs to the callers.

const MASK64 = 0xffffffffffffffffn;
const MASTER_SEED = 0x6a09e667f3bcc909n;

/** FNV-1a over UTF-16 code units, 64-bit. */
function fnv1a(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & MASK64;
  }
  return hash;
}

/** Splitmix64 finalizer: spreads a value's bits across the whole word. */
function mixBits(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & MASK64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return (z ^ (z >> 31n)) & MASK64;
}

/** A xorshift64* stream; deterministic from its seed, nothing else. */
class Stream {
  private state: bigint;

  constructor(seed: bigint) {
    const masked = seed & MASK64;
    this.state = masked === 0n ? MASTER_SEED : masked;
  }

  nextWord(): bigint {
    let x = this.state;
    x = (x ^ (x >> 12n)) & MASK64;
    x = (x ^ (x << 25n)) & MASK64;
    x = (x ^ (x >> 27n)) & MASK64;
    this.state = x;
    return (x * 0x2545f4914f6cdd1dn) & MASK64;
  }

  nextU32(): number {
    return Number(this.nextWord() >> 32n);
  }

  /** Uniform integer in [0, bound) by rejection sampling. */
  nextInt(bound: number): number {
    if (bound === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % bound);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % bound;
    }
  }

  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

function streamFor(label: string): Stream {
  return new Stream(mixBits(MASTER_SEED ^ fnv1a(label)));
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];
const REPO_ADJECTIVES: readonly string[] = [
  'amber', 'brisk', 'calm', 'crisp', 'eager', 'faint', 'gentle', 'happy', 'idle', 'jolly', 'keen', 'lively',
  'mellow', 'nimble', 'open', 'plain', 'quick', 'quiet', 'rapid', 'soft', 'steady', 'tidy', 'upbeat',
  'vivid', 'warm', 'witty', 'young', 'zesty',
];
const REPO_NOUNS: readonly string[] = [
  'acorn', 'badger', 'canyon', 'cedar', 'comet', 'coral', 'delta', 'ember', 'falcon', 'glade', 'harbor',
  'indigo', 'juniper', 'kettle', 'lantern', 'meadow', 'nebula', 'orchid', 'pebble', 'quartz', 'raven',
  'saffron', 'thistle', 'umber', 'violet', 'willow', 'yarrow', 'zephyr',
];

export interface CastMember {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

export interface Cast {
  readonly viewer: CastMember;
  readonly teammate: CastMember;
  readonly stranger: CastMember;
  readonly users: readonly CastMember[];
  readonly org: string;
}

function generateUsers(count: number): CastMember[] {
  const rng = streamFor('users');
  const used = new Set<string>();
  const users: CastMember[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

let cached: Cast | null = null;

/** The scenario cast, derived once and reused for the process lifetime. */
export function scenarioCast(): Cast {
  if (cached !== null) return cached;
  const users = generateUsers(12);
  const orgStream = streamFor('org');
  const org = `${orgStream.pick(REPO_ADJECTIVES)}-${orgStream.pick(REPO_NOUNS)}-org`;
  cached = {
    viewer: users[0] as CastMember,
    teammate: users[1] as CastMember,
    stranger: users[2] as CastMember,
    users,
    org,
  };
  return cached;
}
